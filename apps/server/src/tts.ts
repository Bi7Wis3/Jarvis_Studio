import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LocalService } from './localService.js';
import { VENV_PYTHON, VOICES_DIR } from './paths.js';

const PIPER_PORT = Number(process.env.PIPER_PORT ?? 4721);
const VOICE = process.env.JARVIS_VOICE ?? 'en_GB-alan-medium';
const BASE = `http://127.0.0.1:${PIPER_PORT}`;

/** Local Piper voice, kept warm as an HTTP service so each sentence synthesises quickly. */
export class Voice {
    readonly name: string | null;
    private service: LocalService | null = null;

    constructor() {
        const model = join(VOICES_DIR, `${VOICE}.onnx`);
        if (!existsSync(VENV_PYTHON) || !existsSync(model)) {
            console.warn('[voice] Piper or the voice model is missing; run "npm run setup:voice". Using browser speech.');
            this.name = null;
            return;
        }
        this.name = VOICE;
        this.service = new LocalService({
            name: 'voice',
            up: async () => {
                try {
                    return (await fetch(`${BASE}/voices`, { signal: AbortSignal.timeout(2000) })).ok;
                } catch {
                    return false;
                }
            },
            spawn: () => spawn(VENV_PYTHON, [
                '-m', 'piper.http_server', '-m', model, '--host', '127.0.0.1', '--port', String(PIPER_PORT),
                '--length-scale', '1.05', '--sentence-silence', '0.15',
            ], { stdio: 'ignore' }),
            attempts: 60,
            failed: 'Piper did not start; using browser speech.',
        });
    }

    /** Returns WAV audio for the text, or null when the voice is unavailable. */
    async synthesize(text: string): Promise<Buffer | null> {
        const wav = await this.service?.call(async () => {
            const res = await fetch(`${BASE}/synthesize`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
        });
        return wav ?? null;
    }

    close(): void {
        this.service?.close();
    }
}
