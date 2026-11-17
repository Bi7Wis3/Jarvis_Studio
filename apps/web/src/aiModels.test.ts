import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EFFORTS } from '@jarvis/core/settings';
import {
    CLAUDE_ALIASES, claudeModelOptions, compatibleModelOptions, effortFor, effortsOf, fetchAiModels, listStatus, qualityTitle, type AiModelList,
} from './aiModels';

const fetched: AiModelList = {
    ok: true,
    source: 'Claude Code',
    cached: false,
    models: [
        { value: 'default', name: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'fable', name: 'Fable', efforts: ['low', 'medium', 'high'] },
        { value: 'haiku', name: 'Haiku', efforts: [] },
    ],
};

describe('the model choices', () => {
    it('falls back to the aliases, Fable included, while the list loads or when it fails', () => {
        expect(CLAUDE_ALIASES.map((m) => m.value)).toEqual(['sonnet', 'opus', 'haiku', 'fable']);
        expect(CLAUDE_ALIASES.find((m) => m.value === 'fable')?.name).toBe('Fable (latest)');
        expect(claudeModelOptions(null)).toBe(CLAUDE_ALIASES);
        expect(claudeModelOptions({ ok: false, source: 'Claude Code', models: [], cached: false, error: 'offline' })).toBe(CLAUDE_ALIASES);
        expect(claudeModelOptions({ ...fetched, models: [] })).toBe(CLAUDE_ALIASES);
        expect(claudeModelOptions(fetched).map((m) => m.value)).toEqual(['default', 'fable', 'haiku']);
    });

    it('offers each model only its own effort levels, and any level for a model it does not know', () => {
        const options = claudeModelOptions(fetched);
        expect(effortsOf('fable', options)).toEqual(['low', 'medium', 'high']);
        expect(effortsOf('haiku', options)).toEqual([]);
        expect(effortsOf('claude-typed-id', options)).toEqual(EFFORTS);
        expect(effortsOf('sonnet', CLAUDE_ALIASES)).toEqual(EFFORTS);
    });

    it('keeps the effort when the new model takes it, else the nearest below, else the lowest', () => {
        const options = claudeModelOptions(fetched);
        expect(effortFor('fable', 'medium', options)).toBe('medium');
        expect(effortFor('fable', 'max', options)).toBe('high');
        expect(effortFor('haiku', 'max', options)).toBe('max');
        expect(effortFor('x', 'xhigh', [{ value: 'x', name: 'X', efforts: ['high', 'max'] }])).toBe('high');
        expect(effortFor('x', 'low', [{ value: 'x', name: 'X', efforts: ['high', 'max'] }])).toBe('high');
    });

    it('says what the list is doing', () => {
        expect(listStatus(null, true)).toBe('Loading models…');
        expect(listStatus(fetched, false)).toBe('3 models from Claude Code');
        expect(listStatus({ ...fetched, models: [fetched.models[0]] }, false)).toBe('1 model from Claude Code');
        expect(listStatus({ ok: false, source: 'Claude Code', models: [], cached: false, error: 'No answer' }, false)).toMatch(/could not be loaded: No answer/);
    });

    it('asks the server with the form login and never a key, and reports a server that does not answer', async () => {
        const urls: string[] = [];
        const answer = await fetchAiModels({ auth: 'apiKey' }, true, async (url) => {
            urls.push(url);
            return { ok: true, status: 200, json: async () => fetched };
        });
        expect(answer).toEqual(fetched);
        expect(urls).toEqual(['/api/ai/models?auth=apiKey&refresh=1']);
        expect(await fetchAiModels({ auth: 'local' }, false, async () => {
            throw new Error('offline');
        })).toMatchObject({ ok: false, error: 'The server is not answering.' });
        await fetchAiModels({ provider: 'openai-compatible', preset: 'custom', baseUrl: 'http://localhost:8080/v1' }, false, async (url) => {
            urls.push(url);
            return { ok: true, status: 200, json: async () => fetched };
        });
        expect(urls[1]).toBe('/api/ai/models?provider=openai-compatible&preset=custom&baseUrl=http%3A%2F%2Flocalhost%3A8080%2Fv1');
        expect(await fetchAiModels({ provider: 'openai-compatible', preset: 'groq' }, false, async () => {
            throw new Error('offline');
        })).toMatchObject({ source: 'Groq' });
    });

    it('marks the models of a service that cannot call tools or take pictures', () => {
        const list: AiModelList = {
            ok: true, source: 'OpenRouter', cached: false,
            models: [{ value: 'a', name: 'A', tools: true }, { value: 'b', name: 'B', tools: false, images: false }, { value: 'c', name: 'C', images: false }],
        };
        expect(compatibleModelOptions(list).map((m) => m.name)).toEqual(['A', 'B (no tool calling, no pictures)', 'C (no pictures)']);
        expect(compatibleModelOptions(null)).toEqual([]);
    });

    it('names the model behind Fast and Best on either provider', () => {
        expect(qualityTitle(DEFAULT_SETTINGS.ai, 'fast')).toBe('sonnet at medium effort: quick');
        const other = { ...DEFAULT_SETTINGS.ai, provider: 'openai-compatible' as const, compatible: { preset: 'mistral' as const, baseUrl: '', models: { mistral: { fast: 'small', best: '' } } } };
        expect(qualityTitle(other, 'fast')).toBe('small on Mistral: quick');
        expect(qualityTitle(other, 'best')).toBe('no model chosen on Mistral: slower, better designs');
    });
});
