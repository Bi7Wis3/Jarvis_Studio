import { describe, expect, it } from 'vitest';
import type { SketchGeometry, SketchProfile } from '@jarvis/core';
import { addArc, addCircle, addLine, addRect, geometryEntities, geometryOpenChains, geometryProfiles, EMPTY_GEOMETRY } from './sketchGeometry';
import { area, entitiesToProfiles, inside, profilePoints, type Pt } from './sketchMath';
import { regionsOf } from './regionPick';
import { clearRegionStore } from './sketchRegions';

const areaOf = (p: SketchProfile) => Math.abs(area(profilePoints(p)));

/** A reference to the existing point at `at` (or a new one if there is none). */
function ref(g: SketchGeometry, at: Pt): { at: Pt; point?: string } {
    const p = g.points.find((q) => q.u === at[0] && q.v === at[1] && q.id !== 'origin');
    return p ? { at, point: p.id } : { at };
}

/** Lines through the points in order, sharing points that already exist. */
function polyline(g: SketchGeometry, ...pts: Pt[]): SketchGeometry {
    for (let i = 1; i < pts.length; i++) {
        g = addLine(g, ref(g, pts[i - 1]), ref(g, pts[i])).g;
    }
    return g;
}

/** What the old loop chaining made of the geometry. */
const before = (g: SketchGeometry) => entitiesToProfiles(geometryEntities(g, false));

describe('sketch regions', () => {
    it('joins two squares sharing an edge into one outline', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [10, 0], [20, 0], [20, 10], [10, 10]);
        const { profiles, open } = geometryProfiles(g);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(1);
        expect(areaOf(profiles[0])).toBeCloseTo(200);
        // The shared edge is not part of the outline.
        expect(profiles[0].kind === 'path' && profiles[0].segments).toHaveLength(6);
    });

    it('treats a square with a dividing line as closed', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [0, 0], [10, 10]);
        const { profiles, open } = geometryProfiles(g);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(1);
        expect(areaOf(profiles[0])).toBeCloseTo(100);
    });

    it('counts a line sticking out of a corner as open', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        const square = geometryProfiles(g).profiles;
        g = polyline(g, [10, 10], [15, 20]);
        const { profiles, open } = geometryProfiles(g);
        expect(open).toBe(1);
        expect(profiles).toEqual(square);
    });

    it('joins an L of three rectangles drawn separately (coinciding points merge)', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = addRect(g, [10, 0], [20, 10]).g;
        g = addRect(g, [0, 10], [10, 30]).g;
        // addRect makes its own corner points, so the shared edges are drawn twice at the same place.
        expect(new Set(g.points.map((p) => `${p.u},${p.v}`)).size).toBeLessThan(g.points.length);
        const { profiles, open } = geometryProfiles(g);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(1);
        expect(areaOf(profiles[0])).toBeCloseTo(400);
        const outline = profilePoints(profiles[0]);
        expect(inside([5, 25], outline)).toBe(true);
        expect(inside([15, 5], outline)).toBe(true);
        expect(inside([15, 15], outline)).toBe(false);
    });

    it('handles a region bounded by an arc that shares its end points with lines', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = addArc(g, ref(g, [10, 10]), ref(g, [0, 10]), [5, 15]).g;
        const { profiles, open } = geometryProfiles(g);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(1);
        expect(areaOf(profiles[0])).toBeCloseTo(100 + (Math.PI * 25) / 2, 0);
        const p = profiles[0];
        expect(p.kind === 'path' && p.segments.filter((s) => s.kind === 'arc')).toHaveLength(1);
    });

    it('takes the outer of two arcs between the same two points', () => {
        // A half-disc on a line, split by a flatter arc: the outline is the half-disc.
        let g = polyline(EMPTY_GEOMETRY, [-10, 0], [10, 0]);
        g = addArc(g, ref(g, [10, 0]), ref(g, [-10, 0]), [0, 10]).g;
        g = addArc(g, ref(g, [10, 0]), ref(g, [-10, 0]), [0, 4]).g;
        const { profiles, open } = geometryProfiles(g);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(1);
        expect(areaOf(profiles[0])).toBeCloseTo((Math.PI * 100) / 2, 0);
    });

    it('keeps squares touching at one corner as two profiles and a bridge between them as open', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [10, 10], [20, 10], [20, 20], [10, 20], [10, 10]);
        expect(geometryProfiles(g).profiles).toHaveLength(2);
        expect(geometryProfiles(g).open).toBe(0);
        g = addRect(g, [40, 0], [50, 10]).g;
        g = polyline(g, [20, 20], [40, 10]);
        const { profiles, open } = geometryProfiles(g);
        expect(profiles.map(areaOf)).toEqual([100, 100, 100].map((a) => expect.closeTo(a)));
        expect(open).toBe(1);
    });

    it('gives the same profiles as before for plain loops, nested loops and circles', () => {
        const rect = addRect(EMPTY_GEOMETRY, [2, 3], [30, 18]).g;
        expect(geometryProfiles(rect)).toEqual(before(rect));
        let g = addCircle(rect, { at: [10, 10] }, 3).g;
        g = addRect(g, [15, 5], [25, 15]).g;
        g = addArc(g, { at: [40, 0] }, { at: [60, 0] }, [50, 10]).g;
        g = polyline(g, [60, 0], [40, 0]);
        const now = geometryProfiles(g);
        expect(now).toEqual(before(g));
        expect(now.profiles.map((p) => p.kind)).toEqual(['circle', 'path', 'path', 'path']);
    });

    it('counts every curve of an open chain', () => {
        const g = polyline(EMPTY_GEOMETRY, [0, 0], [10, 0], [10, 10]);
        expect(geometryProfiles(g)).toEqual({ profiles: [], open: 2 });
    });
});

