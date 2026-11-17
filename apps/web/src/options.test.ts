import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, defaultSettings, LIGHTING_PRESETS, normaliseSettings, type StudioSettings } from '@jarvis/core/settings';
import { angleText, formShownText, setShownPrecision, shownText } from './numberText';
import {
    confirmDeletes, loadOptions, openOptions, saveOptions, savedToolDefaults, toolDefaultNumber, useOptions, viewOf, withSavedDefaults,
} from './options';
import { changeDefault, checkDefaults, defaultsOf, DEFAULTS_TOOLS, defaultsValues, savedDefaults, shownDefaults } from './optionsDefaults';
import { draftOf, draftPatch, resetPage } from './optionsDraft';
import { applySettings, currentSketch, readSketchBlob, SKETCH_TOOL_DEFAULTS } from './optionsSync';
import { OPTIONS_TREE, OptionsPanel } from './OptionsPage';
import { AiPage } from './optionsPages';
import { LightingPage } from './optionsLighting';
import { loadSolver } from './solver';
import { easeOnce, lightDirection, pixelRatioRange, SMOOTH_TIME, transitionTimes } from './sceneLook';
import { finishDefaults, useSketcher } from './sketcher';
import { useSketchToggles } from './sketchToggles';
import { sketchCanvas } from './sketchViewMode';
import { useStudio } from './state';
import { useDisplayStyle } from './displayStyle';
import { ALL_TOOLS } from './toolDefs';
import { useToolForm } from './toolForm';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

type Call = { url: string; method?: string; body?: unknown };

/** A fake server holding settings, answering like the real routes. */
function fakeServer(initial: StudioSettings = defaultSettings()) {
    let settings = initial;
    const calls: Call[] = [];
    const fetcher = async (url: string, init?: { method?: string; body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init?.method, body });
        if (init?.method === 'PUT') {
            if (body?.ai?.apiKey === 'bad key') {
                return { ok: false, status: 400, json: async () => ({ error: 'That does not look like an API key.' }) };
            }
            settings = { ...settings, ...body };
        }
        return { ok: true, status: 200, json: async () => ({ ...viewOf(settings), ai: { ...settings.ai, apiKeySet: false, apiKeyMasked: '' } }) };
    };
    return { fetcher, calls, get: () => settings };
}

const setSettings = (patch: Partial<StudioSettings>) =>
    useOptions.setState({ settings: viewOf({ ...defaultSettings(), ...patch }), loaded: true });

beforeEach(() => {
    useOptions.setState({ settings: viewOf(defaultSettings()), loaded: false, open: null });
    setShownPrecision({ length: 4, angle: 4, angleUnit: 'deg', form: null });
});

describe('the options store', () => {
    it('loads the settings from the server and keeps the defaults when it does not answer', async () => {
        const server = fakeServer({ ...defaultSettings(), general: { confirmDelete: false } });
        expect(await loadOptions(server.fetcher)).toBe(true);
        expect(useOptions.getState()).toMatchObject({ loaded: true, settings: { general: { confirmDelete: false } } });
        useOptions.setState({ settings: viewOf(defaultSettings()), loaded: false });
        expect(await loadOptions(async () => { throw new Error('offline'); })).toBe(false);
        expect(useOptions.getState().settings.general.confirmDelete).toBe(true);
    });

    it('saves whole categories and takes what the server answers; a refusal comes back as its reason', async () => {
        const server = fakeServer();
        expect(await saveOptions({ units: { ...DEFAULT_SETTINGS.units, lengthDecimals: 2 } }, server.fetcher)).toBeNull();
        expect(server.calls[0]).toMatchObject({ url: '/api/settings', method: 'PUT', body: { units: { lengthDecimals: 2 } } });
        expect(useOptions.getState().settings.units.lengthDecimals).toBe(2);
        expect(await saveOptions({ ai: { ...DEFAULT_SETTINGS.ai, apiKey: 'bad key' } }, server.fetcher)).toEqual({ error: 'That does not look like an API key.' });
        expect(await saveOptions({}, async () => { throw new Error('offline'); })).toMatchObject({ error: expect.stringContaining('not answering') });
    });

    it('answers the confirmation setting', () => {
        expect(confirmDeletes()).toBe(true);
        setSettings({ general: { confirmDelete: false } });
        expect(confirmDeletes()).toBe(false);
    });
});

