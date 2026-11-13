// Plays Jarvis's sentences in order through a light "onboard computer" effects chain.

interface Clip {
    text: string;
    muted: boolean;
    buffer: Promise<AudioBuffer | null>;
}

type Listener = (state: { speaking: boolean; text: string }) => void;

let context: AudioContext | null = null;
let input: AudioNode | null = null;
let analyser: AnalyserNode | null = null;
let current: AudioBufferSourceNode | null = null;
let queue: Clip[] = [];
let playing = false;
let generation = 0;
let listener: Listener = () => undefined;

function impulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
        }
    }
    return buffer;
}

function ensureContext(): AudioContext {
    if (context) {
        return context;
    }
    const ctx = new AudioContext();
    const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 130 });
    const presence = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2800, Q: 0.9, gain: 3 });
    const compressor = new DynamicsCompressorNode(ctx, { threshold: -22, ratio: 3.5, attack: 0.004, release: 0.2 });
    const reverb = new ConvolverNode(ctx, { buffer: impulse(ctx, 0.28) });
    const wet = new GainNode(ctx, { gain: 0.14 });
    analyser = new AnalyserNode(ctx, { fftSize: 256 });
    highpass.connect(presence).connect(compressor);
    compressor.connect(analyser);
    compressor.connect(reverb).connect(wet).connect(analyser);
    analyser.connect(ctx.destination);
    input = highpass;
    context = ctx;
    return ctx;
}

/** Must be called from a user gesture so the browser allows audio. */
export function unlockAudio(): void {
    void ensureContext().resume();
}

export function onSpeech(next: Listener): void {
    listener = next;
}

/** Current output loudness, 0 to 1, for the orb. */
export function level(): number {
    if (!analyser || !playing) {
        return 0;
    }
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const sample of data) {
        peak = Math.max(peak, Math.abs(sample - 128));
    }
    return Math.min(1, peak / 90);
}

async function load(url: string): Promise<AudioBuffer | null> {
    try {
        const response = await fetch(url);
        return await ensureContext().decodeAudioData(await response.arrayBuffer());
    } catch (e) {
        console.error('Could not load speech clip', e);
        return null;
    }
}

function speakWithBrowser(text: string): Promise<void> {
    return new Promise((resolve) => {
        if (!('speechSynthesis' in window)) {
            resolve();
            return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = speechSynthesis.getVoices().find((v) => v.lang === 'en-GB') ?? null;
        utterance.lang = 'en-GB';
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
    });
}

function playBuffer(ctx: AudioContext, buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
        const source = new AudioBufferSourceNode(ctx, { buffer });
        source.connect(input!);
        source.onended = () => resolve();
        current = source;
        source.start();
    });
}

async function drain(): Promise<void> {
    if (playing) {
        return;
    }
    playing = true;
    const mine = generation;
    let last = '';
    while (queue.length > 0 && mine === generation) {
        const clip = queue.shift()!;
        const buffer = await clip.buffer;
        if (mine !== generation) {
            break;
        }
        last = clip.text;
        listener({ speaking: true, text: clip.text });
        if (clip.muted) {
            // Roughly the time it takes to say the sentence, so the subtitle stays up as long as the voice.
            await new Promise((resolve) => window.setTimeout(resolve, 400 + clip.text.length * 65));
        } else if (buffer) {
            await playBuffer(ensureContext(), buffer);
        } else {
            await speakWithBrowser(clip.text);
        }
    }
    if (mine === generation) {
        playing = false;
        listener({ speaking: false, text: last });
    }
}

export function enqueue(text: string, audioUrl: string | null, muted = false): void {
    queue.push({ text, muted, buffer: audioUrl ? load(audioUrl) : Promise.resolve(null) });
    void drain();
}

/** Stops speech immediately and drops anything queued. */
export function silence(): void {
    generation++;
    queue = [];
    playing = false;
    try {
        current?.stop();
    } catch {
        // already stopped
    }
    current = null;
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
    listener({ speaking: false, text: '' });
}
