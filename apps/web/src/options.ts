// The Options page's settings in the browser: loaded from the server at start (GET /api/settings), saved there whole
// categories at a time (PUT /api/settings), and read by the rest of the app, which applies them as they change.

import { create } from 'zustand';
import type { ExtrudeDirection, ExtrudeEnd, RevolveType } from '@jarvis/core';
import {
    COMPATIBLE_PRESET_IDS, defaultSettings, maskKey, normaliseSettings, type AiAuth, type AiProvider, type CompatiblePreset, type Effort,
    type SettingsCategory, type StudioSettings, type StudioSettingsView, type ToolDefaultValue,
} from '@jarvis/core/settings';

export type { SettingsCategory, StudioSettings, StudioSettingsView } from '@jarvis/core/settings';

/**
 * A patch of whole categories; `ai.apiKey` sets the Anthropic key ('' removes it), absent keeps it; `ai.compatibleKeys`
 * the same for each OpenAI-compatible service named.
 */
export type OptionsPatch = Partial<Omit<StudioSettings, 'ai'>> & {
    ai?: StudioSettings['ai'] & { apiKey?: string; compatibleKeys?: Partial<Record<CompatiblePreset, string>> };
};

interface OptionsState {
    /** The settings in force (as last saved on the server, or the defaults until they have loaded). */
    settings: StudioSettingsView;
    /** Loaded from the server (false: the defaults, e.g. while offline). */
    loaded: boolean;
    /** The Options page is open on this category. */
    open: SettingsCategory | null;
}

export function viewOf(settings: StudioSettings, apiKey = ''): StudioSettingsView {
    return { ...settings, ai: { ...settings.ai, apiKeySet: apiKey !== '', apiKeyMasked: maskKey(apiKey) } };
}

/** The settings view from a server answer: the settings normalised, the key status as sent. */
export function viewFromServer(raw: unknown): StudioSettingsView {
    const settings = normaliseSettings(raw);
    const ai = (raw && typeof raw === 'object'
        ? (raw as { ai?: { apiKeySet?: unknown; apiKeyMasked?: unknown; compatibleKeys?: unknown } }).ai : undefined) ?? {};
    const masked = ai.compatibleKeys && typeof ai.compatibleKeys === 'object' ? ai.compatibleKeys as Record<string, unknown> : {};
    const compatibleKeys = Object.fromEntries(Object.entries(masked)
        .filter(([preset, m]) => COMPATIBLE_PRESET_IDS.includes(preset as CompatiblePreset) && typeof m === 'string' && m !== ''));
    return {
        ...settings,
        ai: {
            ...settings.ai,
            apiKeySet: ai.apiKeySet === true,
            apiKeyMasked: typeof ai.apiKeyMasked === 'string' ? ai.apiKeyMasked : '',
            compatibleKeys: compatibleKeys as Partial<Record<CompatiblePreset, string>>,
        },
    };
}

export const useOptions = create<OptionsState>(() => ({ settings: viewOf(defaultSettings()), loaded: false, open: null }));

export const optionsNow = (): StudioSettingsView => useOptions.getState().settings;

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const http: Fetch = (url, init) => globalThis.fetch(url, init);

/** Loads the settings from the server; on failure the app keeps the defaults (and says so on the Options page). */
export async function loadOptions(fetcher: Fetch = http): Promise<boolean> {
    try {
        const response = await fetcher('/api/settings');
        if (!response.ok) {
            return false;
        }
        useOptions.setState({ settings: viewFromServer(await response.json()), loaded: true });
        return true;
    } catch {
        return false;
    }
}

