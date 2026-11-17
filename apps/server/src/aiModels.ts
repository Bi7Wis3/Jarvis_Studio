// GET /api/ai/models: the models Jarvis can use with the current credentials, for Options > AI assistant. Claude's come
// from Claude Code itself: a session is started with streaming input that never sends a prompt, asked for its
// supportedModels() (answered from Claude Code's initialize response, so no request reaches a model and nothing is
// billed), then closed. An OpenAI-compatible service's come from GET {baseUrl}/models with its key. Lists are kept in
// memory per credential; ?refresh=1 asks again.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
    COMPATIBLE_PRESET_IDS, compatibleBaseUrl, compatiblePreset, EFFORTS, tidyBaseUrl, validBaseUrl, type AiAuth, type AiProvider,
    type CompatiblePreset, type Effort,
} from '@jarvis/core/settings';
import { sessionSetup } from './agent.js';
import { compatibleModelList, type Fetcher } from './agentOpenAI.js';
import { PROJECTS_DIR } from './paths.js';
import type { AiConfig, SettingsStore } from './settings.js';

export interface AiModelInfo {
    /** What goes into the settings: an alias or a model id. */
    value: string;
    name: string;
    description?: string;
    /** The effort levels the model takes; absent when unknown (any). Empty: the model takes no effort level. */
    efforts?: Effort[];
    /** The model id an alias stands for today. */
    resolved?: string;
    /** OpenAI-compatible services: false when the service says the model cannot call tools. */
    tools?: boolean;
    /** OpenAI-compatible services: false when the service says the model takes no pictures. */
    images?: boolean;
}

export interface AiModelList {
    ok: boolean;
    /** Where the list came from, in words for the page ("Claude Code", "OpenAI"). */
    source: string;
    models: AiModelInfo[];
    error?: string;
    /** Served from memory rather than asked for afresh. */
    cached: boolean;
    /** When the list was fetched (ms since 1970). */
    fetchedAt?: number;
}

/** Which credentials to list the models for (the page's form, which may differ from what is saved). */
export interface ModelListRequest {
    provider?: AiProvider;
    auth?: AiAuth;
    preset?: CompatiblePreset;
    /** Custom's base URL as typed. */
    baseUrl?: string;
}

const LIST_TIMEOUT_MS = 45_000;

/** A prompt stream that never sends anything, ended by `end()` so the session can close cleanly. */
function idleInput(): { stream: AsyncIterable<SDKUserMessage>; end: () => void } {
    let end = () => {};
    const ended = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        end = () => resolve({ value: undefined, done: true });
    });
    return { stream: { [Symbol.asyncIterator]: () => ({ next: () => ended }) }, end };
}

/** Removes every kept key from a text that will be shown or logged. */
export function scrubKeys(text: string, keys: string[]): string {
    return keys.filter((k) => k.length >= 4).reduce((out, key) => out.split(key).join('••••'), text);
}

/** The models Claude Code offers with these credentials. Throws with a plain reason. */
export async function claudeModels(config: AiConfig, run: typeof query = query, timeoutMs = LIST_TIMEOUT_MS): Promise<AiModelInfo[]> {
    const setup = sessionSetup({ ...config, provider: 'claude' }, 'fast');
    if ('error' in setup || 'provider' in setup) {
        throw new Error('error' in setup ? setup.error : 'Not a Claude session.');
    }
    const input = idleInput();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const session = run({
        prompt: input.stream,
        options: {
            ...(setup.env ? { env: setup.env } : {}),
            tools: [],
            settingSources: [],
            persistSession: false,
            permissionMode: 'dontAsk',
            cwd: PROJECTS_DIR,
            abortController: abort,
        },
    });
    try {
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Claude Code did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
        });
        const models = await Promise.race([session.supportedModels(), timeout]);
        return models.map((m) => ({
            value: m.value,
            name: m.displayName || m.value,
            ...(m.description ? { description: m.description } : {}),
            ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels.filter((e) => EFFORTS.includes(e)) }
                : m.supportsEffort === false ? { efforts: [] } : {}),
            ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}),
        }));
    } finally {
        clearTimeout(timer);
        input.end();
        session.close();
    }
}

/** A short fingerprint of a key, so the cache can tell credentials apart without keeping them as names. */
const fingerprint = (key: string): string => (key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'none');

/** An OpenAI-compatible service as the request names it, with the key to use for it. */
export interface CompatibleTarget {
    preset: CompatiblePreset;
    name: string;
    baseUrl: string;
    apiKey: string;
    local: boolean;
}

/**
 * The service a request names. A kept key goes only to the base URL it was kept for: a Custom base URL typed but not
 * yet applied is asked without it (or with a key typed alongside it), so no request can send a kept key elsewhere.
 */
