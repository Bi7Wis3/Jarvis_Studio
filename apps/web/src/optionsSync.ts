// Keeps the app's own setting stores and the saved settings (options.ts) in step. The sketch settings, snaps, sketch
// toggles, spline options, perspective, edges and grid live in their own modules (and their localStorage, as a quick
// cache); the settings file on the server is where they are kept. Saved settings are pushed into the modules, and a
// change made with the toolbar or a sketch form is saved back.

import type { StudioSettings, StudioSettingsView } from '@jarvis/core/settings';
import { setShownPrecision } from './numberText';
import { loadOptions, saveOptions, useOptions } from './options';
import { setSketchSettings, setSnapKind, useSketcher } from './sketcher';
import { useSketchModel, setSnapModel } from './sketchModel';
import { DEFAULT_SKETCH_SETTINGS, gridSnapStep, type SketchSettings } from './sketchSettings';
import { setSplineOptions, useSplineView, type SplineOptions } from './sketchSplineTools';
import { DEFAULT_TOGGLES, setSketchToggle, useSketchToggles, type SketchToggles } from './sketchToggles';
import { setPerspective, useStudio } from './state';
import { QUICK_SNAPS, type QuickSnap } from './snapping';

/** The sketch category as it is kept in the settings file. */
export interface SketchBlob {
    settings: SketchSettings;
    snap: boolean;
    /** Sketch snaps switched off (the rest are on). */
    snapsOff: QuickSnap[];
    toggles: SketchToggles;
    splines: SplineOptions;
    snapModel: boolean;
}

/** The pseudo tool id under Defaults for the sketch tools' starting values. */
export const SKETCH_TOOL_DEFAULTS = 'sketch';

/** The sketch settings as the modules hold them now. */
export function currentSketch(): SketchBlob {
    const s = useSketcher.getState();
    return {
        settings: { ...s.settings },
        snap: s.snap,
        snapsOff: QUICK_SNAPS.map((q) => q.kind).filter((k) => s.snapKinds[k] === false),
        toggles: { ...useSketchToggles.getState() },
        splines: { ...useSplineView.getState().options },
        snapModel: useSketchModel.getState().snapModel,
    };
}

/** A saved sketch category read leniently: anything missing or of the wrong kind is the module's default. */
export function readSketchBlob(raw: Record<string, unknown>): SketchBlob | null {
    if (!raw || Object.keys(raw).length === 0) {
        return null;
    }
    const pickTyped = <T extends object>(defaults: T, value: unknown): T => {
        const out = { ...defaults } as Record<string, unknown>;
        const given = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        for (const key of Object.keys(defaults)) {
            if (typeof given[key] === typeof out[key]) {
                out[key] = given[key];
            }
        }
        return out as T;
    };
    const current = currentSketch();
    return {
        settings: pickTyped(DEFAULT_SKETCH_SETTINGS, raw.settings),
        snap: typeof raw.snap === 'boolean' ? raw.snap : current.snap,
        snapsOff: Array.isArray(raw.snapsOff) ? QUICK_SNAPS.map((q) => q.kind).filter((k) => (raw.snapsOff as unknown[]).includes(k)) : [],
        toggles: pickTyped(DEFAULT_TOGGLES, raw.toggles),
        splines: pickTyped(current.splines, raw.splines),
        snapModel: typeof raw.snapModel === 'boolean' ? raw.snapModel : true,
    };
}

let applying = false;

/** Equal as data, whatever the order of the keys. */
function same(a: unknown, b: unknown): boolean {
    const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v);
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Puts a saved sketch category into the modules, changing only what differs. */
export function applySketch(blob: SketchBlob): void {
    const now = currentSketch();
    applying = true;
    try {
        const patch = Object.fromEntries(Object.entries(blob.settings).filter(([k, v]) => now.settings[k as keyof SketchSettings] !== v));
        if (Object.keys(patch).length) {
            setSketchSettings(patch as Partial<SketchSettings>);
            useSketcher.setState({ grid: gridSnapStep({ ...now.settings, ...patch }) });
        }
        if (blob.snap !== now.snap) {
            useSketcher.setState({ snap: blob.snap });
        }
        if (!same(blob.snapsOff, now.snapsOff)) {
            setSnapKind(null);
            for (const kind of blob.snapsOff) {
                setSnapKind(kind, false);
            }
        }
        for (const [key, on] of Object.entries(blob.toggles) as [keyof SketchToggles, boolean][]) {
            if (now.toggles[key] !== on) {
                setSketchToggle(key, on);
            }
        }
        if (!same(blob.splines, now.splines)) {
            setSplineOptions(blob.splines);
        }
        if (blob.snapModel !== now.snapModel) {
            setSnapModel(blob.snapModel);
        }
    } finally {
        applying = false;
    }
}

