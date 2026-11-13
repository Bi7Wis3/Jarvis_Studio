import { beforeEach, describe, expect, it } from 'vitest';
import type { SketchGeometry, SketchProfile, SketchRegion } from '@jarvis/core';
import { addCircle, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { area, inside, profilePoints, type Pt } from './sketchMath';
import { clearRegionPick, pickedRegions, regionAt, regionsOf, startRegionPick, toggleRegion, useRegionPick } from './regionPick';
import { interiorPoint } from './sketchRegions';

const areaOf = (p: SketchProfile) => Math.abs(area(profilePoints(p)));
/** Area of a region: its outline minus its holes. */
const regionArea = (r: SketchRegion) => areaOf(r.loops[0]) - r.loops.slice(1).reduce((a, h) => a + areaOf(h), 0);
const inRegion = (r: SketchRegion, p: Pt) => regionAt([r], p) === 0;

function ref(g: SketchGeometry, at: Pt): { at: Pt; point?: string } {
    const p = g.points.find((q) => q.u === at[0] && q.v === at[1] && q.id !== 'origin');
    return p ? { at, point: p.id } : { at };
}

function polyline(g: SketchGeometry, ...pts: Pt[]): SketchGeometry {
    for (let i = 1; i < pts.length; i++) {
        g = addLine(g, ref(g, pts[i - 1]), ref(g, pts[i])).g;
    }
    return g;
}

/** Regions sorted by area, for order-independent checks. */
const byArea = (regions: SketchRegion[]) => [...regions].sort((a, b) => regionArea(a) - regionArea(b));

describe('sketch regions', () => {
    it('splits two squares sharing an edge into two regions', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [10, 0], [20, 0], [20, 10], [10, 10]);
        const regions = regionsOf(g);
        expect(regions).toHaveLength(2);
        expect(regions.map(regionArea)).toEqual([100, 100].map((a) => expect.closeTo(a)));
        expect(regions.every((r) => r.loops.length === 1)).toBe(true);
        const left = regions.find((r) => r.at[0] < 10)!;
        const right = regions.find((r) => r.at[0] > 10)!;
        expect(left && right).toBeTruthy();
        expect(inRegion(left, left.at) && !inRegion(right, left.at)).toBe(true);
        // Interior points keep away from the edges.
        expect(left.at[0]).toBeGreaterThan(1);
        expect(left.at[0]).toBeLessThan(9);
        expect(regionAt(regions, [5, 5])).toBe(regions.indexOf(left));
        expect(regionAt(regions, [15, 5])).toBe(regions.indexOf(right));
        expect(regionAt(regions, [25, 5])).toBe(-1);
    });

    it('splits a square along a diagonal into two triangles', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [0, 0], [10, 10]);
        const regions = regionsOf(g);
        expect(regions.map(regionArea)).toEqual([50, 50].map((a) => expect.closeTo(a)));
        const below = regions.filter((r) => r.at[1] < r.at[0]);
        expect(below).toHaveLength(1);
    });

    it('makes a ring with the circle as its hole, and the disc', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [40, 40]).g;
        g = addCircle(g, { at: [20, 20] }, 5).g;
        const [disc, ring] = byArea(regionsOf(g));
        expect(disc.loops).toHaveLength(1);
        expect(disc.loops[0].kind).toBe('circle');
        expect(ring.loops).toHaveLength(2);
        expect(ring.loops[1]).toEqual(disc.loops[0]);
        expect(regionArea(ring)).toBeCloseTo(1600 - Math.PI * 25, -1);
        expect(inRegion(disc, disc.at)).toBe(true);
        // The ring's point is outside the hole.
        expect(Math.hypot(ring.at[0] - 20, ring.at[1] - 20)).toBeGreaterThan(5);
        expect(inRegion(ring, ring.at)).toBe(true);
        expect(regionAt([ring, disc], [20, 20])).toBe(1);
        expect(regionAt([ring, disc], [2, 2])).toBe(0);
    });

    it('nests split shapes: a split square inside a split square', () => {
        // Outer square 0..40 split at u = 20; inner square 5..15 (in the left half) split at v = 10.
        let g = polyline(EMPTY_GEOMETRY, [0, 0], [20, 0], [40, 0], [40, 40], [20, 40], [0, 40], [0, 0]);
        g = polyline(g, [20, 0], [20, 40]);
        g = polyline(g, [5, 5], [15, 5], [15, 10], [15, 15], [5, 15], [5, 10], [5, 5]);
        g = polyline(g, [5, 10], [15, 10]);
        const regions = regionsOf(g);
        expect(regions).toHaveLength(4);
        const sorted = byArea(regions);
        expect(sorted.map(regionArea)).toEqual([50, 50, 700, 800].map((a) => expect.closeTo(a)));
        // The left half has the inner block's outline (the whole 10 x 10 square) as one hole.
        const left = sorted[2];
        expect(left.loops).toHaveLength(2);
        expect(areaOf(left.loops[1])).toBeCloseTo(100);
        expect(sorted[3].loops).toHaveLength(1);
        for (const r of regions) {
            expect(regionAt(regions, r.at)).toBe(regions.indexOf(r));
        }
        expect(pickedRegions(regions, [[7, 7], [30, 30], [8, 8]])).toEqual(
            [regionAt(regions, [7, 7]), regionAt(regions, [30, 30])].sort((a, b) => a - b));
    });

    it('ignores open curves and keeps a single loop as one region', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [10, 10], [15, 20]);
        const regions = regionsOf(g);
        expect(regions).toHaveLength(1);
        expect(regionArea(regions[0])).toBeCloseTo(100);
        expect(regionsOf(polyline(EMPTY_GEOMETRY, [0, 0], [10, 0], [10, 10]))).toEqual([]);
    });

    it('finds an interior point of a concave outline', () => {
        // A thin U: its centroid lies outside it.
        const u: Pt[] = [[0, 0], [30, 0], [30, 30], [28, 30], [28, 2], [2, 2], [2, 30], [0, 30]];
        const p = interiorPoint(u, []);
        expect(inside(p, u)).toBe(true);
    });
});

describe('region pick store', () => {
    beforeEach(() => clearRegionPick());

    it('toggles regions by any point inside them', () => {
        let g = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]).g;
        g = polyline(g, [10, 0], [20, 0], [20, 10], [10, 10]);
        const regions = regionsOf(g);
        startRegionPick('part/sketch1', [[2, 2]]);
        expect(useRegionPick.getState()).toMatchObject({ active: true, sketchKey: 'part/sketch1', picked: [[2, 2]] });
        const left = regions[regionAt(regions, [2, 2])];
        const right = regions[regionAt(regions, [15, 5])];
        toggleRegion(right.at, regions);
        expect(pickedRegions(regions, useRegionPick.getState().picked)).toHaveLength(2);
        // Unpicking by the region's own point removes the restored pick at (2, 2).
        toggleRegion(left.at, regions);
        expect(useRegionPick.getState().picked).toEqual([right.at]);
        toggleRegion(right.at);
        expect(useRegionPick.getState().picked).toEqual([]);
        clearRegionPick();
        expect(useRegionPick.getState()).toEqual({ active: false, sketchKey: null, picked: [] });
    });
});
