// PropertyManagers of a selected line, circle, arc and point: their Parameters, put in through the solver as one
// undo step, refused where relations hold the entity, and which form a click opens.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, loadSolver, pointOf } from './solver';
import { EMPTY_GEOMETRY, addArc, addCircle, addConstraint, addLine } from './sketchGeometry';
import { editEntity, entityValues, solveEntityEdit, type EntityKind, type Numbers } from './sketchEntityParams';
import { entityFormId, entityFormMayOpen } from './sketchEntityOpen';
import { applyPending, usePending } from './sketchEntityForms';
import { sketchClick, undoSketch, useSketcher } from './sketcher';
import { useToolSession } from './toolSession';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const line = (g: SketchGeometry, id: string) => curveOf(g, id) as Extract<SketchCurve, { kind: 'line' }>;
const at = (g: SketchGeometry, id: string) => [pointOf(g, id)!.u, pointOf(g, id)!.v];

function solved(g: SketchGeometry, kind: EntityKind, id: string, next: Numbers): SketchGeometry | string {
    const edit = editEntity(g, kind, id, next);
    return typeof edit === 'string' ? edit : solveEntityEdit(edit);
}

describe('line properties', () => {
    const base = () => addLine(EMPTY_GEOMETRY, { at: [1, 2] }, { at: [11, 2] });

    it('shows length, angle, start, end and delta', () => {
        const r = base();
        const v = entityValues(r.g, 'line', r.id)!;
        expect(v).toMatchObject({ length: 10, angle: 0, start0: 1, start1: 2, end0: 11, end1: 2, delta0: 10, delta1: 0 });
        const up = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [-3, 3] });
        expect(entityValues(up.g, 'line', up.id)!.angle).toBeCloseTo(135, 9);
    });

    it('takes a new length and angle from the start, to a fine value', () => {
        const r = base();
        const g = solved(r.g, 'line', r.id, { length: 12.3456789, angle: 30 });
        expect(typeof g).not.toBe('string');
        const l = line(g as SketchGeometry, r.id);
        expect(at(g as SketchGeometry, l.a)).toEqual([1, 2]);
        const v = entityValues(g as SketchGeometry, 'line', r.id)!;
        expect(v.length).toBeCloseTo(12.3456789, 7);
        expect(v.angle).toBeCloseTo(30, 7);
    });

    it('moves the start, the end, or the end by its delta', () => {
        const r = base();
        let g = solved(r.g, 'line', r.id, { start0: -4 }) as SketchGeometry;
        expect(entityValues(g, 'line', r.id)).toMatchObject({ start0: -4, end0: 11 });
        g = solved(g, 'line', r.id, { end1: 7 }) as SketchGeometry;
        expect(entityValues(g, 'line', r.id)).toMatchObject({ end0: 11, end1: 7 });
        g = solved(g, 'line', r.id, { delta0: 3, delta1: -1 }) as SketchGeometry;
        expect(entityValues(g, 'line', r.id)).toMatchObject({ start0: -4, start1: 2, end0: -1, end1: 1 });
    });

    it('refuses an angle a horizontal relation holds, and a zero length', () => {
        const r = base();
        const g = addConstraint(r.g, { kind: 'horizontal', line: r.id }).g;
        expect(solved(g, 'line', r.id, { angle: 20 })).toMatch(/relations and dimensions/);
        expect(solved(g, 'line', r.id, { length: 0 })).toMatch(/above zero/);
        expect(typeof solved(g, 'line', r.id, { length: 4 })).not.toBe('string');
    });
});

describe('circle, arc and point parameters', () => {
    it('moves a circle and gives it a new radius, unless a diameter dimension holds it', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        const g = solved(c.g, 'circle', c.id, { centre0: 3, centre1: 4, radius: 2.5 }) as SketchGeometry;
        expect(entityValues(g, 'circle', c.id)).toEqual({ centre0: 3, centre1: 4, radius: 2.5 });
        const held = addConstraint(c.g, { kind: 'diameter', curve: c.id, value: 10 }).g;
        expect(solved(held, 'circle', c.id, { radius: 2.5 })).toMatch(/relations and dimensions/);
    });

    it('turns an arc to a new angle and radius', () => {
        const a = addArc(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        const v = entityValues(a.g, 'arc', a.id)!;
        expect(v.radius).toBeCloseTo(10, 9);
        expect(v.angle).toBeCloseTo(180, 9);
        const g = solved(a.g, 'arc', a.id, { angle: 90 }) as SketchGeometry;
        expect(entityValues(g, 'arc', a.id)!.angle).toBeCloseTo(90, 6);
        const r = solved(g, 'arc', a.id, { radius: 4 }) as SketchGeometry;
        expect(entityValues(r, 'arc', a.id)!.radius).toBeCloseTo(4, 6);
        expect(solved(g, 'arc', a.id, { angle: 400 })).toMatch(/between 0 and 360/);
    });

    it('moves a point', () => {
        const r = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const end = line(r.g, r.id).b;
        const g = solved(r.g, 'point', end, { x: 6, y: 8 }) as SketchGeometry;
        expect(entityValues(g, 'point', end)).toEqual({ x: 6, y: 8 });
    });
});

