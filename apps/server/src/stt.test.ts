import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH, type SpeechRuntime } from '@jarvis/core/settings';
import { Ears, SpeechError, usableRuntime } from './stt.js';

/** Stands in for scripts/stt_server.py: the same HTTP protocol, recording what it was sent. */
function fakeSpeechServer(runtime: SpeechRuntime | null) {
    const state = {
        runtime,
        requests: [] as { path: string; type?: string; prompt?: string; body: Buffer }[],
        shutdowns: 0,
        answer: { status: 200, body: { text: ' make a box ' } as Record<string, unknown> },
    };
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const send = (status: number, body: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (req.url === '/health') {
                return state.runtime
                    ? send(200, { ok: true, protocol: 2, ...state.runtime, requested: state.runtime.device, device: 'cpu', gpuError: '' })
                    : send(503, {});
            }
            if (req.url === '/shutdown') {
                state.shutdowns++;
                state.runtime = null;
                return send(200, { ok: true });
            }
            state.requests.push({
                path: req.url ?? '', type: req.headers['content-type'], prompt: req.headers['x-prompt'] as string | undefined, body: Buffer.concat(chunks),
            });
            send(state.answer.status, state.answer.body);
        });
    });
    return { state, server };
}

class FakeProcess extends EventEmitter {
    kill(): boolean {
        this.emit('exit', 0);
        return true;
    }
}

const servers: Server[] = [];
const ears: Ears[] = [];

async function setup(running: SpeechRuntime | null, settings = DEFAULT_SPEECH) {
    const { state, server } = fakeSpeechServer(running);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const started: SpeechRuntime[] = [];
    const e = new Ears(settings, {
        port: (server.address() as AddressInfo).port,
        install: { python: true, engines: { whisper: true, moonshine: true } },
        probe: async () => null,
        attempts: 10,
        spawn: (runtime) => {
            started.push(runtime);
            state.runtime = runtime;
            return new FakeProcess() as unknown as ChildProcess;
        },
    });
    ears.push(e);
    return { state, ears: e, started };
}

afterEach(async () => {
    ears.splice(0).forEach((e) => e.close());
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    vi.restoreAllMocks();
});

const moonshine: SpeechRuntime = { engine: 'moonshine', model: 'base', device: 'auto' };

describe('Ears', () => {
    it('uses a speech server already running what the settings ask for, and sends raw PCM with the words before', async () => {
        const { state, ears: e, started } = await setup(moonshine);
        const pcm = Buffer.from([1, 0, 2, 0]);
        expect(await e.transcribe(pcm, { pcm: true, prompt: 'Make a box, then' })).toBe('make a box');
        expect(started).toEqual([]);
        expect(state.requests[0]).toEqual({ path: '/transcribe', type: 'audio/s16le; rate=16000', prompt: 'Make%20a%20box%2C%20then', body: pcm });
        // A compressed clip goes as it is, for the server to decode.
        await e.transcribe(Buffer.from('webm'));
        expect(state.requests[1].type).toBe('application/octet-stream');
        expect(state.requests[1].prompt).toBeUndefined();
    });

    it('asks a server running other settings (or an older version) to stop, and starts one with these', async () => {
        const { state, ears: e, started } = await setup({ engine: 'whisper', model: 'base.en', device: 'cpu' });
        expect(await e.transcribe(Buffer.from([0, 0]), { pcm: true })).toBe('make a box');
        expect(state.shutdowns).toBe(1);
        expect(started).toEqual([moonshine]);
    });

    it('restarts the speech server only when engine, model or device change', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { state, ears: e, started } = await setup(moonshine);
        expect(e.configure({ ...DEFAULT_SPEECH, whisperModel: 'small.en' })).toBe(false);
        expect(e.configure({ ...DEFAULT_SPEECH, moonshineModel: 'tiny' })).toBe(true);
        expect(await e.transcribe(Buffer.from([0, 0]), { pcm: true })).toBe('make a box');
        expect(state.shutdowns).toBeGreaterThanOrEqual(1);
        expect(started).toEqual([{ engine: 'moonshine', model: 'tiny', device: 'auto' }]);
        expect(e.configure({ ...DEFAULT_SPEECH, moonshineModel: 'tiny' })).toBe(false);
        expect(e.configure({ ...DEFAULT_SPEECH, moonshineModel: 'tiny', device: 'cpu' })).toBe(true);
    });

    it("passes on the server's reason when it refuses the audio", async () => {
        const { state, ears: e } = await setup(moonshine);
        state.answer = { status: 415, body: { error: 'decoding it needs ffmpeg, which is not installed' } };
        const refused = await e.transcribe(Buffer.from('webm')).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(SpeechError);
        expect((refused as SpeechError).message).toContain('ffmpeg');
        expect((refused as SpeechError).status).toBe(415);
    });

    it('reports its status', async () => {
        const { ears: e } = await setup(moonshine);
        const status = await e.status();
        expect(status.available).toBe(true);
        expect(status.wanted).toEqual(moonshine);
        expect(status.running).toMatchObject({ engine: 'moonshine', model: 'base', device: 'cpu' });
    });
});

describe('usableRuntime', () => {
    it('uses the chosen engine, or the installed one when the chosen one is missing', () => {
        expect(usableRuntime(DEFAULT_SPEECH, { whisper: true, moonshine: true })).toEqual(moonshine);
        expect(usableRuntime(DEFAULT_SPEECH, { whisper: true, moonshine: false })).toEqual({ engine: 'whisper', model: 'base.en', device: 'auto' });
        expect(usableRuntime(DEFAULT_SPEECH, { whisper: false, moonshine: false })).toEqual(moonshine);
    });
});
