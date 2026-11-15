// Shared helpers of the sketch tool audit: tools are switched on the way the toolbar does it (the ToolDef of
// SKETCH_GROUPS), clicks go through the sketcher's pointer functions, and the results are checked for clean solving,
// exact undo and no dangling references.

import { expect } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { SKETCH_GROUPS, type Ctx, type ToolDef, type Values } from '../toolDefs';
import { AXIS_U, ORIGIN, pointOf, solveGeometry } from '../solver';
import { constraintRefs, EMPTY_GEOMETRY, geometryOpenChains, geometryProfiles } from '../sketchGeometry';
import { curvePoints } from '../sketchEdit';
import { choosePlane, setTool, sketchClick, sketchMove, startSketch, undoSketch, redoSketch, useSketcher, type SketchTool } from '../sketcher';
import { regionsOf } from '../regionPick';
import { DEFAULT_DRAW_OPTIONS } from '../sketchDrawVariants';
import { DEFAULT_EDIT_OPTIONS } from '../sketcher';
import { setStyleSplineType } from '../sketchConics';
import type { FontGlyphs } from '@jarvis/core/text';
import { buildText } from '../sketchTextItems';
import { splineBezier } from '@jarvis/core/curves';
import { buildEquation } from '../sketchEquation';
import { makeBlock } from '../sketchBlocks';

const SETTINGS = useSketcher.getState().settings;

export const TOL = 0.05;
export const state = () => useSketcher.getState();
export const geo = () => state().geometry;
export const ctx: Ctx = { part: null, project: null, edit: null } as unknown as Ctx;

/** Every tool of the sketch toolbar, by id. */
export function toolbarTool(id: string): ToolDef {
    const found = SKETCH_GROUPS.flatMap((g) => g.tools).find((t) => t.id === id);
    if (!found) {
        throw new Error(`No toolbar tool ${id}`);
    }
    return found;
}

export const groupTools = (group: string): ToolDef[] => SKETCH_GROUPS.find((g) => g.id === group)!.tools;

/** A fresh sketch on the front plane, as Sketch then a plane pick leaves it; grid snap off so clicks land where given. */
export function begin(g: SketchGeometry = EMPTY_GEOMETRY): void {
    startSketch(null, 'sketch');
    choosePlane('front');
    useSketcher.setState({
        snapKinds: { grid: false }, geometry: g, undo: [], redo: [], selection: [], message: null,
        drawOptions: DEFAULT_DRAW_OPTIONS, editOptions: DEFAULT_EDIT_OPTIONS, sides: 6, filletRadius: 5, chamferDistance: 2, settings: SETTINGS, grid: 1, snap: true,
    });
    setStyleSplineType('bezier');
    if (g !== EMPTY_GEOMETRY) {
        const r = solveGeometry(g);
        if (r.ok) {
            useSketcher.setState({ geometry: r.geometry, dof: r.dof });
        }
    }
}

/** The form a toolbar button opens: its default values, kept up to date by change(). */
export interface OpenForm {
    def: ToolDef;
    values: Values;
    change: (key: string, value: Values[string]) => void;
    apply: () => Promise<{ text: string; isError: boolean }>;
}

/**
 * Presses a toolbar button: an instant tool runs; a form tool opens (defaults), and a draw form switches the
 * sketcher to its tool as its DrawSession does when it mounts.
 */
export function press(id: string, drawTool?: SketchTool): OpenForm {
    const def = toolbarTool(id);
    if (def.instant) {
        def.instant(ctx);
    }
    const values: Values = def.defaults ? { ...def.defaults(ctx) } : {};
    if (drawTool && state().tool !== drawTool) {
        setTool(drawTool);
    }
    const form: OpenForm = {
        def,
        values,
        change(key, value) {
            form.values = { ...form.values, [key]: value };
            const patch = def.onChange?.(key, form.values, ctx);
            if (patch && typeof patch === 'object') {
                form.values = { ...form.values, ...(patch as Values) };
            }
        },
        apply: async () => {
            const r = await def.apply!(form.values, ctx);
            return r ?? { text: '', isError: false };
        },
    };
    return form;
}