describe('tool defaults', () => {
    it('start new forms from the saved values, only for keys the form has and of the same kind', () => {
        setSettings({ defaults: { fillet: { r: '3.25', tangent: false, nonsense: 'x' } } });
        expect(savedToolDefaults('fillet')).toEqual({ r: '3.25', tangent: false, nonsense: 'x' });
        const fillet = ALL_TOOLS.find((t) => t.id === 'fillet')!;
        const values = withSavedDefaults('fillet', fillet.defaults!({ part: null, project: null, edit: null }));
        expect(values).toMatchObject({ r: '3.25', tangent: false, edges: 'vertical' });
        expect('nonsense' in values).toBe(false);
        expect(withSavedDefaults('fillet', { r: true })).toEqual({ r: true });
    });

    it('are what a new form opens with, while an edited step keeps its own values', () => {
        setSettings({ defaults: { chamfer: { type: 'distance', s: '0.75', d2: '1.5' } } });
        const chamfer = ALL_TOOLS.find((t) => t.id === 'chamfer')!;
        let opened: Record<string, unknown> = {};
        const Probe = ({ edit }: { edit: boolean }) => {
            const feature = { id: 'c1', op: 'chamfer', size: 3, edges: 'all' } as never;
            const ctx = { part: null, project: null, edit: edit ? { partId: 'p', feature } : null };
            opened = useToolForm(chamfer, ctx, () => {}).values;
            return null;
        };
        renderToStaticMarkup(createElement(Probe, { edit: false }));
        expect(opened).toMatchObject({ type: 'distance', s: '0.75', d2: '1.5', edges: 'top' });
        renderToStaticMarkup(createElement(Probe, { edit: true }));
        expect(opened).toMatchObject({ type: 'equal', s: '3', edges: 'all' });
    });

    it('give a new sketch feature its depth and angle', () => {
        expect(finishDefaults(null, null)).toMatchObject({ distance: 10, angle: 360 });
        setSettings({ defaults: { extrude: { distance: '25.125' }, revolve: { angle: '180' } } });
        expect(finishDefaults(null, null)).toMatchObject({ distance: 25.125, angle: 180 });
        expect(toolDefaultNumber('extrude', 'distance', 10)).toBe(25.125);
        expect(toolDefaultNumber('chamfer', 's', 1)).toBe(1);
        setSettings({ defaults: { extrude: { end: 'throughAll', direction: 'symmetric', draft: true, draftAngle: '2.5' }, revolve: { revolveType: 'midPlane' } } });
        expect(finishDefaults(null, null)).toMatchObject({ end: 'throughAll', through: true, direction: 'symmetric', draft: 2.5, type: 'midPlane' });
        // Editing a base body keeps its own options.
        const base = finishDefaults(null, { extrude: { distance: 5 } });
        expect(base).toMatchObject({ distance: 5, direction: 'normal', through: false });
        expect(base.end).toBeUndefined();
    });

    it('list fields of every tool from the tool itself', () => {
        for (const tool of DEFAULTS_TOOLS) {
            const { fields, builtIn } = defaultsOf(tool.id);
            expect(fields.length, tool.id).toBeGreaterThan(0);
            for (const key of tool.keys) {
                expect(key in builtIn, `${tool.id}.${key}`).toBe(true);
            }
        }
        expect(defaultsOf('fillet').builtIn).toEqual({ tangent: true, edges: 'vertical', r: '2' });
    });

    it('follow the form: a thread size sets its diameter and pitch, a hole kind shows its own fields', () => {
        const values = changeDefault('thread', defaultsValues('thread', undefined), 'size', 'M6');
        expect(values).toMatchObject({ size: 'M6', diameter: '6', pitch: '1' });
        expect(savedDefaults('thread', values)).toEqual({ size: 'M6', diameter: '6', pitch: '1' });
        const extrude = changeDefault('extrude', defaultsValues('extrude', undefined), 'end', 'throughAll');
        expect(savedDefaults('extrude', extrude)).toEqual({ end: 'throughAll', through: true });
        const hole = defaultsValues('hole', { kind: 'plain' });
        const keys = shownDefaults(defaultsOf('hole').fields, hole).map((f) => f.key);
        expect(keys).toContain('diameter');
        expect(keys).not.toContain('size');
    });

    it('refuse numbers that are not numbers or out of range', () => {
        expect(checkDefaults('fillet', { ...defaultsValues('fillet', undefined), r: 'abc' })).toMatch(/Radius must be a number/);
        expect(checkDefaults(SKETCH_TOOL_DEFAULTS, { filletRadius: '1', chamferDistance: '1', sides: '50' })).toMatch(/Polygon sides/);
        expect(checkDefaults('fillet', defaultsValues('fillet', undefined))).toBeNull();
    });
});

