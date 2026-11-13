import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { ORIGIN, curveOf, curveRadius, loadSolver, pointOf, solveGeometry } from './solver';
import { addCircle, addConstraint, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { circularSketchPattern, linearSketchPattern } from './sketchPattern';
import { extendAt, mirrorCurves, offsetEntities, splitAt, trimAt } from './sketchEdit';
import { chamferSides, filletCornerAt, filletSides, type FilletCorner } from './sketchFillet';
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

describe('sketch patterns tied to the original', () => {
    const drawn = (g: SketchGeometry) => g.curves.filter((c) => !c.construction);
    const centres = (g: SketchGeometry) => drawn(g).filter((c) => c.kind === 'circle').map((c) => at(g, (c as { center: string }).center));

    /** A circle of diameter 4 at (5, 5), fully defined: diameter and its centre's distances from the origin. */
    function definedCircle() {
        const c = addCircle(EMPTY_GEOMETRY, { at: [5, 5] }, 2);
        let g = addConstraint(c.g, { kind: 'diameter', curve: c.id, value: 4 }).g;
        g = addConstraint(g, { kind: 'distance', a: ORIGIN, b: c.center, value: 5, axis: 'u' }).g;
        g = addConstraint(g, { kind: 'distance', a: ORIGIN, b: c.center, value: 5, axis: 'v' }).g;
        expect(solveGeometry(g).dof).toBe(0);
        return { g, id: c.id, centre: c.center };
    }

    it('makes a fully defined linear pattern from a fully defined circle, which follows the original', () => {
        const s = definedCircle();
        const r = linearSketchPattern(s.g, [s.id], { count: 4, spacing: 10, angle: 0 });
        expect('error' in r).toBe(false);
        let out = solveGeometry((r as { g: SketchGeometry }).g);
        expect(out.ok).toBe(true);
        expect(out.dof).toBe(0);
        expect(out.redundant).toEqual([]);
        expect(drawn(out.geometry)).toHaveLength(4);
        expect(centres(out.geometry).map((p) => p[0]).sort((a, b) => a - b)).toEqual([5, 15, 25, 35]);
        // One spacing dimension drives the pattern; the original's diameter drives every instance.
        const spacing = out.geometry.constraints.filter((k) => k.kind === 'length');
        expect(spacing).toHaveLength(1);
        let g = { ...out.geometry, constraints: out.geometry.constraints.map((k) => (k.id === spacing[0].id ? { ...k, value: 12 } : k.kind === 'diameter' ? { ...k, value: 6 } : k)) };
        out = solveGeometry(g);
        expect(out.ok).toBe(true);
        expect(centres(out.geometry).map((p) => p[0]).sort((a, b) => a - b)).toEqual([5, 17, 29, 41]);
        drawn(out.geometry).forEach((c) => expect((c as { radius: number }).radius).toBeCloseTo(3, 5));
        // Moving the original takes the instances along.
        g = { ...out.geometry, constraints: out.geometry.constraints.map((k) => (k.kind === 'distance' && k.axis === 'v' ? { ...k, value: 8 } : k)) };
        out = solveGeometry(g);
        centres(out.geometry).forEach((p) => expect(p[1]).toBeCloseTo(8, 5));
        expect(linearSketchPattern(s.g, [s.id], { count: 1, spacing: 10, angle: 0 })).toHaveProperty('error');
    });

    it('makes a grid in two directions, skipping instances, and keeps a rectangle\'s shape in each', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [4, 2]);
        let g = addConstraint(rect.g, { kind: 'length', line: rect.lines[0], value: 4 }).g;
        g = addConstraint(g, { kind: 'length', line: rect.lines[1], value: 2 }).g;
        const corner = (curveOf(g, rect.lines[0]) as Extract<SketchCurve, { kind: 'line' }>).a;
        g = addConstraint(g, { kind: 'coincident', a: corner, b: ORIGIN }).g;
        expect(solveGeometry(g).dof).toBe(0);
        const r = linearSketchPattern(g, rect.lines, { count: 3, spacing: 10, angle: 0, count2: 2, spacing2: 5, angle2: 90, skip: [[1, 1]] });
        const out = solveGeometry((r as { g: SketchGeometry }).g);
        expect(out.ok).toBe(true);
        expect(out.dof).toBe(0);
        expect(out.redundant).toEqual([]);
        // 6 places, one skipped, 4 lines each.
        expect(drawn(out.geometry)).toHaveLength(20);
        const xs = new Set(drawn(out.geometry).flatMap((c) => {
            const l = c as Extract<SketchCurve, { kind: 'line' }>;
            return [at(out.geometry, l.a), at(out.geometry, l.b)].map((p) => `${Math.round(p[0])},${Math.round(p[1])}`);
        }));
        expect(xs.has('10,5')).toBe(false);
        expect(xs.has('14,7')).toBe(false);
        expect(xs.has('24,7')).toBe(true);
    });

    it('makes a fully defined circular pattern with one angle, and equal spacing round the centre', () => {
        const s = definedCircle();
        const r = circularSketchPattern(s.g, [s.id], { count: 4, angle: 360, centre: [0, 0] });
        let out = solveGeometry((r as { g: SketchGeometry }).g);
        expect(out.ok).toBe(true);
        expect(out.dof).toBe(0);
        expect(out.redundant).toEqual([]);
        const ps = centres(out.geometry);
        expect(ps).toHaveLength(4);
        ps.forEach((p) => expect(Math.hypot(p[0], p[1])).toBeCloseTo(Math.hypot(5, 5), 5));
        expect(ps.some((p) => Math.abs(p[0] + 5) < 1e-5 && Math.abs(p[1] + 5) < 1e-5)).toBe(true);
        // The angle dimension drives the spacing of all of them.
        const angle = out.geometry.constraints.filter((k) => k.kind === 'angle');
        expect(angle).toHaveLength(1);
        const g = { ...out.geometry, constraints: out.geometry.constraints.map((k) => (k.id === angle[0].id ? { ...k, value: 60 } : k)) };
        out = solveGeometry(g);
        expect(out.ok).toBe(true);
        const turned = centres(out.geometry).map((p) => (Math.atan2(p[1], p[0]) * 180) / Math.PI).map((a) => Math.round(((a % 360) + 360) % 360)).sort((a, b) => a - b);
        expect(turned).toEqual([45, 105, 165, 225]);
    });

    it('turns a fully defined rectangle into a fully defined circular pattern', () => {
        const rect = addRect(EMPTY_GEOMETRY, [10, 0], [14, 2]);
        let g = addConstraint(rect.g, { kind: 'length', line: rect.lines[0], value: 4 }).g;
        g = addConstraint(g, { kind: 'length', line: rect.lines[1], value: 2 }).g;
        const corner = (curveOf(g, rect.lines[0]) as Extract<SketchCurve, { kind: 'line' }>).a;
        g = addConstraint(g, { kind: 'distance', a: ORIGIN, b: corner, value: 10, axis: 'u' }).g;
        g = addConstraint(g, { kind: 'pointOnCurve', point: corner, curve: 'axis-u' }).g;
        expect(solveGeometry(g).dof).toBe(0);
        const r = circularSketchPattern(g, rect.lines, { count: 3, angle: 360, centre: [0, 0] });
        const out = solveGeometry((r as { g: SketchGeometry }).g);
        expect(out.ok).toBe(true);
        expect(out.dof).toBe(0);
        expect(out.redundant).toEqual([]);
        expect(unmetConstraints(out.geometry)).toEqual([]);
    });

    it('turns a line pattern about a point, the copies keeping the line\'s length', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [20, 0] }, 'horizontal').g;
        g = addConstraint(g, { kind: 'length', line: g.curves[0].id, value: 10 }).g;
        const r = circularSketchPattern(g, [g.curves[0].id], { count: 3, angle: 90, centre: [0, 0] });
        let out = solveGeometry((r as { g: SketchGeometry }).g);
        expect(out.ok).toBe(true);
        const last = lines(out.geometry).filter((l) => !l.construction)[2];
        expect(at(out.geometry, last.a)[0]).toBeCloseTo(0, 5);
        expect(at(out.geometry, last.a)[1]).toBeCloseTo(10, 5);
        const len = g.constraints.find((k) => k.kind === 'length')!;
        out = solveGeometry({ ...out.geometry, constraints: out.geometry.constraints.map((k) => (k.id === len.id ? { ...k, value: 15 } : k)) });
        expect(out.ok).toBe(true);
        lines(out.geometry).filter((l) => !l.construction).forEach((l) => {
            expect(Math.hypot(...[0, 1].map((i) => at(out.geometry, l.a)[i] - at(out.geometry, l.b)[i]) as [number, number])).toBeCloseTo(15, 5);
        });
    });
});