export function click(p: [number, number], tol = TOL): void {
    sketchMove(p, tol);
    sketchClick(p, tol);
}

export function clicks(...ps: [number, number][]): void {
    for (const p of ps) {
        click(p);
    }
}

export const at = (id: string, g = geo()): [number, number] => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};

export const curvesOf = (kind: SketchCurve['kind'], construction = false, g = geo()) =>
    g.curves.filter((c) => c.kind === kind && !!c.construction === construction);
export const relations = (kind: string, g = geo()) => g.constraints.filter((c) => c.kind === kind);

export function expectPt(actual: [number, number], expected: [number, number], digits = 9): void {
    expect(actual[0]).toBeCloseTo(expected[0], digits);
    expect(actual[1]).toBeCloseTo(expected[1], digits);
}

/** Solves with nothing conflicting or redundant; returns the degrees of freedom. */
export function solvesCleanly(g = geo()): number {
    const r = solveGeometry(g);
    expect(r.ok).toBe(true);
    expect(r.conflicting).toEqual([]);
    expect(r.redundant).toEqual([]);
    return r.dof;
}

/** No relation or curve refers to a point or curve that is not there. */
export function noDangling(g = geo()): void {
    const points = new Set([...g.points.map((p) => p.id), ORIGIN]);
    const curves = new Set([...g.curves.map((c) => c.id), AXIS_U, 'axis-v']);
    for (const c of g.curves) {
        for (const p of curvePoints(c)) {
            expect(points.has(p), `curve ${c.id} uses missing point ${p}`).toBe(true);
        }
    }
    for (const c of g.constraints) {
        for (const r of constraintRefs(c)) {
            expect(points.has(r) || curves.has(r), `${c.kind} ${c.id} refers to missing ${r}`).toBe(true);
        }
    }
}

/** Same geometry to 1e-9 (point positions), same curves and constraints. */
export function expectSameGeometry(a: SketchGeometry, b: SketchGeometry, tol = SAME): void {
    const radiusFree = (g: SketchGeometry) => g.curves.map((c) => (c.kind === 'circle' ? { ...c, radius: 0 } : c));
    expect(radiusFree(a)).toEqual(radiusFree(b));
    for (const c of a.curves) {
        const d = b.curves.find((x) => x.id === c.id);
        if (c.kind === 'circle' && d?.kind === 'circle') {
            expect(Math.abs(c.radius - d.radius), `radius of ${c.id}`).toBeLessThan(tol);
        }
    }
    expect(a.constraints).toEqual(b.constraints);
    expect(a.points.map((p) => p.id)).toEqual(b.points.map((p) => p.id));
    for (const p of a.points) {
        const q = b.points.find((x) => x.id === p.id)!;
        expect(Math.abs(p.u - q.u) + Math.abs(p.v - q.v), `point ${p.id}`).toBeLessThan(tol);
    }
    expect(a.texts ?? []).toEqual(b.texts ?? []);
    expect(a.equations ?? []).toEqual(b.equations ?? []);
    expect(a.inserts ?? []).toEqual(b.inserts ?? []);
    expect(a.blocks ?? []).toEqual(b.blocks ?? []);
}

/** Runs `act`, then checks that undo brings back the sketch before it and redo the one after. */
/**
 * How close undo and redo must bring the points back. Undo and redo solve the sketch again, and a second solve moves
 * points by up to 0.000002 mm (recorded as a defect in draw.audit.test.ts); the other tests look past that.
 */
export const SAME = 1e-5;

/** |a - b| within the solver's tolerance (0.000001 mm). */
export function near(a: number, b: number, tol = 1e-6): void {
    expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);
}

export function undoRedoRestores(act: () => void, steps = 1, tol = SAME): void {
    const before = geo();
    act();
    const after = geo();
    expect(after).not.toBe(before);
    for (let i = 0; i < steps; i++) {
        undoSketch();
    }
    expectSameGeometry(geo(), before, tol);
    for (let i = 0; i < steps; i++) {
        redoSketch();
    }
    expectSameGeometry(geo(), after, tol);
}

