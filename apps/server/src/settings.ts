// The studio's settings file: one JSON file in the data folder, readable and writable by the owner only (it holds the
// Anthropic API key when one is set). The key never leaves this module except to the assistant's own calls; the web
// sees it masked.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
    applyPatch, defaultSettings, EFFORTS, maskKey, normaliseSettings, resetCategory, SETTINGS_CATEGORIES, validModel,
    type AiSettings, type Effort, type SettingsCategory, type StudioSettings, type StudioSettingsView,
} from '@jarvis/core/settings';
import { SETTINGS_FILE } from './paths.js';

/** What the assistant needs to reach Claude. */
export interface AiConfig extends AiSettings {
    /** The Anthropic API key, or '' when none is kept. */
    apiKey: string;
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

export class SettingsStore {
    private settings: StudioSettings;
    private apiKey = '';
    private listeners = new Set<Listener>();

    constructor(private readonly file: string = SETTINGS_FILE, private readonly base: StudioSettings = serverDefaults()) {
        this.settings = normaliseSettings({}, base);
        this.load();
    }

    get(): StudioSettings {
        return this.settings;
    }

    /** The settings as the web may see them: the API key masked. */
    view(): StudioSettingsView {
        return {
            ...this.settings,
            ai: { ...this.settings.ai, apiKeySet: this.apiKey !== '', apiKeyMasked: maskKey(this.apiKey) },
        };
    }

    ai(): AiConfig {
        return { ...this.settings.ai, apiKey: this.apiKey };
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Applies whole categories from `patch` (see applyPatch). `ai.apiKey`: a string sets the key, '' removes it, absent
     * keeps it. Throws SettingsError for a key that cannot be one.
     */
    update(patch: unknown): StudioSettingsView {
        const ai = patch && typeof patch === 'object' ? (patch as { ai?: { apiKey?: unknown } }).ai : undefined;
        let key = this.apiKey;
        if (ai && typeof ai === 'object' && 'apiKey' in ai && ai.apiKey !== undefined && ai.apiKey !== null) {
            if (typeof ai.apiKey !== 'string') {
                throw new SettingsError('The API key must be text.');
            }
            const typed = ai.apiKey.trim();
            if (typed && !validApiKey(typed)) {
                throw new SettingsError('That does not look like an API key: it should be one word of letters, digits and dashes.');
            }
            key = typed;
        }
        this.commit(applyPatch(this.settings, patch, this.base), key);
        return this.view();
    }

    /** Puts the categories back to their defaults (the API key is kept; it is removed only on request). */
    reset(categories: SettingsCategory[] = SETTINGS_CATEGORIES): StudioSettingsView {
        let next = this.settings;
        for (const category of categories) {
            next = resetCategory(next, category, this.base);
        }
        this.commit(next, this.apiKey);
        return this.view();
    }

    private commit(next: StudioSettings, key: string): void {
        const previous = this.settings;
        this.settings = next;
        this.apiKey = key;
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
            const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { settings?: unknown; secrets?: { anthropicApiKey?: unknown } };
            this.settings = normaliseSettings(raw.settings ?? {}, this.base);
            const key = raw.secrets?.anthropicApiKey;
            this.apiKey = typeof key === 'string' && validApiKey(key) ? key : '';
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
        const data = JSON.stringify({ version: 1, settings: this.settings, secrets: this.apiKey ? { anthropicApiKey: this.apiKey } : {} }, null, 2);
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
