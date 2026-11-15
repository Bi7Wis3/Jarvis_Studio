// The dimension, relation and setting additions: path length driving, angular running and ordinate dimensions (along
// an edge, aligned rows, Break alignment, a new zero), the Ordinate scheme of Fully Define, dimensions to spline
// handles, locking the type, zero and negative values with Reverse direction, maintaining proportions, driven
// dimensions placed automatically, the over-defining options, quick snaps, No solve move, the External and Locked
// filters, and Use fully defined sketches.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { loadSolver, measure, pointOf, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, addArc, addConstraint, addLine, addRect, dimensionFromPicks, type NewConstraint, type Pick } from './sketchGeometry';
import { setDriven } from './sketchDimensions';
import {
    alignedLabels, drawnDimensions, firstDimensionScale, groupZeros, handleDimension, ordinateFrame, positionDimension, rezeroed, typedValue,
} from './sketchDimGroups';
import {
    applyDimension, commitGeometry, dimensionAnchor, moveLabel, setDimText, setPathLengthTool, setSketchSettings, setTool, sketchClick, sketchMove, useSketcher,
} from './sketcher';
import {
    reverseDimension, setRunningTool, setSmartOrdinateTool, setUnaligned, smartDimension, toggleDimensionLock,
} from './sketchDimTools';
import { DEFAULT_FULLY_DEFINE, fullyDefineWith } from './sketchFullyDefine';
import { chooseQuickSnap, quickSnapUsed, snapKindsInForce, useQuickSnap } from './sketchQuickSnaps';
import { answerNoSolve, noSolveDrag, noSolveDrop, useNoSolve } from './sketchNoSolve';
import { externalRelations, showsUnder } from './sketchRelationEdit';
import { undefinedSketchRefusal } from './sketchUseDefined';
import { DEFAULT_SKETCH_SETTINGS, gridSnapStep } from './sketchSettings';
import { gridScale, gridSegments } from './sketchGrid';
import { toleranceOf, toleranceText } from './sketchDimTolerance';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

afterEach(() => {
    useSketcher.setState({ settings: { ...DEFAULT_SKETCH_SETTINGS } });
});

/** Opens `g` in the sketcher with nothing picked. */
function open(g: SketchGeometry): void {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], labels: {}, conflicting: [], redundant: [],
        dimDraft: null, dimSpecial: null, drag: null, dragFrom: null, settings: { ...DEFAULT_SKETCH_SETTINGS },
    });
}

const point = (id: string): Pick => ({ type: 'point', id });
const curve = (id: string): Pick => ({ type: 'curve', id });
const at = (g: SketchGeometry, id: string): [number, number] => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};

/** Two lines end to end: (0, 0) to (10, 0) to (10, 5). */
function chain(): { g: SketchGeometry; lines: [string, string] } {
    const a = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [10, 0] });
    const b = addLine(a.g, { at: [10, 0], point: a.b }, { at: [10, 5] });
    return { g: b.g, lines: [a.id, b.id] };
}

describe('path length dimension', () => {
    it('drives the length of a chain and can be switched to driven', () => {
        const { g, lines } = chain();
        const free = solveGeometry(g).dof;
        const r = addConstraint(g, { kind: 'pathLength', curves: lines, value: 24 });
        const s = solveGeometry(r.g);
        expect(s.ok).toBe(true);
        expect(s.dof).toBe(free - 1);
        expect(measure(s.geometry, r.g.constraints.find((c) => c.id === r.id)!)).toBeCloseTo(24, 6);
        // Driven, it only reports.
        const driven = setDriven(s.geometry, [r.id], true);
        expect(driven.constraints.find((c) => c.id === r.id)).toMatchObject({ driven: true });
        expect(solveGeometry(driven).dof).toBe(free);
    });

    it('is placed driving by the Path length tool, driven only when it would over define', () => {
        const { g } = chain();
        open(g);
        setPathLengthTool();
        sketchClick([5, 0], 0.5);
        sketchClick([20, 20], 0.5);
        const path = useSketcher.getState().geometry.constraints.find((c) => c.kind === 'pathLength')!;
        expect(path).toMatchObject({ value: 15 });
        expect('driven' in path && path.driven).toBeFalsy();
    });
});