describe('which form a click opens', () => {
    it('opens Line properties, Circle, Arc or Point; nothing for the origin', () => {
        const r = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const c = addCircle(r.g, { at: [20, 0] }, 3);
        const a = addArc(c.g, { at: [10, 0] }, { at: [-10, 0] }, [0, 10]);
        expect(entityFormId(a.g, { type: 'curve', id: r.id })).toBe('sk-pm-line');
        expect(entityFormId(a.g, { type: 'curve', id: c.id })).toBe('sk-pm-circle');
        expect(entityFormId(a.g, { type: 'curve', id: a.id })).toBe('sk-pm-arc');
        expect(entityFormId(a.g, { type: 'point', id: line(a.g, r.id).b })).toBe('sk-pm-point');
        expect(entityFormId(a.g, { type: 'point', id: 'origin' })).toBeNull();
    });

    it('opens over no form or another entity form, but not over a command that selects (Fully define)', () => {
        expect(entityFormMayOpen(null)).toBe(true);
        expect(entityFormMayOpen('sk-pm-circle')).toBe(true);
        expect(entityFormMayOpen('sk-pm-slot')).toBe(true);
        expect(entityFormMayOpen('sk-fully-define')).toBe(false);
        expect(entityFormMayOpen('sk-pattern-linear')).toBe(false);
    });
});

describe('a click with the Select tool', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        useToolSession.setState({ toolId: null });
    });

    it('opens the form of what was clicked; the same form open already follows the selection; a command form keeps the click', () => {
        const r = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const c = addCircle(r.g, { at: [30, 0] }, 3);
        const other = addLine(c.g, { at: [0, 20] }, { at: [10, 20] });
        useSketcher.setState({ active: true, stage: 'draw', tool: 'select', geometry: other.g, undo: [], redo: [], selection: [], message: null });
        const dispatchEvent = vi.fn();
        vi.stubGlobal('window', { dispatchEvent });
        const opened = () => dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).detail);
        sketchClick([5, 0], 0.5);
        sketchClick([33, 0], 0.5);
        sketchClick([10, 20], 0.5);
        expect(opened()).toEqual(['sk-pm-line', 'sk-pm-circle', 'sk-pm-point']);
        useToolSession.setState({ toolId: 'sk-pm-line' });
        sketchClick([5, 20], 0.5);
        expect(useSketcher.getState().selection).toEqual([{ type: 'curve', id: other.id }]);
        useToolSession.setState({ toolId: 'sk-fully-define' });
        sketchClick([33, 0], 0.5);
        expect(opened()).toHaveLength(3);
    });
});

describe('typed values in the open form', () => {
    beforeEach(() => {
        const r = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        useSketcher.setState({ active: true, stage: 'draw', geometry: r.g, undo: [], redo: [], selection: [{ type: 'curve', id: r.id }], message: null });
        usePending.setState({ subject: r.id, edits: {}, note: null });
    });

    it('puts length and angle in together as one undo step, and undo takes them back', () => {
        const id = useSketcher.getState().geometry.curves[0].id;
        usePending.setState({ edits: { length: '20', angle: '90' } });
        expect(applyPending('line')).toBeNull();
        const g = useSketcher.getState().geometry;
        expect(entityValues(g, 'line', id)!.length).toBeCloseTo(20, 9);
        expect(entityValues(g, 'line', id)!.angle).toBeCloseTo(90, 9);
        expect(useSketcher.getState().undo).toHaveLength(1);
        undoSketch();
        expect(entityValues(useSketcher.getState().geometry, 'line', id)!.length).toBeCloseTo(10, 9);
    });

    it('says why when the value is not a number, and changes nothing', () => {
        usePending.setState({ edits: { length: 'abc' } });
        expect(applyPending('line')).toMatch(/not a number/);
        expect(useSketcher.getState().undo).toHaveLength(0);
        expect(usePending.getState().note).toMatch(/not a number/);
    });
});
