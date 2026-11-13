import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityEntry, ClientMessage, ServerMessage } from '@jarvis/core';
import { Jarvis } from './agent.js';
import { z } from 'zod';
import { MAX_ASSET_BYTES, readAsset, saveAsset } from './assets.js';
import { CadKernel } from './cad/kernel.js';
import { createHostTools } from './hostTools.js';
import { MeshService } from './meshes.js';
import { registerMcpHttp } from './mcpHttp.js';
import { EXPORTS_DIR } from './paths.js';
import { PreviewRejected, runPreview } from './preview.js';
import { ProjectStore, slug } from './store.js';
import { Ears } from './stt.js';
import { callTool, createTools } from './tools.js';
import { Voice } from './tts.js';

const PORT = Number(process.env.PORT ?? 4720);
const MAX_CACHED_CLIPS = 100;
const CAPTURE_TIMEOUT_MS = 20000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

type Socket = { send: (data: string) => void };

const store = new ProjectStore();
// Real geometry: OpenCascade in a worker thread builds every part; browsers fetch the meshes by key.
const kernel = CadKernel.start();
const meshes = new MeshService(kernel, (status) => broadcast({ type: 'meshes', ...status }));
const voice = new Voice();
const ears = new Ears();
const clips = new Map<string, Buffer>();
const MAX_IMAGES = 4;
const MAX_ACTIVITY = 20;
let activity: ActivityEntry[] = [];

function logActivity(turn: number, state: ActivityEntry['state'], entry?: Omit<ActivityEntry, 'turn' | 'state'>): void {
    const existing = activity.find((a) => a.turn === turn);
    if (existing) {
        existing.state = state;
    } else if (entry) {
        activity = [...activity, { turn, state, ...entry }].slice(-MAX_ACTIVITY);
    }
    broadcast({ type: 'activity', entries: activity });
}
const sockets = new Set<Socket>();
// Only one browser plays Jarvis's voice: the one used most recently. The rest get the subtitles only,
// otherwise every open tab speaks at once and the voice echoes.
let speaker: Socket | null = null;
const captures = new Map<string, (image: string | null) => void>();
let model = process.env.JARVIS_MODEL ?? 'sonnet';
let speech: Promise<void> = Promise.resolve();

function broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of sockets) {
        socket.send(data);
    }
}

/** Asks every connected browser for a picture of its viewport and takes the first one that has it. */
function capture(): Promise<Buffer> {
    if (sockets.size === 0) {
        return Promise.reject(new Error('No browser is showing the studio, so there is nothing to look at.'));
    }
    return new Promise((resolve, reject) => {
        const id = randomUUID();
        let waiting = sockets.size;
        const finish = (error?: Error) => {
            clearTimeout(timer);
            captures.delete(id);
            if (error) {
                reject(error);
            }
        };
        const timer = setTimeout(() => finish(new Error('The browser did not return a screenshot in time.')),
            CAPTURE_TIMEOUT_MS);
        captures.set(id, (image) => {
            if (image) {
                finish();
                resolve(Buffer.from(image, 'base64'));
            } else if (--waiting === 0) {
                finish(new Error('The browser could not capture the viewport (no WebGL canvas).'));
            }
        });
        broadcast({ type: 'capture', id });
    });
}

const tools = [
    ...createTools(store),
    ...createHostTools(store, {
        capture,
        download: (filename) => broadcast({ type: 'download', url: `/api/exports/${filename}`, filename }),
        meshes,
        kernel,
    }),
];

const info = (): ServerMessage => ({
    type: 'info',
    model,
    voice: voice.name,
    ears: ears.available,
    quality: jarvis.getQuality(),
});

const jarvis = new Jarvis(store, tools, {
    status: (status, detail) => {
        broadcast({ type: 'status', status, detail });
        // A turn that never reported back (session restarted or crashed) is not still running.
        if (status === 'idle' && activity.some((a) => a.state === 'running')) {
            activity = activity.map((a) => (a.state === 'running' ? { ...a, state: 'stopped' } : a));
            broadcast({ type: 'activity', entries: activity });
        }
    },
    interrupted: (turn) => {
        broadcast({ type: 'stop', turn });
        logActivity(turn, 'stopped');
    },
    finished: (turn, ok) => logActivity(turn, ok ? 'done' : 'failed'),
    error: (message) => broadcast({ type: 'error', message }),
    model: (name) => {
        model = name;
        broadcast(info());
    },
    // Sentences are synthesised one at a time so they reach the browser in spoken order.
    sentence: (turn, text) => {
        speech = speech.then(async () => {
            if (jarvis.isCancelled(turn)) {
                return;
            }
            const wav = await voice.synthesize(text);
            if (jarvis.isCancelled(turn)) {
                return;
            }
            let audio: string | null = null;
            if (wav) {
                const id = randomUUID();
                clips.set(id, wav);
                if (clips.size > MAX_CACHED_CLIPS) {
                    clips.delete(clips.keys().next().value!);
                }
                audio = `/api/audio/${id}`;
            }
            for (const socket of sockets) {
                const muted = socket !== speaker;
                socket.send(JSON.stringify({ type: 'say', turn, text, audio: muted ? null : audio, muted }));
            }
        });
    },
});

