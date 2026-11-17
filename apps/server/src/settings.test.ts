import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Nothing here may touch the real data folder.
await vi.hoisted(async () => {
    const { mkdtempSync: temp } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const scratch = temp(path.join(os.tmpdir(), 'jarvis-settings-data-'));
    process.env.JARVIS_PROJECTS_DIR = scratch;
    process.env.JARVIS_SETTINGS_FILE = path.join(scratch, '.studio', 'settings.json');
});

import { DEFAULT_SETTINGS, LIGHTING_PRESETS } from '@jarvis/core/settings';
import { Jarvis, sessionSetup } from './agent.js';
import { serverDefaults, SettingsError, SettingsStore, type AiConfig } from './settings.js';
import { registerSettingsRoutes } from './settingsRoutes.js';
import { testAi } from './aiTest.js';
import type { ProjectStore } from './store.js';

const root = mkdtempSync(join(tmpdir(), 'jarvis-settings-test-'));
let dir = '';
let file = '';
const KEY = 'sk-ant-api03-test-0123456789abcdefWXYZ';

beforeEach(() => {
    dir = mkdtempSync(join(root, 'case-'));
    file = join(dir, '.studio', 'settings.json');
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe('settings file', () => {
    it('starts from the defaults and writes nothing until something changes', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        expect(store.get()).toEqual(DEFAULT_SETTINGS);
        expect(existsSync(file)).toBe(false);
    });

    it('is written readable by the owner only, in a folder only the owner can open', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        store.update({ general: { confirmDelete: false } });
        expect(mode(file)).toBe(0o600);
        expect(mode(join(dir, '.studio'))).toBe(0o700);
        // No temporary file is left behind.
        expect(readdirSync(join(dir, '.studio'))).toEqual(['settings.json']);
        expect(new SettingsStore(file, DEFAULT_SETTINGS).get().general.confirmDelete).toBe(false);
    });

    it('closes up a settings file someone made readable by others', () => {
        new SettingsStore(file, DEFAULT_SETTINGS).update({ ai: { apiKey: KEY } });
        chmodSync(file, 0o644);
        const again = new SettingsStore(file, DEFAULT_SETTINGS);
        expect(mode(file)).toBe(0o600);
        expect(again.ai().apiKey).toBe(KEY);
    });

    it('keeps whole categories from a patch and repairs broken values', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        const view = store.update({
            display: { meshQuality: 'coarse', pixelRatio: 99, background: 'red', transition: 'slow' },
            units: { lengthDecimals: 2, formDecimals: 3 },
            unknown: { anything: true },
        });
        expect(view.display.meshQuality).toBe('coarse');
        expect(view.display.pixelRatio).toBe(4);
        expect(view.display.background).toBe(DEFAULT_SETTINGS.display.background);
        expect(view.display.transition).toBe('slow');
        expect(view.units).toMatchObject({ lengthDecimals: 2, formDecimals: 3 });
        expect('unknown' in view).toBe(false);
        // A category left out of the patch is kept as it was.
        store.update({ general: { confirmDelete: false } });
        expect(store.get().display.meshQuality).toBe('coarse');
    });

    it('resets one category to its defaults and leaves the others', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        store.update({ display: { meshQuality: 'fine' }, lighting: LIGHTING_PRESETS.dark });
        store.reset(['lighting']);
        expect(store.get().lighting).toEqual(DEFAULT_SETTINGS.lighting);
        expect(store.get().display.meshQuality).toBe('fine');
    });

    it('reads a broken file as the defaults without printing it', () => {
        new SettingsStore(file, DEFAULT_SETTINGS).update({ ai: { apiKey: KEY } });
        writeFileSync(file, `{"secrets": {"anthropicApiKey": "${KEY}"`);
        const warnings: string[] = [];
        const warn = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
        try {
            expect(new SettingsStore(file, DEFAULT_SETTINGS).get()).toEqual(DEFAULT_SETTINGS);
        } finally {
            console.warn = warn;
        }
        expect(warnings.join('\n')).not.toContain(KEY);
    });
});

