import { beforeEach, describe, expect, it } from 'vitest';
import type { SketchCurve, SketchGeometry, SketchProfile, SketchRegion, SketchSegment } from '@jarvis/core';
import { closestParam, pointAt } from '@jarvis/core/curveIntersect';
import { segmentPoints } from '@jarvis/core/curves';
import { addLine, addSlot, EMPTY_GEOMETRY, geometryEntities } from './sketchGeometry';
import { geomOfCurve } from './sketchCut';
import { area, circleThrough, dist, profilePoints, type Pt } from './sketchMath';
import { regionAt, regionsOf } from './regionPick';
import { clearRegionStore } from './sketchRegions';

/** Geometry from named points and curves. */
function sketch(points: Record<string, Pt>, curves: SketchCurve[]): SketchGeometry {
    return { points: Object.entries(points).map(([id, [u, v]]) => ({ id, u, v })), curves, constraints: [] };
}

/** A loop's area: exact for lines, arcs, circles and ellipses, other curves finely sampled. */
function loopArea(l: SketchProfile): number {
    if (l.kind === 'circle') {
        return Math.PI * l.radius ** 2;
    }
    if (l.kind === 'ellipse') {
        return Math.PI * dist(l.center, l.major) * l.minor;
    }
    if (l.kind !== 'path') {
        return Math.abs(area(profilePoints(l)));
    }
    let twice = 0;
    let at = l.start;
    for (const seg of l.segments) {
        const pts = seg.kind === 'line' || seg.kind === 'arc' ? [seg.to] : segmentPoints(at, seg, 4000);
        let q = at;
        for (const p of pts) {
            twice += q[0] * p[1] - p[0] * q[1];
            q = p;
        }
        if (seg.kind === 'arc') {
            // The circular segment between the chord and the arc, on the side the arc bulges to.
            const c = circleThrough(at, seg.through, seg.to)!;
            const chord = dist(at, seg.to);
            const theta0 = 2 * Math.asin(Math.min(1, chord / (2 * c.r)));
            const bulgeLeft = (seg.to[0] - at[0]) * (seg.through[1] - at[1]) - (seg.to[1] - at[1]) * (seg.through[0] - at[0]) > 0;
            // The arc is the major one when the centre lies on the bulge side of the chord.
            const centreLeft = (seg.to[0] - at[0]) * (c.c[1] - at[1]) - (seg.to[1] - at[1]) * (c.c[0] - at[0]) > 0;
            const theta = bulgeLeft === centreLeft ? 2 * Math.PI - theta0 : theta0;
            const piece = (c.r ** 2 / 2) * (theta - Math.sin(theta));
            // Running along the chord, a bulge to the right adds area for a counter-clockwise loop.
            twice += 2 * (bulgeLeft ? -piece : piece);
        }
        at = seg.to;
    }
    return Math.abs(twice / 2);
}

const areaOf = (r: SketchRegion): number => loopArea(r.loops[0]) - r.loops.slice(1).reduce((s, l) => s + loopArea(l), 0);
const total = (rs: SketchRegion[]) => rs.reduce((s, r) => s + areaOf(r), 0);

/** Every segment of the region's loops with the point it starts from. */
function segmentsOf(r: SketchRegion): { from: Pt; seg: SketchSegment }[] {
    return r.loops.flatMap((l: SketchProfile) => {
        if (l.kind !== 'path') {
            return [];
        }
        let at = l.start;
        return l.segments.map((seg) => {
            const out = { from: at, seg };
            at = seg.to;
            return out;
        });
    });
}

/** How far the point is from the curve (its exact shape). */
function offCurve(g: SketchGeometry, id: string, p: Pt): number {
    const geom = geomOfCurve(g, g.curves.find((c) => c.id === id)!)!;
    return dist(pointAt(geom, closestParam(geom, p)) as Pt, p);
}

const rect: Record<string, Pt> = { r0: [0, 0], r1: [40, 0], r2: [40, 20], r3: [0, 20] };
const rectSides: SketchCurve[] = [
    { id: 's0', kind: 'line', a: 'r0', b: 'r1' }, { id: 's1', kind: 'line', a: 'r1', b: 'r2' },
    { id: 's2', kind: 'line', a: 'r2', b: 'r3' }, { id: 's3', kind: 'line', a: 'r3', b: 'r0' },
];

beforeEach(() => clearRegionStore());