describe('angular running dimensions', () => {
    /** A centre at the origin with points at 0, 90 and 270 degrees, each on a line from the centre. */
    function spokes(): { g: SketchGeometry; ends: string[] } {
        let g = EMPTY_GEOMETRY;
        const ends: string[] = [];
        for (const p of [[10, 0], [0, 10], [0, -10]] as [number, number][]) {
            const r = addLine(g, { at: [0, 0], point: 'origin' }, { at: p });
            g = r.g;
            ends.push(r.b);
        }
        return { g, ends };
    }

    it('measures anticlockwise from the zero, up to 360, and drives', () => {
        const { g, ends } = spokes();
        open(g);
        setRunningTool();
        sketchClick([0, 0], 0.5);
        sketchClick([10, 0], 0.5);
        sketchClick([20, 3], 0.5);
        sketchClick([0, 10], 0.5);
        sketchClick([0, -10], 0.5);
        const s = useSketcher.getState();
        const angles = s.geometry.constraints.filter((c): c is Extract<SketchConstraint, { kind: 'pointAngle' }> => c.kind === 'pointAngle');
        expect(angles.map((c) => [c.b, c.running, Math.round(c.value * 1e6) / 1e6])).toEqual([[ends[1], true, 90], [ends[2], true, 270]]);
        // In one ring: the labels sit at one radius.
        const radii = angles.map((c) => Math.hypot(...s.labels[c.id]));
        expect(radii[0]).toBeCloseTo(radii[1], 9);
        // Driving: 300 degrees anticlockwise from the zero puts the point at -60 degrees.
        const next = solveGeometry({ ...s.geometry, constraints: s.geometry.constraints.map((c) => (c.id === angles[1].id ? { ...c, value: 300 } as SketchConstraint : c)) });
        expect(next.ok).toBe(true);
        const [p, z] = [at(next.geometry, ends[2]), at(next.geometry, ends[0])];
        const turn = ((Math.atan2(p[1], p[0]) - Math.atan2(z[1], z[0])) * 180) / Math.PI;
        expect(((turn % 360) + 360) % 360).toBeCloseTo(300, 5);
        expect(measure(next.geometry, next.geometry.constraints.find((c) => c.id === angles[1].id)!)).toBeCloseTo(300, 6);
        // Run bidirectionally: the nearer way.
        const both = { ...angles[1], bidirectional: true } as SketchConstraint;
        expect(measure(s.geometry, both)).toBeCloseTo(90, 9);
    });
});

