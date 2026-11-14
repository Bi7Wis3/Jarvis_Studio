import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LocalService } from './localService.js';
import { PIPER_PYTHON, ROOT } from './paths.js';

const STT_PORT = Number(process.env.STT_PORT ?? 4722);
const SCRIPT = join(ROOT, 'scripts', 'stt_server.py');
const BASE = `http://127.0.0.1:${STT_PORT}`;

function hasFasterWhisper(): boolean {
    if (!existsSync(PIPER_PYTHON)) {
        return false;
    }
    const probe = spawnSync(PIPER_PYTHON, ['-c', 'import importlib.util, sys; '
        + 'sys.exit(0 if importlib.util.find_spec("faster_whisper") else 1)'], { stdio: 'ignore' });
    return probe.status === 0;
}

/** Local Whisper speech recognition, kept warm as an HTTP service so the model loads only once. */
export class Ears {
    readonly available: boolean;
    private service: LocalService | null = null;

    constructor() {
        if (!existsSync(SCRIPT) || !hasFasterWhisper()) {
            console.warn('[ears] faster-whisper is missing; run "npm run setup:stt" to enable speech input.');
            this.available = false;
            return;
        }
        this.available = true;
        this.service = new LocalService({
            name: 'ears',
            up: async () => {
                try {
                    return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })).ok;
                } catch {
                    return false;
                }
            },
            spawn: () => spawn(PIPER_PYTHON, [SCRIPT, '--port', String(STT_PORT)], {
                stdio: ['ignore', 'ignore', 'inherit'],
            }),
            // The first run may still be loading or downloading the model, so allow about two minutes.
            attempts: 240,
            failed: 'Whisper did not start; speech input is disabled.',
        });
    }

    /** Returns the trimmed transcript of the audio, or null when recognition is unavailable or fails. */
    async transcribe(audio: Buffer): Promise<string | null> {
        const heard = await this.service?.call(async () => {
            const res = await fetch(`${BASE}/transcribe`, {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: new Uint8Array(audio),
            });
            if (!res.ok) {
                return null;
            }
            const { text } = (await res.json()) as { text?: unknown };
            return typeof text === 'string' ? text.trim() : null;
        });
        return heard ?? null;
    }

    close(): void {
        this.service?.close();
    }
}
