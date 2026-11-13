import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, loadSolver, pointOf, solveGeometry } from './solver';
import { addConstraint, addLine, EMPTY_GEOMETRY } from './sketchGeometry';
import { extendAt, trimAt } from './sketchEdit';
import { unmetConstraints } from './sketchCheck';
import { powerTrim, trimBetween, trimCorner } from './sketchTrim';
import type { Pt } from './sketchMath';

beforeAll(async () => {
    await loadSolver();
});

const at = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const lines = (g: SketchGeometry) => g.curves.filter((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line');

describe('extend after trim', () => {
    it('moves a trimmed end to the next line, off the line it was cut at', () => {
        const base = addLine(EMPTY_GEOMETRY, { at: [-30, 0] }, { at: [30, 0] }, 'horizontal');
        let g = base.g;
        g = addLine(g, { at: [0, -20] }, { at: [0, 20] }).g;
        const far = addLine(g, { at: [-40, -20] }, { at: [-40, 20] });
        g = far.g;
        const trimmed = solveGeometry(trimAt(g, base.id, [-10, 0])!.g);
        expect(trimmed.ok).toBe(true);
        const plan = extendAt(trimmed.geometry, base.id, [1, 0])!;
        expect(plan).not.toBeNull();
        const r = solveGeometry(plan.g);
        expect(r.ok).toBe(true);
        const line = curveOf(r.geometry, base.id) as Extract<SketchCurve, { kind: 'line' }>;
        const [a, b] = [at(r.geometry, line.a), at(r.geometry, line.b)];
        expect(Math.min(a[0], b[0])).toBeCloseTo(-40, 5);
        expect(Math.max(a[0], b[0])).toBeCloseTo(30, 5);
        expect(a[1]).toBeCloseTo(0, 5);
        expect(b[1]).toBeCloseTo(0, 5);
        expect(lines(r.geometry)).toHaveLength(3);
        expect(unmetConstraints(r.geometry)).toEqual([]);
    });
});

describe('trim modes', () => {
    /** Three vertical lines at u = 0, 10, 20 and a horizontal line across them. */
    function comb() {
        let g = EMPTY_GEOMETRY;
        const ids: string[] = [];
        for (const u of [0, 10, 20]) {
            const r = addLine(g, { at: [u, -10] }, { at: [u, 10] });
            g = r.g;
            ids.push(r.id);
        }
        const across = addLine(g, { at: [-10, 0] }, { at: [30, 0] });
        return { g: across.g, verticals: ids, across: across.id };
    }

    it('power trims every piece a dragged path crosses', () => {
        const s = comb();
        // A path across the three verticals above the horizontal line.
        const r = powerTrim(s.g, [-5, 5], [25, 5]);
        expect(r.trimmed).toBe(3);
        const out = solveGeometry(r.g);
        expect(out.ok).toBe(true);
        // Each vertical lost its top half: it now ends at v = 0.
        for (const id of s.verticals) {
            const l = curveOf(out.geometry, id) as Extract<SketchCurve, { kind: 'line' }>;
            expect(Math.max(at(out.geometry, l.a)[1], at(out.geometry, l.b)[1])).toBeCloseTo(0, 5);
        }
        expect(unmetConstraints(out.geometry)).toEqual([]);
    });

    it('keeps trimmed pieces as construction, and can leave construction alone', () => {
        const s = comb();
        const kept = powerTrim(s.g, [-5, 5], [25, 5], { construction: true });
        expect(kept.g.curves.filter((c) => c.construction)).toHaveLength(3);
        expect(solveGeometry(kept.g).ok).toBe(true);
        const g = { ...s.g, curves: s.g.curves.map((c) => (c.id === s.verticals[1] ? { ...c, construction: true } : c)) };
        const r = powerTrim(g, [-5, 5], [25, 5], { ignoreConstruction: true });
        expect(r.trimmed).toBe(2);
        expect(curveOf(r.g, s.verticals[1])).toEqual(curveOf(g, s.verticals[1]));
    });

    it('trims two lines to their corner, keeping the clicked sides', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] }).g;
        const v = addLine(g, { at: [20, -10] }, { at: [20, 5] });
        g = v.g;
        const h = g.curves[0].id;
        // Keep the left of the horizontal (cut off at 20) and the bottom of the vertical (extended up to 0).
        const r = trimCorner(g, { id: h, at: [5, 0] }, { id: v.id, at: [20, -8] });
        expect('error' in r).toBe(false);
        const out = solveGeometry((r as { g: SketchGeometry }).g).geometry;
        const hl = curveOf(out, h) as Extract<SketchCurve, { kind: 'line' }>;
        const vl = curveOf(out, v.id) as Extract<SketchCurve, { kind: 'line' }>;
        const shared = [hl.a, hl.b].find((p) => p === vl.a || p === vl.b)!;
        expect(at(out, shared)).toEqual([20, 0]);
        expect(trimCorner(g, { id: h, at: [5, 0] }, { id: h, at: [6, 0] })).toHaveProperty('error');
    });

    it('trims away inside and outside two boundaries', () => {
        const s = comb();
        const bounds: [string, string] = [s.verticals[0], s.verticals[2]];
        const inside = trimBetween(s.g, s.across, bounds, 'inside') as { g: SketchGeometry };
        let out = solveGeometry(inside.g).geometry;
        // Two pieces left, outside u = 0..20.
        let xs = lines(out).filter((l) => !s.verticals.includes(l.id)).map((l) => [at(out, l.a)[0], at(out, l.b)[0]].sort((a, b) => a - b));
        expect(xs).toEqual(expect.arrayContaining([[-10, 0], [20, 30]]));
        const outside = trimBetween(s.g, s.across, bounds, 'outside') as { g: SketchGeometry };
        out = solveGeometry(outside.g).geometry;
        xs = lines(out).filter((l) => !s.verticals.includes(l.id)).map((l) => [at(out, l.a)[0], at(out, l.b)[0]].sort((a, b) => a - b));
        expect(xs).toEqual([[0, 20]]);
        expect(trimBetween(s.g, s.verticals[1], bounds, 'inside')).toHaveProperty('error');
    });
});

describe('checking a solve', () => {
    it('finds the relations and dimensions a sketch does not meet', () => {
        // A line held on another it does not touch, a horizontal line that is not, and a length that is off.
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 5] }).g;
        const other = addLine(g, { at: [0, 20] }, { at: [10, 20] });
        g = other.g;
        const line = lines(g)[0];
        const k1 = addConstraint(g, { kind: 'pointOnCurve', point: line.a, curve: other.id });
        const k2 = addConstraint(k1.g, { kind: 'horizontal', line: line.id });
        const k3 = addConstraint(k2.g, { kind: 'length', line: other.id, value: 10 });
        expect(unmetConstraints(k3.g).sort()).toEqual([k1.id, k2.id].sort());
        // Once solved, all hold.
        const r = solveGeometry(k3.g);
        expect(r.ok).toBe(true);
        expect(unmetConstraints(r.geometry)).toEqual([]);
    });
});
