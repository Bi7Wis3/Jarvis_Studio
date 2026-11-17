import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSttRoutes, type SttRouteEars } from './sttRoutes.js';
import { SpeechError, type SpeechStatus, type TranscribeOptions } from './stt.js';

class FakeEars implements SttRouteEars {
    readonly available = true;
    calls: { audio: Buffer; options: TranscribeOptions }[] = [];
    refuse: SpeechError | null = null;
    async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<string | null> {
        this.calls.push({ audio, options });
        if (this.refuse) {
            throw this.refuse;
        }
        return options.pcm ? `pcm ${audio.length / 2} samples` : `clip ${audio.length} bytes`;
    }
    async status(): Promise<SpeechStatus> {
        return { available: true } as SpeechStatus;
    }
}

const apps: ReturnType<typeof Fastify>[] = [];

function setup() {
    const ears = new FakeEars();
    const app = Fastify();
    registerSttRoutes(app, ears);
    apps.push(app);
    return { app, ears };
}

afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
});

const PCM = 'audio/s16le;rate=16000';

describe('speech routes', () => {
    it('takes raw PCM on /api/stt with no decoding step, and a compressed clip as before', async () => {
        const { app, ears } = setup();
        const pcm = await app.inject({ method: 'POST', url: '/api/stt', headers: { 'content-type': PCM }, payload: Buffer.alloc(3200) });
        expect(pcm.json()).toEqual({ text: 'pcm 1600 samples' });
        expect(ears.calls[0].options).toEqual({ pcm: true });
        const webm = await app.inject({ method: 'POST', url: '/api/stt', headers: { 'content-type': 'audio/webm;codecs=opus' }, payload: Buffer.alloc(100) });
        expect(webm.json()).toEqual({ text: 'clip 100 bytes' });
        expect(ears.calls[1].options).toEqual({ pcm: false });
    });

    it("refuses an empty body, and passes on the speech server's reason (no ffmpeg) in plain words", async () => {
        const { app, ears } = setup();
        expect((await app.inject({ method: 'POST', url: '/api/stt', headers: { 'content-type': PCM }, payload: Buffer.alloc(0) })).statusCode).toBe(400);
        ears.refuse = new SpeechError('decoding it needs ffmpeg, which is not installed', 415);
        const refused = await app.inject({ method: 'POST', url: '/api/stt', headers: { 'content-type': 'audio/webm' }, payload: Buffer.alloc(10) });
        expect(refused.statusCode).toBe(415);
        expect(refused.json().error).toContain('ffmpeg');
    });

    it('recognises phrases while talking and joins them on the last one, an empty one included', async () => {
        const { app } = setup();
        const phrase = (seq: number, bytes: number, final = false) => app.inject({
            method: 'POST',
            url: `/api/stt/phrase?session=abc-1&seq=${seq}${final ? '&final=1' : ''}`,
            headers: { 'content-type': PCM },
            payload: Buffer.alloc(bytes),
        });
        expect((await phrase(0, 640)).json()).toEqual({ text: 'pcm 320 samples', final: false });
        expect((await phrase(1, 320)).json()).toEqual({ text: 'pcm 320 samples pcm 160 samples', final: false });
        expect((await phrase(2, 0, true)).json()).toEqual({ text: 'pcm 320 samples pcm 160 samples', final: true });
        // An empty last phrase sent with no body and no content type at all.
        await phrase(0, 640);
        const bare = await app.inject({ method: 'POST', url: '/api/stt/phrase?session=abc-1&seq=1&final=1' });
        expect(bare.json()).toEqual({ text: 'pcm 320 samples', final: true });
    });

    it('refuses phrases without a session and number, or that are not raw PCM', async () => {
        const { app } = setup();
        const post = (url: string, type = PCM) => app.inject({ method: 'POST', url, headers: { 'content-type': type }, payload: Buffer.alloc(4) });
        expect((await post('/api/stt/phrase?seq=0')).statusCode).toBe(400);
        expect((await post('/api/stt/phrase?session=a/b&seq=0')).statusCode).toBe(400);
        expect((await post('/api/stt/phrase?session=a&seq=-1')).statusCode).toBe(400);
        expect((await post('/api/stt/phrase?session=a&seq=1.5')).statusCode).toBe(400);
        expect((await post('/api/stt/phrase?session=a&seq=0', 'audio/webm')).statusCode).toBe(415);
    });

    it('reports the status', async () => {
        const { app } = setup();
        expect((await app.inject({ method: 'GET', url: '/api/stt/status' })).json()).toEqual({ available: true });
    });
});
