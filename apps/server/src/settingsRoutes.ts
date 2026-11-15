// HTTP routes of the Options page: GET /api/settings (the API key masked), PUT /api/settings (whole categories), POST
// /api/settings/reset and POST /api/settings/ai-test.

import type { FastifyInstance } from 'fastify';
import { EFFORTS, SETTINGS_CATEGORIES, validModel, type Effort, type SettingsCategory } from '@jarvis/core/settings';
import { testAi, type AiTestResult } from './aiTest.js';
import { SettingsError, type SettingsStore } from './settings.js';

export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsStore,
    test: typeof testAi = testAi): void {
    app.get('/api/settings', async () => settings.view());

    app.put('/api/settings', async (request, reply) => {
        try {
            return settings.update(request.body ?? {});
        } catch (error) {
            if (error instanceof SettingsError) {
                return reply.code(400).send({ error: error.message });
            }
            throw error;
        }
    });

    app.post('/api/settings/reset', async (request, reply) => {
        const body = request.body as { categories?: unknown } | null;
        const categories = Array.isArray(body?.categories) ? body.categories : SETTINGS_CATEGORIES;
        if (!categories.every((c) => SETTINGS_CATEGORIES.includes(c as SettingsCategory))) {
            return reply.code(400).send({ error: `Categories are ${SETTINGS_CATEGORIES.join(', ')}.` });
        }
        return settings.reset(categories as SettingsCategory[]);
    });

    app.post('/api/settings/ai-test', async (request): Promise<AiTestResult> => {
        const body = (request.body ?? {}) as { auth?: unknown; apiKey?: unknown; model?: unknown; effort?: unknown };
        return test(settings.ai(), {
            ...(body.auth === 'local' || body.auth === 'apiKey' ? { auth: body.auth } : {}),
            ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
            ...(validModel(body.model) ? { model: body.model } : {}),
            ...(EFFORTS.includes(body.effort as Effort) ? { effort: body.effort as Effort } : {}),
        });
    });
}
