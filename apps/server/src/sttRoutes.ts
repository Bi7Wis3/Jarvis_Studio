// Speech input routes. POST /api/stt: a whole clip, raw PCM (audio/s16le, 16 kHz mono) or recorded in a container
// (webm/opus, from browsers without AudioWorklet). POST /api/stt/phrase?session=&seq=[&final=1]: one phrase of a clip
// recognised while Talk is held (see sttSessions.ts). GET /api/stt/status: what the Options page shows about it.

import type { FastifyInstance } from 'fastify';
import { MAX_PHRASES, SpeechSessions, validSessionId } from './sttSessions.js';
import { SpeechError, type SpeechStatus, type Transcriber } from './stt.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Raw PCM as the browser records it: 16-bit little-endian, mono, 16 kHz. */
export const isPcm = (contentType: string | undefined): boolean => /^audio\/s16le\b/i.test(contentType ?? '');

export interface SttRouteEars extends Transcriber {
    readonly available: boolean;
    status(): Promise<SpeechStatus>;
}

const audioBody = (body: unknown): Buffer => (Buffer.isBuffer(body) ? body : Buffer.alloc(0));

export function registerSttRoutes(app: FastifyInstance, ears: SttRouteEars, sessions = new SpeechSessions(ears)): void {
    app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) => {
        done(null, body);
    });

    app.post('/api/stt', async (request, reply) => {
        const audio = audioBody(request.body);
        if (audio.length === 0) {
            return reply.code(400).send({ error: 'Expected an audio body.' });
        }
        try {
            const text = await ears.transcribe(audio, { pcm: isPcm(request.headers['content-type']) });
            if (text === null) {
                return reply.code(503).send({ error: 'Speech recognition is unavailable.' });
            }
            return { text };
        } catch (error) {
            if (error instanceof SpeechError) {
                return reply.code(error.status >= 400 && error.status < 500 ? error.status : 502).send({ error: error.message });
            }
            throw error;
        }
    });

    app.post<{ Querystring: { session?: string; seq?: string; final?: string } }>('/api/stt/phrase', async (request, reply) => {
        const { session, seq, final } = request.query;
        const n = Number(seq);
        if (!validSessionId(session) || !Number.isInteger(n) || n < 0 || n >= MAX_PHRASES) {
            return reply.code(400).send({ error: 'Expected ?session=<id>&seq=<phrase number>.' });
        }
        const audio = audioBody(request.body);
        if (audio.length > 0 && !isPcm(request.headers['content-type'])) {
            return reply.code(415).send({ error: 'Phrases are raw 16 kHz PCM (audio/s16le).' });
        }
        const answer = await sessions.phrase(session, n, audio, final === '1' || final === 'true');
        if (!answer) {
            return reply.code(503).send({ error: 'Speech recognition is unavailable.' });
        }
        return answer;
    });

    app.get('/api/stt/status', async () => ears.status());
}