describe('offset tied to the original', () => {
    const drawn = (g: SketchGeometry) => g.curves.filter((c) => !c.construction);
    /** Solves and checks it is sound: no conflicts, nothing redundant, every relation met. */
    const sound = (g: SketchGeometry) => {
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(r.redundant).toEqual([]);
        expect(unmetConstraints(r.geometry)).toEqual([]);
        return r;
    };
    /** A 40 x 20 rectangle with its corner on the origin, fully defined. */
    function definedRect() {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
        let g = addConstraint(rect.g, { kind: 'length', line: rect.lines[0], value: 40 }).g;
        g = addConstraint(g, { kind: 'length', line: rect.lines[1], value: 20 }).g;
        const corner = (curveOf(g, rect.lines[0]) as Extract<SketchCurve, { kind: 'line' }>).a;
        g = addConstraint(g, { kind: 'coincident', a: corner, b: ORIGIN }).g;
        expect(solveGeometry(g).dof).toBe(0);
        return { g, lines: rect.lines };
    }

    it('ties an offset circle to the original: concentric, one dimension, follows its diameter', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 10);
        let g = addConstraint(c.g, { kind: 'diameter', curve: c.id, value: 20 }).g;
        g = addConstraint(g, { kind: 'coincident', a: c.center, b: ORIGIN }).g;
        const r = offsetEntities(g, [c.id], { distance: -3 });
        let out = sound((r as { g: SketchGeometry }).g);
        expect(out.dof).toBe(0);
        const copy = drawn(out.geometry).find((k) => k.id !== c.id) as Extract<SketchCurve, { kind: 'circle' }>;
        expect(copy.center).toBe(c.center);
        expect(copy.radius).toBeCloseTo(13, 5);
        out = sound({ ...out.geometry, constraints: out.geometry.constraints.map((k) => (k.kind === 'diameter' ? { ...k, value: 30 } : k)) });
        expect((curveOf(out.geometry, copy.id) as { radius: number }).radius).toBeCloseTo(18, 5);
    });

    it('gives a rectangle one offset dimension, and the offset stays fully defined and follows it', () => {
        const s = definedRect();
        const r = offsetEntities(s.g, [s.lines[0]], { distance: -5 });
        let out = sound((r as { g: SketchGeometry }).g);
        expect(out.dof).toBe(0);
        expect(drawn(out.geometry)).toHaveLength(8);
        const dims = out.geometry.constraints.filter((k) => k.kind === 'length' && !s.g.constraints.some((x) => x.id === k.id));
        expect(dims).toHaveLength(1);
        out = sound({ ...out.geometry, constraints: out.geometry.constraints.map((k) => (k.id === dims[0].id ? { ...k, value: 2 } : k)) });
        const us = out.geometry.points.filter((p) => !s.g.points.some((q) => q.id === p.id)).map((p) => p.u);
        expect(Math.min(...us)).toBeGreaterThanOrEqual(-2 - 1e-6);
        // Without Add dimensions, only the distance is left free.
        const free = solveGeometry((offsetEntities(s.g, [s.lines[0]], { distance: -5, dimension: false }) as { g: SketchGeometry }).g);
        expect(free.dof).toBe(1);
    });

    it('offsets one side alone with Select chain off, and turns the originals or the offset into construction', () => {
        const s = definedRect();
        const r = offsetEntities(s.g, [s.lines[0]], { distance: -5, chain: false, baseConstruction: true });
        const out = sound((r as { g: SketchGeometry }).g);
        expect(out.dof).toBe(0);
        expect(r.created).toHaveLength(1);
        expect(curveOf(out.geometry, s.lines[0])?.construction).toBe(true);
        const line = curveOf(out.geometry, r.created![0]) as Extract<SketchCurve, { kind: 'line' }>;
        expect(at(out.geometry, line.a)[1]).toBeCloseTo(-5, 5);
        expect(Math.abs(at(out.geometry, line.a)[0] - at(out.geometry, line.b)[0])).toBeCloseTo(40, 5);
        const c = offsetEntities(s.g, [s.lines[0]], { distance: -5, chain: false, offsetConstruction: true });
        expect(curveOf((c as { g: SketchGeometry }).g, c.created![0])?.construction).toBe(true);
    });

    it('offsets an open chain both ways with capped ends, fully defined', () => {
        // An L of two lines, fully defined.
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] }, 'horizontal').g;
        const first = g.curves[0] as Extract<SketchCurve, { kind: 'line' }>;
        const second = addLine(g, { at: [30, 0], point: first.b }, { at: [30, 20] }, 'vertical');
        g = second.g;
        g = addConstraint(g, { kind: 'length', line: first.id, value: 30 }).g;
        g = addConstraint(g, { kind: 'length', line: second.id, value: 20 }).g;
        g = addConstraint(g, { kind: 'coincident', a: first.a, b: ORIGIN }).g;
        expect(solveGeometry(g).dof).toBe(0);
        for (const cap of ['none', 'lines', 'arcs'] as const) {
            const r = offsetEntities(g, [first.id], { distance: 4, both: true, cap });
            const out = sound((r as { g: SketchGeometry }).g);
            expect(out.dof).toBe(0);
            expect(r.created).toHaveLength(cap === 'none' ? 4 : 6);
            expect(out.geometry.constraints.filter((k) => k.kind === 'length')).toHaveLength(3);
        }
        // One side, capped: the caps join the original's ends.
        for (const cap of ['lines', 'arcs'] as const) {
            const r = offsetEntities(g, [first.id], { distance: 4, cap });
            const out = sound((r as { g: SketchGeometry }).g);
            expect(out.dof).toBe(0);
            expect(r.created).toHaveLength(4);
        }
    });

    it('offsets a lone line and a line-arc chain, the arc on the same centre, fully defined', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] }, 'horizontal').g;
        const line = g.curves[0] as Extract<SketchCurve, { kind: 'line' }>;
        g = addConstraint(g, { kind: 'length', line: line.id, value: 30 }).g;
        g = addConstraint(g, { kind: 'coincident', a: line.a, b: ORIGIN }).g;
        const one = sound((offsetEntities(g, [line.id], { distance: 5 }) as { g: SketchGeometry }).g);
        expect(one.dof).toBe(0);
        const u: SketchGeometry = {
            points: [
                { id: 'a', u: 0, v: 20 }, { id: 'b', u: 0, v: 0 }, { id: 'c', u: 20, v: 0 }, { id: 'd', u: 20, v: 20 }, { id: 'm', u: 10, v: 0 },
            ],
            curves: [
                { id: 'l1', kind: 'line', a: 'a', b: 'b' },
                { id: 'arc', kind: 'arc', center: 'm', start: 'b', end: 'c' },
                { id: 'l2', kind: 'line', a: 'c', b: 'd' },
            ],
            constraints: [],
        };
        const before = solveGeometry(u).dof;
        const r = offsetEntities(u, ['l1'], { distance: 3 });
        const out = sound((r as { g: SketchGeometry }).g);
        // The offset adds nothing free but its one distance (held by the dimension).
        expect(out.dof).toBe(before);
    });
});

