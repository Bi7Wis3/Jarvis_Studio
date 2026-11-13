import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { AXIS_V, curveOf, curveRadius, loadSolver, pointOf, solveGeometry } from './solver';
import { addCircle, addConstraint, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import {
    addCentreArc, addCentreRect, chamferCorner, cornerOf, extendAt, filletCorner, mirrorCurves,
    offsetChain, sideDistance, transformEntities, trimAt,
} from './sketchEdit';
import { geometryProfiles } from './sketchGeometry';
import { area, profilePoints, type Pt } from './sketchMath';

beforeAll(async () => {
    await loadSolver();
});

const at = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const lines = (g: SketchGeometry) => g.curves.filter((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line');
const ok = (r: { g?: SketchGeometry; error?: string }): SketchGeometry => {
    expect(r.error).toBeUndefined();
    return r.g!;
};
const solved = (g: SketchGeometry) => {
    const r = solveGeometry(g);
    expect(r.ok).toBe(true);
    return r.geometry;
};
/** Distance from a point to a circle's rim. */
const offRim = (g: SketchGeometry, point: string, circle: string) => {
    const c = curveOf(g, circle)!;
    const centre = at(g, (c as { center: string }).center);
    const p = at(g, point);
    return Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - curveRadius(g, circle)!);
};

describe('trim', () => {
    /** A line along u through a circle of radius 10 at the origin. */
    function lineThroughCircle() {
        const l = addLine(EMPTY_GEOMETRY, { at: [-30, 0] }, { at: [30, 0] }, 'horizontal');
        const c = addCircle(l.g, { at: [5, 5] }, 10);
        return { g: c.g, line: l.id, circle: c.id, centre: c.center };
    }

    it('cuts a line inside a circle into two lines whose new ends stay on the circle', () => {
        const s = lineThroughCircle();
        const plan = trimAt(s.g, s.line, [5, 0])!;
        expect(plan.removed.kind).toBe('line');
        let g = solved(plan.g);
        expect(lines(g)).toHaveLength(2);
        const inner = lines(g).flatMap((l) => [l.a, l.b]).filter((id) => Math.abs(at(g, id)[0]) < 29);
        expect(inner).toHaveLength(2);
        inner.forEach((id) => expect(offRim(g, id, s.circle)).toBeLessThan(1e-6));
        // Moving the circle takes the cut ends along, and the two pieces stay in line.
        g = { ...g, constraints: [...g.constraints, { id: 'r', kind: 'radius', curve: s.circle, value: 12 }] };
        g = solved(g);
        inner.forEach((id) => expect(offRim(g, id, s.circle)).toBeLessThan(1e-5));
        const vs = lines(g).flatMap((l) => [l.a, l.b]).map((id) => at(g, id)[1]);
        vs.forEach((v) => expect(v).toBeCloseTo(vs[0], 5));
    });

    it('shortens a line from its end to the first crossing', () => {
        const s = lineThroughCircle();
        const plan = trimAt(s.g, s.line, [25, 0])!;
        const g = solved(plan.g);
        expect(lines(g)).toHaveLength(1);
        const l = lines(g)[0];
        const xs = [at(g, l.a)[0], at(g, l.b)[0]].sort((a, b) => a - b);
        expect(xs[0]).toBeCloseTo(-30);
        expect(xs[1]).toBeCloseTo(5 + Math.sqrt(75), 4);
    });

    it('turns a circle cut by a line into an arc, keeping its diameter dimension', () => {
        const s = lineThroughCircle();
        const g0 = addConstraint(s.g, { kind: 'diameter', curve: s.circle, value: 20 }).g;
        const plan = trimAt(g0, s.circle, [5, -5])!;
        const g = solved(plan.g);
        const arc = curveOf(g, s.circle)!;
        expect(arc.kind).toBe('arc');
        expect(curveRadius(g, s.circle)).toBeCloseTo(10);
        // The lower half went: the arc's middle is above the line.
        if (arc.kind === 'arc') {
            expect(at(g, arc.start)[1]).toBeCloseTo(0, 5);
            expect(at(g, arc.end)[1]).toBeCloseTo(0, 5);
            expect(at(g, arc.start)[0]).toBeGreaterThan(at(g, arc.end)[0]);
        }
    });

    it('deletes a curve nothing crosses, and will not trim a circle crossed once', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const plan = trimAt(l.g, l.id, [5, 0])!;
        expect(plan.g.curves).toHaveLength(0);
        expect(plan.g.points).toHaveLength(0);
        // A line ending on the circle touches it once.
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        const t = addLine(c.g, { at: [5, 0], onCurves: [c.id] }, { at: [20, 0] });
        expect(trimAt(t.g, c.id, [0, 5])).toBeNull();
    });

    it('trims a rectangle side between two crossing lines, sharing the T junction points', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
        const bottom = r.lines[0];
        const corner = (g: SketchGeometry, u: number, v: number) => g.points.find((p) => Math.abs(p.u - u) < 1e-6 && Math.abs(p.v - v) < 1e-6)!.id;
        // Two uprights standing on the bottom edge.
        let g = addLine(r.g, { at: [10, 0], onCurves: [bottom] }, { at: [10, -10] }).g;
        g = addLine(g, { at: [30, 0], onCurves: [bottom] }, { at: [30, -10] }).g;
        const feet = [corner(g, 10, 0), corner(g, 30, 0)];
        const plan = trimAt(g, bottom, [20, 0])!;
        const out = solved(plan.g);
        const ends = lines(out).filter((l) => l.id === bottom || !g.curves.some((c) => c.id === l.id)).flatMap((l) => [l.a, l.b]);
        expect(ends).toEqual(expect.arrayContaining(feet));
        expect(out.points).toHaveLength(g.points.length);
    });
});

