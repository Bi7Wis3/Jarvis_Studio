import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import type { ModelSketch } from '@jarvis/core/projection';
import { loadSolver } from './solver';
import { addCircle, EMPTY_GEOMETRY } from './sketchGeometry';
import {
    addRelationToSelection, applyDimension, currentSketch, setDimText, setTool, sketchClick, undoSketch, useSketcher,
} from './sketcher';
import { edgesKey, isModelLock, isModelReference, modelTarget, useSketchModel } from './sketchModel';
import { convertModelPicks, convertSelected, modelMenu, selectedReferences } from './sketchModelSelect';
import { sketchSpaceMenu, type SketchMenuActions } from './contextMenus';
import { ALL_TOOLS, type Ctx } from './toolDefs';
import type { MenuEntry } from './menus';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();
const geo = () => state().geometry;
/** After the click: references nothing uses are taken out once the click has finished. */
const settle = () => new Promise<void>((done) => queueMicrotask(done));
const references = (g: SketchGeometry = geo()) => [...g.curves.map((c) => c.id), ...g.points.map((p) => p.id)].filter(isModelReference);

/** A 40 x 20 plate with a hole of radius 5, as the kernel projects it onto the top plane at y 10. */
const plate: ModelSketch = {
    curves: [
        { kind: 'line', a: [0, 0], b: [40, 0], edge: 0 },
        { kind: 'line', a: [40, 0], b: [40, -20], edge: 1 },
        { kind: 'line', a: [40, -20], b: [0, -20], edge: 2 },
        { kind: 'line', a: [0, -20], b: [0, 0], edge: 3 },
        { kind: 'circle', center: [20, -10], radius: 5, edge: 4 },
    ],
    points: [[0, 0], [40, 0], [40, -20], [0, -20]],
    skipped: [],
};

let start: SketchGeometry;

