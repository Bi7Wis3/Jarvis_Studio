import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    DEFAULT_SPEECH, sameRuntime, SPEECH_ENGINES, speechRuntime, type SpeechDevice, type SpeechEngine, type SpeechRuntime,
    type SpeechSettings,
} from '@jarvis/core/settings';
import { LocalService } from './localService.js';
import { ROOT, VENV_PYTHON } from './paths.js';
import { libraryEnv, nvidiaLibraryDirs } from './python.js';

const SCRIPT = join(ROOT, 'scripts', 'stt_server.py');
/** The speech server's own protocol version (its /health says it); an older one on the port is replaced. */
const PROTOCOL = 2;

/** What the Python environment has: found without importing anything, so it is quick enough for start-up. */
export interface SpeechInstall {
    python: boolean;
    engines: Record<SpeechEngine, boolean>;
}

/** What the speech server reports about this machine (python stt_server.py --probe). */
export interface SpeechProbe {
    cudaDevices: number;
    onnxProviders: string[];
    /** How a compressed clip is decoded: pyav, ffmpeg, or '' (only raw PCM works). */
    decoder: string;
    /** Models already downloaded, per engine. */
    downloaded: Partial<Record<SpeechEngine, string[]>>;
    /** Per engine: whether a GPU runtime is there, and the error of its last GPU test when that failed. */
    gpu: Partial<Record<SpeechEngine, { runtime: boolean; failed: string }>>;
}

export interface SpeechHealth extends SpeechRuntime {
    protocol: number;
    requested: SpeechDevice;
    /** Where it runs now. */
    device: SpeechDevice;
    gpuError: string;
}

export interface SpeechStatus {
    available: boolean;
    platform: NodeJS.Platform;
    installed: Record<SpeechEngine, boolean>;
    /** The NVIDIA libraries are in the venv (not on macOS). */
    gpuLibraries: boolean;
    probe: SpeechProbe | null;
    /** What the settings ask for, and the engine used when the chosen one is not installed. */
    wanted: SpeechRuntime;
    running: SpeechHealth | null;
}

export interface TranscribeOptions {
    /** Raw 16 kHz mono s16le samples, not a clip in a container. */
    pcm?: boolean;
    /** The words heard just before, as context (Whisper uses it). */
    prompt?: string;
}

/** Recognises speech; null when recognition is unavailable or failed. */
export interface Transcriber {
    transcribe(audio: Buffer, options?: TranscribeOptions): Promise<string | null>;
}

export function findInstall(python: string = VENV_PYTHON): SpeechInstall {
    const none = { python: false, engines: { whisper: false, moonshine: false } };
    if (!existsSync(python)) {
        return none;
    }
    const probe = spawnSync(python, ['-c', 'import importlib.util as u, json; f = lambda m: u.find_spec(m) is not None; '
        + 'print(json.dumps({"whisper": f("faster_whisper"), "moonshine": f("moonshine_onnx") and f("onnxruntime")}))'],
    { encoding: 'utf8', timeout: 20000 });
    try {
        const engines = JSON.parse(probe.stdout) as Record<SpeechEngine, boolean>;
        return { python: true, engines: { whisper: engines.whisper === true, moonshine: engines.moonshine === true } };
    } catch {
        return { ...none, python: true };
    }
}

/** The runtime to start: the chosen engine, or the other one when only that is installed. */
export function usableRuntime(settings: SpeechSettings, installed: Record<SpeechEngine, boolean>): SpeechRuntime {
    if (installed[settings.engine] || !SPEECH_ENGINES.some((e) => installed[e])) {
        return speechRuntime(settings);
    }
    const other = SPEECH_ENGINES.find((e) => installed[e]) as SpeechEngine;
    return speechRuntime({ ...settings, engine: other });
}

export interface EarsOptions {
    port?: number;
    python?: string;
    install?: SpeechInstall;
    spawn?: (runtime: SpeechRuntime, port: number) => ChildProcess;
    probe?: () => Promise<SpeechProbe | null>;
    /** Half-second waits for the server to come up (the first run may download a model). */
    attempts?: number;
}

function startServer(runtime: SpeechRuntime, port: number, python: string): ChildProcess {
    const env = libraryEnv(process.env, nvidiaLibraryDirs(ROOT));
    return spawn(python, [SCRIPT, '--port', String(port), '--engine', runtime.engine, '--model', runtime.model, '--device', runtime.device], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env,
        windowsHide: true,
    });
}

function runProbe(python: string): Promise<SpeechProbe | null> {
    return new Promise((resolve) => {
        const child = spawn(python, [SCRIPT, '--probe'], {
            stdio: ['ignore', 'pipe', 'ignore'], env: libraryEnv(process.env, nvidiaLibraryDirs(ROOT)), windowsHide: true,
        });
        let out = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString();
        });
        child.on('error', () => resolve(null));
        child.on('close', () => {
            try {
                resolve(JSON.parse(out) as SpeechProbe);
            } catch {
                resolve(null);
            }
        });
    });
}