describe('ordinate dimensions', () => {
    it('measures from a slanted zero line along its leaders, in one row that moves together', () => {
        // A slanted zero line and two points off it.
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 10] }).g;
        const zero = g.curves[0].id;
        g = { ...g, points: [...g.points, { id: 'q1', u: 10, v: 0 }, { id: 'q2', u: 20, v: 0 }] };
        open(g);
        setSmartOrdinateTool();
        sketchClick([5, 5], 0.5);
        sketchClick([10, 0], 0.5);
        sketchClick([20, 0], 0.5);
        const s = useSketcher.getState();
        const ords = s.geometry.constraints.filter((c) => c.kind === 'distance' && c.ordinate);
        expect(ords).toEqual([
            expect.objectContaining({ a: 'q1', b: zero, value: expect.closeTo(Math.SQRT2 * 5, 6) }),
            expect.objectContaining({ a: 'q2', b: zero, value: expect.closeTo(Math.SQRT2 * 10, 6) }),
        ]);
        const f = ordinateFrame(s.geometry, ords[0])!;
        expect(f.d[0]).toBeCloseTo(Math.SQRT1_2, 9);
        expect(f.d[1]).toBeCloseTo(Math.SQRT1_2, 9);
        const row = (id: string) => useSketcher.getState().labels[id][0] * f.d[0] + useSketcher.getState().labels[id][1] * f.d[1];
        expect(row(ords[0].id)).toBeCloseTo(row(ords[1].id), 9);
        // Dragging one label moves the row; after Break alignment the other stays.
        moveLabel(ords[0].id, [30, 30]);
        expect(row(ords[1].id)).toBeCloseTo(row(ords[0].id), 9);
        expect(setUnaligned([ords[1].id], true)).toBe(true);
        const before = row(ords[1].id);
        moveLabel(ords[0].id, [40, 40]);
        expect(row(ords[1].id)).toBeCloseTo(before, 9);
    });

    it('decides horizontal or vertical by where the row goes, and takes a new zero', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [10, 4] }).g;
        g = addLine(g, { at: [10, 4], point: g.points[g.points.length - 1].id }, { at: [25, 6] }).g;
        const [, p1, p2] = g.points.map((p) => p.id);
        open(g);
        setSmartOrdinateTool();
        sketchClick([0, 0], 0.5);
        // To the side: vertical ordinates.
        sketchClick([-8, 3], 0.5);
        sketchClick([10, 4], 0.5);
        sketchClick([25, 6], 0.5);
        const s = useSketcher.getState();
        const ords = s.geometry.constraints.filter((c) => c.kind === 'distance' && c.ordinate);
        expect(ords).toEqual([
            expect.objectContaining({ a: 'origin', b: p1, axis: 'v', value: 4 }),
            expect.objectContaining({ a: 'origin', b: p2, axis: 'v', value: 6 }),
        ]);
        const zeros = groupZeros(s.geometry, s.labels, (c) => dimensionAnchor(s.geometry, c));
        expect(zeros).toHaveLength(1);
        expect(zeros[0].members).toEqual(ords.map((c) => c.id));
        // The zero dragged onto p1: the other is measured from it, and p1's own goes.
        const moved = rezeroed(s.geometry, zeros[0].key, p1)!;
        const left = moved.constraints.filter((c) => c.kind === 'distance' && c.ordinate);
        expect(left).toEqual([expect.objectContaining({ a: p1, b: p2, axis: 'v', value: 2 })]);
        expect(rezeroed(s.geometry, zeros[0].key, g.curves[0].id)).toBeNull();
    });

    it('keeps labels of other groups where they are', () => {
        const g = { ...EMPTY_GEOMETRY, points: [{ id: 'a', u: 5, v: 0 }, { id: 'b', u: 9, v: 0 }] };
        const one = addConstraint(g, { kind: 'distance', a: 'origin', b: 'a', axis: 'u', value: 5, ordinate: true }).g;
        const two = addConstraint(one, { kind: 'distance', a: 'a', b: 'b', axis: 'u', value: 4, ordinate: true });
        const [first] = two.g.constraints;
        const labels = alignedLabels(two.g, { [first.id]: [5, 10], [two.id]: [9, 20] }, () => [0, 0], first.id, [5, 15]);
        expect(labels[two.id]).toEqual([9, 20]);
    });
});

describe('fully define with the ordinate scheme', () => {
    it('places horizontal and vertical ordinates from the datum, each row in one line', () => {
        const rect = addRect(EMPTY_GEOMETRY, [2, 3], [12, 9]).g;
        const r = fullyDefineWith(rect, { ...DEFAULT_FULLY_DEFINE, horizontal: 'ordinate', vertical: 'ordinate' });
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.dof).toBe(0);
        const ords = r.g.constraints.filter((c): c is Extract<SketchConstraint, { kind: 'distance' }> => c.kind === 'distance' && !!c.ordinate);
        expect(ords.length).toBeGreaterThan(1);
        for (const axis of ['u', 'v'] as const) {
            const rows = new Set(ords.filter((c) => c.axis === axis).map((c) => c.at![axis === 'u' ? 1 : 0]));
            expect(rows.size).toBeLessThanOrEqual(1);
        }
        expect(ords.every((c) => c.a === 'origin')).toBe(true);
    });
});