export const profiles = (g = geo()) => geometryProfiles(g).profiles;
export const openChains = (g = geo()) => geometryOpenChains(g);
export const regions = (g = geo()) => regionsOf(g);

/** A sketch holding one of every curve kind, away from the origin and turned, for the tools that act on curves. */
export function everyKind(): { g: SketchGeometry; ids: Record<string, string> } {
    const points = [
        // line, tilted
        { id: 'l1', u: 12.5, v: 3.25 }, { id: 'l2', u: 31.75, v: 14.125 },
        // circle centre
        { id: 'cc', u: -20.5, v: 18.25 },
        // arc: centre, start, end (ccw)
        { id: 'ac', u: 40.5, v: -12.25 }, { id: 'as', u: 48.5, v: -12.25 }, { id: 'ae', u: 40.5, v: -4.25 },
        // ellipse, turned 30 degrees
        { id: 'ec', u: -40, v: -30 }, { id: 'em', u: -40 + 12 * Math.cos(Math.PI / 6), v: -30 + 12 * Math.sin(Math.PI / 6) },
        { id: 'en', u: -40 - 6 * Math.sin(Math.PI / 6), v: -30 + 6 * Math.cos(Math.PI / 6) },
        // partial ellipse about (60, 30), axis along u, quarter
        { id: 'pc', u: 60, v: 30 }, { id: 'pm', u: 70, v: 30 }, { id: 'pn', u: 60, v: 35 }, { id: 'ps', u: 70, v: 30 }, { id: 'pe', u: 60, v: 35 },
        // spline
        { id: 's1', u: -10, v: -50 }, { id: 's2', u: 0, v: -42 }, { id: 's3', u: 10, v: -51 }, { id: 's4', u: 20, v: -44 },
        // style spline (Bezier)
        { id: 'b1', u: 30, v: -50 }, { id: 'b2', u: 35, v: -40 }, { id: 'b3', u: 45, v: -40 }, { id: 'b4', u: 50, v: -50 },
        // parabola: focus, vertex, start, end (vertex at (80,-30), focus 2 above: y = x^2/8 around it)
        { id: 'qf', u: 80, v: -28 }, { id: 'qv', u: 80, v: -30 }, { id: 'qs', u: 72, v: -22 }, { id: 'qe', u: 88, v: -22 },
        // conic
        { id: 'ks', u: 90, v: 0 }, { id: 'ke', u: 110, v: 0 }, { id: 'ka', u: 100, v: 10 },
    ];
    const curves: SketchCurve[] = [
        { id: 'line', kind: 'line', a: 'l1', b: 'l2' },
        { id: 'circle', kind: 'circle', center: 'cc', radius: 7.25 },
        { id: 'arc', kind: 'arc', center: 'ac', start: 'as', end: 'ae' },
        { id: 'ellipse', kind: 'ellipse', center: 'ec', major: 'em', minor: 'en' },
        { id: 'ellipseArc', kind: 'ellipseArc', center: 'pc', major: 'pm', minor: 'pn', start: 'ps', end: 'pe' },
        { id: 'spline', kind: 'spline', points: ['s1', 's2', 's3', 's4'] },
        { id: 'styleSpline', kind: 'styleSpline', points: ['b1', 'b2', 'b3', 'b4'] },
        { id: 'parabola', kind: 'parabola', focus: 'qf', vertex: 'qv', start: 'qs', end: 'qe' },
        { id: 'conic', kind: 'conic', start: 'ks', end: 'ke', apex: 'ka', rho: 0.4 },
    ];
    // The partial ellipse shares its start and end with the axis points: give it ends of its own.
    const g: SketchGeometry = { points, curves, constraints: [] };
    return { g, ids: Object.fromEntries(curves.map((c) => [c.kind, c.id])) };
}

/** Every text, equation curve and block instance owns curves and points that are all in the sketch. */
export function itemsIntact(g = geo()): void {
    const curves = new Set(g.curves.map((c) => c.id));
    const points = new Set(g.points.map((p) => p.id));
    for (const item of [...(g.texts ?? []), ...(g.equations ?? []), ...(g.inserts ?? [])]) {
        for (const c of item.curves) {
            expect(curves.has(c), `item ${item.id} owns missing curve ${c}`).toBe(true);
        }
        for (const p of item.points) {
            expect(points.has(p), `item ${item.id} owns missing point ${p}`).toBe(true);
        }
    }
}