describe('shown precision', () => {
    it('rounds what is shown, never the value', () => {
        expect(shownText(1.23456789)).toBe('1.2346');
        setShownPrecision({ length: 2 });
        expect(shownText(1.23456789)).toBe('1.23');
        expect(formShownText('1.23456789')).toBe('1.23456789');
        setShownPrecision({ form: 3 });
        expect(formShownText('1.23456789')).toBe('1.235');
        expect(formShownText('abc')).toBe('abc');
        expect(formShownText('')).toBe('');
    });

    it('shows angles in degrees, degrees and minutes, with seconds, or radians', () => {
        expect(angleText(45.5)).toBe('45.5°');
        setShownPrecision({ angleUnit: 'dm', angle: 2 });
        expect(angleText(45.5)).toBe("45°30'");
        setShownPrecision({ angleUnit: 'dms', angle: 0 });
        expect(angleText(12.3456)).toBe('12°20\'44"');
        expect(angleText(-0.5)).toBe("−0°30'0\"");
        setShownPrecision({ angleUnit: 'rad', angle: 4 });
        expect(angleText(180)).toBe('3.1416 rad');
    });
});

describe('the draft of the Options page', () => {
    it('saves nothing when nothing changed, and only the changed categories otherwise', () => {
        const saved = viewOf(defaultSettings());
        const draft = draftOf(saved);
        // A sketch category that was never saved is saved with the first change.
        const first = draftPatch(draft, saved);
        expect(Object.keys(first)).toEqual(['sketch']);
        const synced = viewOf({ ...defaultSettings(), sketch: first.sketch! });
        expect(draftPatch(draftOf(synced), synced)).toEqual({});
        const changed = { ...draftOf(synced) };
        changed.settings = { ...changed.settings, display: { ...changed.settings.display, meshQuality: 'coarse' } };
        changed.defaults = { ...changed.defaults, fillet: { ...changed.defaults.fillet, r: '4' } };
        const patch = draftPatch(changed, synced);
        expect(Object.keys(patch).sort()).toEqual(['defaults', 'display']);
        expect(patch.defaults).toEqual({ fillet: { r: '4' } });
        expect(draftPatch({ ...changed, apiKey: 'sk-ant-x123456789' }, synced).ai).toMatchObject({ apiKey: 'sk-ant-x123456789', auth: 'local' });
    });

    it('refuses a sketch setting out of range', () => {
        const saved = viewOf(defaultSettings());
        const draft = draftOf(saved);
        expect(() => draftPatch({ ...draft, sketch: { ...draft.sketch, snapAngle: '500' } }, saved)).toThrow(/Snap angle/);
    });

    it('resets only the page shown', () => {
        const saved = viewOf(defaultSettings());
        const draft = draftOf(saved);
        draft.settings.units = { ...draft.settings.units, lengthDecimals: 1 };
        draft.settings.display = { ...draft.settings.display, bloom: false };
        draft.sketch = { ...draft.sketch, gridMajor: '25', snapAngle: '5' };
        draft.defaults = { ...draft.defaults, fillet: { ...draft.defaults.fillet, r: '9' }, chamfer: { ...draft.defaults.chamfer, s: '3' } };
        const units = resetPage(draft, 'units');
        expect(units.settings.units).toEqual(DEFAULT_SETTINGS.units);
        expect(units.settings.display.bloom).toBe(false);
        const grid = resetPage(draft, 'grid');
        expect(grid.sketch).toMatchObject({ gridMajor: '10', snapAngle: '5' });
        const fillet = resetPage(draft, 'defaults:fillet');
        expect(fillet.defaults.fillet.r).toBe('2');
        expect(fillet.defaults.chamfer.s).toBe('3');
        const ai = resetPage({ ...draft, apiKey: 'typed' }, 'ai');
        expect(ai.apiKey).toBeNull();
    });
});

