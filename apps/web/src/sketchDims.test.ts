// Driven (reference) dimensions and the Smart Dimension kinds beyond the first set: arc length, the angle at a point,
// distances to midpoints, to the near or far side of circles, doubled across a centreline, horizontal and vertical.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { curveRadius, loadSolver, measure, pointOf, solveGeometry } from './solver';
import {
    EMPTY_GEOMETRY, addArc, addCircle, addConstraint, addLine, addRect, dimensionFromPicks, midPick, toggleConstruction, type NewConstraint, type Pick,
} from './sketchGeometry';
import { overDefines, setDriven } from './sketchDimensions';
import { splitAt, transformEntities } from './sketchEdit';
import { chooseDimensionDriven, setDimensionTool, setOrdinateTool, setPathLengthTool, setTool, sketchClick, useSketcher } from './sketcher';

const curve = (id: string, edge?: boolean): Pick => ({ type: 'curve', id, ...(edge ? { edge } : {}) });
const point = (id: string): Pick => ({ type: 'point', id });

describe('ordinate and path length dimensions', () => {
    it('dimensions points from a zero in one row, driving', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [10, 0] }).g;
        g = addLine(g, { at: [10, 0], point: g.points[g.points.length - 1].id }, { at: [25, 6] }).g;
        const [, p1, p2] = g.points.map((p) => p.id);
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], labels: {}, conflicting: [], redundant: [], dimDraft: null });
        setOrdinateTool('u');
        sketchClick([0, 0], 0.5);
        sketchClick([5, 20], 0.5);
        sketchClick([10, 0], 0.5);
        sketchClick([25, 6], 0.5);
        const s = useSketcher.getState();
        const ords = s.geometry.constraints.filter((c) => c.kind === 'distance' && c.ordinate);
        expect(ords).toEqual([
            expect.objectContaining({ a: 'origin', b: p1, axis: 'u', value: 10 }),
            expect.objectContaining({ a: 'origin', b: p2, axis: 'u', value: 25 }),
        ]);
        expect(ords.every((c) => !('driven' in c))).toBe(true);
        expect(ords.map((c) => s.labels[c.id][1])).toEqual([20, 20]);
        // Driving: changing one moves its point.
        const moved = solveGeometry({ ...s.geometry, constraints: s.geometry.constraints.map((c) => (c.id === ords[1].id ? { ...c, value: 30 } as SketchConstraint : c)) });
        expect(pointOf(moved.geometry, p2)!.u).toBeCloseTo(30, 6);
    });

    it('dimensions the length of a chain, driving, and can be made driven', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        g = addLine(g, { at: [10, 0], point: g.points[1].id }, { at: [10, 5] }).g;
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], labels: {}, conflicting: [], redundant: [], dimDraft: null });
        setPathLengthTool();
        sketchClick([5, 0], 0.5);
        expect(useSketcher.getState().picks).toHaveLength(2);
        sketchClick([20, 20], 0.5);
        const path = useSketcher.getState().geometry.constraints.find((c) => c.kind === 'pathLength')!;
        expect(path).toMatchObject({ value: 15 });
        expect(path).not.toHaveProperty('driven');
        expect(solveGeometry(useSketcher.getState().geometry).dof).toBe(solveGeometry(g).dof - 1);
        const driven = setDriven(useSketcher.getState().geometry, [path.id], true);
        expect(driven.constraints.find((c) => c.id === path.id)).toMatchObject({ driven: true });
        expect(solveGeometry(driven).dof).toBe(solveGeometry(g).dof);
    });
});