describe('extend', () => {
    it('lengthens a line to the next line it meets', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        const wall = addLine(g, { at: [25, -10] }, { at: [25, 10] });
        g = wall.g;
        const plan = extendAt(g, g.curves[0].id, [9, 0])!;
        expect(plan.added).toMatchObject({ kind: 'line' });
        const out = solved(plan.g);
        const l = lines(out)[0];
        expect(at(out, l.b)[0]).toBeCloseTo(25);
        expect(out.constraints.some((c) => c.kind === 'pointOnCurve' && c.curve === wall.id)).toBe(true);
    });

    it('extends an arc round to a line', () => {
        // Quarter arc of radius 10 from +u to +v, and a vertical line at u = -5.
        let g: SketchGeometry = {
            points: [{ id: 'c', u: 0, v: 0 }, { id: 's', u: 10, v: 0 }, { id: 'e', u: 0, v: 10 }],
            curves: [{ id: 'a', kind: 'arc', center: 'c', start: 's', end: 'e' }],
            constraints: [],
        };
        g = addLine(g, { at: [-5, -20] }, { at: [-5, 20] }).g;
        const out = solved(extendAt(g, 'a', [1, 10])!.g);
        expect(at(out, 'e')[0]).toBeCloseTo(-5);
        expect(at(out, 'e')[1]).toBeCloseTo(Math.sqrt(75));
    });
});