beforeEach(() => {
    start = addCircle(EMPTY_GEOMETRY, { at: [10, -4] }, 2).g;
    useSketcher.setState({
        active: true, stage: 'draw', partId: 'plate', edit: null, plane: 'top', offset: 10, context: [], tool: 'select',
        geometry: start, labels: {}, picks: [], selection: [], dimDraft: null, dimDrag: null, undo: [], redo: [], message: null,
    });
    useSketchModel.setState({ edges: { [edgesKey(modelTarget(state())!, null)]: plate }, hover: null, picking: null, pendingPick: null });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('a click on a model edge selects it', () => {
    it('lights it up as the selection; the sketch is as it was once it is no longer selected', async () => {
        setTool('select');
        sketchClick([40.2, -12], TOL);
        await settle();
        const [picked] = state().selection;
        expect(picked).toMatchObject({ type: 'curve' });
        expect(isModelReference(picked.id)).toBe(true);
        // The edge as the line it is, locked where the model is; no undo step.
        expect(geo().curves.find((c) => c.id === picked.id)).toMatchObject({ kind: 'line', construction: true });
        expect(state().undo).toHaveLength(0);
        // Clicking off it: it goes again, and nothing is left of it.
        sketchClick([60, 30], TOL);
        await settle();
        expect(state().selection).toEqual([]);
        expect(references()).toEqual([]);
        expect(geo().curves).toEqual(start.curves);
        expect(geo().constraints).toEqual(start.constraints);
    });

    it('a vertex is selected as a point; Shift adds edges, and they all stay while selected', async () => {
        setTool('select');
        sketchClick([40.2, -20.2], TOL);
        sketchClick([20, -20.2], TOL, true);
        sketchClick([25.1, -10], TOL, true);
        await settle();
        expect(state().selection.map((x) => x.type)).toEqual(['point', 'curve', 'curve']);
        expect(selectedReferences()).toHaveLength(3);
        expect(geo().curves.filter((c) => isModelReference(c.id)).map((c) => c.kind).sort()).toEqual(['circle', 'line']);
    });

    it('a dimension made with it keeps it (quietly), and undo takes both away', async () => {
        setTool('dimension');
        sketchClick([12, -4], TOL);
        sketchClick([40.2, -12], TOL);
        await settle();
        expect(references().length).toBeGreaterThan(0);
        sketchClick([45, 5], TOL);
        setDimText('6.25');
        applyDimension();
        await settle();
        expect(state().dimDraft).toBeNull();
        const kept = geo().curves.find((c) => isModelReference(c.id));
        expect(kept).toMatchObject({ kind: 'line', construction: true });
        expect(geo().constraints.some((c) => c.kind === 'distance')).toBe(true);
        undoSketch();
        await settle();
        expect(references()).toEqual([]);
    });

    it('a relation made with the selection keeps it after it is deselected', async () => {
        setTool('select');
        sketchClick([12, -4], TOL);
        sketchClick([40.2, -12], TOL, true);
        expect(addRelationToSelection('tangent')).toBeNull();
        useSketcher.setState({ selection: [] });
        await settle();
        expect(geo().curves.filter((c) => isModelReference(c.id))).toHaveLength(1);
        expect(geo().constraints.some((c) => c.kind === 'tangent')).toBe(true);
    });

    it('finishing the sketch with a model edge only selected leaves no trace of it', () => {
        setTool('select');
        sketchClick([40.2, -12], TOL);
        expect(references().length).toBeGreaterThan(0);
        expect(references(currentSketch().geometry)).toEqual([]);
    });
});

describe('Convert entities and Copy as sketch entities', () => {
    const selectTwoSides = () => {
        setTool('select');
        sketchClick([40.2, -12], TOL);
        sketchClick([20, -20.2], TOL, true);
    };

    it('Convert entities: the selected edges as locked lines that share their corner; the references go', async () => {
        selectTwoSides();
        expect(convertSelected('convert')).toBeNull();
        await settle();
        const lines = geo().curves.filter((c) => c.kind === 'line');
        expect(lines).toHaveLength(2);
        expect(lines.every((c) => !c.construction && !isModelReference(c.id))).toBe(true);
        expect(references()).toEqual([]);
        // Locked where the model is, and joined at the corner (40, -20).
        const ends = lines.flatMap((c) => (c.kind === 'line' ? [c.a, c.b] : []));
        expect(new Set(ends).size).toBe(3);
        expect(geo().constraints.filter(isModelLock).map((c) => (c.kind === 'fix' ? c.point : ''))).toEqual(expect.arrayContaining([...new Set(ends)]));
        expect(state().selection.map((x) => x.id).sort()).toEqual(lines.map((c) => c.id).sort());
    });

    it('Copy as sketch entities: plain lines and a circle, nothing holding them', async () => {
        selectTwoSides();
        sketchClick([25.1, -10], TOL, true);
        expect(convertSelected('copy')).toBeNull();
        await settle();
        expect(references()).toEqual([]);
        expect(geo().curves.filter((c) => c.kind === 'line')).toHaveLength(2);
        expect(geo().curves.filter((c) => c.kind === 'circle' && c.radius === 5)).toHaveLength(1);
        expect(geo().curves.every((c) => !c.construction)).toBe(true);
        expect(geo().constraints).toEqual(start.constraints);
        expect(state().dof).toBeGreaterThan(0);
    });

    it('the Modify toolbar buttons act at once on selected model edges, and open their form without', async () => {
        const copy = ALL_TOOLS.find((t) => t.id === 'sk-copy-model')!;
        const convert = ALL_TOOLS.find((t) => t.id === 'sk-convert')!;
        const ctx = {} as Ctx;
        expect(copy.popupIf!(ctx)).toBe(true);
        selectTwoSides();
        expect(convert.popupIf!(ctx)).toBe(false);
        copy.instant!(ctx);
        await settle();
        expect(geo().curves.filter((c) => c.kind === 'line' && !c.construction)).toHaveLength(2);
        expect(geo().constraints).toEqual(start.constraints);
    });

    it('right-click on selected model edges offers Convert and Copy, not the entries that edit sketch entities', () => {
        selectTwoSides();
        const selection = selectedReferences();
        const actions: SketchMenuActions = { openTool: () => undefined, deleteSelected: () => undefined, endChain: () => undefined, fitSketch: () => undefined, closeSketch: () => undefined };
        const labels = (items: MenuEntry[]) => items.flatMap((e) => (typeof e === 'object' && 'label' in e ? [e.label] : typeof e === 'object' && 'header' in e ? [`# ${e.header}`] : []));
        const menu = sketchSpaceMenu({ stage: 'draw', tool: 'select', geometry: geo(), draft: 0, selection, lastUsed: {}, model: modelMenu(selection, null) }, actions);
        expect(labels(menu)).toEqual(expect.arrayContaining(['# 2 model items', 'Convert entities', 'Copy as sketch entities']));
        expect(labels(menu)).not.toContain('Delete');
        expect(labels(menu)).not.toContain('Lock');
        // A face of the part right-clicked with nothing selected: its own header and the two entries.
        const face = modelMenu([], { kind: 'face', index: 3, at: [20, 10, -10], normal: [0, 1, 0] });
        const empty = sketchSpaceMenu({ stage: 'draw', tool: 'select', geometry: geo(), draft: 0, selection: [], lastUsed: {}, model: face }, actions);
        expect(labels(empty).slice(0, 3)).toEqual(['# Model face', 'Convert entities', 'Copy as sketch entities']);
    });

    it('Convert entities on a face of the part: its loops, as the kernel projects them, locked', async () => {
        const answer: ModelSketch = {
            curves: [...plate.curves.slice(0, 4).map((c) => ({ ...c, face: 0, loop: 0 })), { ...plate.curves[4], face: 0, loop: 1 }],
            points: [], skipped: [], loops: [2],
        };
        const fetch = vi.fn(async (_url: string, init: { body: string }) => {
            expect(JSON.parse(init.body).query).toMatchObject({ kind: 'convert', edges: [], faces: [{ at: [20, 10, -10], normal: [0, 1, 0] }] });
            return { ok: true, json: async () => answer };
        });
        vi.stubGlobal('fetch', fetch);
        expect(await convertModelPicks([{ kind: 'face', index: 3, at: [20, 10, -10], normal: [0, 1, 0] }], 'convert')).toBeNull();
        expect(geo().curves.filter((c) => c.kind === 'line')).toHaveLength(4);
        expect(geo().curves.filter((c) => c.kind === 'circle')).toHaveLength(2);
        expect(geo().constraints.filter(isModelLock).length).toBeGreaterThan(4);
    });
});