describe('the further kinds in edits', () => {
    it('drops an arc length when the arc is split, scales it with the arc, and keeps a point angle under scaling', () => {
        const arc = addArc(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        const c = arc.g.curves[0] as Extract<SketchGeometry['curves'][number], { kind: 'arc' }>;
        let g = addConstraint(arc.g, { kind: 'arcLength', curve: c.id, value: 10 * Math.PI }).g;
        g = addConstraint(g, { kind: 'pointAngle', vertex: c.center, a: c.start, b: c.end, value: 180 }).g;
        const split = splitAt(g, c.id, [0, 10]);
        expect('error' in split).toBe(false);
        if (!('error' in split)) {
            expect(split.dropped).toBe(1);
            expect(split.g.constraints.some((k) => k.kind === 'arcLength')).toBe(false);
        }
        const scaled = transformEntities(g, [c.id], { kind: 'scale', centre: [0, 0], factor: 2 }, true);
        expect('error' in scaled).toBe(false);
        if (!('error' in scaled)) {
            const copies = scaled.g.constraints.slice(2);
            expect(copies.find((k) => k.kind === 'arcLength')).toMatchObject({ value: 20 * Math.PI });
            expect(copies.find((k) => k.kind === 'pointAngle')).toMatchObject({ value: 180 });
        }
    });
});

describe('smart dimension picks', () => {
    it('makes arc length from an arc and its two ends, and the angle at the first of three points', () => {
        const arc = addArc(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        const c = arc.g.curves[0] as Extract<SketchGeometry['curves'][number], { kind: 'arc' }>;
        expect(dimensionFromPicks(arc.g, [curve(c.id), point(c.start), point(c.end)], [0, 15])).toEqual({ kind: 'arcLength', curve: c.id, value: 0 });
        expect(dimensionFromPicks(arc.g, [curve(c.id), point(c.start), point(c.center)], [0, 15])).toBeNull();
        expect(dimensionFromPicks(arc.g, [point(c.center), point(c.start), point(c.end)], [0, 3])).toEqual({
            kind: 'pointAngle', vertex: c.center, a: c.start, b: c.end, value: 0,
        });
    });

    it('dimensions to a line midpoint, to an arc edge (Shift), and doubled across a centreline', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const g = { ...line.g, points: [...line.g.points, { id: 'p9', u: 5, v: 7 }] };
        expect(dimensionFromPicks(g, [point('p9'), midPick(line.id)], [12, 3])).toMatchObject({ kind: 'distance', a: 'p9', b: line.id, bMid: true, axis: 'v' });
        const circle = addCircle(g, { at: [30, 0] }, 4);
        expect(dimensionFromPicks(circle.g, [point('p9'), curve(circle.id, true)], [20, 10])).toMatchObject({ kind: 'distance', a: 'p9', b: circle.id, bCond: 'min' });
        expect(dimensionFromPicks(circle.g, [curve(circle.id, true), curve(line.id)], [20, 10])).toMatchObject({ kind: 'distance', a: circle.id, aCond: 'min', b: line.id });
        // A centreline: near side a radius-style distance, far side doubled.
        const axis = addLine(g, { at: [0, -20] }, { at: [0, 20] });
        const cl = toggleConstruction(axis.g, [axis.id]);
        expect(dimensionFromPicks(cl, [curve(axis.id), point('p9')], [8, 3])).not.toHaveProperty('doubled');
        expect(dimensionFromPicks(cl, [curve(axis.id), point('p9')], [-8, 3])).toMatchObject({ kind: 'distance', a: 'p9', b: axis.id, doubled: true });
    });

    it('locks the Horizontal and Vertical Dimension tools to one axis', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 4] });
        const l = line.g.curves[0] as Extract<SketchGeometry['curves'][number], { kind: 'line' }>;
        expect(dimensionFromPicks(line.g, [curve(l.id)], [5, -5], 'u')).toEqual({ kind: 'distance', a: l.a, b: l.b, value: 0, axis: 'u' });
        expect(dimensionFromPicks(line.g, [point(l.a), point(l.b)], [20, 2], 'u')).toMatchObject({ axis: 'u' });
        expect(dimensionFromPicks(line.g, [point(l.b), curve('axis-v')], [20, 2], 'u')).toEqual({ kind: 'distance', a: l.b, b: 'axis-v', value: 0 });
        expect(dimensionFromPicks(line.g, [point(l.b), curve('axis-v')], [20, 2], 'v')).toBeNull();
    });

    it('collects the third pick in the view', () => {
        const arc = addArc(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        const c = arc.g.curves[0] as Extract<SketchGeometry['curves'][number], { kind: 'arc' }>;
        useSketcher.setState({ active: true, stage: 'draw', geometry: arc.g, undo: [], redo: [], selection: [], picks: [], labels: {}, conflicting: [], redundant: [], dimDraft: null });
        setDimensionTool(null);
        sketchClick([0, 10], 0.5);
        sketchClick([10, 0], 0.5);
        sketchClick([-10, 0], 0.5);
        // Right at the arc's middle the pick is its midpoint, which stands for the arc here.
        expect(useSketcher.getState().picks.map((p) => p.id)).toEqual([`mid:${c.id}`, c.start, c.end]);
        sketchClick([0, 16], 0.5);
        expect(useSketcher.getState().dimDraft?.constraint).toMatchObject({ kind: 'arcLength', curve: c.id });
        setDimensionTool('v');
        expect(useSketcher.getState().dimLock).toBe('v');
    });
});

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const lengthOf = (g: SketchGeometry, id: string) => {
    const line = g.curves.find((c) => c.id === id);
    if (line?.kind !== 'line') {
        return NaN;
    }
    const [a, b] = [pointOf(g, line.a)!, pointOf(g, line.b)!];
    return Math.hypot(b.u - a.u, b.v - a.v);
};