describe('dimensions to spline handles', () => {
    /** A spline from (0, 0) to (20, 0) with a handle at its start. */
    function spline(): SketchGeometry {
        return {
            points: [{ id: 's0', u: 0, v: 0 }, { id: 's1', u: 10, v: 4 }, { id: 's2', u: 20, v: 0 }, { id: 'h0', u: 3, v: 3 }],
            curves: [{ id: 'sp', kind: 'spline', points: ['s0', 's1', 's2'], startHandle: 'h0' }],
            constraints: [],
        };
    }

    it('gives the handle length alone, its angle with a line, and drives the angle', () => {
        const g = spline();
        expect(handleDimension(g, [point('h0')])).toEqual({ kind: 'distance', a: 's0', b: 'h0', value: 0 });
        expect(dimensionFromPicks(g, [point('h0'), curve('axis-u')], [5, 5])).toEqual({ kind: 'angle', a: 'h0', b: 'axis-u', value: 0 });
        expect(handleDimension(g, [point('s1')])).toBeUndefined();
        const c = addConstraint(g, { kind: 'angle', a: 'h0', b: 'axis-u', value: 30 });
        // The spline's end held, so only the handle turns.
        const held = addConstraint(c.g, { kind: 'fix', point: 's0' }).g;
        const r = solveGeometry(held);
        expect(r.ok).toBe(true);
        const h = at(r.geometry, 'h0');
        expect((Math.atan2(h[1], h[0]) * 180) / Math.PI).toBeCloseTo(30, 5);
        expect(measure(r.geometry, r.geometry.constraints.find((k) => k.id === c.id)!)).toBeCloseTo(30, 6);
    });
});

describe('locking the dimension type', () => {
    it('keeps the type the preview showed while the pointer moves to place it', () => {
        const g = { ...EMPTY_GEOMETRY, points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 6 }] };
        open(g);
        setTool('dimension');
        useSketcher.setState({ picks: [point('a'), point('b')], cursor: [5, 20] });
        expect(smartDimension(g, [point('a'), point('b')], [20, 3], null)).toMatchObject({ axis: 'v' });
        expect(toggleDimensionLock()).toBe(true);
        expect(smartDimension(g, [point('a'), point('b')], [20, 3], null)).toMatchObject({ axis: 'u' });
        expect(toggleDimensionLock()).toBe(true);
        expect(smartDimension(g, [point('a'), point('b')], [20, 3], null)).toMatchObject({ axis: 'v' });
    });
});

describe('zero and negative values', () => {
    /** A horizontal line from (5, 0) to (15, 0) and the dimension of its start from the origin, horizontally. */
    function offset(): { g: SketchGeometry; dim: string; start: string } {
        const r = addLine(EMPTY_GEOMETRY, { at: [5, 0] }, { at: [15, 0] }, 'horizontal');
        const start = r.g.curves[0].kind === 'line' ? r.g.curves[0].a : '';
        const g0 = addConstraint(r.g, { kind: 'length', line: r.id, value: 10 }).g;
        const d = addConstraint(g0, { kind: 'distance', a: 'origin', b: start, axis: 'u', value: 5 });
        const g = addConstraint(d.g, { kind: 'distance', a: 'origin', b: start, axis: 'v', value: 0 }).g;
        return { g: solveGeometry(g).geometry, dim: d.id, start };
    }

    it('takes zero and negative values only for position dimensions', () => {
        const { g, dim } = offset();
        const c = g.constraints.find((k) => k.id === dim)!;
        expect(positionDimension(g, c)).toBe(true);
        expect(typedValue(g, c, -7)).toEqual({ value: 7, reverse: true });
        expect(typedValue(g, c, 0)).toEqual({ value: 0, reverse: false });
        const length = g.constraints.find((k) => k.kind === 'length')!;
        expect(typedValue(g, length, 0)).toHaveProperty('error');
        expect(typedValue(g, length, -3)).toHaveProperty('error');
    });

    it('reverses a position dimension, from Reverse direction or a negative value', () => {
        const { g, dim, start } = offset();
        open(g);
        expect(reverseDimension(dim)).toBeNull();
        expect(at(useSketcher.getState().geometry, start)[0]).toBeCloseTo(-5, 6);
        // A negative value typed in the value input: back to the right, at 8.
        const c = useSketcher.getState().geometry.constraints.find((k) => k.id === dim)!;
        const { id: _id, ...constraint } = c;
        useSketcher.setState({ dimDraft: { constraint: constraint as NewConstraint, at: [0, 5], text: '-8', editing: dim, error: null } });
        applyDimension();
        expect(useSketcher.getState().dimDraft).toBeNull();
        expect(at(useSketcher.getState().geometry, start)[0]).toBeCloseTo(8, 6);
        // Zero: the start on the vertical axis.
        useSketcher.setState({ dimDraft: { constraint: constraint as NewConstraint, at: [0, 5], text: '0', editing: dim, error: null } });
        applyDimension();
        expect(at(useSketcher.getState().geometry, start)[0]).toBeCloseTo(0, 6);
    });
});

