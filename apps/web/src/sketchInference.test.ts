// Automatic relations while drawing (parallel, perpendicular, tangent; off, and Ctrl), the further quick snaps
// (tangent, perpendicular, parallel, angle, length) and the sketch settings: automatic solve, detach segment on
// drag, override dimensions on drag.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, measure, pointOf } from './solver';
import { EMPTY_GEOMETRY, addArc, addCircle, addConstraint, addLine } from './sketchGeometry';
import { snapCursor, type SnapOptions } from './snapping';
import { setSketchSettings, setTool, sketchClick, sketchDown, sketchMove, sketchUp, solveSketch, useSketcher } from './sketcher';
import { DEFAULT_SKETCH_SETTINGS } from './sketchSettings';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const opts = (extra: Partial<SnapOptions> = {}): SnapOptions => ({ enabled: true, grid: 0, tolerance: 0.5, kinds: { aligned: false }, drawsLine: true, ...extra });
const state = () => useSketcher.getState();

function begin(g: SketchGeometry, tool: Parameters<typeof setTool>[0]) {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], typed: '', draft: [], message: null,
        conflicting: [], redundant: [], dimDraft: null, labels: {}, snapKinds: {}, snap: true, grid: 0, settings: { ...DEFAULT_SKETCH_SETTINGS },
    });
    setTool(tool);
}

beforeEach(() => {
    setSketchSettings({ ...DEFAULT_SKETCH_SETTINGS });
});

describe('inferred directions and the further snaps', () => {
    it('infers parallel and perpendicular to a woken line, and perpendicular to the line it goes on from', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 5] }).g;
        const [line] = g.curves.map((c) => c.id);
        const along = snapCursor(g, [20.1, 14.9], opts({ last: [10, 10], woken: [line] }));
        expect(along).toMatchObject({ kind: 'parallel', ref: { infer: { kind: 'parallel', to: line } } });
        expect((along.p[1] - 10) / (along.p[0] - 10)).toBeCloseTo(0.5, 9);
        const square = snapCursor(g, [14.1, 2], opts({ last: [10, 10], woken: [line] }));
        expect(square).toMatchObject({ kind: 'perpendicular', ref: { infer: { kind: 'perpendicular', to: line } } });
        const end = g.points[1].id;
        const fromEnd = snapCursor(g, [7.9, 9.1], opts({ last: [10, 5], lastPoint: end }));
        expect(fromEnd).toMatchObject({ kind: 'perpendicular', ref: { infer: { to: line } } });
    });

    it('infers tangent off an arc end, snaps to tangent points of a circle and to the foot on a line', () => {
        const arc = addArc(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        const start = arc.g.points.find((p) => p.u === 10)!.id;
        const off = snapCursor(arc.g, [10.2, -6], opts({ last: [10, 0], lastPoint: start }));
        expect(off).toMatchObject({ kind: 'tangent', ref: { infer: { kind: 'tangent', to: arc.id } } });
        expect(off.p[0]).toBeCloseTo(10, 9);
        const circle = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        // From (10, 0) the tangent points are at 60° from the u axis.
        const t = snapCursor(circle.g, [2.6, 4.2], opts({ last: [10, 0] }));
        expect(t).toMatchObject({ kind: 'tangent', ref: { onCurves: [circle.id], infer: { kind: 'tangent', to: circle.id } } });
        expect(t.p[0]).toBeCloseTo(2.5, 9);
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 10] });
        const foot = snapCursor(line.g, [11.9, 6.1], opts({ last: [14, 2] }));
        expect(foot).toMatchObject({ kind: 'perpendicular', ref: { infer: { kind: 'perpendicular', to: line.id } } });
    });

    it('snaps to steps of the snap angle and, with Shift, to lengths in grid steps', () => {
        const a = snapCursor(EMPTY_GEOMETRY, [8.7, 5.05], opts({ last: [0, 0], angleStep: 30 }));
        expect(a.kind).toBe('angle');
        expect(Math.atan2(a.p[1], a.p[0]) * 180 / Math.PI).toBeCloseTo(30, 9);
        const l = snapCursor(EMPTY_GEOMETRY, [7.3, 3.1], opts({ last: [0, 0], grid: 2, lengthSnap: true, kinds: {} }));
        expect(Math.hypot(l.p[0], l.p[1])).toBeCloseTo(8, 6);
        // Switched off in the quick snaps, they do nothing.
        expect(snapCursor(EMPTY_GEOMETRY, [8.7, 5.05], opts({ last: [0, 0], angleStep: 30, kinds: { aligned: false, angle: false } })).kind).not.toBe('angle');
    });
});

