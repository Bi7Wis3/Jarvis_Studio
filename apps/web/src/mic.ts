// Push-to-talk recording: captures the microphone and sends the clip to the server for transcription.

const MIN_DURATION_MS = 300;

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let startedAt = 0;

/** True when this browser can record audio from a microphone. */
export function micSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function pickMimeType(): string | undefined {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type));
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

/** Starts recording; asks for microphone permission the first time. Rejects if the microphone is unavailable. */
export async function startRecording(): Promise<void> {
    if (recorder?.state === 'recording') {
        return;
    }
    const source = await ensureStream();
    const mimeType = pickMimeType();
    const next = new MediaRecorder(source, mimeType ? { mimeType } : undefined);
    chunks = [];
    next.ondataavailable = (event) => {
        if (event.data.size > 0) {
            chunks.push(event.data);
        }
    };
    recorder = next;
    startedAt = performance.now();
    next.start();
}

/** Stops recording and resolves with the transcript, or '' when nothing usable was heard. */
export async function stopRecording(): Promise<string> {
    const active = recorder;
    recorder = null;
    if (!active || active.state === 'inactive') {
        return '';
    }
    const duration = performance.now() - startedAt;
    await new Promise<void>((resolve) => {
        active.onstop = () => resolve();
        active.stop();
    });
    if (duration < MIN_DURATION_MS || chunks.length === 0) {
        return '';
    }
    const blob = new Blob(chunks, { type: active.mimeType || 'audio/webm' });
    chunks = [];
    try {
        const response = await fetch('/api/stt', {
            method: 'POST',
            headers: { 'content-type': blob.type },
            body: blob,
        });
        if (!response.ok) {
            return '';
        }
        const { text } = (await response.json()) as { text?: unknown };
        return typeof text === 'string' ? text.trim() : '';
    } catch (e) {
        console.error('Could not transcribe recording', e);
        return '';
    }
}