describe('maintain proportions', () => {
    it('scales the whole sketch with its first dimension, not with later ones', () => {
        const rect = addRect(EMPTY_GEOMETRY, [2, 2], [12, 7]);
        const g = rect.g;
        const c: NewConstraint = { kind: 'length', line: rect.lines[0], value: 0 };
        const scaled = firstDimensionScale(g, c, 20)!;
        expect(measure(scaled, { ...c, id: 'm' } as SketchConstraint)).toBeCloseTo(20, 9);
        const other = scaled.curves.find((k) => k.id === rect.lines[1])!;
        const len = (x: SketchGeometry, id: string) => {
            const l = x.curves.find((k) => k.id === id)!;
            return l.kind === 'line' ? Math.hypot(at(x, l.b)[0] - at(x, l.a)[0], at(x, l.b)[1] - at(x, l.a)[1]) : NaN;
        };
        expect(len(scaled, other.id)).toBeCloseTo(len(g, other.id) * 2, 9);
        // A second dimension, or an angle, does not scale.
        expect(firstDimensionScale(addConstraint(g, { kind: 'length', line: rect.lines[1], value: 5 }).g, c, 20)).toBeNull();
        expect(firstDimensionScale(g, { kind: 'angle', a: rect.lines[0], b: rect.lines[1], value: 90 }, 45)).toBeNull();
        // Through the value input.
        open(g);
        useSketcher.setState({ dimDraft: { constraint: c, at: [5, 10], text: '20', editing: null, error: null } });
        applyDimension();
        expect(len(useSketcher.getState().geometry, rect.lines[1])).toBeCloseTo(len(g, rect.lines[1]) * 2, 6);
    });
});

describe('driven dimensions placed automatically', () => {
    it('makes the dimensions drawn with an entity driven when set, or where they would over define', () => {
        const before = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]).g;
        const line = before.curves[0].id;
        const withLength = addConstraint(before, { kind: 'length', line, value: 10 }).g;
        const all = drawnDimensions(before, withLength, true, solveGeometry);
        expect(all.constraints.find((c) => c.kind === 'length')).toMatchObject({ driven: true });
        // The rectangle's opposite side already has its length: a second one there repeats it.
        const held = addConstraint(before, { kind: 'length', line: before.curves[2].id, value: 10 }).g;
        const clash = addConstraint(held, { kind: 'length', line, value: 10 }).g;
        const out = drawnDimensions(held, clash, false, solveGeometry);
        expect(out.constraints.filter((c) => c.kind === 'length' && c.driven)).toHaveLength(1);
        expect(solveGeometry(out).redundant).toEqual(solveGeometry(held).redundant);
        // Nothing clashes: left driving.
        expect(drawnDimensions(before, withLength, false, solveGeometry)).toBe(withLength);
    });

    it('adds an over defining dimension driven at once when the settings say so', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        const g = addConstraint(rect.g, { kind: 'length', line: rect.lines[2], value: 10 }).g;
        open(g);
        setSketchSettings({ overDefPrompt: false, overDefDriven: true });
        setTool('dimension');
        sketchClick([5, 0], 0.5);
        sketchClick([5, -6], 0.5);
        const s = useSketcher.getState();
        expect(s.dimDraft).toBeNull();
        expect(s.geometry.constraints.filter((c) => c.kind === 'length' && c.line === rect.lines[0])).toEqual([expect.objectContaining({ driven: true })]);
    });
});