describe('the API key', () => {
    it('is kept in the file but shown to the web only masked', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        const view = store.update({ ai: { auth: 'apiKey', apiKey: `  ${KEY}  ` } });
        expect(view.ai).toMatchObject({ auth: 'apiKey', apiKeySet: true, apiKeyMasked: '••••••••WXYZ' });
        expect(JSON.stringify(view)).not.toContain(KEY);
        expect(JSON.stringify(store.get())).not.toContain(KEY);
        expect(store.ai().apiKey).toBe(KEY);
        expect(readFileSync(file, 'utf8')).toContain(KEY);
        expect(new SettingsStore(file, DEFAULT_SETTINGS).ai().apiKey).toBe(KEY);
    });

    it('is kept when a patch leaves it out, removed by an empty one, and refused when it cannot be a key', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        store.update({ ai: { apiKey: KEY } });
        store.update({ ai: { auth: 'apiKey', fast: { model: 'haiku', effort: 'low' } } });
        expect(store.ai()).toMatchObject({ apiKey: KEY, fast: { model: 'haiku', effort: 'low' } });
        expect(() => store.update({ ai: { apiKey: 'two words' } })).toThrow(SettingsError);
        expect(() => store.update({ ai: { apiKey: 42 } })).toThrow(SettingsError);
        expect(store.ai().apiKey).toBe(KEY);
        // Reset to defaults leaves the key; only removing it removes it.
        store.reset(['ai']);
        expect(store.ai()).toMatchObject({ auth: 'local', apiKey: KEY });
        store.update({ ai: { apiKey: '' } });
        expect(store.ai().apiKey).toBe('');
        expect(store.view().ai).toMatchObject({ apiKeySet: false, apiKeyMasked: '' });
        expect(readFileSync(file, 'utf8')).not.toContain(KEY);
    });

    it('is never written into project files', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        store.update({ ai: { apiKey: KEY } });
        const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f !== join('.studio', 'settings.json'));
        for (const f of files) {
            if (statSync(join(dir, f)).isFile()) {
                expect(readFileSync(join(dir, f), 'utf8')).not.toContain(KEY);
            }
        }
    });
});

describe('the keys of other providers', () => {
    const OPENAI = 'sk-FAKE-openai-key-for-tests-1111';
    const GROQ = 'gsk_FAKE-groq-key-for-tests-2222';

    it('keeps one key per service, masked to the web, each kept when switching between them', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        store.update({ ai: { provider: 'openai-compatible', compatible: { preset: 'openai' }, compatibleKeys: { openai: ` ${OPENAI} ` } } });
        store.update({ ai: { compatible: { preset: 'groq' }, compatibleKeys: { groq: GROQ } } });
        store.update({ ai: { compatible: { preset: 'openai' } } });
        expect(store.ai().compatibleKeys).toEqual({ openai: OPENAI, groq: GROQ });
        const view = store.view();
        expect(view.ai.compatibleKeys).toEqual({ openai: '••••••••1111', groq: '••••••••2222' });
        expect(JSON.stringify(view)).not.toContain(OPENAI);
        expect(JSON.stringify(store.get())).not.toContain(GROQ);
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        expect(raw.secrets.compatibleKeys).toEqual({ openai: OPENAI, groq: GROQ });
        expect(JSON.stringify(raw.settings)).not.toContain(OPENAI);
        expect(new SettingsStore(file, DEFAULT_SETTINGS).ai().compatibleKeys).toEqual({ openai: OPENAI, groq: GROQ });
    });

    it('removes a key with an empty one, refuses a bad one or an unknown service, and keeps them on reset', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        store.update({ ai: { compatibleKeys: { openai: OPENAI, groq: GROQ } } });
        expect(() => store.update({ ai: { compatibleKeys: { openai: 'two words' } } })).toThrow(SettingsError);
        expect(() => store.update({ ai: { compatibleKeys: { skynet: OPENAI } } })).toThrow(SettingsError);
        expect(() => store.update({ ai: { compatibleKeys: 'x' } })).toThrow(SettingsError);
        store.reset(['ai']);
        expect(store.ai().compatibleKeys).toEqual({ openai: OPENAI, groq: GROQ });
        store.update({ ai: { compatibleKeys: { groq: '' } } });
        expect(store.ai().compatibleKeys).toEqual({ openai: OPENAI });
        expect(readFileSync(file, 'utf8')).not.toContain(GROQ);
    });

    it('loads a file from before other providers unchanged', () => {
        mkdirSync(join(dir, '.studio'), { recursive: true });
        writeFileSync(file, JSON.stringify({
            version: 1,
            settings: { ai: { auth: 'apiKey', fast: { model: 'haiku', effort: 'low' }, best: { model: 'fable', effort: 'high' } } },
            secrets: { anthropicApiKey: KEY },
        }), { mode: 0o600 });
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        expect(store.ai()).toMatchObject({
            provider: 'claude', auth: 'apiKey', apiKey: KEY, compatibleKeys: {},
            fast: { model: 'haiku', effort: 'low' }, best: { model: 'fable', effort: 'high' },
        });
        expect(store.view().ai.compatibleKeys).toEqual({});
    });

    it('tells when any key changes without showing one', () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        const before = store.keysStamp();
        store.update({ general: { confirmDelete: false } });
        expect(store.keysStamp()).toBe(before);
        store.update({ ai: { compatibleKeys: { openai: OPENAI } } });
        expect(store.keysStamp()).not.toBe(before);
        expect(store.keysStamp()).not.toContain(OPENAI);
    });
});

