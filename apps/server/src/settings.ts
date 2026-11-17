// The studio's settings file: one JSON file in the data folder, readable and writable by the owner only (it holds the
// Anthropic API key and the OpenAI-compatible services' keys when they are set). The keys never leave this module
// except to the assistant's own calls; the web sees them masked.

import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
    applyPatch, COMPATIBLE_PRESET_IDS, defaultSettings, EFFORTS, maskKey, normaliseSettings, resetCategory, SETTINGS_CATEGORIES,
    validModel, type AiSettings, type CompatiblePreset, type Effort, type SettingsCategory, type StudioSettings, type StudioSettingsView,
} from '@jarvis/core/settings';
import { SETTINGS_FILE } from './paths.js';

export type CompatibleKeys = Partial<Record<CompatiblePreset, string>>;

/** What the assistant needs to reach its model. */
export interface AiConfig extends AiSettings {
    /** The Anthropic API key, or '' when none is kept. */
    apiKey: string;
    /** The OpenAI-compatible services' keys, by preset (absent: none kept). */
    compatibleKeys?: CompatibleKeys;
}

type Listener = (next: StudioSettings, previous: StudioSettings) => void;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** A plausible API key: printable characters without spaces, of a sensible length. */
export function validApiKey(key: string): boolean {
    return key.length >= 8 && key.length <= 400 && /^[\x21-\x7e]+$/.test(key);
}

/** The built-in defaults, with the model and effort set by JARVIS_MODEL and JARVIS_EFFORT where given. */
export function serverDefaults(env: NodeJS.ProcessEnv = process.env): StudioSettings {
    const base = defaultSettings();
    if (validModel(env.JARVIS_MODEL)) {
        base.ai.fast.model = env.JARVIS_MODEL;
    }
    if (EFFORTS.includes(env.JARVIS_EFFORT as Effort)) {
        base.ai.fast.effort = env.JARVIS_EFFORT as Effort;
    }
    return base;
}

export class SettingsError extends Error {}

/** A key as typed: trimmed, '' for none. Throws SettingsError for one that cannot be a key. */
function typedKey(value: unknown): string {
    if (typeof value !== 'string') {
        throw new SettingsError('The API key must be text.');
    }
    const typed = value.trim();
    if (typed && !validApiKey(typed)) {
        throw new SettingsError('That does not look like an API key: it should be one word of letters, digits and dashes.');
    }
    return typed;
}

export class SettingsStore {
    private settings: StudioSettings;
    private apiKey = '';
    private compatibleKeys: CompatibleKeys = {};
    private listeners = new Set<Listener>();

    constructor(private readonly file: string = SETTINGS_FILE, private readonly base: StudioSettings = serverDefaults()) {
        this.settings = normaliseSettings({}, base);
        this.load();
    }

    get(): StudioSettings {
        return this.settings;
    }

    /** The settings as the web may see them: the keys masked. */
    view(): StudioSettingsView {
        const compatibleKeys = Object.fromEntries(Object.entries(this.compatibleKeys).map(([preset, key]) => [preset, maskKey(key)]));
        return {
            ...this.settings,
            ai: { ...this.settings.ai, apiKeySet: this.apiKey !== '', apiKeyMasked: maskKey(this.apiKey), compatibleKeys },
        };
    }

    ai(): AiConfig {
        return { ...this.settings.ai, apiKey: this.apiKey, compatibleKeys: { ...this.compatibleKeys } };
    }