describe('automatic relations while drawing', () => {
    it('adds the inferred relation to the line drawn', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 5] }).g;
        const [line] = g.curves.map((c) => c.id);
        begin(g, 'line');
        sketchMove([5, 2.5], 0.5);
        sketchClick([0, 10], 0.5);
        sketchMove([20.1, 19.9], 0.5);
        sketchClick([20.1, 19.9], 0.5);
        const drawn = state().geometry.curves[1].id;
        expect(state().geometry.constraints).toContainEqual(expect.objectContaining({ kind: 'parallel', a: line, b: drawn }));
    });

    it('adds no relations when switched off, or for a click with Ctrl held', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        const end = g.points[1].id;
        begin(g, 'line');
        sketchClick([10.1, 0.1], 0.5, false, true);
        sketchClick([20, 0.2], 0.5, false, true);
        const loose = state().geometry;
        expect(loose.constraints).toEqual([]);
        // The new line starts where the old one ends, on a point of its own.
        expect(loose.curves[1]).not.toMatchObject({ a: end });
        begin(g, 'line');
        setSketchSettings({ autoRelations: false });
        sketchClick([10.1, 0.1], 0.5);
        sketchClick([20, 0.2], 0.5);
        expect(state().geometry.constraints).toEqual([]);
        setSketchSettings({ autoRelations: true });
        begin(g, 'line');
        sketchClick([10.1, 0.1], 0.5);
        sketchClick([20, 0.2], 0.5);
        expect(state().geometry.curves[1]).toMatchObject({ a: end });
        expect(state().geometry.constraints).toContainEqual(expect.objectContaining({ kind: 'horizontal' }));
    });
});

describe('sketch settings', () => {
    it('keeps changes unsolved with automatic solve off until Solve', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        begin(line.g, 'select');
        setSketchSettings({ autoSolve: false });
        const next = addConstraint(state().geometry, { kind: 'length', line: line.id, value: 30 }).g;
        useSketcher.setState({ geometry: next });
        const c = next.constraints[0];
        expect(measure(state().geometry, c)).toBeCloseTo(10, 9);
        expect(solveSketch()).toBe(true);
        expect(measure(state().geometry, c)).toBeCloseTo(30, 6);
    });

    it('detaches a shared end on drag, and joins it again for a press without a drag', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        const corner = g.points[1].id;
        g = addLine(g, { at: [10, 0], point: corner }, { at: [10, 10] }).g;
        begin(g, 'select');
        setSketchSettings({ detachOnDrag: true });
        expect(sketchDown([10, 0], 0.5)).toBe(true);
        sketchUp();
        expect(state().geometry.points).toHaveLength(3);
        sketchDown([10, 0], 0.5);
        sketchMove([12, 3], 0.5);
        sketchUp();
        const after = state().geometry;
        expect(after.points).toHaveLength(4);
        expect(pointOf(after, corner)).toMatchObject({ u: 10, v: 0 });
    });

    it('lets a drag override the dimensions on what is dragged', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [10, 0] });
        const g = addConstraint(addConstraint(line.g, { kind: 'length', line: line.id, value: 10 }).g, { kind: 'horizontal', line: line.id }).g;
        begin(g, 'select');
        setSketchSettings({ overrideDims: true });
        sketchDown([10, 0], 0.5);
        sketchMove([14.5, 0], 0.5);
        sketchUp();
        const length = state().geometry.constraints.find((c) => c.kind === 'length')!;
        expect(length).not.toHaveProperty('driven');
        expect((length as { value: number }).value).toBeCloseTo(14.5, 6);
        setSketchSettings({ overrideDims: false });
        sketchDown([14.5, 0], 0.5);
        sketchMove([20, 0], 0.5);
        sketchUp();
        expect(pointOf(state().geometry, line.b)!.u).toBeCloseTo(14.5, 6);
    });
});