describe('regions where curves cross or touch without a shared point', () => {
    it('splits a slot along a line through its centre that crosses both end arcs', () => {
        let g = addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 5).g;
        g = addLine(g, { at: [-8, 0] }, { at: [28, 0] }).g;
        const rs = regionsOf(g);
        expect(rs).toHaveLength(2);
        const upper = regionAt(rs, [10, 2.5]);
        const lower = regionAt(rs, [10, -2.5]);
        expect(upper).toBeGreaterThanOrEqual(0);
        expect(lower).toBeGreaterThanOrEqual(0);
        expect(upper).not.toBe(lower);
        for (const r of rs) {
            expect(areaOf(r)).toBeCloseTo(100 + (25 * Math.PI) / 2, 6);
        }
        // Each half is the slot's own quarter arcs and sides: the arcs are pieces of the slot's arcs, exactly.
        const arcs = g.curves.filter((c) => c.kind === 'arc').map((c) => c.id);
        for (const { from, seg } of segmentsOf(rs[upper])) {
            if (seg.kind === 'arc') {
                expect(Math.min(...arcs.map((id) => offCurve(g, id, seg.through)))).toBeLessThan(1e-9);
                expect(Math.min(...arcs.map((id) => offCurve(g, id, from)))).toBeLessThan(1e-9);
            }
        }
    });

    it('splits a slot across its sides by a line that crosses them, and by one that only ends on them', () => {
        const crossing = addLine(addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 5).g, { at: [10, -9] }, { at: [10, 9] }).g;
        // Ends on the sides, as points of their own (no shared point, no relation).
        const touching = addLine(addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 5).g, { at: [10, -5] }, { at: [10, 5] }).g;
        for (const g of [crossing, touching]) {
            const rs = regionsOf(g);
            expect(rs).toHaveLength(2);
            expect(regionAt(rs, [3, 0])).not.toBe(regionAt(rs, [17, 0]));
            for (const r of rs) {
                expect(areaOf(r)).toBeCloseTo(100 + (25 * Math.PI) / 2, 6);
            }
        }
    });

    it('lets no construction line bound a region', () => {
        let g = addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 5).g;
        const r = addLine(g, { at: [-8, 0] }, { at: [28, 0] });
        g = { ...r.g, curves: r.g.curves.map((c) => (c.id === r.id ? { ...c, construction: true } : c)) };
        const rs = regionsOf(g);
        expect(rs).toHaveLength(1);
        expect(areaOf(rs[0])).toBeCloseTo(200 + 25 * Math.PI, 6);
    });

    it('splits areas where lines cross each other in a grid, every cell a region', () => {
        let g = EMPTY_GEOMETRY;
        for (let i = 0; i <= 5; i++) {
            g = addLine(g, { at: [-1, i * 2] }, { at: [11, i * 2] }).g;
            g = addLine(g, { at: [i * 2, -1] }, { at: [i * 2, 11] }).g;
        }
        const rs = regionsOf(g);
        expect(rs).toHaveLength(25);
        for (const r of rs) {
            expect(areaOf(r)).toBeCloseTo(4, 6);
        }
    });

    it('cuts a rectangle by every kind of open curve crossing it, into exact pieces of that curve', () => {
        const cases: { name: string; points: Record<string, Pt>; curve: SketchCurve; kind: SketchSegment['kind'] }[] = [
            { name: 'arc', points: { c: [20, -10], a: [45, -10], b: [-5, -10] }, curve: { id: 'x', kind: 'arc', center: 'c', start: 'a', end: 'b' }, kind: 'arc' },
            {
                name: 'partial ellipse', points: { c: [20, 10], M: [20, 25], m: [15, 10], a: [20, -5], b: [20, 25] },
                curve: { id: 'x', kind: 'ellipseArc', center: 'c', major: 'M', minor: 'm', start: 'a', end: 'b' }, kind: 'ellipse',
            },
            { name: 'parabola', points: { f: [20, 7], v: [20, 5], a: [8, 23], b: [32, 23] }, curve: { id: 'x', kind: 'parabola', focus: 'f', vertex: 'v', start: 'a', end: 'b' }, kind: 'conic' },
            { name: 'conic', points: { a: [5, -5], b: [35, -5], t: [20, 40] }, curve: { id: 'x', kind: 'conic', start: 'a', end: 'b', apex: 't', rho: 0.4 }, kind: 'conic' },
            { name: 'spline', points: { a: [10, -5], m: [22, 10], b: [15, 25] }, curve: { id: 'x', kind: 'spline', points: ['a', 'm', 'b'] }, kind: 'bspline' },
            {
                name: 'style spline', points: { a: [10, -5], p: [30, 5], q: [5, 15], b: [25, 25] },
                curve: { id: 'x', kind: 'styleSpline', points: ['a', 'p', 'q', 'b'] }, kind: 'bspline',
            },
        ];
        for (const c of cases) {
            clearRegionStore();
            const g = sketch({ ...rect, ...c.points }, [...rectSides, c.curve]);
            const rs = regionsOf(g);
            expect(rs, c.name).toHaveLength(2);
            expect(total(rs), c.name).toBeCloseTo(800, 2);
            // The crossing curve's pieces in the outlines are of its own kind and lie on it.
            const own = rs.flatMap(segmentsOf).filter(({ seg }) => seg.kind === c.kind);
            expect(own.length, c.name).toBeGreaterThan(0);
            for (const { from, seg } of own) {
                for (const p of [from, seg.to, ...profilePoints({ kind: 'path', start: from, segments: [seg] }).slice(1, -1)]) {
                    expect(offCurve(g, 'x', p), c.name).toBeLessThan(1e-6);
                }
            }
        }
    });

    it('cuts closed curves crossing a rectangle: circle, ellipse and closed spline', () => {
        const cases: { name: string; points: Record<string, Pt>; curve: SketchCurve; inside: Pt; outside: Pt }[] = [
            { name: 'circle', points: { c: [40, 10] }, curve: { id: 'x', kind: 'circle', center: 'c', radius: 5 }, inside: [38, 10], outside: [42, 10] },
            { name: 'ellipse', points: { c: [40, 10], M: [48, 10], m: [40, 14] }, curve: { id: 'x', kind: 'ellipse', center: 'c', major: 'M', minor: 'm' }, inside: [37, 10], outside: [43, 10] },
            {
                name: 'closed spline', points: { a: [35, 10], b: [40, 15], d: [45, 10], e: [40, 5] },
                curve: { id: 'x', kind: 'spline', points: ['a', 'b', 'd', 'e', 'a'] }, inside: [38, 10], outside: [42, 10],
            },
        ];
        for (const c of cases) {
            clearRegionStore();
            const g = sketch({ ...rect, ...c.points }, [...rectSides, c.curve]);
            const rs = regionsOf(g);
            expect(rs, c.name).toHaveLength(3);
            const [a, b, far] = [regionAt(rs, c.inside), regionAt(rs, c.outside), regionAt(rs, [5, 5])];
            expect(new Set([a, b, far]).size, c.name).toBe(3);
            // The rectangle less the part of the curve's area inside it, that part, and the part outside: the union.
            const whole = loopArea(geometryRegionOf(g, 'x'));
            expect(total(rs), c.name).toBeCloseTo(800 + whole / 2, 2);
            expect(areaOf(rs[a]) + areaOf(rs[b]), c.name).toBeCloseTo(whole, 2);
        }
    });

    it('splits two crossing circles into the lens and two crescents', () => {
        const g = sketch({ a: [0, 0], b: [6, 0] }, [{ id: 'A', kind: 'circle', center: 'a', radius: 5 }, { id: 'B', kind: 'circle', center: 'b', radius: 5 }]);
        const rs = regionsOf(g);
        expect(rs).toHaveLength(3);
        const lens = 2 * 25 * Math.acos(6 / 10) - 3 * Math.sqrt(100 - 36);
        expect(areaOf(rs[regionAt(rs, [3, 0])])).toBeCloseTo(lens, 6);
        expect(areaOf(rs[regionAt(rs, [-3, 0])])).toBeCloseTo(25 * Math.PI - lens, 6);
        expect(areaOf(rs[regionAt(rs, [9, 0])])).toBeCloseTo(25 * Math.PI - lens, 6);
    });

    it('splits two crossed ellipses into the middle and four lobes', () => {
        const g = sketch({ c: [0, 0], M: [10, 0], m: [0, 4], N: [0, 10], n: [4, 0] }, [
            { id: 'A', kind: 'ellipse', center: 'c', major: 'M', minor: 'm' },
            { id: 'B', kind: 'ellipse', center: 'c', major: 'N', minor: 'n' },
        ]);
        const rs = regionsOf(g);
        expect(rs).toHaveLength(5);
        expect(total(rs)).toBeCloseTo(2 * 40 * Math.PI - areaOf(rs[regionAt(rs, [0, 0])]), 2);
        expect(new Set([[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]].map((p) => regionAt(rs, p as Pt))).size).toBe(5);
    });

    it('keeps a circle that only touches a side whole, as the disc and a hole in the rectangle', () => {
        const g = sketch({ ...rect, c: [20, 15] }, [...rectSides, { id: 'x', kind: 'circle', center: 'c', radius: 5 }]);
        const rs = regionsOf(g);
        expect(rs).toHaveLength(2);
        expect(total(rs)).toBeCloseTo(800, 6);
    });

    it('works out a crossing pair again from what was kept, the same as from scratch', () => {
        let g = addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 5).g;
        g = addLine(g, { at: [-8, 0] }, { at: [28, 0] }).g;
        const first = regionsOf(g).map((r) => r.loops);
        const again = regionsOf(g).map((r) => r.loops);
        clearRegionStore();
        expect(regionsOf(g).map((r) => r.loops)).toEqual(first);
        expect(again).toEqual(first);
    });
});

/** The closed curve's own area as a profile (its entity alone). */
function geometryRegionOf(g: SketchGeometry, id: string): SketchProfile {
    const alone = { ...g, curves: g.curves.filter((c) => c.id === id) };
    const r = regionsOf(alone);
    expect(r).toHaveLength(1);
    expect(geometryEntities(alone)).toHaveLength(1);
    return r[0].loops[0];
}