describe('sketch fillet and chamfer', () => {
    const sound = (g: SketchGeometry) => {
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(r.redundant).toEqual([]);
        expect(unmetConstraints(r.geometry)).toEqual([]);
        return r;
    };
    /** A 40 x 20 rectangle, fully defined: side lengths and a corner dimensioned from the origin. */
    function definedRect() {
        const rect = addRect(EMPTY_GEOMETRY, [10, 10], [50, 30]);
        let g = addConstraint(rect.g, { kind: 'length', line: rect.lines[0], value: 40 }).g;
        g = addConstraint(g, { kind: 'length', line: rect.lines[1], value: 20 }).g;
        const corner = (curveOf(g, rect.lines[0]) as Extract<SketchCurve, { kind: 'line' }>).a;
        g = addConstraint(g, { kind: 'distance', a: ORIGIN, b: corner, value: 10, axis: 'u' }).g;
        g = addConstraint(g, { kind: 'distance', a: ORIGIN, b: corner, value: 10, axis: 'v' }).g;
        expect(solveGeometry(g).dof).toBe(0);
        return { g, lines: rect.lines, corner };
    }

    it('keeps a constrained corner as a sharp point with its dimensions, and the sides\' lengths', () => {
        const s = definedRect();
        const corner = filletCornerAt(s.g, s.corner);
        expect('error' in corner).toBe(false);
        const r = filletSides(s.g, corner as FilletCorner, 5, { keepCorners: true });
        expect('error' in r).toBe(false);
        const { g, kept, dropped } = r as { g: SketchGeometry; kept: boolean; dropped: number };
        expect(kept).toBe(true);
        expect(dropped).toBe(0);
        const dims = (x: SketchGeometry) => x.constraints.filter((k) => k.kind === 'distance' || k.kind === 'length').length;
        expect(dims(g)).toBe(dims(s.g));
        const out = sound(g);
        expect(out.dof).toBe(0);
        expect(at(out.geometry, s.corner)).toEqual([10, 10]);
        // The sides still measure 40 and 20 to the sharp.
        const changed = sound({ ...g, constraints: g.constraints.map((k) => (k.kind === 'length' && k.value === 40 ? { ...k, value: 50 } : k)) });
        expect(Math.max(...changed.geometry.points.map((p) => p.u))).toBeCloseTo(60, 5);
    });

    it('says how many relations went when Keep constrained corners is off', () => {
        const s = definedRect();
        const r = filletSides(s.g, filletCornerAt(s.g, s.corner) as FilletCorner, 5, { keepCorners: false }) as { g: SketchGeometry; dropped: number; kept: boolean };
        expect(r.kept).toBe(false);
        expect(r.dropped).toBe(3);
        expect(r.g.points.some((p) => p.id === s.corner)).toBe(false);
    });

    it('rounds a corner of a line and an arc, tangent to both', () => {
        // A line from (-20, 10) to (0, 10) meeting a quarter arc about the origin from (0, 10) round to (10, 0).
        const g0: SketchGeometry = {
            points: [{ id: 'o', u: 0, v: 0 }, { id: 's', u: 10, v: 0 }, { id: 'e', u: 0, v: 10 }, { id: 'f', u: 10, v: 25 }],
            curves: [
                { id: 'arc', kind: 'arc', center: 'o', start: 's', end: 'e' },
                { id: 'line', kind: 'line', a: 'e', b: 'f' },
            ],
            constraints: [],
        };
        const r = filletSides(g0, filletCornerAt(g0, 'e') as FilletCorner, 3) as { g: SketchGeometry; arc: string };
        expect('error' in r).toBe(false);
        const out = sound(r.g).geometry;
        const fillet = curveOf(out, r.arc) as Extract<SketchCurve, { kind: 'arc' }>;
        const c = at(out, fillet.center);
        // Tangent to the arc's circle (inside or outside) and to the line.
        const d = Math.hypot(c[0], c[1]);
        expect(Math.min(Math.abs(d - 13), Math.abs(d - 7))).toBeLessThan(1e-4);
        const [a, b] = [at(out, 'f'), at(out, (curveOf(out, 'line') as { a: string }).a)];
        const toLine = Math.abs((b[0] - a[0]) * (a[1] - c[1]) - (a[0] - c[0]) * (b[1] - a[1])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
        expect(toLine).toBeCloseTo(3, 4);
        expect(curveRadius(out, r.arc)).toBeCloseTo(3, 5);
    });

    it('makes later fillets equal to the first instead of dimensioning each', () => {
        const s = definedRect();
        const first = filletSides(s.g, filletCornerAt(s.g, s.corner) as FilletCorner, 4) as { g: SketchGeometry; arc: string };
        const line = curveOf(first.g, s.lines[1]) as Extract<SketchCurve, { kind: 'line' }>;
        const other = [line.a, line.b].find((p) => filletCornerAt(first.g, p) && !('error' in filletCornerAt(first.g, p)))!;
        const second = filletSides(first.g, filletCornerAt(first.g, other) as FilletCorner, 4, { equalTo: first.arc }) as { g: SketchGeometry; arc: string };
        expect(second.g.constraints.filter((k) => k.kind === 'radius')).toHaveLength(1);
        expect(second.g.constraints.some((k) => k.kind === 'equal' && k.a === second.arc && k.b === first.arc)).toBe(true);
        expect(sound(second.g).dof).toBe(0);
    });

    it('chamfers with two distances, or a distance and an angle', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] }).g;
        const h = g.curves[0] as Extract<SketchCurve, { kind: 'line' }>;
        g = addLine(g, { at: [0, 0], point: h.a }, { at: [0, 20] }).g;
        const corner = filletCornerAt(g, h.a) as FilletCorner;
        const firstIsH = corner.sides[0].curve.id === h.id;
        const dd = chamferSides(g, corner, { type: 'distance', distance: 4, distance2: 6 }) as { g: SketchGeometry };
        let out = sound(dd.g).geometry;
        const cut = out.curves.find((c) => !c.construction && !g.curves.some((k) => k.id === c.id)) as Extract<SketchCurve, { kind: 'line' }>;
        const ends = [at(out, cut.a), at(out, cut.b)];
        const onH = ends.find((p) => Math.abs(p[1]) < 1e-6)!;
        const onV = ends.find((p) => Math.abs(p[0]) < 1e-6)!;
        expect(onH[0]).toBeCloseTo(firstIsH ? 4 : 6, 5);
        expect(onV[1]).toBeCloseTo(firstIsH ? 6 : 4, 5);
        const ad = chamferSides(g, corner, { type: 'angle', distance: 5, angle: 45 }) as { g: SketchGeometry };
        out = sound(ad.g).geometry;
        const cut2 = out.curves.find((c) => !c.construction && !g.curves.some((k) => k.id === c.id)) as Extract<SketchCurve, { kind: 'line' }>;
        const e2 = [at(out, cut2.a), at(out, cut2.b)];
        // 45 degrees at a right-angle corner: 5 along both.
        expect(e2.find((p) => Math.abs(p[1]) < 1e-6)![0]).toBeCloseTo(5, 5);
        expect(e2.find((p) => Math.abs(p[0]) < 1e-6)![1]).toBeCloseTo(5, 5);
        expect(chamferSides(g, corner, { type: 'angle', distance: 5, angle: 95 })).toHaveProperty('error');
    });
});