describe('open chains', () => {
    it('keeps a polyline with an arc as one open path, in order', () => {
        let g = polyline(EMPTY_GEOMETRY, [0, 0], [0, 20]);
        g = addArc(g, ref(g, [0, 20]), { at: [10, 30] }, [10 - 10 * Math.SQRT1_2, 20 + 10 * Math.SQRT1_2]).g;
        g = polyline(g, [10, 30], [30, 30]);
        expect(geometryProfiles(g)).toMatchObject({ profiles: [], open: 3 });
        const [chain, ...rest] = geometryOpenChains(g);
        expect(rest).toHaveLength(0);
        if (chain.kind !== 'path') throw new Error('path expected');
        // Walked from one free end to the other, whichever end it starts at.
        const ends = [chain.start, chain.segments[chain.segments.length - 1].to];
        expect(ends).toContainEqual([0, 0]);
        expect(ends).toContainEqual([30, 30]);
        expect(chain.segments.map((s) => s.kind).sort()).toEqual(['arc', 'line', 'line']);
    });

    it('splits chains at branch points and leaves closed areas out', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [20, 0], [30, 0], [40, 0]);
        g = polyline(g, [30, 0], [30, 10]);
        g = polyline(g, [10, 10], [15, 15]);
        const chains = geometryOpenChains(g);
        // Three legs meet at (30, 0); the tail on the square's corner is a chain of its own.
        expect(chains).toHaveLength(4);
        expect(chains.every((c) => c.kind === 'path' && c.segments.length === 1)).toBe(true);
        expect(geometryProfiles(g).profiles).toHaveLength(1);
        expect(geometryOpenChains(addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5).g)).toEqual([]);
    });
});

describe('regions kept between calls', () => {
    /** Every number of `a` and `b` the same (Object.is), and the same shape. */
    const same = (a: unknown, b: unknown): boolean => {
        if (typeof a === 'number' || typeof b === 'number') {
            return Object.is(a, b);
        }
        if (Array.isArray(a) && Array.isArray(b)) {
            return a.length === b.length && a.every((x, i) => same(x, b[i]));
        }
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            const [ka, kb] = [Object.keys(a), Object.keys(b)];
            return ka.join() === kb.join() && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
        }
        return a === b;
    };

    /** Rectangles with circles inside and beside them, a shared edge, a circle twice over. */
    function sketch(): SketchGeometry {
        let g = EMPTY_GEOMETRY;
        for (let i = 0; i < 4; i++) {
            g = addRect(g, [i * 30, 0], [i * 30 + 20, 14]).g;
            g = addCircle(g, { at: [i * 30 + 8, 7] }, 3).g;
            g = addCircle(g, { at: [i * 30 + 25, 30] }, 2).g;
        }
        g = polyline(g, [20, 0], [26, 0], [26, 14], [20, 14]);
        g = addCircle(g, { at: [200, 0] }, 5).g;
        return addCircle(g, { at: [200, 0] }, 5).g;
    }

    it('gives what working everything out again gives, also while a point is dragged', () => {
        let g = sketch();
        const corner = g.points.find((p) => p.u === 30 && p.v === 0)!;
        for (let step = 0; step < 6; step++) {
            const kept = regionsOf(g);
            clearRegionStore();
            expect(same(kept, regionsOf(g))).toBe(true);
            // A corner of the second rectangle moves a little each time (the fourth time onto the next corner).
            g = { ...g, points: g.points.map((p) => (p.id === corner.id ? { ...p, u: step === 3 ? 50 : p.u + 0.7, v: step === 3 ? 0 : p.v - 0.4 } : p)) };
        }
    });

    it('keeps the regions a change does not touch as the same objects, and two equal regions as two', () => {
        const g = sketch();
        const first = regionsOf(g);
        const moved = g.points.find((p) => p.u === 90 && p.v === 0)!;
        const next = regionsOf({ ...g, points: g.points.map((p) => (p === moved ? { ...p, u: 89 } : p)) });
        const shared = next.filter((r) => first.includes(r));
        expect(shared.length).toBeGreaterThan(first.length - 4);
        expect(shared.length).toBeLessThan(first.length);
        expect(new Set(next).size).toBe(next.length);
    });
});
