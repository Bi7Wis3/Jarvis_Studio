import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, solveGeometry } from './solver';
import { addArc, addCircle, addLine, placePoint, EMPTY_GEOMETRY } from './sketchGeometry';
import { snapCursor, type SnapOptions } from './snapping';

beforeAll(async () => {
    await loadSolver();
});

const opts = (extra: Partial<SnapOptions> = {}): SnapOptions => ({ enabled: true, grid: 1, tolerance: 0.5, ...extra });

/** A 20 mm line along u from the origin, and a circle of radius 5 at (10, 0). */
function scene(): SketchGeometry {
    let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 0] }).g;
    g = addCircle(g, { at: [10, 0] }, 5).g;
    return g;
}

describe('sketch snapping', () => {
    it('prefers sketch points, then intersections and midpoints, then curves', () => {
        const g = scene();
        expect(snapCursor(g, [20.2, 0.1], opts())).toMatchObject({ p: [20, 0], kind: 'point' });
        expect(snapCursor(g, [10.1, 0.2], opts())).toMatchObject({ p: [10, 0], kind: 'centre' });
        const cross = snapCursor(g, [5.2, 0.2], opts());
        expect(cross.kind).toBe('intersection');
        expect(cross.p[0]).toBeCloseTo(5);
        expect(cross.ref.onCurves).toHaveLength(2);
        const top = snapCursor(g, [10.2, 5.3], opts());
        expect(top.kind).toBe('quadrant');
        expect(top.p[1]).toBeCloseTo(5);
        const on = snapCursor(g, [13.6, 3.7], opts());
        expect(on.kind).toBe('curve');
        expect(Math.hypot(on.p[0] - 10, on.p[1])).toBeCloseTo(5);
    });

    it('finds the middle of an arc and ignores the part of its circle that is not drawn', () => {
        // Upper half arc of radius 5 around (0, 0), counter-clockwise from (5, 0) to (-5, 0).
        const g = addArc(EMPTY_GEOMETRY, { at: [5, 0] }, { at: [-5, 0] }, [0, 5]).g;
        const m = snapCursor(g, [0.2, 5.2], opts());
        expect(m.kind).toBe('mid');
        expect(m.p[1]).toBeCloseTo(5);
        expect(snapCursor(g, [0.3, -5.2], opts()).kind).not.toBe('quadrant');
        expect(snapCursor(g, [3.5, -3.6], opts()).kind).not.toBe('curve');
    });

    it('lines up with the last point and any sketch point, on both axes at once', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [3, 0] }, { at: [3, 4] }).g;
        expect(snapCursor(g, [3.3, 9.6], opts({ last: [3, 4] }))).toMatchObject({ p: [3, 10], kind: 'vertical' });
        expect(snapCursor(EMPTY_GEOMETRY, [8.2, 4.3], opts({ last: [2, 4] }))).toMatchObject({ p: [8, 4], kind: 'horizontal' });
        // Corner: u of one sketch point, v of the other.
        const g2 = addLine(EMPTY_GEOMETRY, { at: [7, 2] }, { at: [12, 9] }).g;
        const corner = snapCursor(g2, [7.3, 8.8], opts({ tolerance: 0.4 }));
        expect(corner).toMatchObject({ p: [7, 9], kind: 'aligned' });
        expect(corner.guides).toHaveLength(2);
    });

    it('offers the midpoint of a line under the cursor, and catches it from further along the line', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 0] }).g;
        const along = snapCursor(g, [4.3, 0.3], opts());
        expect(along.kind).toBe('curve');
        expect(along.hints).toEqual([[10, 0]]);
        // 0.8 mm from the middle along the line: outside the 0.5 mm catch, inside the doubled one.
        expect(snapCursor(g, [10.8, 0.2], opts())).toMatchObject({ p: [10, 0], kind: 'mid' });
        expect(snapCursor(g, [4.3, 3], opts()).hints).toEqual([]);
    });

    it('snaps to the grid step otherwise, or not at all when off', () => {
        expect(snapCursor(EMPTY_GEOMETRY, [13.4, 7.7], opts({ grid: 5 }))).toMatchObject({ p: [15, 10], kind: 'grid' });
        expect(snapCursor(EMPTY_GEOMETRY, [13.4, 7.7], opts({ enabled: false }))).toMatchObject({ p: [13.4, 7.7], kind: null });
    });

    it('skips the snap kinds that are switched off and falls through to the next one', () => {
        const g = scene();
        // End point off: the cursor near (20, 0) lands on the line itself.
        expect(snapCursor(g, [20.2, 0.1], opts({ kinds: { point: false } })).kind).toBe('curve');
        // Intersection off: the crossing of line and circle is also the circle's quadrant; with both off, on a curve.
        expect(snapCursor(g, [5.2, 0.2], opts({ kinds: { intersection: false } })).kind).toBe('quadrant');
        expect(snapCursor(g, [5.2, 0.2], opts({ kinds: { intersection: false, quadrant: false } })).kind).toBe('curve');
        // Centre off: the centre (10, 0) lies on the line, and its middle is there too.
        expect(snapCursor(g, [10.1, 0.2], opts({ kinds: { centre: false } })).kind).toBe('mid');
        // On curve off as well: alignment, then the grid.
        expect(snapCursor(g, [13.6, 3.7], opts({ kinds: { curve: false } })).kind).toBe('grid');
        expect(snapCursor(EMPTY_GEOMETRY, [8.2, 4.3], opts({ last: [2, 4], kinds: { aligned: false } }))).toMatchObject({ p: [8, 4], kind: 'grid' });
        expect(snapCursor(EMPTY_GEOMETRY, [13.4, 7.7], opts({ grid: 5, kinds: { grid: false } }))).toMatchObject({ p: [13.4, 7.7], kind: null });
        // Midpoint hints go with the midpoints.
        expect(snapCursor(g, [4.3, 0.3], opts({ kinds: { mid: false } })).hints).toEqual([]);
    });

    it('keeps a point placed at an intersection on both curves when the sketch changes', () => {
        let g = scene();
        const cross = snapCursor(g, [5.2, 0.2], opts());
        const placed = placePoint(g, cross.ref);
        g = placed.g;
        expect(g.constraints.filter((c) => c.kind === 'pointOnCurve' && c.point === placed.id)).toHaveLength(2);
        const circle = g.curves.find((c) => c.kind === 'circle')!;
        const centre = circle.kind === 'circle' ? circle.center : '';
        const moved = solveGeometry(g, { targets: [{ point: centre, u: 12, v: 0 }] });
        expect(moved.ok).toBe(true);
        if (moved.ok) {
            const pt = (id: string) => moved.geometry.points.find((x) => x.id === id)!;
            const p = pt(placed.id);
            const c = pt(centre);
            const line = moved.geometry.curves.find((x) => x.kind === 'line')!;
            const [a, b] = line.kind === 'line' ? [pt(line.a), pt(line.b)] : [c, c];
            const offLine = ((b.u - a.u) * (p.v - a.v) - (b.v - a.v) * (p.u - a.u)) / Math.hypot(b.u - a.u, b.v - a.v);
            expect(c.u).toBeCloseTo(12, 4);
            expect(Math.abs(offLine)).toBeLessThan(1e-6);
            const circleNow = moved.geometry.curves.find((x) => x.kind === 'circle')!;
            expect(Math.hypot(p.u - c.u, p.v - c.v)).toBeCloseTo(circleNow.kind === 'circle' ? circleNow.radius : NaN, 4);
        }
    });
});
