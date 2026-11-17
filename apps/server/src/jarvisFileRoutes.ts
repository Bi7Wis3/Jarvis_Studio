// HTTP side and assistant tools of the studio's own file (jarvisFile.ts): POST /api/jarvis/save-as, /api/jarvis/save
// and /api/jarvis/open, GET /api/jarvis/info for the Open form; the tools project_save_as and project_save
// (project_open with a path is in tools.ts, beside opening by name). The folder of a file saved or opened becomes the
// first of the file browser's recent folders.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FileAccessError } from './files.js';
import { rememberImportFolder } from './fileRoutes.js';
import {
    fileInfo, FileExistsError, NoFileError, openProjectFile, saveLinkedFile, saveProjectFile, type FileOptions, type SaveAnswer,
} from './jarvisFile.js';
import { isPng, JarvisFileError } from './jarvisFormat.js';
import type { SettingsStore } from './settings.js';
import type { ProjectStore } from './store.js';
import { checkHistory, type HostTool } from './tools.js';

/** The largest thumbnail sent with a save, as base64. */
const MAX_THUMBNAIL_TEXT = 12 * 1024 * 1024;

const thumbnailText = z.string().max(MAX_THUMBNAIL_TEXT).optional();

const saveAsBody = z.object({
    path: z.string().min(1).max(4096),
    mode: z.enum(['copy', 'copyAndOpen']).optional(),
    overwrite: z.boolean().optional(),
    description: z.string().max(10_000).optional(),
    /** A PNG of the view, base64. */
    thumbnail: thumbnailText,
});

/** The PNG in a base64 text; anything else is left out (a save never fails for its picture). */
function pngOf(text: string | undefined): Uint8Array | null {
    if (!text) {
        return null;
    }
    const bytes = new Uint8Array(Buffer.from(text.replace(/^data:image\/png;base64,/, ''), 'base64'));
    return isPng(bytes) ? bytes : null;
}

function refuse(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof FileExistsError) {
        return reply.code(409).send({ error: error.message, exists: true, path: error.path });
    }
    if (error instanceof NoFileError) {
        return reply.code(409).send({ error: error.message, noFile: true });
    }
    if (error instanceof FileAccessError) {
        return reply.code(error.status).send({ error: error.message });
    }
    if (error instanceof JarvisFileError) {
        return reply.code(422).send({ error: error.message });
    }
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
}

export interface JarvisRouteOptions {
    /** The home folder (tests). */
    home?: string;
    /** Called before another project is opened (stops the assistant's turn, as opening from the project list does). */
    stop?: () => void;
}

export function registerJarvisFileRoutes(app: FastifyInstance, store: ProjectStore, settings: SettingsStore, options: JarvisRouteOptions = {}): void {
    const files: FileOptions = { checkPart: checkHistory, ...(options.home ? { home: options.home } : {}) };
    // Remembering the folder is a nicety: the save or open has happened either way.
    const remember = (path: string) => rememberImportFolder(settings, path, options.home).catch(() => undefined);
    const saved = async (answer: SaveAnswer) => {
        await remember(answer.path);
        return {
            text: answer.text, path: answer.path, missing: answer.missing, thumbnail: answer.thumbnail,
            ...(answer.opened ? { opened: answer.opened.name } : {}),
        };
    };

    void app.register(async (scope) => {
        scope.post('/api/jarvis/save-as', { bodyLimit: MAX_THUMBNAIL_TEXT + 64 * 1024 }, async (request, reply) => {
            const body = saveAsBody.safeParse(request.body ?? {});
            if (!body.success) {
                return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
            }
            try {
                if (body.data.mode === 'copyAndOpen') {
                    options.stop?.();
                }
                return await saved(saveProjectFile(store, { ...body.data, thumbnail: pngOf(body.data.thumbnail) }, files));
            } catch (error) {
                return refuse(reply, error);
            }
        });

        scope.post('/api/jarvis/save', { bodyLimit: MAX_THUMBNAIL_TEXT + 64 * 1024 }, async (request, reply) => {
            const body = z.object({ thumbnail: thumbnailText }).safeParse(request.body ?? {});
            try {
                return await saved(saveLinkedFile(store, { thumbnail: body.success ? pngOf(body.data.thumbnail) : null }, files));
            } catch (error) {
                return refuse(reply, error);
            }
        });

        scope.post('/api/jarvis/open', async (request, reply) => {
            const body = z.object({ path: z.string().min(1).max(4096) }).safeParse(request.body ?? {});
            if (!body.success) {
                return reply.code(400).send({ error: 'Expected { path }.' });
            }
            try {
                options.stop?.();
                const answer = openProjectFile(store, body.data.path, files);
                await remember(answer.path);
                return answer;
            } catch (error) {
                return refuse(reply, error);
            }
        });

        scope.get('/api/jarvis/info', async (request, reply) => {
            const path = (request.query as { path?: unknown }).path;
            try {
                return fileInfo(typeof path === 'string' ? path : '', files);
            } catch (error) {
                return refuse(reply, error);
            }
        });
    });
}

export interface JarvisToolHost {
    /** A PNG of the view from the open browser, or null; never throws. */
    thumbnail?: () => Promise<Uint8Array | null>;
    home?: string;
}

/** project_save_as and project_save: the assistant's File > Save As and File > Save. */
export function jarvisFileTools(store: ProjectStore, host: JarvisToolHost = {}): HostTool[] {
    const files: FileOptions = { checkPart: checkHistory, ...(host.home ? { home: host.home } : {}) };
    const thumbnail = async () => (await host.thumbnail?.().catch(() => null)) ?? null;
    return [
        {
            name: 'project_save_as',
            description: 'Saves the open project to a .jarvis file on this computer (home folder only; ".jarvis" is added to '
                + 'a name without it): the project and every file it uses (imported files, pictures) in one file that File > '
                + 'Open or project_open with a path opens again, on this or another machine. mode "copy" (default, Save as '
                + 'copy and continue): the open project stays open and remembers the file, so project_save writes it again; '
                + '"copyAndOpen" (Save as copy and open): the file is then opened as a new project and the one that was open '
                + 'stays as it was. A file that is there is only replaced with overwrite: true: ask the user first.',
            schema: {
                path: z.string().describe('Absolute path of the file (~ for the home folder), e.g. ~/Documents/robot arm.jarvis'),
                mode: z.enum(['copy', 'copyAndOpen']).optional(),
                overwrite: z.boolean().optional().describe('Replace a file that is there (only when the user said so)'),
                description: z.string().optional().describe('Description kept with the project and shown when the file is opened'),
            },
            run: async (args: { path: string; mode?: 'copy' | 'copyAndOpen'; overwrite?: boolean; description?: string }) => {
                try {
                    return { text: saveProjectFile(store, { ...args, thumbnail: await thumbnail() }, files).text };
                } catch (error) {
                    if (error instanceof FileExistsError) {
                        throw new Error(`${error.message} Ask the user whether to replace it, then call again with overwrite: true.`);
                    }
                    throw error;
                }
            },
        },
        {
            name: 'project_save',
            description: 'Saves the open project to the .jarvis file it was last saved to or opened from (File > Save). '
                + 'Fails when it has none: then use project_save_as.',
            schema: {},
            run: async () => ({ text: saveLinkedFile(store, { thumbnail: await thumbnail() }, files).text }),
        },
    ];
}