/** Local speech recognition (Whisper or Moonshine), kept warm as an HTTP service so the model loads only once. */
export class Ears implements Transcriber {
    readonly available: boolean;
    readonly install: SpeechInstall;
    private wanted: SpeechRuntime;
    private service: LocalService | null = null;
    private probed: Promise<SpeechProbe | null> | null = null;
    private readonly base: string;

    constructor(settings: SpeechSettings = DEFAULT_SPEECH, private readonly options: EarsOptions = {}) {
        const port = options.port ?? Number(process.env.STT_PORT ?? 4722);
        const python = options.python ?? VENV_PYTHON;
        this.base = `http://127.0.0.1:${port}`;
        this.install = options.install ?? findInstall(python);
        this.wanted = usableRuntime(settings, this.install.engines);
        if (!existsSync(SCRIPT) || !SPEECH_ENGINES.some((e) => this.install.engines[e])) {
            console.warn('[ears] no speech recogniser is installed; run "npm run setup:stt" to enable speech input.');
            this.available = false;
            return;
        }
        if (this.wanted.engine !== settings.engine) {
            console.warn(`[ears] ${settings.engine} is not installed; using ${this.wanted.engine}.`);
        }
        this.available = true;
        const start = options.spawn ?? ((runtime, at) => startServer(runtime, at, python));
        this.probed = (options.probe ?? (() => runProbe(python)))();
        this.service = new LocalService({
            name: 'ears',
            up: () => this.up(),
            spawn: () => start(this.wanted, port),
            attempts: options.attempts ?? 240,
            failed: 'Speech recognition did not start; speech input is disabled.',
        });
    }

    /** Follows changed speech settings; the speech server restarts only when its engine, model or device changes. */
    configure(settings: SpeechSettings): boolean {
        const next = usableRuntime(settings, this.install.engines);
        if (!this.service || sameRuntime(next, this.wanted)) {
            return false;
        }
        this.wanted = next;
        console.log(`[ears] restarting speech recognition: ${next.engine} ${next.model}, device ${next.device}`);
        this.service.restart();
        return true;
    }

    /**
     * The trimmed transcript of the audio, or null when recognition is unavailable. Throws SpeechError when the speech
     * server refused the audio (one it cannot decode, for example), with its reason.
     */
    async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<string | null> {
        const answer = await this.service?.call(async (): Promise<{ text: string | null } | { error: string; status: number }> => {
            const res = await fetch(`${this.base}/transcribe`, {
                method: 'POST',
                headers: {
                    'content-type': options.pcm ? 'audio/s16le; rate=16000' : 'application/octet-stream',
                    ...(options.prompt ? { 'x-prompt': encodeURIComponent(options.prompt.slice(-600)) } : {}),
                },
                body: new Uint8Array(audio),
            });
            const body = await res.json().catch(() => ({})) as { text?: unknown; error?: unknown };
            if (!res.ok) {
                return { error: typeof body.error === 'string' ? body.error : `The speech server answered ${res.status}.`, status: res.status };
            }
            return { text: typeof body.text === 'string' ? body.text.trim() : null };
        });
        if (answer && 'error' in answer) {
            throw new SpeechError(answer.error, answer.status);
        }
        return answer?.text ?? null;
    }

    async status(): Promise<SpeechStatus> {
        return {
            available: this.available,
            platform: process.platform,
            installed: this.install.engines,
            gpuLibraries: nvidiaLibraryDirs(ROOT).length > 0,
            probe: await (this.probed ?? Promise.resolve(null)),
            wanted: this.wanted,
            running: this.available ? await this.health() : null,
        };
    }

    close(): void {
        this.service?.close();
    }

    private async health(): Promise<SpeechHealth | null> {
        try {
            const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(2000) });
            return res.ok ? await res.json() as SpeechHealth : null;
        } catch {
            return null;
        }
    }

    /**
     * Up when a server answering on the port runs what the settings ask for. One running something else (other settings,
     * or an older version of the script) is asked to stop, so a new one can take the port.
     */
    private async up(): Promise<boolean> {
        const health = await this.health();
        if (!health) {
            return false;
        }
        const same = health.protocol === PROTOCOL && sameRuntime({ engine: health.engine, model: health.model, device: health.requested }, this.wanted);
        if (same) {
            return true;
        }
        try {
            await fetch(`${this.base}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
        } catch {
            // An older server has no /shutdown; it goes when the process that started it goes.
        }
        for (let i = 0; i < 20 && await this.health(); i++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return false;
    }
}

/** The speech server refused the audio; the message says why (for example a clip it cannot decode). */
export class SpeechError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}