describe('applying saved settings to the app', () => {
    it('puts the sketch settings, toggles, view toggles and sketch tool sizes into their modules', () => {
        const blob = currentSketch();
        const sketch = {
            ...blob,
            settings: { ...blob.settings, snapAngle: 7.5, gridMajor: 20 },
            snapsOff: ['grid', 'tangent'],
            toggles: { ...blob.toggles, instant2d: false },
        };
        applySettings({
            ...defaultSettings(),
            sketch: sketch as unknown as Record<string, unknown>,
            display: { ...DEFAULT_SETTINGS.display, edges: false, perspective: { model: false, sketch: true } },
            units: { ...DEFAULT_SETTINGS.units, lengthDecimals: 1 },
            defaults: { [SKETCH_TOOL_DEFAULTS]: { filletRadius: '1.5', sides: '8' } },
        });
        const s = useSketcher.getState();
        expect(s.settings).toMatchObject({ snapAngle: 7.5, gridMajor: 20 });
        expect(s.grid).toBe(2);
        expect(s.snapKinds).toMatchObject({ grid: false, tangent: false });
        expect(useSketchToggles.getState().instant2d).toBe(false);
        expect(useStudio.getState()).toMatchObject({ edges: false, perspective: { model: false, sketch: true } });
        expect(s).toMatchObject({ filletRadius: 1.5, chamferDistance: 2, sides: 8 });
        expect(shownText(1.26)).toBe('1.3');
        expect(readSketchBlob(sketch as unknown as Record<string, unknown>)).toEqual(currentSketch());
    });

    it('puts the display style into the view; Show model edges is Shaded with edges against Shaded', () => {
        applySettings({ ...defaultSettings(), display: { ...DEFAULT_SETTINGS.display, style: 'hiddenVisible', hiddenEdges: 'solid', seeThrough: true } });
        expect(useDisplayStyle.getState()).toEqual({ style: 'hiddenVisible', hiddenEdges: 'solid', seeThrough: true });
        applySettings({ ...defaultSettings(), display: { ...DEFAULT_SETTINGS.display, style: 'shadedEdges', edges: false } });
        expect(useDisplayStyle.getState().style).toBe('shaded');
        expect(useStudio.getState().edges).toBe(false);
        applySettings({ ...defaultSettings(), display: { ...DEFAULT_SETTINGS.display, style: 'shaded', edges: true } });
        expect(useDisplayStyle.getState()).toEqual({ style: 'shadedEdges', hiddenEdges: 'dashed', seeThrough: false });
        expect(useStudio.getState().edges).toBe(true);
    });

    it('reads a damaged sketch category leniently', () => {
        expect(readSketchBlob({})).toBeNull();
        const blob = readSketchBlob({ settings: { snapAngle: 'x', autoSolve: false }, snapsOff: ['grid', 'nonsense'], toggles: 5 })!;
        expect(blob.settings.snapAngle).toBe(15);
        expect(blob.settings.autoSolve).toBe(false);
        expect(blob.snapsOff).toEqual(['grid']);
        expect(blob.toggles.instant2d).toBe(true);
    });
});