describe('quick snaps', () => {
    it('filter to one snap for the next entity, or keep it (double-click)', () => {
        chooseQuickSnap('mid');
        expect(snapKindsInForce({}, true)).toMatchObject({ mid: true, point: false, grid: false });
        quickSnapUsed();
        expect(useQuickSnap.getState().kind).toBeNull();
        chooseQuickSnap('centre', true);
        quickSnapUsed();
        expect(useQuickSnap.getState()).toEqual({ kind: 'centre', keep: true });
        // A click on the kept one goes back to the sketch snaps; the grid snap only while the grid shows.
        chooseQuickSnap('centre');
        expect(useQuickSnap.getState().kind).toBeNull();
        expect(snapKindsInForce({ point: false }, false)).toEqual({ point: false, grid: false });
    });

    it('works with snapping off, and is spent by the entity drawn', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        open(g);
        useSketcher.setState({ snap: false });
        setTool('point');
        chooseQuickSnap('mid');
        sketchMove([5.3, 0.2], 1);
        expect(useSketcher.getState().snapKind).toBe('mid');
        sketchClick([5.3, 0.2], 1);
        expect(useQuickSnap.getState().kind).toBeNull();
        sketchMove([5.3, 0.2], 1);
        expect(useSketcher.getState().snapKind).toBeNull();
    });
});

describe('no solve move', () => {
    /** A line from (0, 0) to (10, 0) with its length dimensioned, and a second line on its end. */
    function bent(): { g: SketchGeometry; first: string; end: string } {
        const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const b = addLine(a.g, { at: [10, 0], point: a.b }, { at: [10, 5] });
        return { g: addConstraint(b.g, { kind: 'length', line: a.id, value: 10 }).g, first: a.id, end: a.b };
    }

    function drag(g: SketchGeometry, point: string, by: [number, number]): void {
        const p = at(g, point);
        useSketcher.setState({ settings: { ...DEFAULT_SKETCH_SETTINGS, noSolveMove: true }, drag: { points: [{ id: point, from: p }], grab: p }, dragFrom: g });
        noSolveDrag([p[0] + by[0], p[1] + by[1]]);
    }

    it('moves without solving, then deletes what it broke (Yes)', () => {
        const { g, end } = bent();
        open(g);
        drag(g, end, [5, 0]);
        expect(at(useSketcher.getState().geometry, end)).toEqual([15, 0]);
        expect(noSolveDrop()).toBe(true);
        expect(useNoSolve.getState().pending?.broken).toHaveLength(1);
        expect(useSketcher.getState().geometry).toBe(g);
        expect(answerNoSolve('delete')).toBeNull();
        const s = useSketcher.getState();
        expect(at(s.geometry, end)).toEqual([15, 0]);
        expect(s.geometry.constraints.some((c) => c.kind === 'length')).toBe(false);
    });

    it('copies instead when the relations are kept (No)', () => {
        const { g: g0, first } = bent();
        // The second line's length breaks when the first moves up without solving.
        const g = addConstraint(g0, { kind: 'length', line: g0.curves[1].id, value: 5 }).g;
        open(g);
        const line = g.curves.find((c) => c.id === first)!;
        const ends = line.kind === 'line' ? [line.a, line.b] : [];
        const p = at(g, ends[0]);
        useSketcher.setState({
            settings: { ...DEFAULT_SKETCH_SETTINGS, noSolveMove: true },
            drag: { points: ends.map((id) => ({ id, from: at(g, id) })), grab: p }, dragFrom: g,
        });
        noSolveDrag([p[0], p[1] + 7]);
        expect(noSolveDrop()).toBe(true);
        expect(useNoSolve.getState().pending?.broken).toHaveLength(1);
        expect(answerNoSolve('copy')).toBeNull();
        const s = useSketcher.getState();
        expect(s.geometry.curves).toHaveLength(3);
        expect(at(s.geometry, ends[1])).toEqual([10, 0]);
    });
});