const catalog = (): ServerMessage => ({
    type: 'projects',
    projects: store.catalog(),
    current: slug(store.get().name),
});
let lastCatalog = JSON.stringify(catalog());

function broadcastCatalog(): void {
    const next = catalog();
    if (JSON.stringify(next) !== lastCatalog) {
        lastCatalog = JSON.stringify(next);
        broadcast(next);
    }
}

meshes.update(store.get());

store.subscribe((project) => {
    broadcast({ type: 'state', project });
    meshes.update(project);
    broadcastCatalog();
});

const app = Fastify();
await app.register(websocket);

app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'state', project: store.get() } satisfies ServerMessage));
    socket.send(JSON.stringify(info()));
    socket.send(JSON.stringify(catalog()));
    socket.send(JSON.stringify({ type: 'activity', entries: activity } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: 'meshes', ...meshes.current() } satisfies ServerMessage));
    socket.on('message', (raw: Buffer) => {
        let message: ClientMessage;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (message.type !== 'capture' && !(message.type === 'active' && message.soft && speaker)) {
            speaker = socket;
        }
        if (message.type === 'active') {
            return;
        }
        if (message.type === 'prompt' && typeof message.text === 'string') {
            const images = (Array.isArray(message.images) ? message.images : [])
                .filter((i) => typeof i?.data === 'string' && ['image/jpeg', 'image/png', 'image/webp'].includes(i.mimeType))
                .slice(0, MAX_IMAGES);
            const text = message.text.trim() || (images.length ? 'Build this.' : '');
            if (text) {
                // Keep attached pictures as assets, so Jarvis can put them on parts as decals.
                const ids = images.map((i) => saveAsset(Buffer.from(i.data, 'base64'), i.mimeType));
                const note = ids.length ? `\n(Attached pictures are stored as assets: ${ids.join(', ')}.)` : '';
                const turn = jarvis.prompt(text + note, images);
                logActivity(turn, 'running', { text, images: images.length, at: Date.now() });
            }
        } else if (message.type === 'quality' && (message.quality === 'fast' || message.quality === 'best')) {
            jarvis.setQuality(message.quality);
            broadcast(info());
        } else if (message.type === 'tool' && typeof message.id === 'string' && typeof message.name === 'string') {
            const found = tools.find((t) => t.name === message.name);
            const reply = (text: string, isError: boolean) =>
                socket.send(JSON.stringify({ type: 'toolResult', id: message.id, text, isError } satisfies ServerMessage));
            if (!found) {
                reply(`No tool named "${message.name}".`, true);
            } else {
                // Validate like an MCP call would, then run through the shared error handling.
                const parsed = z.object(found.schema).safeParse(message.args ?? {});
                if (!parsed.success) {
                    reply(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), true);
                } else {
                    void callTool(found, parsed.data).then((result) => reply(
                        result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
                        result.isError === true,
                    ));
                }
            }
        } else if (message.type === 'stop') {
            jarvis.stop();
        } else if (message.type === 'open' && typeof message.slug === 'string') {
            jarvis.stop();
            store.open(message.slug);
        } else if (message.type === 'create' && typeof message.name === 'string') {
            jarvis.stop();
            store.create(message.name.slice(0, 80));
        } else if (message.type === 'delete' && typeof message.slug === 'string') {
            jarvis.stop();
            store.remove(message.slug);
            broadcastCatalog();
        } else if (message.type === 'suppress') {
            store.mutate((draft) => {
                const feature = draft.parts.find((p) => p.id === message.partId)?.features
                    ?.find((f) => f.id === message.featureId);
                if (feature) {
                    feature.suppressed = message.suppressed === true;
                }
            });
        } else if (message.type === 'rename' && typeof message.name === 'string') {
            if (!store.rename(message.name.slice(0, 80))) {
                socket.send(JSON.stringify({ type: 'error', message: `A project named "${message.name}" already exists.` } satisfies ServerMessage));
            }
            broadcastCatalog();
        } else if (message.type === 'saveAs' && typeof message.name === 'string') {
            store.saveAs(message.name.slice(0, 80));
        } else if (message.type === 'rollback' && typeof message.partId === 'string') {
            const count = typeof message.count === 'number' ? Math.max(0, Math.floor(message.count)) : null;
            store.mutate((draft) => {
                draft.view.rollback = count === null ? null : { partId: message.partId, count };
            }, { undoable: false });
        } else if (message.type === 'hideSketch' && typeof message.partId === 'string' && typeof message.featureId === 'string') {
            const key = `${message.partId}/${message.featureId}`;
            store.mutate((draft) => {
                const hidden = new Set(draft.view.hiddenSketches ?? []);
                if (message.hidden) {
                    hidden.add(key);
                } else {
                    hidden.delete(key);
                }
                draft.view.hiddenSketches = [...hidden];
            }, { undoable: false });
        } else if (message.type === 'hide' && typeof message.partId === 'string') {
            store.mutate((draft) => {
                const hidden = new Set(draft.view.hidden ?? []);
                if (message.hidden) {
                    hidden.add(message.partId);
                } else {
                    hidden.delete(message.partId);
                }
                draft.view.hidden = [...hidden];
            }, { undoable: false });
        } else if (message.type === 'focus') {
            const id = store.get().parts.some((p) => p.id === message.id) ? message.id : null;
            store.mutate((draft) => {
                draft.view.focus = id;
            }, { undoable: false });
        } else if (message.type === 'action') {
            if (message.action === 'undo') {
                store.undo();
            } else {
                store.mutate((draft) => {
                    if (message.action === 'spin') {
                        draft.view.autoRotate = !draft.view.autoRotate;
                    } else {
                        draft.view.explode = message.action === 'explode' ? 1 : 0;
                        draft.view.labels = message.action === 'explode';
                    }
                }, { undoable: false });
            }
        } else if (message.type === 'capture') {
            captures.get(message.id)?.(typeof message.image === 'string' ? message.image : null);
        }
    });
    socket.on('close', () => {
        sockets.delete(socket);
        if (speaker === socket) {
            speaker = null;
        }
    });
});

