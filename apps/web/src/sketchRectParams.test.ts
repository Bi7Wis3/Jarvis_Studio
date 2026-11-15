// The Rectangle form: the rectangle's corners (and centre) as Parameters, and the Rectangle type and Slot type choice
// in the form, which opens the other tool's form as the toolbar flyout does.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, pointOf, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, addRect, addRect3 } from './sketchGeometry';
import { addCentreRect } from './sketchEdit';
import { rectangleOf, rectTargets, rectValues } from './sketchRectParams';
import { ALL_TOOLS } from './toolDefs';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const at = (g: SketchGeometry, id: string) => [pointOf(g, id)!.u, pointOf(g, id)!.v];
const ctx = { part: null, project: null, edit: null };

describe('rectangle parameters', () => {
    it('finds the four corners in order, whatever order the sides are in', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        const found = rectangleOf(r.g, r.lines)!;
        expect(found.corners.map((id) => at(r.g, id))).toEqual([[0, 0], [10, 0], [10, 5], [0, 5]]);
        expect(found.centre).toBeNull();
        const shuffled = rectangleOf(r.g, [r.lines[2], r.lines[0], r.lines[3], r.lines[1]])!;
        expect(new Set(shuffled.corners)).toEqual(new Set(found.corners));
        expect(rectangleOf(r.g, r.lines.slice(0, 3))).toBeNull();
    });

    it('gives a centre rectangle its centre, and moving the centre moves the rectangle', () => {
        const r = addCentreRect(EMPTY_GEOMETRY, { at: [5, 5] }, { at: [9, 7] });
        const curves = r.g.curves.map((c) => c.id);
        const found = rectangleOf(r.g, curves)!;
        expect(found.centre).not.toBeNull();
        const now = rectValues(r.g, found, true);
        expect([now.p_m0, now.p_m1]).toEqual([5, 5]);
        const targets = rectTargets(r.g, found, { ...now, p_m0: 7.25, p_m1: -1.5 }, now);
        const s = solveGeometry(r.g, { targets });
        expect(s.ok).toBe(true);
        const after = rectValues(s.geometry, rectangleOf(s.geometry, curves)!, true);
        expect([after.p_m0, after.p_m1]).toEqual([7.25, -1.5]);
        // The same size: a corner moved as far as the centre.
        expect(after.p_c10 - now.p_c10).toBeCloseTo(2.25, 9);
    });

    it('pulls a typed corner there; the relations keep it a rectangle', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        const found = rectangleOf(r.g, r.lines)!;
        const now = rectValues(r.g, found, false);
        const s = solveGeometry(r.g, { targets: rectTargets(r.g, found, { ...now, p_c30: 12.0001, p_c31: 8 }, now) });
        const v = rectValues(s.geometry, found, false);
        expect([v.p_c30, v.p_c31]).toEqual([12.0001, 8]);
        // The corners beside it follow along their sides; the opposite one stays.
        expect([v.p_c10, v.p_c11]).toEqual([0, 0]);
        expect(v.p_c20).toBeCloseTo(12.0001, 9);
        expect(v.p_c41).toBeCloseTo(8, 9);
    });

    it('works for a 3 point corner rectangle at an angle', () => {
        const r = addRect3(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [8, 6] }, [5, 10])!;
        const found = rectangleOf(r.g, r.lines)!;
        expect(found.corners).toHaveLength(4);
        expect(rectValues(r.g, found, false).p_c20).toBeCloseTo(8, 9);
    });
});

describe('type choice in the form', () => {
    const tool = (id: string) => ALL_TOOLS.find((t) => t.id === id)!;

    it('the rectangle forms offer the five rectangle types, each showing its own', () => {
        const rect = tool('sk-centerRect');
        const field = rect.fields!(ctx).find((f) => f.key === 'rectType')!;
        expect(field.options!.map((o) => o.label)).toEqual(['Corner rectangle', 'Centre rectangle', '3 point corner rectangle', '3 point centre rectangle', 'Parallelogram']);
        expect(rect.defaults!(ctx).rectType).toBe('centerRect');
        expect(rect.fields!(ctx).some((f) => f.key === 'p_m')).toBe(true);
        expect(tool('sk-rect').fields!(ctx).some((f) => f.key === 'p_m')).toBe(false);
        expect(tool('sk-parallelogram').fields!(ctx).filter((f) => f.key.startsWith('p_c'))).toHaveLength(4);
    });

    it('choosing another type opens that tool, as the flyout does; the slot forms likewise', () => {
        const dispatchEvent = vi.fn();
        vi.stubGlobal('window', { dispatchEvent });
        const rect = tool('sk-rect');
        rect.onChange!('rectType', { ...rect.defaults!(ctx), rectType: 'rect3' }, ctx);
        expect(dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).detail)).toEqual(['sk-rect3']);
        const slot = tool('sk-slot');
        const field = slot.fields!(ctx).find((f) => f.key === 'slotType')!;
        expect(field.options!.map((o) => o.value)).toEqual(['slot', 'centerSlot', 'arcSlot3', 'centerArcSlot']);
        slot.onChange!('slotType', { ...slot.defaults!(ctx), slotType: 'centerArcSlot' }, ctx);
        // The same type chosen again opens nothing.
        slot.onChange!('slotType', { ...slot.defaults!(ctx), slotType: 'slot' }, ctx);
        expect(dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).detail)).toEqual(['sk-rect3', 'sk-centerArcSlot']);
    });
});