describe('split entities', () => {
    it('splits a line into two in line, an arc into two on one circle, and a circle at two points', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] }, 'horizontal').g;
        const line = g.curves[0];
        g = addConstraint(g, { kind: 'length', line: line.id, value: 30 }).g;
        const r = splitAt(g, line.id, [10, 1]) as { g: SketchGeometry; point: string; dropped: number };
        expect(r.dropped).toBe(1);
        let out = solveGeometry(r.g);
        expect(out.ok).toBe(true);
        expect(lines(out.geometry)).toHaveLength(2);
        expect(at(out.geometry, r.point)).toEqual([10, 0]);
        // Moving the far end up keeps both pieces in line.
        const far = (curveOf(r.g, r.g.curves[1].id) as Extract<SketchCurve, { kind: 'line' }>).b;
        out = solveGeometry({ ...out.geometry, constraints: [...out.geometry.constraints.filter((k) => k.kind !== 'horizontal'), { id: 'f', kind: 'fix', point: line.kind === 'line' ? line.a : '' }, { id: 'd', kind: 'distance', a: far, b: 'axis-u', value: 6 }] });
        expect(out.ok).toBe(true);
        expect(unmetConstraints(out.geometry)).toEqual([]);
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 10);
        expect(splitAt(c.g, c.id, [10, 0])).toHaveProperty('error');
        const two = splitAt(c.g, c.id, [10, 0], [-10, 0]) as { g: SketchGeometry };
        expect(two.g.curves.filter((k) => k.kind === 'arc')).toHaveLength(2);
        expect(solveGeometry(two.g).ok).toBe(true);
    });
});

describe('mirror without copy', () => {
    it('removes the originals and keeps their dimensions on the mirrored curves', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [5, 0] }, { at: [15, 10] }).g;
        const line = g.curves[0];
        g = addConstraint(g, { kind: 'length', line: line.id, value: Math.hypot(10, 10) }).g;
        const r = mirrorCurves(g, [line.id], 'axis-v', false) as { g: SketchGeometry; created: string[]; dropped: number };
        expect(r.g.curves).toHaveLength(1);
        expect(curveOf(r.g, line.id)).toBeUndefined();
        expect(r.g.constraints.filter((k) => k.kind === 'length')).toHaveLength(1);
        expect(r.dropped).toBe(0);
        const out = solveGeometry(r.g).geometry;
        const l = curveOf(out, r.created[0]) as Extract<SketchCurve, { kind: 'line' }>;
        expect([at(out, l.a)[0], at(out, l.b)[0]].sort((a, b) => a - b)).toEqual([-15, -5]);
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