async function send(url: string, method: string, body: unknown, fetcher: Fetch): Promise<{ error: string } | null> {
    try {
        const response = await fetcher(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const answer = await response.json().catch(() => null) as { error?: unknown } | null;
        if (!response.ok) {
            return { error: typeof answer?.error === 'string' ? answer.error : `The server refused the settings (${response.status}).` };
        }
        useOptions.setState({ settings: viewFromServer(answer), loaded: true });
        return null;
    } catch {
        return { error: 'The server is not answering, so the settings were not saved.' };
    }
}

/** Saves whole categories; the app picks them up at once. Returns the server's reason when it refused them. */
export function saveOptions(patch: OptionsPatch, fetcher: Fetch = http): Promise<{ error: string } | null> {
    return send('/api/settings', 'PUT', patch, fetcher);
}

/** Puts categories back to their defaults on the server (the API key stays until it is removed). */
export function resetOptions(categories: SettingsCategory[], fetcher: Fetch = http): Promise<{ error: string } | null> {
    return send('/api/settings/reset', 'POST', { categories }, fetcher);
}

export interface AiTestResult {
    ok: boolean;
    model?: string;
    credential?: string;
    ms: number;
    reply?: string;
    error?: string;
    models?: { value: string; name: string; efforts?: Effort[] }[];
}

/** Test connection: one short request with what the form shows (a typed key is used, not saved). */
export async function testAiConnection(form: {
    provider?: AiProvider; auth?: AiAuth; apiKey?: string; model: string; effort?: Effort; preset?: CompatiblePreset; baseUrl?: string;
}, fetcher: Fetch = http): Promise<AiTestResult> {
    try {
        const response = await fetcher('/api/settings/ai-test', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form),
        });
        return await response.json() as AiTestResult;
    } catch {
        return { ok: false, ms: 0, error: 'The server is not answering.' };
    }
}

export function openOptions(category: SettingsCategory = 'general'): void {
    useOptions.setState({ open: category });
}

export function closeOptions(): void {
    useOptions.setState({ open: null });
}

// ---- What the rest of the app reads --------------------------------------------------------------------------

/** Ask before deleting projects, parts and history steps (General > Confirmations). */
export const confirmDeletes = (): boolean => optionsNow().general.confirmDelete;

/** A component dragged in the assembly moves within its mates' freedom (General > Assemblies). */
export const movesComponentsByDragging = (): boolean => optionsNow().general.moveComponentsByDragging !== false;

/** The saved defaults of a tool's new forms (Defaults), by field key. */
export function savedToolDefaults(toolId: string): Record<string, ToolDefaultValue> {
    return optionsNow().defaults[toolId] ?? {};
}

/** One saved default as a number, or `fallback` when none is saved or it is not a number. */
export function toolDefaultNumber(toolId: string, key: string, fallback: number): number {
    const value = savedToolDefaults(toolId)[key];
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

/** A new form's starting values: the tool's own defaults, then the saved ones for the keys the tool has. */
export function withSavedDefaults<V extends Record<string, unknown>>(toolId: string, values: V): V {
    const saved = savedToolDefaults(toolId);
    const out: Record<string, unknown> = { ...values };
    for (const [key, value] of Object.entries(saved)) {
        // Only keys the form has, with a value of the same kind (text for text, a check box for a check box).
        if (key in values && typeof values[key] === typeof value) {
            out[key] = value;
        }
    }
    return out as V;
}

/**
 * A new sketch feature's options from the saved Extrude, Cut and Revolve defaults, for the sketch finish panel (which
 * starts from these rather than from the Extrude form's values). A cut's direction is not taken: it follows the sketch.
 */
export function savedFinishOptions(intent: string): {
    distance: number; angle: number; direction?: ExtrudeDirection; end?: ExtrudeEnd; through?: boolean; draft?: number; draftOutward?: boolean;
    type?: RevolveType;
} {
    const tool = intent === 'cut' ? 'cut' : 'extrude';
    const d = savedToolDefaults(tool);
    const out: ReturnType<typeof savedFinishOptions> = {
        distance: toolDefaultNumber(tool, 'distance', 10),
        angle: toolDefaultNumber('revolve', 'angle', 360),
    };
    if (tool === 'extrude' && (d.direction === 'normal' || d.direction === 'reverse' || d.direction === 'symmetric')) {
        out.direction = d.direction;
    }
    if (d.end === 'blind' || d.end === 'throughAll' || d.end === 'upToNext') {
        out.end = d.end;
        out.through = d.end === 'throughAll';
    }
    if (d.draft === true) {
        out.draft = toolDefaultNumber(tool, 'draftAngle', 1);
        out.draftOutward = d.draftOutward === true;
    }
    const revolveType = savedToolDefaults('revolve').revolveType;
    if (revolveType === 'blind' || revolveType === 'midPlane') {
        out.type = revolveType;
    }
    return out;
}