export function compatibleTarget(saved: AiConfig, preset: CompatiblePreset = saved.compatible.preset, typedUrl?: string,
    typedKey?: string): CompatibleTarget {
    const info = compatiblePreset(preset);
    const savedUrl = compatibleBaseUrl(saved.compatible, preset);
    const baseUrl = preset === 'custom' && typedUrl && validBaseUrl(typedUrl) ? tidyBaseUrl(typedUrl) : savedUrl;
    const kept = baseUrl === savedUrl ? saved.compatibleKeys?.[preset] ?? '' : '';
    return { preset, name: info.name, baseUrl, apiKey: typedKey?.trim() || kept, local: info.local };
}

type Target = { provider: 'claude'; config: AiConfig } | { provider: 'openai-compatible'; target: CompatibleTarget };

/** What the request asks about: the saved settings with the form's choices over them. */
function requested(saved: AiConfig, request: ModelListRequest): Target {
    if ((request.provider ?? saved.provider) === 'openai-compatible') {
        return { provider: 'openai-compatible', target: compatibleTarget(saved, request.preset, request.baseUrl) };
    }
    return { provider: 'claude', config: { ...saved, ...(request.auth ? { auth: request.auth } : {}) } };
}

/** The cache key of the credentials a request is for. */
function credentialKey(target: Target): string {
    if (target.provider === 'openai-compatible') {
        const t = target.target;
        return `compatible:${t.preset}:${t.baseUrl}:${fingerprint(t.apiKey)}`;
    }
    return target.config.auth === 'apiKey' ? `claude:key:${fingerprint(target.config.apiKey)}` : 'claude:local';
}

/** The model lists, kept per credential until the credentials change or a refresh is asked for. */
export class ModelLists {
    private lists = new Map<string, AiModelList>();
    private asking = new Map<string, Promise<AiModelList>>();

    constructor(private readonly run: typeof query = query, private readonly timeoutMs = LIST_TIMEOUT_MS,
        private readonly fetcher?: Fetcher) {}

    clear(): void {
        this.lists.clear();
    }

    async list(saved: AiConfig, request: ModelListRequest = {}, refresh = false): Promise<AiModelList> {
        const target = requested(saved, request);
        const key = credentialKey(target);
        const kept = this.lists.get(key);
        if (kept && !refresh) {
            return { ...kept, cached: true };
        }
        const running = this.asking.get(key);
        if (running) {
            return running;
        }
        const asked = this.fetch(target).then((list) => {
            this.asking.delete(key);
            // A failure is not kept: the next request asks again.
            if (list.ok) {
                this.lists.set(key, list);
            }
            return list;
        });
        this.asking.set(key, asked);
        return asked;
    }

    private async fetch(target: Target): Promise<AiModelList> {
        const source = target.provider === 'claude' ? 'Claude Code' : target.target.name;
        const key = target.provider === 'claude' ? target.config.apiKey : target.target.apiKey;
        try {
            const models = target.provider === 'claude'
                ? await claudeModels(target.config, this.run, this.timeoutMs)
                : await this.compatible(target.target);
            return { ok: true, source, models, cached: false, fetchedAt: Date.now() };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, source, models: [], cached: false, error: scrubKeys(reason, [key]) };
        }
    }

    private async compatible(t: CompatibleTarget): Promise<AiModelInfo[]> {
        if (!t.baseUrl) {
            throw new Error('Type the base URL of the service first');
        }
        if (!t.apiKey && !t.local && t.preset !== 'custom') {
            throw new Error(`No API key is kept for ${t.name}: apply one to list its models`);
        }
        return compatibleModelList({ ...t, model: '' }, this.fetcher, this.timeoutMs);
    }
}

/** What identifies the credentials in the saved settings, to drop the lists when they change. */
const credentialsOf = (settings: SettingsStore): string =>
    JSON.stringify([settings.get().ai.auth, settings.get().ai.compatible.baseUrl, settings.keysStamp()]);

/** The form's choices from a query string (never a key: the server uses the kept ones). */
export function modelListRequest(q: Record<string, unknown>): ModelListRequest {
    return {
        ...(q.provider === 'claude' || q.provider === 'openai-compatible' ? { provider: q.provider } : {}),
        ...(q.auth === 'local' || q.auth === 'apiKey' ? { auth: q.auth } : {}),
        ...(COMPATIBLE_PRESET_IDS.includes(q.preset as CompatiblePreset) ? { preset: q.preset as CompatiblePreset } : {}),
        ...(validBaseUrl(q.baseUrl) ? { baseUrl: q.baseUrl } : {}),
    };
}

export function registerAiModelRoutes(app: FastifyInstance, settings: SettingsStore, lists: ModelLists = new ModelLists()): void {
    let credentials = credentialsOf(settings);
    settings.subscribe(() => {
        const next = credentialsOf(settings);
        if (next !== credentials) {
            credentials = next;
            lists.clear();
        }
    });
    app.get('/api/ai/models', async (request): Promise<AiModelList> => {
        const q = (request.query ?? {}) as Record<string, unknown>;
        return lists.list(settings.ai(), modelListRequest(q), q.refresh === '1' || q.refresh === 'true');
    });
}