    /** A fingerprint of every kept key, to tell when one changes without comparing (or keeping) the keys themselves. */
    keysStamp(): string {
        return createHash('sha256').update(JSON.stringify([this.apiKey, Object.entries(this.compatibleKeys).sort()])).digest('hex');
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Applies whole categories from `patch` (see applyPatch). `ai.apiKey`: a string sets the key, '' removes it, absent
     * keeps it. `ai.compatibleKeys`: the same for each preset named. Throws SettingsError for a key that cannot be one.
     */
    update(patch: unknown): StudioSettingsView {
        const ai = patch && typeof patch === 'object' ? (patch as { ai?: { apiKey?: unknown; compatibleKeys?: unknown } }).ai : undefined;
        let key = this.apiKey;
        if (ai && typeof ai === 'object' && 'apiKey' in ai && ai.apiKey !== undefined && ai.apiKey !== null) {
            key = typedKey(ai.apiKey);
        }
        const keys: CompatibleKeys = { ...this.compatibleKeys };
        if (ai && typeof ai === 'object' && ai.compatibleKeys !== undefined && ai.compatibleKeys !== null) {
            if (typeof ai.compatibleKeys !== 'object' || Array.isArray(ai.compatibleKeys)) {
                throw new SettingsError('The keys must be given by service.');
            }
            for (const [preset, value] of Object.entries(ai.compatibleKeys)) {
                if (!COMPATIBLE_PRESET_IDS.includes(preset as CompatiblePreset)) {
                    throw new SettingsError(`There is no service called ${preset.slice(0, 40)}.`);
                }
                if (value === undefined || value === null) {
                    continue;
                }
                const typed = typedKey(value);
                if (typed) {
                    keys[preset as CompatiblePreset] = typed;
                } else {
                    delete keys[preset as CompatiblePreset];
                }
            }
        }
        this.commit(applyPatch(this.settings, patch, this.base), key, keys);
        return this.view();
    }

    /** Puts the categories back to their defaults (the API key is kept; it is removed only on request). */
    reset(categories: SettingsCategory[] = SETTINGS_CATEGORIES): StudioSettingsView {
        let next = this.settings;
        for (const category of categories) {
            next = resetCategory(next, category, this.base);
        }
        this.commit(next, this.apiKey, this.compatibleKeys);
        return this.view();
    }

    private commit(next: StudioSettings, key: string, keys: CompatibleKeys): void {
        const previous = this.settings;
        this.settings = next;
        this.apiKey = key;
        this.compatibleKeys = keys;
        this.save();
        for (const listener of this.listeners) {
            listener(next, previous);
        }
    }

    private load(): void {
        if (!existsSync(this.file)) {
            return;
        }
        try {
            // A file someone made readable by others is closed up again before it is read.
            if ((statSync(this.file).mode & 0o077) !== 0) {
                chmodSync(this.file, FILE_MODE);
            }
            const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
                settings?: unknown; secrets?: { anthropicApiKey?: unknown; compatibleKeys?: unknown };
            };
            this.settings = normaliseSettings(raw.settings ?? {}, this.base);
            const key = raw.secrets?.anthropicApiKey;
            this.apiKey = typeof key === 'string' && validApiKey(key) ? key : '';
            const keys = raw.secrets?.compatibleKeys;
            this.compatibleKeys = {};
            for (const [preset, value] of Object.entries(keys && typeof keys === 'object' ? keys : {})) {
                if (COMPATIBLE_PRESET_IDS.includes(preset as CompatiblePreset) && typeof value === 'string' && validApiKey(value)) {
                    this.compatibleKeys[preset as CompatiblePreset] = value;
                }
            }
        } catch (error) {
            // Never print the file: it may hold the key.
            console.warn(`[settings] ${this.file} could not be read (${error instanceof Error ? error.name : 'error'}); using the defaults`);
        }
    }

    /** Written to a private temporary file first and renamed over the old one, so a crash never leaves half a file. */
    private save(): void {
        const dir = dirname(this.file);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: DIR_MODE });
            chmodSync(dir, DIR_MODE);
        }
        const secrets = {
            ...(this.apiKey ? { anthropicApiKey: this.apiKey } : {}),
            ...(Object.keys(this.compatibleKeys).length ? { compatibleKeys: this.compatibleKeys } : {}),
        };
        const data = JSON.stringify({ version: 1, settings: this.settings, secrets }, null, 2);
        const temp = `${this.file}.${process.pid}.tmp`;
        const fd = openSync(temp, 'w', FILE_MODE);
        try {
            writeSync(fd, data);
        } finally {
            closeSync(fd);
        }
        chmodSync(temp, FILE_MODE);
        renameSync(temp, this.file);
    }
}