describe('relation filters and fully defined sketches', () => {
    it('lists relations to geometry from the model as External, its locks as Locked', () => {
        const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const line = a.g.curves[0];
        const ends = line.kind === 'line' ? [line.a, line.b] : [];
        let g: SketchGeometry = { ...a.g, constraints: ends.map((point, i) => ({ id: `km${i + 1}`, kind: 'fix', point }) as SketchConstraint) };
        const b = addLine(g, { at: [0, 5] }, { at: [10, 6] });
        g = addConstraint(b.g, { kind: 'parallel', a: line.id, b: b.id }).g;
        const outside = externalRelations(g);
        expect([...outside.locked]).toEqual(['km1', 'km2']);
        const parallel = g.constraints.find((c) => c.kind === 'parallel')!;
        expect(showsUnder('external', 'ok', parallel, [], outside)).toBe(true);
        expect(showsUnder('locked', 'ok', parallel, [], outside)).toBe(false);
    });

    it('refuses a feature from a sketch that is not fully defined, with the setting on', () => {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
        try {
            const free = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]).g;
            const sketch = { plane: 'top' as const, profiles: [], geometry: free };
            const step = { id: 's1', op: 'sketch', sketch };
            const extrude = { id: 'e1', op: 'extrude', sketchRef: 's1', mode: 'add', distance: 5 };
            const args = { partId: 'p1', features: [step, extrude] };
            expect(undefinedSketchRefusal('features_add', args, null)).toBeNull();
            store.set('jarvis.sketch.settings', JSON.stringify({ useFullyDefined: true }));
            expect(undefinedSketchRefusal('features_add', args, null)).toMatch(/fully define/);
            expect(undefinedSketchRefusal('parts_add', { parts: [{ name: 'Part 2', features: [step, extrude] }] }, null)).toMatch(/fully define/);
            // A sketch step alone is not a feature.
            expect(undefinedSketchRefusal('features_add', { partId: 'p1', features: [step] }, null)).toBeNull();
            const defined = fullyDefineWith(free, DEFAULT_FULLY_DEFINE);
            if ('error' in defined) {
                throw new Error(defined.error);
            }
            expect(undefinedSketchRefusal('features_add', { partId: 'p1', features: [{ ...step, sketch: { ...sketch, geometry: defined.g } }, extrude] }, null)).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('dimensions to an arc midpoint', () => {
    it('measures and drives to the middle of an arc', () => {
        // A half circle from (10, 0) round to (-10, 0) through (0, 10), and a point at (0, 20).
        const arc = addArc(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        const c = arc.g.curves[0] as Extract<SketchGeometry['curves'][number], { kind: 'arc' }>;
        const g = { ...arc.g, points: [...arc.g.points, { id: 'q', u: 0, v: 20, fixed: true }] };
        const d = dimensionFromPicks(g, [{ type: 'point', id: `mid:${c.id}` }, point('q')], [20, 10]);
        expect(d).toMatchObject({ kind: 'distance', a: c.id, aMid: true, b: 'q' });
        expect(measure(g, { ...d!, id: 'm' } as SketchConstraint)).toBeCloseTo(10, 9);
        expect(dimensionFromPicks(g, [{ type: 'point', id: `mid:${c.id}` }], [5, 5])).toEqual({ kind: 'radius', curve: c.id, value: 0 });
        // Driving: the arc's middle 4 from the point; the arc's centre and ends held, only its radius can give.
        let held = addConstraint(g, { kind: 'fix', point: c.center }).g;
        held = addConstraint(held, { kind: 'horizontalPoints', a: c.start, b: c.center }).g;
        held = addConstraint(held, { kind: 'horizontalPoints', a: c.end, b: c.center }).g;
        const r = addConstraint(held, { ...d!, value: 4 } as NewConstraint);
        const s = solveGeometry(r.g);
        expect(s.ok).toBe(true);
        expect(measure(s.geometry, s.geometry.constraints.find((k) => k.id === r.id)!)).toBeCloseTo(4, 6);
        expect(at(s.geometry, c.start)[0]).toBeCloseTo(16, 5);
    });
});

describe('tolerance and precision', () => {
    it('shows the tolerance types with the value, at the precision asked, and changes nothing else', () => {
        const base = { id: 'k1', kind: 'length', line: 'c1', value: 40 } as const;
        const shown = (v: Record<string, unknown>) => {
            const tolerance = toleranceOf({ tolMax: '0.1', tolMin: '0.05', precision: '', tolPrecision: '', ...v });
            return toleranceText({ ...base, ...(tolerance ? { tolerance } : {}) }, '40');
        };
        expect(shown({ tolType: 'none' })).toBe('40');
        expect(toleranceOf({ tolType: 'none', precision: '' })).toBeUndefined();
        expect(shown({ tolType: 'basic', precision: '2' })).toBe('40.00');
        expect(shown({ tolType: 'bilateral', tolPrecision: '2' })).toBe('40 +0.10 −0.05');
        expect(shown({ tolType: 'limit' })).toBe('40.1 / 39.95');
        expect(shown({ tolType: 'symmetric', parentheses: true })).toBe('(40 ±0.1)');
        expect(shown({ tolType: 'min' })).toBe('40 MIN');
        expect(shown({ tolType: 'max' })).toBe('40 MAX');
        expect(() => toleranceOf({ tolType: 'bilateral', tolMax: 'x' })).toThrow(/Maximum variation/);
        // The solver sees only the value.
        const { g, lines } = chain();
        const plain = addConstraint(g, { kind: 'length', line: lines[0], value: 12 }).g;
        const tolerant = addConstraint(g, { kind: 'length', line: lines[0], value: 12, tolerance: { type: 'symmetric', max: 0.2 } }).g;
        expect(solveGeometry(tolerant).geometry.points).toEqual(solveGeometry(plain).geometry.points);
    });
});

describe('automatic solve and undo limit', () => {
    it('stops solving and keeping undo steps over the set number of entities', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]).g;
        open(rect);
        useSketcher.setState({ settings: { ...DEFAULT_SKETCH_SETTINGS, solveLimitOn: true, solveLimit: 4 } });
        const more = addLine(rect, { at: [20, 0] }, { at: [30, 0] }).g;
        expect(commitAndState(more)).toMatchObject({ dof: -1, undo: [] });
        expect(useSketcher.getState().message).toMatch(/More than 4 entities/);
        useSketcher.setState({ settings: { ...DEFAULT_SKETCH_SETTINGS, solveLimitOn: true, solveLimit: 10 } });
        const again = addLine(more, { at: [20, 5] }, { at: [30, 5] }).g;
        expect(commitAndState(again).undo).toHaveLength(1);
    });
});

/** Commits through the sketcher and gives its state. */
function commitAndState(g: SketchGeometry) {
    commitGeometry(g);
    return useSketcher.getState();
}

describe('grid options', () => {
    it('snaps at the minor spacing over the snap points, and thins the lines by tens when zoomed out', () => {
        expect(gridSnapStep({ ...DEFAULT_SKETCH_SETTINGS, gridMajor: 50, gridMinorPerMajor: 5, gridSnapPerMinor: 2 })).toBe(5);
        expect(gridScale(1, 0.05)).toBe(1);
        expect(gridScale(1, 0.5)).toBe(10);
        expect(gridScale(1, 5)).toBe(100);
        expect(gridSegments(5, 0, 10, 0, 10)).toHaveLength(12);
    });
});
