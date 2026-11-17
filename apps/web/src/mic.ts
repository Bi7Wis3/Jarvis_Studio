// Push-to-talk recording. With Web Audio (every current browser) the microphone is captured as raw samples, made 16 kHz
// mono and cut into phrases at pauses (micChunks.ts); each phrase goes to the server while the next one is spoken, so on
// release only the last is left to recognise, and the words so far arrive while talking. Without Web Audio the clip is
// recorded with MediaRecorder (webm/opus) and sent whole on release, as before.

import { PhraseChunker, Resampler, SAMPLE_RATE, toPcm16 } from './micChunks';

const MIN_DURATION_MS = 300;
const PCM_TYPE = `audio/s16le;rate=${SAMPLE_RATE}`;

/** A recording failed; the message is meant for the person talking. */
export class MicError extends Error {}

interface Capture {
    /** Ends the recording and resolves with the words heard: null when there was nothing to send, '' for no words. */
    stop(): Promise<string | null>;
}

let stream: MediaStream | null = null;
let current: Promise<Capture> | null = null;

const webAudio = (): boolean => typeof AudioContext !== 'undefined';

/** True when this browser can record audio from a microphone. */
export function micSupported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && (webAudio() || typeof MediaRecorder !== 'undefined');
}

async function ensureStream(): Promise<MediaStream> {
    if (stream && stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        return stream;
    }
    stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    return stream;
}

/**
 * Starts recording; asks for microphone permission the first time. Rejects if the microphone is unavailable.
 * `onWords` gets the words heard so far each time a phrase has been recognised.
 */
export async function startRecording(onWords?: (text: string) => void): Promise<void> {
    if (!current) {
        const starting = (async () => {
            const source = await ensureStream();
            if (webAudio()) {
                try {
                    return await startPcm(source, onWords);
                } catch (error) {
                    if (typeof MediaRecorder === 'undefined') {
                        throw error;
                    }
                    console.warn('Raw audio capture failed; recording a compressed clip instead', error);
                }
            }
            return startClip(source);
        })();
        current = starting;
        starting.catch(() => {
            if (current === starting) {
                current = null;
            }
        });
    }
    await current;
}

/**
 * Stops recording and resolves with the transcript: null when there was nothing to send (no recording, or one too
 * short to be speech), '' when no words were heard. Rejects when the server could not transcribe it.
 */
export async function stopRecording(): Promise<string | null> {
    const pending = current;
    current = null;
    if (!pending) {
        return null;
    }
    let capture: Capture;
    try {
        capture = await pending;
    } catch {
        return null;
    }
    return capture.stop();
}

async function answerText(response: Response): Promise<string> {
    const answer = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
    if (!response.ok) {
        throw new MicError(typeof answer.error === 'string' ? answer.error : `Transcription failed (${response.status})`);
    }
    return typeof answer.text === 'string' ? answer.text.trim() : '';
}

// ---- Raw samples (AudioWorklet, or ScriptProcessor where there is none) ----------------------------------------

// Collects the input in blocks and posts them; 'flush' posts what is left, so release loses nothing.
const WORKLET = `
class JarvisCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.block = new Float32Array(1024);
        this.n = 0;
        this.port.onmessage = () => {
            this.port.postMessage({ samples: this.block.slice(0, this.n), flushed: true });
            this.n = 0;
        };
    }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel) {
            for (let i = 0; i < channel.length; i++) {
                this.block[this.n++] = channel[i];
                if (this.n === this.block.length) {
                    this.port.postMessage({ samples: this.block });
                    this.block = new Float32Array(1024);
                    this.n = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('jarvis-capture', JarvisCapture);
`;

interface Graph {
    context: AudioContext;
    source: MediaStream;
    /** Where blocks of samples go while recording. */
    sink: ((block: Float32Array) => void) | null;
    /** Posts what the worklet still holds; resolves once it has arrived. */
    flush: () => Promise<void>;
}

let graph: Graph | null = null;

