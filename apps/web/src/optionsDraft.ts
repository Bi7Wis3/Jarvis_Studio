// The Options page's working copy: what the pages edit until Apply or OK saves it (Cancel drops it), and how it becomes
// the patch sent to the server. Kept apart from the page so it can be tested without a browser.

import {
    defaultSettings, SETTINGS_CATEGORIES, validBaseUrl, type CompatiblePreset, type SettingsCategory, type StudioSettings,
    type StudioSettingsView,
} from '@jarvis/core/settings';
import type { OptionsPatch } from './options';
import { checkDefaults, DEFAULTS_TOOLS, defaultsValues, savedDefaults } from './optionsDefaults';
import { currentSketch, readSketchBlob, type SketchBlob } from './optionsSync';
import { DEFAULT_SKETCH_SETTINGS } from './sketchSettings';
import { sketchSettingsOf, sketchSettingValues } from './sketchSettingsForm';
import { DEFAULT_SPLINE_OPTIONS } from './sketchSplineTools';
import { DEFAULT_TOGGLES } from './sketchToggles';
import type { Values } from './toolDefs';

export interface Draft {
    /** Every category but the sketch one and the tool defaults, which are edited as form values below. */
    settings: StudioSettings;
    /** The sketch settings as the Sketch settings form holds them (text for numbers). */
    sketch: Values;
    sketchRest: Pick<SketchBlob, 'toggles' | 'snapsOff'>;
    /** Per tool under Defaults: its form values. */
    defaults: Record<string, Values>;
    /** A new API key typed, '' to remove the kept one, null to keep it as it is. */
    apiKey: string | null;
    /** The same for the OpenAI-compatible services, by preset (a preset left out keeps its key). */
    compatibleKeys?: Partial<Record<CompatiblePreset, string>>;
}

/** Pages of the Options tree; a page belongs to one settings category (`defaults:<tool>` pages to Defaults). */
export type PageId = SettingsCategory | 'relations' | 'grid' | `defaults:${string}`;

export const pageCategory = (page: PageId): SettingsCategory =>
    page === 'relations' || page === 'grid' ? 'sketch' : page.startsWith('defaults:') ? 'defaults' : page as SettingsCategory;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Form values of a sketch blob, as the Sketch settings form has them. */
export function sketchValues(blob: SketchBlob): Values {
    return {
        snap: blob.snap, snapModel: blob.snapModel, ...sketchSettingValues(blob.settings),
        splineHandles: blob.splines.handles, splinePolygon: blob.splines.polygon, splineBounding: blob.splines.bounding,
    };
}

/** The draft the page opens with: the saved settings, and the sketch settings as the sketcher has them now. */
export function draftOf(saved: StudioSettingsView): Draft {
    const { apiKeySet: _set, apiKeyMasked: _masked, compatibleKeys: _keys, ...ai } = saved.ai;
    const blob = currentSketch();
    return {
        settings: clone({ ...saved, ai }),
        sketch: sketchValues(blob),
        sketchRest: { toggles: { ...blob.toggles }, snapsOff: [...blob.snapsOff] },
        defaults: Object.fromEntries(DEFAULTS_TOOLS.map((t) => [t.id, defaultsValues(t.id, saved.defaults[t.id])])),
        apiKey: null,
        compatibleKeys: {},
    };
}

/** The sketch form keys on each sketch page, for Reset on that page. */
export const SKETCH_PAGE_KEYS: Record<'sketch' | 'relations' | 'grid', string[]> = {
    sketch: ['autoSolve', 'noSolveMove', 'detachOnDrag', 'overrideDims', 'showRelations', 'useFullyDefined', 'displayPlane', 'previewDims',
        'ghostOnDrag', 'drivenOnCreate', 'relationsOnError', 'solveLimitOn', 'solveLimit', 'overDefPrompt', 'overDefDriven',
        'splineHandles', 'splinePolygon', 'splineBounding'],
    relations: ['snap', 'snapModel', 'autoRelations', 'snapAngle'],
    grid: ['gridDisplay', 'gridDash', 'gridAutoScale', 'gridMajor', 'gridMinorPerMajor', 'gridSnapPerMinor', 'gridSnapOnlyShown'],
};

const DEFAULT_SKETCH_VALUES: Values = sketchValues({
    settings: DEFAULT_SKETCH_SETTINGS, snap: true, snapModel: true, snapsOff: [], toggles: DEFAULT_TOGGLES, splines: DEFAULT_SPLINE_OPTIONS,
});