const withDim = (g: SketchGeometry, c: NewConstraint) => addConstraint(g, c);

function solved(g: SketchGeometry): SketchGeometry {
    const r = solveGeometry(g);
    expect(r.ok).toBe(true);
    return r.geometry;
}

describe('driven dimensions', () => {
    it('hold nothing and follow the geometry', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const free = solveGeometry(line.g).dof;
        const driven = withDim(line.g, { kind: 'length', line: line.id, value: 3, driven: true });
        const r = solveGeometry(driven.g);
        expect(r.ok).toBe(true);
        expect(r.dof).toBe(free);
        // The value is what the line measures, not what was stored.
        expect((r.geometry.constraints[0] as Extract<SketchConstraint, { kind: 'length' }>).value).toBeCloseTo(10, 9);
        // A driving dimension on the same line moves it; the driven one follows.
        const driving = withDim(r.geometry, { kind: 'length', line: line.id, value: 25.123456789 });
        const after = solved(driving.g);
        expect(lengthOf(after, line.id)).toBeCloseTo(25.123456789, 6);
        expect((after.constraints[0] as Extract<SketchConstraint, { kind: 'length' }>).value).toBeCloseTo(25.123456789, 6);
    });

    it('tells a dimension that would over define the sketch', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
        const g = withDim(r.g, { kind: 'length', line: r.lines[0], value: 40 }).g;
        // Top and bottom of a rectangle are the same length: a second width over defines it.
        expect(overDefines(g, { kind: 'length', line: r.lines[2], value: 0 })).toBe(true);
        expect(overDefines(g, { kind: 'length', line: r.lines[1], value: 0 })).toBe(false);
    });

    it('switches between driving and driven at the size the geometry has', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const d = withDim(line.g, { kind: 'length', line: line.id, value: 10 });
        const asDriven = setDriven(d.g, [d.id], true);
        expect(asDriven.constraints[0]).toMatchObject({ driven: true, value: 10 });
        expect(solveGeometry(asDriven).dof).toBe(solveGeometry(line.g).dof);
        const back = setDriven(asDriven, [d.id], false);
        expect('driven' in back.constraints[0]).toBe(false);
        expect(solveGeometry(back).dof).toBe(solveGeometry(line.g).dof - 1);
    });

    it('is added as driven from the over-defined choice', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
        const g = withDim(r.g, { kind: 'length', line: r.lines[0], value: 40 }).g;
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], labels: {}, conflicting: [], redundant: [] });
        setTool('dimension');
        useSketcher.setState({ dimDraft: { constraint: { kind: 'length', line: r.lines[2], value: 0 }, at: [20, -5], text: '40', editing: null, error: null, overDefining: true } });
        chooseDimensionDriven(true);
        const s = useSketcher.getState();
        expect(s.dimDraft).toBeNull();
        const added = s.geometry.constraints.find((c) => c.kind === 'length' && c.line === r.lines[2]);
        expect(added).toMatchObject({ driven: true });
        expect(s.redundant).toEqual([]);
    });
});

