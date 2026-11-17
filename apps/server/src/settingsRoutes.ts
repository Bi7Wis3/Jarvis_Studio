// HTTP routes of the Options page: GET /api/settings (the API key masked), PUT /api/settings (whole categories), POST
// /api/settings/reset, POST /api/settings/ai-test, GET /api/ai/models (aiModels.ts) and GET /api/ai/skills (skills.ts).

import type { FastifyInstance } from 'fastify';
import {
    COMPATIBLE_PRESET_IDS, EFFORTS, SETTINGS_CATEGORIES, validBaseUrl, validCompatibleModel, validModel, type CompatiblePreset, type Effort,
    type SettingsCategory,
} from '@jarvis/core/settings';
import { ModelLists, registerAiModelRoutes } from './aiModels.js';
import { testAi, type AiTestResult } from './aiTest.js';
import { SettingsError, type SettingsStore } from './settings.js';
import { registerSkillRoutes } from './skills.js';

export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsStore,
    test: typeof testAi = testAi, models: ModelLists = new ModelLists()): void {
    app.get('/api/settings', async () => settings.view());
    registerAiModelRoutes(app, settings, models);
    registerSkillRoutes(app);

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
        const body = (request.body ?? {}) as {
            provider?: unknown; auth?: unknown; apiKey?: unknown; model?: unknown; effort?: unknown; preset?: unknown; baseUrl?: unknown;
        };
        const compatible = (body.provider ?? settings.get().ai.provider) === 'openai-compatible';
        return test(settings.ai(), {
            ...(body.provider === 'claude' || body.provider === 'openai-compatible' ? { provider: body.provider } : {}),
            ...(body.auth === 'local' || body.auth === 'apiKey' ? { auth: body.auth } : {}),
            ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
            ...((compatible ? validCompatibleModel(body.model) : validModel(body.model)) ? { model: body.model as string } : {}),
            ...(EFFORTS.includes(body.effort as Effort) ? { effort: body.effort as Effort } : {}),
            ...(COMPATIBLE_PRESET_IDS.includes(body.preset as CompatiblePreset) ? { preset: body.preset as CompatiblePreset } : {}),
            ...(validBaseUrl(body.baseUrl) ? { baseUrl: body.baseUrl } : {}),
        });
    });
}