/** The draft with one page put back to its defaults (only that page: Reset in SolidWorks resets the page shown). */
export function resetPage(draft: Draft, page: PageId): Draft {
    const next: Draft = { ...draft, settings: { ...draft.settings } };
    if (page === 'sketch' || page === 'relations' || page === 'grid') {
        next.sketch = { ...draft.sketch, ...Object.fromEntries(SKETCH_PAGE_KEYS[page].map((k) => [k, DEFAULT_SKETCH_VALUES[k]])) };
        next.sketchRest = {
            toggles: page === 'sketch' ? { ...DEFAULT_TOGGLES } : draft.sketchRest.toggles,
            snapsOff: page === 'relations' ? [] : draft.sketchRest.snapsOff,
        };
    } else if (page === 'defaults') {
        next.defaults = Object.fromEntries(DEFAULTS_TOOLS.map((t) => [t.id, defaultsValues(t.id, undefined)]));
    } else if (page.startsWith('defaults:')) {
        const id = page.slice('defaults:'.length);
        next.defaults = { ...draft.defaults, [id]: defaultsValues(id, undefined) };
    } else {
        const category = page as Exclude<SettingsCategory, 'sketch' | 'defaults'>;
        (next.settings as unknown as Record<string, unknown>)[category] = clone(defaultSettings()[category]);
        if (category === 'ai') {
            next.apiKey = null;
            next.compatibleKeys = {};
        }
    }
    return next;
}

const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v);
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The patch that saves the draft: the categories that differ from the saved ones. Throws an Error with the reason when a
 * value cannot be saved (a sketch setting or a tool default out of range).
 */
export function draftPatch(draft: Draft, saved: StudioSettingsView): OptionsPatch {
    const blob: SketchBlob = {
        settings: sketchSettingsOf(draft.sketch),
        snap: !!draft.sketch.snap,
        snapModel: !!draft.sketch.snapModel,
        splines: { handles: !!draft.sketch.splineHandles, polygon: !!draft.sketch.splinePolygon, bounding: !!draft.sketch.splineBounding },
        toggles: draft.sketchRest.toggles,
        snapsOff: draft.sketchRest.snapsOff,
    };
    const defaults: StudioSettings['defaults'] = {};
    // Saved defaults of tools the page does not list are kept as they are.
    for (const [id, values] of Object.entries(saved.defaults)) {
        if (!DEFAULTS_TOOLS.some((t) => t.id === id)) {
            defaults[id] = values;
        }
    }
    for (const tool of DEFAULTS_TOOLS) {
        const values = draft.defaults[tool.id] ?? defaultsValues(tool.id, undefined);
        const problem = checkDefaults(tool.id, values);
        if (problem) {
            throw new Error(problem);
        }
        const kept = savedDefaults(tool.id, values);
        if (Object.keys(kept).length) {
            defaults[tool.id] = kept;
        }
    }
    const next: StudioSettings = { ...draft.settings, defaults };
    const compatible = next.ai.compatible;
    if (compatible.preset === 'custom' && compatible.baseUrl && !validBaseUrl(compatible.baseUrl)) {
        throw new Error('The custom base URL must start with http:// or https:// (AI assistant).');
    }
    const patch: Record<string, unknown> = {};
    const { apiKeySet: _set, apiKeyMasked: _masked, compatibleKeys: _keys, ...savedAi } = saved.ai;
    const savedPlain: StudioSettings = { ...saved, ai: savedAi };
    for (const category of SETTINGS_CATEGORIES) {
        // The file browser's folders are kept by the server as they change, never by this page; the toolbars by their
        // own module as they change (toolbarSync.ts), also while this page is open.
        if (category !== 'sketch' && category !== 'files' && category !== 'toolbars' && !same(next[category], savedPlain[category])) {
            patch[category] = next[category];
        }
    }
    if (!same(blob, readSketchBlob(saved.sketch))) {
        patch.sketch = blob;
    }
    const keys = draft.compatibleKeys ?? {};
    if (draft.apiKey !== null || Object.keys(keys).length) {
        patch.ai = { ...next.ai, ...(draft.apiKey !== null ? { apiKey: draft.apiKey } : {}), ...(Object.keys(keys).length ? { compatibleKeys: keys } : {}) };
    }
    return patch as OptionsPatch;
}

/** Whether the draft changes anything (Apply is offered only then). */
export function draftChanged(draft: Draft, saved: StudioSettingsView): boolean {
    try {
        return Object.keys(draftPatch(draft, saved)).length > 0;
    } catch {
        return true;
    }
}
