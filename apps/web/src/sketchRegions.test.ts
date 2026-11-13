import { describe, expect, it } from 'vitest';
import type { SketchGeometry, SketchProfile } from '@jarvis/core';
import { addArc, addCircle, addLine, addRect, geometryEntities, geometryProfiles, EMPTY_GEOMETRY } from './sketchGeometry';
import { area, entitiesToProfiles, inside, profilePoints, type Pt } from './sketchMath';

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
