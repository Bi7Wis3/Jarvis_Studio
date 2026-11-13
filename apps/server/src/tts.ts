import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PIPER_PYTHON, VOICES_DIR } from './paths.js';

const PIPER_PORT = Number(process.env.PIPER_PORT ?? 4721);
const VOICE = process.env.JARVIS_VOICE ?? 'en_GB-alan-medium';

/** Local Piper voice, kept warm as an HTTP child process so each sentence synthesises quickly. */
export class Voice {
    readonly name: string | null;
    private child: ChildProcess | null = null;
    private ready: Promise<boolean>;

    constructor() {
        const model = join(VOICES_DIR, `${VOICE}.onnx`);
        if (!existsSync(PIPER_PYTHON) || !existsSync(model)) {
            console.warn('[voice] Piper or the voice model is missing; run "npm run setup:voice". Using browser speech.');
            this.name = null;
            this.ready = Promise.resolve(false);
            return;
        }
        this.name = VOICE;
        this.child = spawn(PIPER_PYTHON, [
            '-m', 'piper.http_server', '-m', model, '--host', '127.0.0.1', '--port', String(PIPER_PORT),
            '--length-scale', '1.05', '--sentence-silence', '0.15',
        ], { stdio: 'ignore' });
        this.child.on('exit', () => {
            this.child = null;
        });
        this.ready = this.waitUntilUp();
    }

    /** Returns WAV audio for the text, or null when the voice is unavailable. */
    async synthesize(text: string): Promise<Buffer | null> {
        if (!(await this.ready) || !this.child) {
            return null;
        }
        try {
            const res = await fetch(`http://127.0.0.1:${PIPER_PORT}/synthesize`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
        } catch (e) {
            console.error('[voice] synthesis failed', e);
            return null;
        }
    }

    close(): void {
        this.child?.kill();
    }

    private async waitUntilUp(): Promise<boolean> {
        for (let attempt = 0; attempt < 60 && this.child; attempt++) {
            try {
                await fetch(`http://127.0.0.1:${PIPER_PORT}/voices`);
                return true;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        console.warn('[voice] Piper did not start; using browser speech.');
        return false;
    }
}
