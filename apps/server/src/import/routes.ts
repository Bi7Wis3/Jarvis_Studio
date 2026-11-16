// HTTP side of File > Import: the formats the form offers, and the upload. The file comes as the raw request body;
// its name and the options come in the x-import header (URI-encoded JSON). A file picked in the form's own file browser
// comes as its path instead (no body): the server reads it from the disk, home folder only.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CadKernel } from '../cad/kernel.js';
import { FileAccessError } from '../files.js';
import type { ProjectStore } from '../store.js';
import { importFromPath, MAX_IMPORT_BYTES } from './fromPath.js';
import { importIntoProject } from './project.js';
import { importFormats } from './registry.js';
import { importOptionsSchema } from './schema.js';

export { MAX_IMPORT_BYTES };

const header = z.object({
    name: z.string().min(1).max(255),
    /** A file on this machine to read instead of a body. */
    path: z.string().min(1).max(4096).optional(),
    options: importOptionsSchema.optional(),
    target: z.string().optional(),
    replace: z.string().optional(),
});

export interface ImportHooks {
    /** A file was imported by its path (resolved). */
    importedPath?: (path: string) => void | Promise<void>;
    /** The home folder (for tests). */
    home?: string;
}

export function registerImportRoutes(app: FastifyInstance, store: ProjectStore, kernel: CadKernel, hooks: ImportHooks = {}): void {
    void app.register(async (scope) => {
        scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_request, body, done) => {
            done(null, body);
        });

        scope.get('/api/import/formats', async () => ({ formats: importFormats() }));

        scope.post('/api/import', { bodyLimit: MAX_IMPORT_BYTES }, async (request, reply) => {
            let meta: z.infer<typeof header>;
            try {
                meta = header.parse(JSON.parse(decodeURIComponent(String(request.headers['x-import'] ?? ''))));
            } catch (error) {
                return reply.code(400).send({ error: `Expected the file name and options in x-import (${error instanceof Error ? error.message : error}).` });
            }
            const bytes = Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array(0);
            if (meta.path) {
                let report: Awaited<ReturnType<typeof importFromPath>>;
                try {
                    report = await importFromPath(store, kernel, meta.path, { options: meta.options, target: meta.target, replace: meta.replace }, hooks.home);
                } catch (error) {
                    return reply.code(error instanceof FileAccessError ? error.status : 422)
                        .send({ error: error instanceof Error ? error.message : String(error) });
                }
                // Remembering the folder is a nicety: the import has happened either way.
                await Promise.resolve(hooks.importedPath?.(report.path)).catch(() => undefined);
                const { result: _result, path: _path, ...rest } = report;
                return rest;
            }
            // Without a file, a replaced step reads its own original again.
            if (bytes.length === 0 && !meta.replace) {
                return reply.code(400).send({ error: 'Expected the file as the request body.' });
            }
            try {
                const report = await importIntoProject(store, kernel, {
                    filename: meta.name, bytes, options: meta.options, target: meta.target, replace: meta.replace,
                });
                const { result: _result, ...rest } = report;
                return rest;
            } catch (error) {
                return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
            }
        });
    });
}