describe('the view settings', () => {
    it('points the lights where the view always had them', () => {
        const key = LIGHTING_PRESETS.studio.directional[0];
        const d = lightDirection(key.azimuth, key.elevation);
        const old = [300, 600, 400].map((v) => v / Math.hypot(300, 600, 400));
        d.forEach((v, i) => expect(v).toBeCloseTo(old[i], 3));
        const panel = LIGHTING_PRESETS.studio.environment.formers[1];
        const p = lightDirection(panel.azimuth, panel.elevation).map((v) => v * panel.distance);
        [-8, 2, 3].forEach((v, i) => expect(p[i]).toBeCloseTo(v, 1));
    });

    it('maps the transition speed, pixel ratio and sketch quality', () => {
        expect(transitionTimes('normal')).toEqual({ smoothTime: 0.22, settleMs: 1800, smooth: true });
        expect(transitionTimes('off').smooth).toBe(false);
        expect(transitionTimes('slow').smoothTime).toBeGreaterThan(transitionTimes('fast').smoothTime);
        expect(pixelRatioRange(2)).toEqual([1, 2]);
        expect(sketchCanvas(false, 3)).toEqual({ frameloop: 'always', dpr: [1, 3] });
        expect(sketchCanvas(true, 3)).toEqual({ frameloop: 'demand', dpr: 1 });
    });

    it('eases only the view change at the chosen speed, then goes back to the usual easing', () => {
        const listeners = new Map<string, Set<() => void>>();
        const controls = {
            smoothTime: SMOOTH_TIME,
            addEventListener: (type: string, f: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(f),
            removeEventListener: (type: string, f: () => void) => void listeners.get(type)?.delete(f),
        };
        easeOnce(controls, transitionTimes('slow').smoothTime);
        expect(controls.smoothTime).toBe(0.45);
        for (const f of [...(listeners.get('rest') ?? [])]) {
            f();
        }
        expect(controls.smoothTime).toBe(SMOOTH_TIME);
        expect(listeners.get('rest')?.size).toBe(0);
        expect(listeners.get('controlstart')?.size).toBe(0);
    });
});

describe('the Options page', () => {
    it('has every category in its tree and draws each page', () => {
        const pages = OPTIONS_TREE.flatMap((n) => [n.page, ...(n.children ?? []).map((c) => c.page)]);
        for (const category of ['general', 'sketch', 'defaults', 'units', 'display', 'lighting', 'ai', 'toolbars']) {
            expect(pages).toContain(category);
        }
        const draw = (page: string) => renderToStaticMarkup(createElement(OptionsPanel, { initial: page as never }));
        for (const page of pages) {
            const html = draw(page);
            expect(html, page).toContain('Reset to defaults');
            expect(html, page).toContain('Apply');
        }
        expect(draw('ai')).toContain('Test connection');
        expect(draw('ai')).toContain('Claude Code on this computer');
        expect(draw('toolbars')).toContain('Reset all toolbars');
        expect(draw('defaults:thread')).toContain('Pitch');
        expect(draw('lighting')).toContain('Add directional light');
        expect(draw('lighting')).toContain('Add point light');
        expect(draw('lighting')).toContain('Add spot light');
        expect(draw('lighting')).toContain('The frustum is the view&#x27;s camera');
        openOptions('display');
        expect(useOptions.getState().open).toBe('display');
    });

    it('lists every kind of light, and says which turn with the view', () => {
        const lighting = normaliseSettings({ lighting: { ...LIGHTING_PRESETS.studio, point: [{ id: 'lamp' }], spot: [{ id: 'beam', lockToModel: false }] } }).lighting;
        const saved = viewOf({ ...defaultSettings(), lighting });
        const html = renderToStaticMarkup(createElement(LightingPage, { draft: draftOf(saved), setDraft: () => {}, saved, page: 'lighting', onPage: () => {} }));
        for (const row of ['Directional 1', 'Directional 2', 'Point 1', 'Spot 1', 'Panel 4', 'turns with the view']) {
            expect(html).toContain(row);
        }
        // Nothing is picked yet: only the rows show, not their settings.
        expect(html).not.toContain('Cone angle');
    });

    it('never shows the API key, only its mask', () => {
        const saved = { ...viewOf(defaultSettings()), ai: { ...DEFAULT_SETTINGS.ai, auth: 'apiKey' as const, apiKeySet: true, apiKeyMasked: '••••••••WXYZ' } };
        const html = renderToStaticMarkup(createElement(AiPage, { draft: draftOf(saved), setDraft: () => {}, saved, page: 'ai', onPage: () => {} }));
        expect(html).toContain('Key kept: ••••••••WXYZ');
        expect(html).toContain('type="password"');
    });
});