describe('settings routes', () => {
    it('serves the settings masked, takes whole categories and refuses a bad key', async () => {
        const store = new SettingsStore(file, DEFAULT_SETTINGS);
        const tested: unknown[] = [];
        const app = Fastify();
        registerSettingsRoutes(app, store, async (saved, override) => {
            tested.push({ saved, override });
            return { ok: true, ms: 1, model: 'claude-test' };
        });
        const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ai: { auth: 'apiKey', apiKey: KEY } } });
        expect(put.statusCode).toBe(200);
        expect(put.body).not.toContain(KEY);
        const got = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(got.json().ai).toMatchObject({ apiKeySet: true, apiKeyMasked: '••••••••WXYZ' });
        expect(got.body).not.toContain(KEY);
        const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ai: { apiKey: 'not a key' } } });
        expect(bad.statusCode).toBe(400);
        const reset = await app.inject({ method: 'POST', url: '/api/settings/reset', payload: { categories: ['ai'] } });
        expect(reset.json().ai).toMatchObject({ auth: 'local', apiKeySet: true });
        expect((await app.inject({ method: 'POST', url: '/api/settings/reset', payload: { categories: ['nope'] } })).statusCode).toBe(400);
        const test = await app.inject({ method: 'POST', url: '/api/settings/ai-test', payload: { model: 'opus', effort: 'high', auth: 'local' } });
        expect(test.json()).toMatchObject({ ok: true, model: 'claude-test' });
        expect(tested[0]).toMatchObject({ override: { model: 'opus', effort: 'high', auth: 'local' } });
        await app.close();
    });
});