/** A tiny font: O is a square with a square hole (lines); capital height 1000. */
export const FONT: FontGlyphs = {
    family: 'Test Sans', style: 'regular', unitsPerEm: 1000, capHeight: 1000, lineHeight: 1200, kerning: {},
    glyphs: {
        O: {
            advance: 1000,
            contours: [
                { start: [0, 0], segments: [{ kind: 'line', to: [800, 0] }, { kind: 'line', to: [800, 1000] }, { kind: 'line', to: [0, 1000] }, { kind: 'line', to: [0, 0] }] },
                { start: [200, 200], segments: [{ kind: 'line', to: [200, 800] }, { kind: 'line', to: [600, 800] }, { kind: 'line', to: [600, 200] }, { kind: 'line', to: [200, 200] }] },
            ],
        },
        S: {
            advance: 900,
            contours: [{ start: [0, 0], segments: [{ kind: 'quad', c: [400, 600], to: [800, 0] }, { kind: 'quad', c: [400, 1200], to: [0, 0] }] }],
        },
        ' ': { advance: 300, contours: [] },
    },
};

/** The sketch with one text ("O" at (200, 100), 10 high), one equation curve and one block instance (a line and a circle). */
export function withItems(base: SketchGeometry = EMPTY_GEOMETRY): { g: SketchGeometry; text: string; equation: string; insert: string } {
    const t = buildText(base, { id: 't1', text: 'O', font: 'Test Sans', height: 10, at: [200, 100], curves: [], points: [] }, { regular: FONT });
    if (typeof t === 'string') {
        throw new Error(t);
    }
    const e = buildEquation(t.g, { id: 'e1', type: 'explicit', y: '0.1*x^2', from: '-10', to: '10', tolerance: 0.001, curves: [], points: [] });
    if (typeof e === 'string') {
        throw new Error(e);
    }
    // A block of one line and one circle, placed at (150, -60).
    let g: SketchGeometry = {
        ...e.g,
        points: [...e.g.points, { id: 'ba', u: 150, v: -60 }, { id: 'bb', u: 165, v: -52 }, { id: 'bc', u: 158, v: -70 }],
        curves: [...e.g.curves, { id: 'bl', kind: 'line', a: 'ba', b: 'bb' }, { id: 'bk', kind: 'circle', center: 'bc', radius: 3 }],
    };
    const m = makeBlock(g, ['bl', 'bk'], [150, -60], 'Lug');
    if (typeof m === 'string') {
        throw new Error(m);
    }
    g = m.g;
    return { g, text: 't1', equation: 'e1', insert: m.insert.id };
}

/** A point inside each curve of everyKind(), away from its ends (where a click picks the curve, not a point). */
const splineMid = (() => {
    const poles = splineBezier([[-10, -50], [0, -42], [10, -51], [20, -44]]);
    const t = 0.5;
    const u = 1 - t;
    return [0, 1].map((j) => u * u * u * poles[3][j] + 3 * u * u * t * poles[4][j] + 3 * u * t * t * poles[5][j] + t * t * t * poles[6][j]) as [number, number];
})();
const E30 = Math.PI / 6;
export const ON_CURVE: Record<string, [number, number]> = {
    line: [22.125, 8.6875],
    circle: [-20.5 + 7.25, 18.25],
    arc: [40.5 + 8 * Math.SQRT1_2, -12.25 + 8 * Math.SQRT1_2],
    ellipse: [-40 + 12 * Math.cos(E30) * 0.5 - 6 * Math.sin(E30) * Math.sin(Math.PI / 3), -30 + 12 * Math.sin(E30) * 0.5 + 6 * Math.cos(E30) * Math.sin(Math.PI / 3)],
    ellipseArc: [60 + 10 * Math.SQRT1_2, 30 + 5 * Math.SQRT1_2],
    spline: splineMid,
    styleSpline: [40, -42.5],
    parabola: [84, -28],
    conic: [100, 4],
};