describe('further dimension kinds', () => {
    it('drives the length along an arc', () => {
        const arc = addArc(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        const radius = withDim(arc.g, { kind: 'radius', curve: arc.id, value: 10 });
        const g = solved(withDim(radius.g, { kind: 'arcLength', curve: arc.id, value: 20 }).g);
        const c = g.constraints.find((k) => k.kind === 'arcLength')!;
        expect(measure(g, c)).toBeCloseTo(20, 6);
        expect(curveRadius(g, arc.id)).toBeCloseTo(10, 5);
    });

    it('drives the angle at a point between two others', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        g = addLine(g, { at: [0, 0], point: g.points[0].id }, { at: [5, 8] }).g;
        const [v, a, b] = g.points.map((p) => p.id);
        const r = withDim(g, { kind: 'pointAngle', vertex: v, a, b, value: 30 });
        const out = solved(r.g);
        expect(measure(out, out.constraints[0])).toBeCloseTo(30, 4);
    });

    it('measures and drives to a line midpoint, also horizontally', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        const line = g.curves[0].id;
        g = { ...g, points: [...g.points, { id: 'p9', u: 5, v: 7 }] };
        const aligned = withDim(g, { kind: 'distance', a: 'p9', b: line, bMid: true, value: 0 });
        expect(measure(g, aligned.g.constraints[0])).toBeCloseTo(7, 9);
        const out = solved({ ...aligned.g, constraints: [{ ...aligned.g.constraints[0], value: 12 } as SketchConstraint] });
        expect(measure(out, out.constraints[0])).toBeCloseTo(12, 6);
        const across = withDim(g, { kind: 'distance', a: 'p9', b: line, bMid: true, axis: 'u', value: 3 });
        const moved = solved(across.g);
        const p = pointOf(moved, 'p9')!;
        const [s, e] = [pointOf(moved, g.points[0].id)!, pointOf(moved, g.points[1].id)!];
        expect(Math.abs(p.u - (s.u + e.u) / 2)).toBeCloseTo(3, 6);
    });

    it('measures to the near or far side of a circle, and drives it', () => {
        const circle = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        const fixed = withDim(circle.g, { kind: 'fix', point: circle.center }).g;
        const radius = withDim(fixed, { kind: 'radius', curve: circle.id, value: 5 }).g;
        const g = { ...radius, points: [...radius.points, { id: 'p9', u: 20, v: 0 }] };
        expect(measure(g, { id: 'm', kind: 'distance', a: 'p9', b: circle.id, bCond: 'min', value: 0 })).toBeCloseTo(15, 9);
        expect(measure(g, { id: 'm', kind: 'distance', a: 'p9', b: circle.id, bCond: 'max', value: 0 })).toBeCloseTo(25, 9);
        const near = solved(withDim(g, { kind: 'distance', a: 'p9', b: circle.id, bCond: 'min', value: 10 }).g);
        expect(Math.hypot(pointOf(near, 'p9')!.u, pointOf(near, 'p9')!.v)).toBeCloseTo(15, 6);
        const far = solved(withDim(g, { kind: 'distance', a: 'p9', b: circle.id, bCond: 'max', value: 30 }).g);
        expect(Math.hypot(pointOf(far, 'p9')!.u, pointOf(far, 'p9')!.v)).toBeCloseTo(25, 6);
        // Between two circles, edge to edge.
        const other = addCircle(g, { at: [30, 0] }, 4);
        const both = withDim(other.g, { kind: 'distance', a: circle.id, aCond: 'min', b: other.id, bCond: 'min', value: 0 });
        expect(measure(both.g, both.g.constraints[both.g.constraints.length - 1])).toBeCloseTo(21, 9);
    });

    it('drives a doubled distance across a centreline (a diameter for revolving)', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, -10] }, { at: [0, 10] }).g;
        const axis = g.curves[0].id;
        g = { ...g, points: [...g.points, { id: 'p9', u: 6, v: 0 }] };
        expect(measure(g, { id: 'm', kind: 'distance', a: 'p9', b: axis, doubled: true, value: 0 })).toBeCloseTo(12, 9);
        const out = solved(withDim(g, { kind: 'distance', a: 'p9', b: axis, doubled: true, value: 30 }).g);
        const [p, a] = [pointOf(out, 'p9')!, pointOf(out, g.points[0].id)!];
        expect(Math.abs(p.u - a.u)).toBeCloseTo(15, 6);
    });
});
