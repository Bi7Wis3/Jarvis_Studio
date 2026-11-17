// Keeps the toolbars (toolbarStore.ts: each toolbar's tools and look; floatingToolbars.ts: floating toolbars and the
// lock) in the settings file's `toolbars` category, as optionsSync.ts does for the sketch settings: local storage
// stays a quick cache for the first frame, the settings file is where they are kept. The category holds lists, not
// maps, because a saved category is merged into the old one key by key (a toolbar reset would come back) while a
// list is replaced whole.

import { saveOptions, useOptions } from './options';
import { cleanArrangement, saveArrangement, useToolbarArrangement } from './toolbarStore';
import type { ToolbarArrangement } from './toolbarLayout';
import { cleanFloating, replaceFloating, useFloatingToolbars, type FloatingSet } from './floatingToolbars';

/** The `toolbars` category as kept in the settings file. */
export interface ToolbarsBlob {
    v: 1;
    arrangement: Record<string, unknown>[];
    floating: Record<string, unknown>[];
    locked: boolean;
}

export interface ToolbarsState {
    arrangement: ToolbarArrangement;
    floating: FloatingSet;
    locked: boolean;
}

export function toolbarsBlob(state: ToolbarsState): ToolbarsBlob {
    const sorted = <T>(record: Record<string, T>) => Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
    return {
        v: 1,
        arrangement: sorted(state.arrangement).map(([key, prefs]) => ({ key, ...prefs })),
        floating: sorted(state.floating).map(([key, s]) => ({ key, ...s })),
        locked: state.locked,
    };
}

/** A saved category read leniently (anything damaged is left out), or null when none was saved yet. */
export function readToolbarsBlob(raw: unknown): ToolbarsState | null {
    if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) {
        return null;
    }
    const r = raw as Record<string, unknown>;
    const entries = (list: unknown) => (Array.isArray(list) ? list : [])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { key?: unknown }).key === 'string')
        .map((e) => [e.key as string, e] as const);
    return {
        arrangement: cleanArrangement(Object.fromEntries(entries(r.arrangement))),
        floating: cleanFloating(Object.fromEntries(entries(r.floating))),
        locked: r.locked === true,
    };
}

export const toolbarsNow = (): ToolbarsState => ({
    arrangement: useToolbarArrangement.getState().arrangement,
    floating: useFloatingToolbars.getState().floating,
    locked: useFloatingToolbars.getState().locked,
});

/** Equal as data, whatever the order of the keys. */
const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, stable(x)])) : v);
const canonical = (state: ToolbarsState): string => JSON.stringify(stable(toolbarsBlob(state)));
const isEmpty = (state: ToolbarsState): boolean => !Object.keys(state.arrangement).length && !Object.keys(state.floating).length && !state.locked;
/** Kept under the settings file's limit for a category (plainData's 64 KB): beyond it, this browser keeps them only. */
const MAX_BYTES = 60 * 1024;

let applied = '';
let applying = false;
let waiting = false;
let sending = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Puts saved toolbars into the stores (and the local cache), unless this browser has newer ones on the way. */
export function applyToolbars(state: ToolbarsState): void {
    const key = canonical(state);
    if (key === applied || waiting || sending > 0) {
        return;
    }
    applied = key;
    applying = true;
    try {
        if (canonical(toolbarsNow()) !== key) {
            useToolbarArrangement.setState({ arrangement: state.arrangement });
            saveArrangement(state.arrangement);
            replaceFloating({ floating: state.floating, locked: state.locked });
        }
    } finally {
        applying = false;
    }
}

async function send(): Promise<void> {
    waiting = false;
    const state = toolbarsNow();
    const key = canonical(state);
    const blob = toolbarsBlob(state);
    if (key === applied || JSON.stringify(blob).length > MAX_BYTES) {
        return;
    }
    applied = key;
    sending += 1;
    try {
        await saveOptions({ toolbars: blob as unknown as Record<string, unknown> });
    } finally {
        sending -= 1;
    }
}

/** A toolbar changed here: save it (after a moment, once). */
function changed(): void {
    if (applying || !useOptions.getState().loaded) {
        return;
    }
    clearTimeout(timer);
    waiting = true;
    timer = setTimeout(() => void send(), 400);
}

let started = false;

/** Loads the toolbars from the settings and keeps them in step from then on. */
export function startToolbarSync(): void {
    if (started) {
        return;
    }
    started = true;
    const loaded = () => {
        const saved = readToolbarsBlob(useOptions.getState().settings.toolbars);
        if (saved) {
            applyToolbars(saved);
        } else if (!isEmpty(toolbarsNow())) {
            // First start with a settings file: this browser's toolbars become the saved ones.
            void send();
        } else {
            applied = canonical(toolbarsNow());
        }
    };
    if (useOptions.getState().loaded) {
        loaded();
    }
    useOptions.subscribe((s, prev) => {
        if (s.loaded && !prev.loaded) {
            loaded();
        } else if (s.loaded && s.settings.toolbars !== prev.settings.toolbars) {
            const saved = readToolbarsBlob(s.settings.toolbars);
            if (saved) {
                applyToolbars(saved);
            } else if (readToolbarsBlob(prev.settings.toolbars)) {
                // The category was reset: every toolbar at its defaults.
                applyToolbars({ arrangement: {}, floating: {}, locked: false });
            }
        }
    });
    useToolbarArrangement.subscribe(changed);
    useFloatingToolbars.subscribe(changed);
}