let appliedTools = '';
let appliedView = '';

/** Applies saved settings to the app: shown precision, the sketch modules, the view toggles, the sketch tools' sizes. */
export function applySettings(settings: StudioSettings | StudioSettingsView): void {
    const { units, display } = settings;
    setShownPrecision({ length: units.lengthDecimals, angle: units.angleDecimals, angleUnit: units.angleUnit, form: units.formDecimals });
    const blob = readSketchBlob(settings.sketch);
    if (blob) {
        applySketch(blob);
    }
    applying = true;
    try {
        // Only when they changed in the settings, so a value changed for this session is not put back on every save.
        const view = JSON.stringify([display.perspective, display.edges, display.grid]);
        if (view !== appliedView) {
            appliedView = view;
            const { perspective, edges, grid } = useStudio.getState();
            if (perspective.model !== display.perspective.model) {
                setPerspective('model', display.perspective.model);
            }
            if (perspective.sketch !== display.perspective.sketch) {
                setPerspective('sketch', display.perspective.sketch);
            }
            if (edges !== display.edges || grid !== display.grid) {
                useStudio.setState({ edges: display.edges, grid: display.grid });
            }
        }
        const tools = settings.defaults[SKETCH_TOOL_DEFAULTS] ?? {};
        const key = JSON.stringify(tools);
        if (key !== appliedTools) {
            appliedTools = key;
            const number = (k: string, fallback: number) => {
                const n = typeof tools[k] === 'string' ? Number(tools[k]) : NaN;
                return Number.isFinite(n) && n > 0 ? n : fallback;
            };
            useSketcher.setState({
                filletRadius: number('filletRadius', 5),
                chamferDistance: number('chamferDistance', 2),
                sides: Math.max(3, Math.min(40, Math.round(number('sides', 6)))),
            });
        }
    } finally {
        applying = false;
    }
}

let pending: ReturnType<typeof setTimeout> | undefined;

/** A sketch setting or view toggle changed outside the Options page: save it (after a moment, once). */
function changedElsewhere(): void {
    if (applying || !useOptions.getState().loaded) {
        return;
    }
    clearTimeout(pending);
    pending = setTimeout(() => {
        const saved = useOptions.getState().settings;
        const sketch = currentSketch();
        const { perspective, edges, grid } = useStudio.getState();
        const display = { ...saved.display, perspective: { ...perspective }, edges, grid };
        const patch: Partial<StudioSettings> = {};
        if (!same(readSketchBlob(saved.sketch), sketch)) {
            patch.sketch = sketch as unknown as Record<string, unknown>;
        }
        if (!same(display, saved.display)) {
            patch.display = display;
            appliedView = JSON.stringify([display.perspective, display.edges, display.grid]);
        }
        if (Object.keys(patch).length) {
            void saveOptions(patch);
        }
    }, 500);
}

let started = false;

/** Loads the settings and keeps the app in step with them from then on. */
export async function startOptions(): Promise<void> {
    if (started) {
        return;
    }
    started = true;
    if (await loadOptions()) {
        const saved = useOptions.getState().settings;
        if (!readSketchBlob(saved.sketch)) {
            // First start with a settings file: this browser's sketch settings and view toggles become the saved ones.
            const { perspective, edges, grid } = useStudio.getState();
            await saveOptions({ sketch: currentSketch() as unknown as Record<string, unknown>, display: { ...saved.display, perspective, edges, grid } });
        }
        applySettings(useOptions.getState().settings);
    }
    // Offline the app keeps what this browser had; settings saved later are applied as they arrive.
    useOptions.subscribe((s, prev) => {
        if (s.settings !== prev.settings) {
            applySettings(s.settings);
        }
    });
    useSketcher.subscribe((s, prev) => {
        if (s.settings !== prev.settings || s.snapKinds !== prev.snapKinds || s.snap !== prev.snap) {
            changedElsewhere();
        }
    });
    useSketchToggles.subscribe(changedElsewhere);
    useSplineView.subscribe((s, prev) => {
        if (s.options !== prev.options) {
            changedElsewhere();
        }
    });
    useSketchModel.subscribe((s, prev) => {
        if (s.snapModel !== prev.snapModel) {
            changedElsewhere();
        }
    });
    useStudio.subscribe((s, prev) => {
        if (s.perspective !== prev.perspective || s.edges !== prev.edges || s.grid !== prev.grid) {
            changedElsewhere();
        }
    });
}
