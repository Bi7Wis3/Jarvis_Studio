import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PIPER_PYTHON, ROOT } from './paths.js';

const STT_PORT = Number(process.env.STT_PORT ?? 4722);
const SCRIPT = join(ROOT, 'scripts', 'stt_server.py');

function hasFasterWhisper(): boolean {
    if (!existsSync(PIPER_PYTHON)) {
        return false;
    }
    const probe = spawnSync(PIPER_PYTHON, ['-c', 'import importlib.util, sys; '
        + 'sys.exit(0 if importlib.util.find_spec("faster_whisper") else 1)'], { stdio: 'ignore' });
    return probe.status === 0;
}

/** Local Whisper speech recognition, kept warm as an HTTP child process so the model loads only once. */
export class Ears {
    readonly available: boolean;
    private child: ChildProcess | null = null;
    private ready: Promise<boolean>;

    constructor() {
        if (!existsSync(SCRIPT) || !hasFasterWhisper()) {
            console.warn('[ears] faster-whisper is missing; run "npm run setup:stt" to enable speech input.');
            this.available = false;
            this.ready = Promise.resolve(false);
            return;
        }
        this.available = true;
        this.child = spawn(PIPER_PYTHON, [SCRIPT, '--port', String(STT_PORT)], {
            stdio: ['ignore', 'ignore', 'inherit'],
        });
        this.child.on('exit', () => {
            this.child = null;
        });
        this.ready = this.waitUntilUp();
    }

    /** Returns the trimmed transcript of the audio, or null when recognition is unavailable or fails. */
    async transcribe(audio: Buffer): Promise<string | null> {
        if (!(await this.ready) || !this.child) {
            return null;
        }
        try {
            const res = await fetch(`http://127.0.0.1:${STT_PORT}/transcribe`, {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: new Uint8Array(audio),
            });
            if (!res.ok) {
                return null;
            }
            const { text } = (await res.json()) as { text?: unknown };
            return typeof text === 'string' ? text.trim() : null;
        } catch (e) {
            console.error('[ears] transcription failed', e);
            return null;
        }
    }

    close(): void {
        this.child?.kill();
    }

    private async waitUntilUp(): Promise<boolean> {
        // The first run may still be loading or downloading the model, so allow about two minutes.
        for (let attempt = 0; attempt < 240 && this.child; attempt++) {
            try {
                const res = await fetch(`http://127.0.0.1:${STT_PORT}/health`);
                if (res.ok) {
                    return true;
                }
            } catch {
                // not listening yet
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        console.warn('[ears] Whisper did not start; speech input is disabled.');
        return false;
    }
}
