// The model choices of Options > AI assistant: the list the server fetches (GET /api/ai/models), with Claude's aliases
// as the fallback while it loads or when it cannot be had, and the effort levels each model takes.

import {
    compatibleModels, compatiblePreset, EFFORTS, type AiAuth, type AiProvider, type AiSettings, type CompatiblePreset, type Effort,
} from '@jarvis/core/settings';

export interface AiModelInfo {
    value: string;
    name: string;
    description?: string;
    /** Absent: unknown, any level is offered. Empty: the model takes no effort level. */
    efforts?: Effort[];
    resolved?: string;
    /** OpenAI-compatible services: false when the service says the model cannot call tools. */
    tools?: boolean;
    /** OpenAI-compatible services: false when the service says the model takes no pictures. */
    images?: boolean;
}

export interface AiModelList {
    ok: boolean;
    source: string;
    models: AiModelInfo[];
    error?: string;
    cached: boolean;
    fetchedAt?: number;
}

/** Claude Code's model aliases: they always mean the latest model of the family. */
export const CLAUDE_ALIASES: AiModelInfo[] = [
    { value: 'sonnet', name: 'Sonnet (latest)' },
    { value: 'opus', name: 'Opus (latest)' },
    { value: 'haiku', name: 'Haiku (latest)' },
    { value: 'fable', name: 'Fable (latest)' },
];

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const http: Fetch = (url, init) => globalThis.fetch(url, init);

/** Which models to list: the form's provider and login, or service and Custom base URL. */
export interface ModelListForm {
    provider?: AiProvider;
    auth?: AiAuth;
    preset?: CompatiblePreset;
    baseUrl?: string;
}

/** Asks the server for the models of these credentials (never a key: the server uses the kept one). */
export async function fetchAiModels(form: ModelListForm, refresh = false, fetcher: Fetch = http): Promise<AiModelList> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
        if (typeof value === 'string' && value) {
            params.set(key, value);
        }
    }
    if (refresh) {
        params.set('refresh', '1');
    }
    const source = form.provider === 'openai-compatible' && form.preset ? compatiblePreset(form.preset).name : 'Claude Code';
    try {
        const response = await fetcher(`/api/ai/models?${params}`);
        const answer = await response.json() as AiModelList;
        if (!response.ok || !Array.isArray(answer?.models)) {
            return { ok: false, source, models: [], cached: false, error: `The server could not list the models (${response.status}).` };
        }
        return answer;
    } catch {
        return { ok: false, source, models: [], cached: false, error: 'The server is not answering.' };
    }
}

/** The models to choose from: the fetched list when there is one, else the aliases. */
export function claudeModelOptions(list: AiModelList | null): AiModelInfo[] {
    return list?.ok && list.models.length ? list.models : CLAUDE_ALIASES;
}

/** An OpenAI-compatible service's models, marked where the service says one cannot call tools or take pictures. */
export function compatibleModelOptions(list: AiModelList | null): AiModelInfo[] {
    if (!list?.ok) {
        return [];
    }
    return list.models.map((m) => {
        const notes = [m.tools === false ? 'no tool calling' : '', m.images === false ? 'no pictures' : ''].filter(Boolean);
        return notes.length ? { ...m, name: `${m.name} (${notes.join(', ')})` } : m;
    });
}

/** The tooltip of the Fast and Best buttons: the model behind each. */
export function qualityTitle(ai: AiSettings, quality: 'fast' | 'best'): string {
    const what = quality === 'fast' ? 'quick' : 'slower, better designs';
    if (ai.provider === 'openai-compatible') {
        const model = compatibleModels(ai.compatible)[quality];
        return `${model || 'no model chosen'} on ${compatiblePreset(ai.compatible.preset).name}: ${what}`;
    }
    return `${ai[quality].model} at ${ai[quality].effort} effort: ${what}`;
}

/** The effort levels a model takes, from its entry in the list; any level when the model is not listed. */
export function effortsOf(model: string, options: AiModelInfo[]): Effort[] {
    const entry = options.find((m) => m.value === model);
    return entry?.efforts ?? EFFORTS;
}

/**
 * The effort to keep after picking a model: the one set when the model takes it, else the nearest level below it that
 * it takes, else its lowest. A model that takes none keeps the one set (it is not used).
 */
export function effortFor(model: string, effort: Effort, options: AiModelInfo[]): Effort {
    const offered = effortsOf(model, options);
    if (offered.length === 0 || offered.includes(effort)) {
        return effort;
    }
    const rank = EFFORTS.indexOf(effort);
    const below = offered.filter((e) => EFFORTS.indexOf(e) < rank);
    return below.length ? below[below.length - 1] : offered[0];
}

export const effortText = (e: Effort): string => (e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1));

/** The line under the model list: loading, how many models came from where, or why there are none. */
export function listStatus(list: AiModelList | null, loading: boolean): string {
    if (loading) {
        return 'Loading models…';
    }
    if (!list) {
        return '';
    }
    if (!list.ok) {
        return `The list could not be loaded: ${list.error ?? 'no reason given'}. The usual choices are shown.`;
    }
    const n = list.models.length;
    return `${n} model${n === 1 ? '' : 's'} from ${list.source}`;
}
