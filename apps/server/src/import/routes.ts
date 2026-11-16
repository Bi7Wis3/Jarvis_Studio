// HTTP side of File > Import: the formats the form offers, and the upload. The file comes as the raw request body;
// its name and the options come in the x-import header (URI-encoded JSON).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CadKernel } from '../cad/kernel.js';
import type { ProjectStore } from '../store.js';
import { importIntoProject } from './project.js';
import { importFormats } from './registry.js';
import { importOptionsSchema } from './schema.js';

export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

const header = z.object({
    name: z.string().min(1).max(255),
    options: importOptionsSchema.optional(),
    target: z.string().optional(),
    replace: z.string().optional(),
});

export function registerImportRoutes(app: FastifyInstance, store: ProjectStore, kernel: CadKernel): void {
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