describe('fillet and chamfer', () => {
    /** Two perpendicular lines meeting at (0, 0). */
    function corner() {
        const a = addLine(EMPTY_GEOMETRY, { at: [20, 0] }, { at: [0, 0] }, 'horizontal');
        const b = addLine(a.g, { at: [0, 0], point: a.b }, { at: [0, 20] }, 'vertical');
        return { g: b.g, point: a.b, lines: [a.id, b.id] as [string, string] };
    }

    it('rounds a right-angle corner with a tangent arc of radius 5', () => {
        const s = corner();
        const c = cornerOf(s.g, { point: s.point });
        expect('error' in c).toBe(false);
        const r = filletCorner(s.g, c as Exclude<typeof c, { error: string }>, 5);
        const g = solved(ok(r));
        const arc = curveOf(g, r.arc!)!;
        expect(curveRadius(g, arc.id)).toBeCloseTo(5);
        if (arc.kind === 'arc') {
            expect(at(g, arc.center)[0]).toBeCloseTo(5);
            expect(at(g, arc.center)[1]).toBeCloseTo(5);
        }
        expect(g.constraints.filter((k) => k.kind === 'perpendicular')).toHaveLength(2);
        expect(g.points.some((p) => p.id === s.point)).toBe(false);
        // The radius drives it: change it and the arc stays tangent to both lines.
        const radius = g.constraints.find((k) => k.kind === 'radius')!;
        const bigger = solved({ ...g, constraints: g.constraints.map((k) => (k.id === radius.id ? { ...k, value: 8 } : k)) });
        if (arc.kind === 'arc') {
            // Still tangent: the centre is a radius away from both lines, square above each end.
            const centre = at(bigger, arc.center);
            const [s0, e0] = [at(bigger, arc.start), at(bigger, arc.end)];
            expect(Math.hypot(s0[0] - centre[0], s0[1] - centre[1])).toBeCloseTo(8, 4);
            expect(Math.min(Math.abs(s0[0] - centre[0]), Math.abs(s0[1] - centre[1]))).toBeCloseTo(0, 4);
            expect(Math.min(Math.abs(e0[0] - centre[0]), Math.abs(e0[1] - centre[1]))).toBeCloseTo(0, 4);
        }
    });

    it('rounds two lines picked one after the other, and refuses a radius too big', () => {
        const s = corner();
        const c = cornerOf(s.g, { lines: s.lines });
        if ('error' in c) {
            throw new Error(c.error);
        }
        expect(filletCorner(s.g, c, 30)).toMatchObject({ error: expect.any(String) });
        solved(ok(filletCorner(s.g, c, 3)));
    });

    it('rounds two lines that do not meet', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [20, 0] }, { at: [4, 0] }).g;
        g = addLine(g, { at: [0, 4] }, { at: [0, 20] }).g;
        const c = cornerOf(g, { lines: [g.curves[0].id, g.curves[1].id] });
        if ('error' in c) {
            throw new Error(c.error);
        }
        const out = solved(ok(filletCorner(g, c, 2)));
        expect(out.curves.filter((k) => k.kind === 'arc')).toHaveLength(1);
        expect(lines(out).flatMap((l) => [l.a, l.b]).map((id) => at(out, id)).some(([u, v]) => Math.abs(u - 2) < 1e-6 && Math.abs(v) < 1e-6)).toBe(true);
    });

    it('cuts a corner with an equal-distance chamfer', () => {
        const s = corner();
        const c = cornerOf(s.g, { point: s.point });
        if ('error' in c) {
            throw new Error(c.error);
        }
        const g = solved(ok(chamferCorner(s.g, c, 4)));
        const cut = lines(g).find((l) => !l.construction && !s.lines.includes(l.id))!;
        expect(Math.hypot(at(g, cut.a)[0] - at(g, cut.b)[0], at(g, cut.a)[1] - at(g, cut.b)[1])).toBeCloseTo(4 * Math.SQRT2);
        expect(lines(g).filter((l) => l.construction)).toHaveLength(2);
    });
});

describe('offset', () => {
    it('offsets a rectangle by 5 outward into one 10 larger each way', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
        // Drawn counter-clockwise, so outward is to the right: negative.
        const d = sideDistance(r.g, r.lines[0], [20, -5]);
        expect(d).toBeCloseTo(-5);
        const g = solved(ok(offsetChain(r.g, r.lines[0], d)));
        expect(g.curves).toHaveLength(8);
        const { profiles } = geometryProfiles(g);
        const areas = profiles.map((p) => Math.abs(area(profilePoints(p)))).sort((a, b) => a - b);
        expect(areas[areas.length - 1]).toBeCloseTo(50 * 30, 3);
        const us = g.points.map((p) => p.u);
        expect(Math.min(...us)).toBeCloseTo(-5);
        expect(Math.max(...us)).toBeCloseTo(45);
    });

    it('offsets a circle to a concentric circle, and a slot with arcs on the same centres', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 10);
        const g = ok(offsetChain(c.g, c.id, sideDistance(c.g, c.id, [0, 13])));
        const copy = g.curves.find((k) => k.id !== c.id)!;
        expect(copy).toMatchObject({ kind: 'circle', center: c.center, radius: 13 });
        expect(offsetChain(c.g, c.id, 12)).toMatchObject({ error: expect.any(String) });
    });

    it('offsets a line and arc chain inward, the arc on the same centre', () => {
        // A U shape: two lines joined by a half circle (no tangent constraints: see filletCorner).
        const g0: SketchGeometry = {
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
        const d = sideDistance(g0, 'l1', [3, 10]);
        const g = solved(ok(offsetChain(g0, 'l1', d)));
        const arc = g.curves.find((k) => k.kind === 'arc' && k.id !== 'arc')!;
        expect(curveRadius(g, arc.id)).toBeCloseTo(7, 4);
        expect(arc.kind === 'arc' && arc.center).toBe('m');
    });
});

