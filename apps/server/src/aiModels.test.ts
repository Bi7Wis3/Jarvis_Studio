import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Nothing here may touch the real data folder.
await vi.hoisted(async () => {
    const { mkdtempSync: temp } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const scratch = temp(path.join(os.tmpdir(), 'jarvis-models-data-'));
    process.env.JARVIS_PROJECTS_DIR = scratch;
    process.env.JARVIS_SETTINGS_FILE = path.join(scratch, '.studio', 'settings.json');
});

import { DEFAULT_SETTINGS } from '@jarvis/core/settings';
import { claudeModels, ModelLists } from './aiModels.js';
import { SettingsStore, type AiConfig } from './settings.js';
import { registerSettingsRoutes } from './settingsRoutes.js';

const root = mkdtempSync(join(tmpdir(), 'jarvis-models-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// An obvious fake, never a real key.
const KEY = 'sk-ant-api03-FAKE-for-tests-only-WXYZ';

const MODELS = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus for planning', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'fable', displayName: 'Fable', description: 'Claude Fable', resolvedModel: 'claude-fable-1', supportedEffortLevels: ['low', 'high'] },
    { value: 'haiku', displayName: 'Haiku', description: 'Fast', supportsEffort: false },
];

interface Seen { prompt: unknown; options: { env?: Record<string, string>; tools?: unknown[]; settingSources?: unknown[] }; closed: boolean; sent: number }

/** A stand-in for the Agent SDK's query: records how it was started, whether it was closed and whether a prompt was sent. */
function fakeQuery(seen: Seen[], answer: () => Promise<unknown[]> = async () => MODELS) {
    return ((params: { prompt: AsyncIterable<unknown>; options: Seen['options'] }) => {
        const record: Seen = { prompt: params.prompt, options: params.options, closed: false, sent: 0 };
        seen.push(record);
        // Read the prompt stream as Claude Code would: anything it yields would be a request to the model.
        void (async () => {
            for await (const _ of params.prompt) {
                record.sent++;
            }
        })();
        return {
            supportedModels: answer,
            close: () => void (record.closed = true),
            async *[Symbol.asyncIterator]() {},
        };
    }) as never;
}

const config = (patch: Partial<AiConfig> = {}): AiConfig => ({ ...DEFAULT_SETTINGS.ai, apiKey: '', ...patch });

describe('the model list from Claude Code', () => {
    it('asks a session that never sends a prompt, then closes it', async () => {
        const seen: Seen[] = [];
        const models = await claudeModels(config(), fakeQuery(seen));
        expect(models).toEqual([
            { value: 'default', name: 'Default (recommended)', description: 'Opus for planning', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { value: 'fable', name: 'Fable', description: 'Claude Fable', efforts: ['low', 'high'], resolved: 'claude-fable-1' },
            { value: 'haiku', name: 'Haiku', description: 'Fast', efforts: [] },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(seen[0]).toMatchObject({ closed: true, sent: 0, options: { tools: [], settingSources: [] } });
        // The local login: the server's environment as it is.
        expect(seen[0].options.env).toBeUndefined();
    });

    it('uses the kept API key as Jarvis does, and needs one', async () => {
        const seen: Seen[] = [];
        await claudeModels(config({ auth: 'apiKey', apiKey: KEY }), fakeQuery(seen));
        expect(seen[0].options.env?.ANTHROPIC_API_KEY).toBe(KEY);
        await expect(claudeModels(config({ auth: 'apiKey' }), fakeQuery(seen))).rejects.toThrow(/No API key/);
    });

    it('gives up after the time limit and still closes the session', async () => {
        const seen: Seen[] = [];
        await expect(claudeModels(config(), fakeQuery(seen, () => new Promise(() => {})), 20)).rejects.toThrow(/did not answer/);
        expect(seen[0].closed).toBe(true);
    });
});

describe('the kept lists', () => {
    it('keeps a list per credential, asks again on refresh, and drops a failure', async () => {
        const seen: Seen[] = [];
        const lists = new ModelLists(fakeQuery(seen));
        const first = await lists.list(config());
        expect(first).toMatchObject({ ok: true, source: 'Claude Code', cached: false });
        expect(await lists.list(config())).toMatchObject({ ok: true, cached: true });
        expect(seen).toHaveLength(1);
        await lists.list(config(), {}, true);
        expect(seen).toHaveLength(2);
        // Another credential is another list.
        await lists.list(config({ auth: 'apiKey', apiKey: KEY }));
        expect(seen).toHaveLength(3);
        // The form's choice of login over the saved one.
        expect(await lists.list(config({ auth: 'apiKey', apiKey: KEY }), { auth: 'local' })).toMatchObject({ cached: true });
        lists.clear();
        await lists.list(config());
        expect(seen).toHaveLength(4);
        const failing = new ModelLists(fakeQuery([], async () => {
            throw new Error('spawn failed');
        }));
        expect(await failing.list(config())).toMatchObject({ ok: false, error: 'spawn failed', models: [] });
    });

    it('asks once for requests that come together', async () => {
        const seen: Seen[] = [];
        const lists = new ModelLists(fakeQuery(seen));
        await Promise.all([lists.list(config()), lists.list(config())]);
        expect(seen).toHaveLength(1);
    });

    it('never repeats the key in an error', async () => {
        const lists = new ModelLists(fakeQuery([], async () => {
            throw new Error(`Invalid API key ${KEY}`);
        }));
        const list = await lists.list(config({ auth: 'apiKey', apiKey: KEY }));
        expect(list.ok).toBe(false);
        expect(JSON.stringify(list)).not.toContain(KEY);
    });
});

describe('GET /api/ai/models', () => {
    it('serves the list without the key, keeps it, refreshes it, and drops it when the key changes', async () => {
        const store = new SettingsStore(join(mkdtempSync(join(root, 'case-')), 'settings.json'), DEFAULT_SETTINGS);
        store.update({ ai: { auth: 'apiKey', apiKey: KEY } });
        const seen: Seen[] = [];
        const app = Fastify();
        registerSettingsRoutes(app, store, undefined, new ModelLists(fakeQuery(seen)));
        const got = await app.inject({ method: 'GET', url: '/api/ai/models' });
        expect(got.statusCode).toBe(200);
        expect(got.json()).toMatchObject({ ok: true, cached: false, models: [{ value: 'default' }, { value: 'fable' }, { value: 'haiku' }] });
        expect(got.body).not.toContain(KEY);
        expect(seen[0].options.env?.ANTHROPIC_API_KEY).toBe(KEY);
        expect((await app.inject({ method: 'GET', url: '/api/ai/models' })).json()).toMatchObject({ cached: true });
        expect((await app.inject({ method: 'GET', url: '/api/ai/models?refresh=1' })).json()).toMatchObject({ cached: false });
        expect(seen).toHaveLength(2);
        // A new key: the kept list is dropped.
        store.update({ ai: { apiKey: 'sk-ant-api03-FAKE-second-key-ABCD' } });
        expect((await app.inject({ method: 'GET', url: '/api/ai/models' })).json()).toMatchObject({ cached: false });
        expect(seen).toHaveLength(3);
        // The form may ask about the local login before it is applied.
        await app.inject({ method: 'GET', url: '/api/ai/models?auth=local' });
        expect(seen[3].options.env).toBeUndefined();
        await app.close();
    });
});