describe('Jarvis and the AI settings', () => {
    const config = (patch: Partial<AiConfig> = {}): AiConfig => ({ ...DEFAULT_SETTINGS.ai, apiKey: '', ...patch });

    it('takes the model and effort of the quality in use', () => {
        const setup = sessionSetup(config({ best: { model: 'claude-opus-5-5', effort: 'max' } }), 'best', {});
        expect(setup).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
    });

    it('with the local login leaves the environment as it is; with a key passes only the key', () => {
        const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'from-shell', ANTHROPIC_AUTH_TOKEN: 'token', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' };
        expect(sessionSetup(config(), 'fast', env)).toEqual({ model: 'sonnet', effort: 'medium' });
        const keyed = sessionSetup(config({ auth: 'apiKey', apiKey: KEY }), 'fast', env);
        expect(keyed).toEqual({ model: 'sonnet', effort: 'medium', env: { PATH: '/bin', ANTHROPIC_API_KEY: KEY } });
        expect(sessionSetup(config({ auth: 'apiKey' }), 'fast', env)).toMatchObject({ error: expect.stringContaining('No API key') });
    });

    it('switches to the new model without a restart', () => {
        let current = config();
        const models: string[] = [];
        const events = { status: () => {}, sentence: () => {}, interrupted: () => {}, finished: () => {}, error: () => {}, model: (m: string) => void models.push(m) };
        const jarvis = new Jarvis({} as ProjectStore, [], events, () => current);
        expect(jarvis.getModel()).toBe('sonnet');
        current = config({ fast: { model: 'haiku', effort: 'low' } });
        jarvis.reconfigure();
        expect(models).toEqual(['haiku']);
        jarvis.setQuality('best');
        expect(models).toEqual(['haiku', 'opus']);
    });

    it('takes JARVIS_MODEL and JARVIS_EFFORT as the defaults of Fast', () => {
        expect(serverDefaults({ JARVIS_MODEL: 'haiku', JARVIS_EFFORT: 'low' }).ai.fast).toEqual({ model: 'haiku', effort: 'low' });
        expect(serverDefaults({ JARVIS_MODEL: 'bad model; rm', JARVIS_EFFORT: 'huge' }).ai.fast).toEqual(DEFAULT_SETTINGS.ai.fast);
    });
});

describe('Test connection', () => {
    const saved: AiConfig = { ...DEFAULT_SETTINGS.ai, auth: 'apiKey', apiKey: KEY };
    /** A stand-in for the Agent SDK's query: answers with these messages and records the options it was given. */
    const fakeQuery = (messages: unknown[], seen: unknown[]) => ((params: { options: unknown }) => {
        seen.push(params.options);
        return {
            async *[Symbol.asyncIterator]() {
                yield* messages;
            },
            supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet', description: '', supportedEffortLevels: ['low', 'high'] }],
        };
    }) as never;

    it('reports the model, the credential and the models offered when Claude answers', async () => {
        const seen: { model?: string; effort?: string; env?: Record<string, string>; tools?: unknown[]; maxTurns?: number }[] = [];
        const result = await testAi(saved, { model: 'haiku', effort: 'low' }, fakeQuery([
            { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', apiKeySource: 'ANTHROPIC_API_KEY' },
            { type: 'result', subtype: 'success', is_error: false, result: 'OK' },
        ], seen));
        expect(result).toMatchObject({ ok: true, model: 'claude-haiku-5-5', credential: 'ANTHROPIC_API_KEY', reply: 'OK' });
        expect(result.models).toEqual([{ value: 'sonnet', name: 'Sonnet', efforts: ['low', 'high'] }]);
        expect(seen[0]).toMatchObject({ model: 'haiku', effort: 'low', tools: [], maxTurns: 1 });
        expect(seen[0].env?.ANTHROPIC_API_KEY).toBe(KEY);
    });

    it('explains a refusal without ever repeating the key', async () => {
        const result = await testAi(saved, {}, fakeQuery([
            { type: 'assistant', error: 'authentication_failed', message: {} },
            { type: 'result', subtype: 'success', is_error: true, result: `Invalid API key ${KEY}` },
        ], []));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/credentials were refused/);
        const leaked = await testAi(saved, {}, fakeQuery([{ type: 'result', subtype: 'success', is_error: true, result: `bad ${KEY}` }], []));
        expect(leaked.error).not.toContain(KEY);
        expect(await testAi({ ...saved, apiKey: '' }, {}, fakeQuery([], []))).toMatchObject({ ok: false, error: expect.stringContaining('No API key') });
    });

    it('tests a key typed in the form before it is saved', async () => {
        const seen: { env?: Record<string, string> }[] = [];
        const typed = 'sk-ant-typed-key-0000';
        await testAi({ ...saved, apiKey: '' }, { apiKey: typed }, fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'OK' }], seen));
        expect(seen[0].env?.ANTHROPIC_API_KEY).toBe(typed);
    });
});