/** The audio graph, made once per microphone stream and suspended between recordings. */
async function audioGraph(source: MediaStream): Promise<Graph> {
    if (graph && graph.source === source && graph.context.state !== 'closed') {
        return graph;
    }
    void graph?.context.close();
    graph = null;
    const open = (rate?: number) => {
        const c = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext();
        try {
            return { context: c, input: c.createMediaStreamSource(source) };
        } catch (error) {
            void c.close();
            throw error;
        }
    };
    let opened: ReturnType<typeof open>;
    try {
        opened = open(SAMPLE_RATE);
    } catch {
        // Firefox cannot connect a microphone to a context at another rate (and older Safari cannot choose the rate):
        // record at the device's rate and resample here.
        opened = open();
    }
    const { context, input } = opened;
    const made: Graph = { context, source, sink: null, flush: async () => undefined };
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        try {
            await context.audioWorklet.addModule(url);
        } catch (error) {
            void context.close();
            throw error;
        } finally {
            URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(context, 'jarvis-capture', { channelCount: 1, channelCountMode: 'explicit' });
        let flushed: (() => void) | null = null;
        node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; flushed?: boolean }>) => {
            if (event.data.samples.length) {
                made.sink?.(event.data.samples);
            }
            if (event.data.flushed) {
                flushed?.();
            }
        };
        made.flush = () => new Promise<void>((resolve) => {
            flushed = resolve;
            node.port.postMessage('flush');
            setTimeout(resolve, 200);
        });
        input.connect(node).connect(context.destination);
    } else {
        const node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (event) => {
            made.sink?.(new Float32Array(event.inputBuffer.getChannelData(0)));
            event.outputBuffer.getChannelData(0).fill(0);
        };
        input.connect(node).connect(context.destination);
    }
    graph = made;
    return made;
}

const sessionId = (): string =>
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function startPcm(source: MediaStream, onWords?: (text: string) => void): Promise<Capture> {
    const g = await audioGraph(source);
    await g.context.resume();
    const resampler = new Resampler(g.context.sampleRate);
    const chunker = new PhraseChunker();
    const session = sessionId();
    const startedAt = performance.now();
    let seq = 0;
    let shown = -1;
    let stopped = false;
    const send = (samples: Float32Array | null, final: boolean): Promise<string> => {
        const n = seq++;
        return fetch(`/api/stt/phrase?session=${session}&seq=${n}${final ? '&final=1' : ''}`, {
            method: 'POST',
            headers: { 'content-type': PCM_TYPE },
            // Int16Array is little-endian on every platform browsers run on.
            body: samples ? toPcm16(samples) : new Uint8Array(0),
        }).then(answerText).then((text) => {
            if (n > shown && !final && !stopped) {
                shown = n;
                onWords?.(text);
            }
            return text;
        });
    };
    g.sink = (block) => {
        for (const phrase of chunker.push(resampler.push(block))) {
            // A failed phrase shows up in the final answer; nothing to do here.
            send(phrase, false).catch(() => undefined);
        }
    };
    return {
        async stop() {
            await g.flush();
            stopped = true;
            g.sink = null;
            void g.context.suspend();
            if (chunker.sent === 0 && performance.now() - startedAt < MIN_DURATION_MS) {
                return null;
            }
            return send(chunker.finish(), true);
        },
    };
}

// ---- Compressed clip (MediaRecorder), for browsers without Web Audio --------------------------------------------

function pickMimeType(): string | undefined {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function startClip(source: MediaStream): Capture {
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(source, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            chunks.push(event.data);
        }
    };
    const startedAt = performance.now();
    recorder.start();
    return {
        async stop() {
            const duration = performance.now() - startedAt;
            await new Promise<void>((resolve) => {
                recorder.onstop = () => resolve();
                recorder.stop();
            });
            if (duration < MIN_DURATION_MS || chunks.length === 0) {
                return null;
            }
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            return answerText(await fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type }, body: blob }));
        },
    };
}
