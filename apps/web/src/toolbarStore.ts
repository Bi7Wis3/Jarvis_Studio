// Where the toolbar arrangement (toolbarLayout.ts) is kept: in this browser's local storage under one key, read once
// at start and written on every change. loadArrangement and saveArrangement are the only places that touch storage.
// The settings file keeps it too (toolbarSync.ts), and wins once it has loaded.

import { create } from 'zustand';
import type { ToolbarArrangement, ToolbarPrefs } from './toolbarLayout';

const KEY = 'jarvis.toolbars';
const SIZES = ['small', 'medium', 'large'];

/** Keeps only well-formed choices, so a damaged or older entry cannot break the toolbar. */
export function cleanArrangement(raw: unknown): ToolbarArrangement {
    const out: ToolbarArrangement = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return out;
    }
    const ids = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((id) => typeof id === 'string') ? [...v] : undefined);
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        const v = value as Record<string, unknown>;
        const prefs: ToolbarPrefs = {};
        if (v.hidden === true) prefs.hidden = true;
        const tools = ids(v.tools);
        if (tools) {
            prefs.tools = tools;
            prefs.base = ids(v.base);
        }
        if (typeof v.size === 'string' && SIZES.includes(v.size)) prefs.size = v.size as ToolbarPrefs['size'];
        if (v.labels === true) prefs.labels = true;
        if (v.families === 'separate') prefs.families = 'separate';
        if (v.tips === 'name' || v.tips === 'off') prefs.tips = v.tips;
        if (Object.keys(prefs).length) {
            out[key] = prefs;
        }
    }
    return out;
}

export function loadArrangement(): ToolbarArrangement {
    try {
        return cleanArrangement(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
    } catch {
        return {};
    }
}

export function saveArrangement(arrangement: ToolbarArrangement): void {
    try {
        if (Object.keys(arrangement).length) {
            localStorage.setItem(KEY, JSON.stringify(arrangement));
        } else {
            localStorage.removeItem(KEY);
        }
    } catch {
        // Private mode or no storage: the arrangement lasts for this visit only.
    }
}

export const useToolbarArrangement = create<{ arrangement: ToolbarArrangement }>(() => ({ arrangement: loadArrangement() }));

/** Sets one toolbar's choices (null or empty: back to its defaults) and keeps them. */
export function setToolbarPrefs(key: string, prefs: ToolbarPrefs | null): void {
    const { [key]: _old, ...rest } = useToolbarArrangement.getState().arrangement;
    const arrangement = prefs && Object.keys(prefs).length ? { ...rest, [key]: prefs } : rest;
    useToolbarArrangement.setState({ arrangement });
    saveArrangement(arrangement);
}

/** Every toolbar back to its defaults. */
export function resetArrangement(): void {
    useToolbarArrangement.setState({ arrangement: {} });
    saveArrangement({});
}
