import { describe, expect, it } from 'vitest';
import type { Feature, Sketch, SketchGeometry } from '@jarvis/core';
import { otherSketches } from './sketchOthers';
import { snapCursor } from './snapping';
import { setTool, sketchClick, sketchDown, sketchUp, useSketcher } from './sketcher';
import { vi } from 'vitest';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

/** A 20 x 10 rectangle with a corner at the sketch origin and a circle of radius 3 at (10, 5). */
const geometry: SketchGeometry = {
    points: [
        { id: 'a', u: 0, v: 0 }, { id: 'b', u: 20, v: 0 }, { id: 'c', u: 20, v: 10 }, { id: 'd', u: 0, v: 10 }, { id: 'm', u: 10, v: 5 },
    ],
    curves: [
        { id: 'l1', kind: 'line', a: 'a', b: 'b' }, { id: 'l2', kind: 'line', a: 'b', b: 'c' },
        { id: 'l3', kind: 'line', a: 'c', b: 'd' }, { id: 'l4', kind: 'line', a: 'd', b: 'a' },
        { id: 'k', kind: 'circle', center: 'm', radius: 3 },
    ],
    constraints: [],
};
const step = (id: string, sketch: Partial<Sketch>): Feature => ({ id, op: 'sketch', sketch: { plane: 'top', profiles: [], geometry, ...sketch } }) as Feature;
const xy = (g: SketchGeometry, id: string) => {
    const p = g.points.find((q) => q.id === id)!;
    return [p.u, p.v].map((n) => Math.round(n * 1e6) / 1e6 + 0);
};

describe('otherSketches', () => {
    it('gives a sketch on a parallel plane point for point, with its lines and circles', () => {
        const g = otherSketches([step('sketch-1', { offset: 30 })], 'top', 0);
        expect(xy(g, 'sketch-1/c')).toEqual([20, 10]);
        expect(xy(g, 'sketch-1/origin')).toEqual([0, 0]);
        expect(g.curves.map((c) => c.kind)).toEqual(['line', 'line', 'line', 'line', 'circle']);
    });

    it('projects a sketch on a crossing plane: lines stay lines, a circle leaves only its centre', () => {
        const g = otherSketches([step('sketch-1', { plane: 'front' })], 'top', 0);
        // The rectangle stands on edge over the top plane: its two horizontal sides land on one line, the others on points.
        expect(g.curves.every((c) => c.kind === 'line')).toBe(true);
        expect(g.curves).toHaveLength(2);
        expect(g.points.some((p) => p.id === 'sketch-1/m')).toBe(true);
    });

    it('leaves out suppressed and skipped steps', () => {
        const steps = [step('sketch-1', {}), { ...step('sketch-2', {}), suppressed: true } as Feature, step('sketch-3', {})];
        const g = otherSketches(steps, 'top', 0, (id) => id === 'sketch-3');
        expect(new Set(g.points.map((p) => p.id.split('/')[0]))).toEqual(new Set(['sketch-1']));
    });
});

describe('snapping to other sketches', () => {
    const others = otherSketches([step('sketch-1', { offset: 30 })], 'top', 0);
    const empty: SketchGeometry = { points: [], curves: [], constraints: [] };
    const opts = { enabled: true, grid: 0, tolerance: 0.5, others };

    it('lands on their corners, midpoints, centres and lines, without tying the point to them', () => {
        const corner = snapCursor(empty, [20.2, 9.9], opts);
        expect(corner).toMatchObject({ p: [20, 10], kind: 'point' });
        expect(corner.ref).toEqual({ at: [20, 10] });
        expect(snapCursor(empty, [10.1, 0.2], opts)).toMatchObject({ p: [10, 0], kind: 'mid', ref: { at: [10, 0] } });
        expect(snapCursor(empty, [10.1, 5.1], opts)).toMatchObject({ p: [10, 5], kind: 'centre' });
        const on = snapCursor(empty, [4.3, 0.2], opts);
        expect(on).toMatchObject({ kind: 'curve', ref: { at: on.p } });
        expect(on.p[1]).toBeCloseTo(0);
    });

    it('prefers a point of the sketch itself at the same spot, and can be switched off with the sketch', () => {
        const own: SketchGeometry = { points: [{ id: 'p1', u: 20, v: 10 }], curves: [], constraints: [] };
        expect(snapCursor(own, [20.1, 10.1], opts).ref).toEqual({ at: [20, 10], point: 'p1' });
        expect(snapCursor(empty, [20.2, 9.9], { ...opts, others: undefined }).p).toEqual([20.2, 9.9]);
    });
});

describe('pressing the mouse in a sketch with the Select tool', () => {
    const start = (g: SketchGeometry) => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, selection: [], drag: null, dragFrom: null });
        setTool('select');
    };
    const TOL = 1;

    it('keeps the view still on empty space too: the press starts a selection box', () => {
        start(geometry);
        expect(sketchDown([60, 60], TOL)).toBe(true);
        sketchUp();
        // Select the corner, then press a little beside it: the view stays put.
        sketchClick([20, 10], TOL);
        expect(useSketcher.getState().selection).toHaveLength(1);
        expect(sketchDown([24, 14], TOL)).toBe(true);
        sketchUp();
    });

    it('keeps the view still on a locked point and on the origin, which cannot be dragged', () => {
        start({ ...geometry, points: geometry.points.map((p) => (p.id === 'c' ? { ...p, fixed: true } : p)) });
        expect(sketchDown([20, 10], TOL)).toBe(true);
        expect(useSketcher.getState().drag).toBeNull();
        sketchUp();
        expect(sketchDown([0, 0], TOL)).toBe(true);
        sketchUp();
    });
});
