// Instant2D: the value handle of a selected dimension, dragging it (the geometry follows, the fixed side stays), and
// the ruler, on which the value steps along the marks.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, measure, pointOf } from './solver';
import { addCircle, addConstraint, addLine, EMPTY_GEOMETRY } from './sketchGeometry';
import { undoSketch, useSketcher } from './sketcher';
import { handleOf, instant2dDown, instant2dMove, instant2dUp, rulerStep, shownHandle, valueAt, withValue } from './sketchInstant2d';
import { setSketchToggle } from './sketchToggles';
import { DEFAULT_SKETCH_SETTINGS } from './sketchSettings';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const state = () => useSketcher.getState();

function sized() {
    const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
    const k = addConstraint(l.g, { kind: 'length', line: l.id, value: 10 });
    const line = l.g.curves[0] as { a: string; b: string };
    return { g: k.g, dim: k.id, a: line.a, b: line.b };
}

function begin(g: SketchGeometry, selected: string): void {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [{ type: 'constraint', id: selected }], tool: 'select', labels: {},
        dimDraft: null, message: null, settings: { ...DEFAULT_SKETCH_SETTINGS },
    });
}

describe('Instant2D', () => {
    it('gives a length a handle at the far end, measured from the first', () => {
        const { g, dim, a } = sized();
        const h = handleOf(g, g.constraints.find((c) => c.id === dim)!)!;
        expect(h).toMatchObject({ kind: 'linear', at: [10, 0], zero: [0, 0], dir: [1, 0], factor: 1, hold: [a] });
        // Off the ruler the value follows the pointer exactly; on it, it steps along the marks.
        expect(valueAt(h, [13.37, 5], 1, 1)).toBeCloseTo(13.37, 12);
        expect(valueAt(h, [13.37, 0.4], 1, 1)).toBe(13);
        expect(valueAt(h, [-4, 0], 1, 1)).toBe(0);
    });

    it('drags the value: the geometry follows, the fixed end stays, one undo step', () => {
        const { g, dim, a, b } = sized();
        begin(g, dim);
        expect(shownHandle(state())).not.toBeNull();
        expect(instant2dDown([30, 30], 0.1)).toBe(false);
        expect(instant2dDown([10.2, 0.1], 0.1)).toBe(true);
        instant2dMove([12, 3]);
        instant2dMove([14.25, 3]);
        instant2dUp();
        const after = state().geometry;
        expect(after.constraints.find((c) => c.id === dim)).toMatchObject({ value: 14.25 });
        expect(pointOf(after, a)).toMatchObject({ u: 0, v: 0 });
        expect(pointOf(after, b)!.u).toBeCloseTo(14.25, 9);
        expect(state().undo).toHaveLength(1);
        undoSketch();
        expect(state().geometry).toBe(g);
    });

    it('shows no handle with Instant2D off, for a driven dimension, or with more selected', () => {
        const { g, dim } = sized();
        begin(g, dim);
        setSketchToggle('instant2d', false);
        expect(shownHandle(state())).toBeNull();
        setSketchToggle('instant2d', true);
        const driven = { ...g, constraints: g.constraints.map((c) => (c.id === dim ? { ...c, driven: true } : c)) };
        expect(handleOf(driven, driven.constraints.find((c) => c.id === dim)!)).toBeNull();
        useSketcher.setState({ selection: [{ type: 'constraint', id: dim }, { type: 'curve', id: g.curves[0].id }] });
        expect(shownHandle(state())).toBeNull();
    });

    it('drags a radius or a diameter out from the centre, toward the label', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        const r = addConstraint(c.g, { kind: 'diameter', curve: c.id, value: 10 });
        const h = handleOf(r.g, r.g.constraints.find((k) => k.id === r.id)!, [0, 12])!;
        expect(h.at[0]).toBeCloseTo(0, 12);
        expect(h.at[1]).toBeCloseTo(5, 12);
        expect(h.factor).toBe(2);
        expect(valueAt(h, [3, 8], 1, 0.5)).toBeCloseTo(16, 12);
        const g = withValue(r.g, h, 16)!;
        expect(measure(g, g.constraints.find((k) => k.id === r.id)!)).toBeCloseTo(16, 9);
        expect(pointOf(g, c.center)).toMatchObject({ u: 0, v: 0 });
    });

    it('drags a point square to a line for a point-to-line distance', () => {
        const base = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 0] });
        const p = addLine(base.g, { at: [5, 4] }, { at: [8, 9] });
        const point = (p.g.curves[1] as { a: string }).a;
        const d = addConstraint(p.g, { kind: 'distance', a: point, b: base.id, value: 4 });
        const h = handleOf(d.g, d.g.constraints.find((k) => k.id === d.id)!)!;
        expect(h).toMatchObject({ at: [5, 4], zero: [5, 0], dir: [0, 1] });
        const held = d.g.curves[0] as { a: string; b: string };
        expect(h.hold).toEqual([held.a, held.b]);
        const g = withValue(d.g, h, 7.5)!;
        expect(pointOf(g, point)!.v).toBeCloseTo(7.5, 9);
    });

    it('turns an angle about the vertex, stepping by whole degrees on the protractor', () => {
        const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const b = addLine(a.g, { at: [0, 0], point: (a.g.curves[0] as { a: string }).a }, { at: [10, 10] });
        const k = addConstraint(b.g, { kind: 'angle', a: a.id, b: b.id, value: 45 });
        const h = handleOf(k.g, k.g.constraints.find((c) => c.id === k.id)!)!;
        expect(h.kind).toBe('angular');
        expect(h.zero[0]).toBeCloseTo(0, 9);
        expect(h.dir).toEqual([1, 0]);
        const r = Math.hypot(h.at[0], h.at[1]);
        const at = (deg: number, rr = r): [number, number] => [rr * Math.cos((deg * Math.PI) / 180), rr * Math.sin((deg * Math.PI) / 180)];
        expect(valueAt(h, at(60.4, r * 2), 1, 0.5)).toBeCloseTo(60.4, 9);
        expect(valueAt(h, at(60.4), 1, 0.5)).toBe(60);
        const g = withValue(k.g, h, 60)!;
        expect(measure(g, g.constraints.find((c) => c.id === k.id)!)).toBeCloseTo(60, 6);
        // The fixed line stays.
        expect(pointOf(g, (a.g.curves[0] as { b: string }).b)).toMatchObject({ u: 10, v: 0 });
    });

    it('spaces the ruler marks at least 8 px apart in steps of 1, 2 or 5', () => {
        expect(rulerStep(0.1, false)).toEqual({ minor: 1, major: 10 });
        expect(rulerStep(0.02, false).minor).toBeCloseTo(0.2, 12);
        expect(rulerStep(0.5, false)).toEqual({ minor: 5, major: 50 });
        expect(rulerStep(1, true)).toEqual({ minor: 1, major: 15 });
    });
});
