// HTTP side of the app's own file browser (files.ts): GET /api/files/list, GET /api/files/preview, and the browser's
// places (GET and PUT /api/files/places), whose pinned and recent folders are kept in the studio's settings.

import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MAX_FAVOURITE_FOLDERS, MAX_RECENT_FOLDERS, type FileSettings } from '@jarvis/core/settings';
import {
    existingFolders, FileAccessError, homeFolder, listFolder, PreviewCache, resolveInHome, standardPlaces, type Place,
} from './files.js';
import type { SettingsStore } from './settings.js';

export interface PlacesAnswer {
    home: string;
    standard: Place[];
    /** Pinned folders, in the order they were pinned. */
    favourites: string[];
    /** Folders files were last imported from, newest first. */
    recent: string[];
    /** The folder the browser was last in (resolved), or home. */
    last: string;
}

const flag = (v: unknown): boolean => v === '1' || v === 'true';

function refuse(reply: { code(n: number): { send(body: unknown): unknown } }, error: unknown): unknown {
    if (error instanceof FileAccessError) {
        return reply.code(error.status).send({ error: error.message });
    }
    throw error;
}

/** Records the folder of a file just imported: first among the recent folders, and where the browser opens next. */
export async function rememberImportFolder(settings: SettingsStore, filePath: string, home?: string): Promise<void> {
    const root = home ?? await homeFolder();
    const folder = await resolveInHome(filePath, root, 'file').then((f) => dirname(f.path), () => null);
    if (!folder) {
        return;
    }
    const files = settings.get().files;
    settings.update({
        files: { ...files, lastFolder: folder, recentFolders: [folder, ...files.recentFolders.filter((f) => f !== folder)].slice(0, MAX_RECENT_FOLDERS) },
    });
}

async function places(settings: SettingsStore, home: string): Promise<PlacesAnswer> {
    const files = settings.get().files;
    const [standard, favourites, recent, last] = await Promise.all([
        standardPlaces(home),
        existingFolders(files.favourites, home),
        existingFolders(files.recentFolders, home),
        existingFolders(files.lastFolder ? [files.lastFolder] : [], home),
    ]);
    return { home, standard, favourites, recent, last: last[0] ?? home };
}

export function registerFileRoutes(app: FastifyInstance, settings: SettingsStore, home: () => Promise<string> = homeFolder): void {
    const previews = new PreviewCache();

    app.get('/api/files/list', async (request, reply) => {
        const query = request.query as { path?: unknown; hidden?: unknown; all?: unknown; last?: unknown };
        const options = { hidden: flag(query.hidden), all: flag(query.all) };
        const root = await home();
        const path = typeof query.path === 'string' ? query.path : '';
        try {
            // last=1 without a path: the folder the browser was last in, or home when that is gone.
            if (!path && flag(query.last) && settings.get().files.lastFolder) {
                const last = await listFolder(settings.get().files.lastFolder, root, options).catch(() => null);
                if (last) {
                    return last;
                }
            }
            return await listFolder(path, root, options);
        } catch (error) {
            return refuse(reply, error);
        }
    });

    app.get('/api/files/preview', async (request, reply) => {
        const query = request.query as { path?: unknown };
        try {
            const png = await previews.get(typeof query.path === 'string' ? query.path : '', await home());
            if (!png) {
                return reply.code(404).send({ error: 'This file carries no preview picture.' });
            }
            // The web asks with the file's modified time in the address, so a changed file is a new address.
            return reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=86400').send(Buffer.from(png));
        } catch (error) {
            return refuse(reply, error);
        }
    });

    app.get('/api/files/places', async () => places(settings, await home()));

    // { favourites?: string[], last?: string, forget?: string }: pinned folders (the whole list), the folder the
    // browser is in, a recent folder to remove. Folders outside home or no longer there are dropped.
    app.put('/api/files/places', async (request, reply) => {
        const body = (request.body ?? {}) as { favourites?: unknown; last?: unknown; forget?: unknown };
        const root = await home();
        const files: FileSettings = { ...settings.get().files };
        if (body.favourites !== undefined) {
            if (!Array.isArray(body.favourites) || !body.favourites.every((f) => typeof f === 'string')) {
                return reply.code(400).send({ error: 'favourites must be a list of folder paths.' });
            }
            files.favourites = (await existingFolders(body.favourites as string[], root)).slice(0, MAX_FAVOURITE_FOLDERS);
        }
        if (typeof body.last === 'string') {
            files.lastFolder = (await existingFolders([body.last], root))[0] ?? files.lastFolder;
        }
        if (typeof body.forget === 'string') {
            files.recentFolders = files.recentFolders.filter((f) => f !== body.forget);
        }
        settings.update({ files });
        return places(settings, root);
    });
}