app.get<{ Params: { id: string } }>('/api/audio/:id', async (request, reply) => {
    const wav = clips.get(request.params.id);
    if (!wav) {
        return reply.code(404).send();
    }
    return reply.type('audio/wav').send(wav);
});

app.get<{ Params: { file: string } }>('/api/exports/:file', async (request, reply) => {
    const { file } = request.params;
    const path = join(EXPORTS_DIR, file);
    const match = /^[a-z0-9-]+\.(stl|step)$/.exec(file);
    if (!match || !existsSync(path)) {
        return reply.code(404).send();
    }
    return reply
        .type(match[1] === 'stl' ? 'model/stl' : 'model/step')
        .header('content-disposition', `attachment; filename="${file}"`)
        .send(readFileSync(path));
});

// mesh2: the format with per-triangle face and per-segment edge ordinals (old /api/mesh responses are cached immutable).
app.get<{ Params: { key: string } }>('/api/mesh2/:key', async (request, reply) => {
    const mesh = /^[a-f0-9]{24}$/.test(request.params.key) ? meshes.get(request.params.key) : null;
    if (!mesh) {
        return reply.code(404).send();
    }
    // A key is a hash of the geometry, so its mesh never changes.
    return reply.type('application/octet-stream').header('cache-control', 'public, max-age=31536000, immutable').send(mesh);
});

/** Tool preview: runs model-editing tool calls on a copy of the project and builds the parts they change. */
app.post('/api/preview', async (request, reply) => {
    try {
        return await runPreview(store.get(), (request.body as { calls?: unknown } | null)?.calls, meshes);
    } catch (error) {
        if (error instanceof PreviewRejected) {
            return reply.code(400).send({ error: error.message });
        }
        throw error;
    }
});

app.addContentTypeParser(/^image\/(png|jpeg|webp)$/, { parseAs: 'buffer', bodyLimit: MAX_ASSET_BYTES }, (_request, body, done) => {
    done(null, body);
});

/** Uploads an image (decals, reference pictures); returns its asset id. */
app.post('/api/assets', async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.code(400).send({ error: 'Expected a PNG, JPEG or WebP body.' });
    }
    return { id: saveAsset(request.body, String(request.headers['content-type']).split(';')[0]) };
});

app.get<{ Params: { id: string } }>('/api/assets/:id', async (request, reply) => {
    const asset = readAsset(request.params.id);
    if (!asset) {
        return reply.code(404).send();
    }
    // The id is a hash of the content, so it never changes.
    return reply.type(asset.type).header('cache-control', 'public, max-age=31536000, immutable').send(asset.data);
});

app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) => {
    done(null, body);
});

app.post('/api/stt', async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.code(400).send({ error: 'Expected an audio body.' });
    }
    const text = await ears.transcribe(request.body);
    if (text === null) {
        return reply.code(503).send({ error: 'Speech recognition is unavailable.' });
    }
    return { text };
});

app.get('/api/health', async () => ({
    ok: true,
    project: store.get().name,
    voice: voice.name,
    ears: ears.available,
    browsers: sockets.size,
}));

registerMcpHttp(app, tools);

const shutdown = () => {
    voice.close();
    ears.close();
    void kernel.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`[server] Jarvis Studio listening on http://127.0.0.1:${PORT} (voice: ${voice.name ?? 'browser'})`);