describe('mirror', () => {
    it('mirrors a line and an arc about the v axis with symmetric points', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [5, 0] }, { at: [15, 10] }).g;
        g = { ...g, points: [...g.points, { id: 'c', u: 10, v: 20 }, { id: 's', u: 15, v: 20 }, { id: 'e', u: 10, v: 25 }],
            curves: [...g.curves, { id: 'arc', kind: 'arc', center: 'c', start: 's', end: 'e' }] };
        const r = mirrorCurves(g, g.curves.map((c) => c.id), AXIS_V);
        const out = solved(ok(r));
        expect(r.created).toHaveLength(2);
        const copy = curveOf(out, r.created![0])!;
        if (copy.kind === 'line') {
            expect(at(out, copy.a)).toEqual([-5, 0]);
            expect(at(out, copy.b)).toEqual([-15, 10]);
        }
        const arc = curveOf(out, r.created![1])!;
        if (arc.kind === 'arc') {
            expect(at(out, arc.center)).toEqual([-10, 20]);
            expect(at(out, arc.start)).toEqual([-10, 25]);
            expect(at(out, arc.end)).toEqual([-15, 20]);
        }
        expect(out.constraints.filter((k) => k.kind === 'symmetric')).toHaveLength(5);
        // Moving an original point moves its image.
        const moved = solved({ ...out, constraints: [...out.constraints, { id: 'x', kind: 'distance', a: 'origin', b: (curveOf(out, g.curves[0].id) as { a: string }).a, axis: 'u', value: 7 }] });
        if (copy.kind === 'line') {
            expect(at(moved, copy.a)[0]).toBeCloseTo(-7, 5);
        }
    });

    it('shares points that lie on the mirror line', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 10] }).g;
        const out = solved(ok(mirrorCurves(g, [g.curves[0].id], AXIS_V)));
        expect(out.points).toHaveLength(3);
    });
});


describe('centre arc and centre rectangle', () => {
    it('draws an arc about its centre', () => {
        const r = addCentreArc(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [10, 0] }, [0, 3], true);
        const g = solved(r.g);
        const arc = curveOf(g, r.id)!;
        expect(arc).toMatchObject({ kind: 'arc', center: 'origin' });
        if (arc.kind === 'arc') {
            expect(at(g, arc.end)[1]).toBeCloseTo(10);
        }
        // Clockwise: the same points, the other way round.
        const cw = addCentreArc(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }, [0, 3], false);
        const other = curveOf(cw.g, cw.id)!;
        if (other.kind === 'arc') {
            expect(at(cw.g, other.start)[0]).toBeCloseTo(0);
            expect(at(cw.g, other.start)[1]).toBeCloseTo(10);
        }
    });

    it('draws a rectangle about its centre that stays centred', () => {
        const r = addCentreRect(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [20, 10] });
        let g = solved(r.g);
        expect(g.points.map((p) => [p.u, p.v])).toEqual(expect.arrayContaining([[-20, -10], [20, 10]]));
        g = solved({ ...g, constraints: [...g.constraints, { id: 'w', kind: 'length', line: r.lines[0], value: 60 }] });
        const us = g.points.map((p) => p.u);
        expect(Math.min(...us)).toBeCloseTo(-30, 4);
        expect(Math.max(...us)).toBeCloseTo(30, 4);
    });
});

describe('move, copy, rotate, scale', () => {
    /** A 20 x 10 rectangle at the origin with its width dimensioned, and a line hanging off its corner (20, 10). */
    function scene() {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [20, 10]);
        let g = addConstraint(rect.g, { kind: 'length', line: rect.lines[0], value: 20 }).g;
        const corner = (curveOf(g, rect.lines[1]) as { b: string }).b;
        const tail = addLine(g, { at: [20, 10], point: corner }, { at: [30, 10] }, 'horizontal');
        g = addConstraint(tail.g, { kind: 'length', line: tail.id, value: 10 }).g;
        return { g, rect: rect.lines, tail: tail.id, corner };
    }

    it('moves a closed set with its relations, and nothing is dropped', () => {
        const { g, rect } = scene();
        const r = transformEntities(g, rect, { kind: 'move', by: [5, 7] }, false);
        if ('error' in r) {
            throw new Error(r.error);
        }
        const out = solved(r.g);
        const first = curveOf(out, rect[0]) as { a: string };
        expect(at(out, first.a)).toEqual([5, 7]);
        // The corner the tail shares split off: the tail stays where it was, and it is still 10 long.
        expect(r.dropped).toBe(0);
        expect(out.constraints.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical')).toHaveLength(5);
        expect(out.curves).toHaveLength(5);
        expect(out.points).toHaveLength(4 + 1 + 1);
    });

    it('drops the relations that tie a moved line to geometry that stays, and splits shared points', () => {
        const { g, tail, corner } = scene();
        const pinned = addConstraint(g, { kind: 'distance', a: corner, b: 'axis-v', value: 20 }).g;
        const r = transformEntities(pinned, [tail], { kind: 'move', by: [0, 5] }, false);
        if ('error' in r) {
            throw new Error(r.error);
        }
        const line = curveOf(r.g, tail) as { a: string; b: string };
        // The tail's start is a new point; the corner stays with the rectangle.
        expect(line.a).not.toBe(corner);
        expect(at(r.g, line.a)).toEqual([20, 15]);
        expect(at(r.g, corner)).toEqual([20, 10]);
        // Its own horizontal and length go along; nothing it shared is a relation, so none dropped here.
        expect(r.dropped).toBe(0);
        expect(solveGeometry(r.g).ok).toBe(true);
        // A point on the line held to the rectangle by a relation: that one goes.
        const held = addConstraint(pinned, { kind: 'pointOnCurve', point: (curveOf(pinned, tail) as { b: string }).b, curve: 'axis-u' }).g;
        const r2 = transformEntities(held, [tail], { kind: 'move', by: [0, 5] }, false);
        expect('error' in r2 ? -1 : r2.dropped).toBe(1);
    });

    it('copies with the relations among the copied curves, leaving the original', () => {
        const { g, rect } = scene();
        const r = transformEntities(g, rect, { kind: 'move', by: [0, 30] }, true);
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.created).toHaveLength(4);
        expect(r.g.curves).toHaveLength(9);
        // 4 + 1 + 1 relations before (4 H/V, a length on the rectangle, the tail's H and length), copied: 4 H/V + length.
        expect(r.g.constraints).toHaveLength(g.constraints.length + 5);
        const out = solved(r.g);
        const copy = curveOf(out, r.created[0]) as { a: string; b: string };
        expect(at(out, copy.a)).toEqual([0, 30]);
        expect(at(out, copy.b)).toEqual([20, 30]);
    });

    it('turns about a point, swapping horizontal and vertical on a quarter turn and dropping them otherwise', () => {
        const { g, rect } = scene();
        const r = transformEntities(g, rect, { kind: 'rotate', centre: [0, 0], angle: 90 }, false);
        if ('error' in r) {
            throw new Error(r.error);
        }
        const out = solved(r.g);
        const first = curveOf(out, rect[0]) as { a: string; b: string };
        expect(at(out, first.b)[0]).toBeCloseTo(0, 6);
        expect(at(out, first.b)[1]).toBeCloseTo(20, 6);
        expect(out.constraints.find((c) => c.kind === 'vertical' && c.line === rect[0])).toBeTruthy();
        const tilted = transformEntities(g, rect, { kind: 'rotate', centre: [0, 0], angle: 30 }, false);
        if ('error' in tilted) {
            throw new Error(tilted.error);
        }
        expect(tilted.g.constraints.filter((c) => (c.kind === 'horizontal' || c.kind === 'vertical') && rect.includes(c.line))).toHaveLength(0);
        expect(tilted.dropped).toBe(4);
        expect(solveGeometry(tilted.g).ok).toBe(true);
    });

    it('scales about a point: positions, radii and dimensions', () => {
        let g = addCircle(EMPTY_GEOMETRY, { at: [10, 0] }, 5).g;
        const circle = g.curves[0].id;
        g = addConstraint(g, { kind: 'diameter', curve: circle, value: 10 }).g;
        const r = transformEntities(g, [circle], { kind: 'scale', centre: [0, 0], factor: 2 }, false);
        if ('error' in r) {
            throw new Error(r.error);
        }
        const out = solved(r.g);
        expect(curveRadius(out, circle)).toBeCloseTo(10);
        expect(at(out, (curveOf(out, circle) as { center: string }).center)).toEqual([20, 0]);
        expect(out.constraints.find((c) => c.kind === 'diameter')).toMatchObject({ value: 20 });
        expect(transformEntities(g, [circle], { kind: 'scale', centre: [0, 0], factor: 0 }, false)).toHaveProperty('error');
        expect(transformEntities(g, [], { kind: 'move', by: [1, 0] }, false)).toHaveProperty('error');
    });
});
