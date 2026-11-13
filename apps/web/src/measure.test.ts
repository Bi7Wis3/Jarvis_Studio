import { describe, expect, it } from 'vitest';
import {
    analyseEdge, analyseFace, angleBetween, closestPointTriangle, closestSegmentSegment, fitCircle, isStraight, lineAngle,
    measurePair, measureSections, minimumDistance, analysePick, polyline, type MeasureMesh,
} from './measure';
import type { P3 } from './picking';

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const closeVec = (a: P3, b: P3, tol = 1e-6) => a.forEach((v, i) => close(v, b[i], tol));

/** Segments of a polyline through points, six floats each. */
function segments(points: P3[], closed = false): number[] {
    const out: number[] = [];
    const n = closed ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) {
        out.push(...points[i], ...points[(i + 1) % points.length]);
    }
    return out;
}

function arcPoints(centre: P3, r: number, from: number, to: number, n: number, plane: 'xz' | 'xy' = 'xz'): P3[] {
    return Array.from({ length: n + 1 }, (_, i) => {
        const t = ((from + ((to - from) * i) / n) * Math.PI) / 180;
        return plane === 'xz'
            ? [centre[0] + r * Math.cos(t), centre[1], centre[2] + r * Math.sin(t)] as P3
            : [centre[0] + r * Math.cos(t), centre[1] + r * Math.sin(t), centre[2]] as P3;
    });
}

/**
 * Box 0..A x 0..B x 0..C: faces 0..5 = x-, x+, y-, y+, z-, z+ (two triangles each, outward winding), edges 0..11 =
 * its sides, then edge 12 = a circle of radius 5 floating above at y = 50, centre (20, 50, 10).
 */
function boxMesh(A = 40, B = 10, C = 20): MeasureMesh {
    const corner = (i: number): P3 => [i & 1 ? A : 0, i & 2 ? B : 0, i & 4 ? C : 0];
    const quads: [number, number, number, number][] = [
        [0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6],
    ];
    const positions: number[] = [];
    const indices: number[] = [];
    const triFace: number[] = [];
    quads.forEach((q, f) => {
        const base = positions.length / 3;
        q.forEach((c) => positions.push(...corner(c)));
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        triFace.push(f, f);
    });
    const sides: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const edges: number[] = [];
    const segEdge: number[] = [];
    sides.forEach(([a, b], e) => {
        edges.push(...corner(a), ...corner(b));
        segEdge.push(e);
    });
    const circle = segments(arcPoints([20, 50, 10], 5, 0, 360, 48).slice(0, 48), true);
    edges.push(...circle);
    for (let s = 0; s < circle.length / 6; s++) segEdge.push(12);
    return { positions, indices, triFace, edges, segEdge };
}

describe('polyline and straightness', () => {
    it('orders shuffled segments into a chain', () => {
        const pts: P3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
        const segs = [...pts[2], ...pts[3], ...pts[0], ...pts[1], ...pts[1], ...pts[2]];
        const { points, closed } = polyline(segs);
        expect(closed).toBe(false);
        expect([points[0][0], points[3][0]].sort()).toEqual([0, 3]);
    });

    it('tells straight from bent', () => {
        expect(isStraight([[0, 0, 0], [1, 1, 1], [2, 2, 2]])).toBe(true);
        expect(isStraight([[0, 0, 0], [1, 0.01, 0], [2, 0, 0]])).toBe(false);
    });
});

describe('fitCircle', () => {
    it('finds the centre and radius of a tilted circle', () => {
        const pts = arcPoints([0, 0, 0], 7.5, 0, 360, 24).slice(0, 24).map(([x, y, z]) => {
            // Tilt 30 degrees about X and move.
            const c = Math.cos(Math.PI / 6);
            const s = Math.sin(Math.PI / 6);
            return [x + 3, y * c - z * s - 2, y * s + z * c + 5] as P3;
        });
        const fit = fitCircle(pts)!;
        close(fit.radius, 7.5, 1e-6);
        closeVec(fit.centre, [3, -2, 5], 1e-6);
        close(Math.abs(fit.normal[1]), Math.cos(Math.PI / 6), 1e-6);
    });

    it('rejects a line and an ellipse', () => {
        expect(fitCircle([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]])).toBeNull();
        const ellipse = Array.from({ length: 24 }, (_, i) => [10 * Math.cos(i / 4), 0, 6 * Math.sin(i / 4)] as P3);
        expect(fitCircle(ellipse)).toBeNull();
    });
});

describe('analyseEdge', () => {
    it('reads a straight edge', () => {
        const e = analyseEdge(segments([[0, 0, 0], [3, 4, 0]]))!;
        expect(e.kind).toBe('line');
        close(e.length, 5);
        if (e.kind === 'line') closeVec(e.direction, [0.6, 0.8, 0]);
    });

    it('reads a full circle with its exact length', () => {
        const e = analyseEdge(segments(arcPoints([1, 2, 3], 4, 0, 360, 32).slice(0, 32), true))!;
        expect(e.kind).toBe('circle');
        if (e.kind === 'circle') {
            close(e.radius, 4, 1e-5);
            closeVec(e.centre, [1, 2, 3], 1e-5);
            close(e.length, 8 * Math.PI, 1e-4);
        }
    });

    it('reads an arc and its angle', () => {
        const e = analyseEdge(segments(arcPoints([0, 0, 0], 10, 0, 90, 8, 'xy')))!;
        expect(e.kind).toBe('arc');
        if (e.kind === 'arc') {
            close(e.angle, 90, 1e-6);
            close(e.length, 5 * Math.PI, 1e-5);
        }
    });
});

describe('analyseFace', () => {
    const mesh = boxMesh();

    it('gives area, normal and perimeter of a planar face', () => {
        const top = analyseFace(mesh, 3);
        close(top.area, 800);
        expect(top.planar).toBe(true);
        closeVec(top.normal!, [0, 1, 0]);
        close(top.perimeter, 120);
        expect(top.perimeterApprox).toBe(false);
        expect(top.edges).toHaveLength(4);
        closeVec(top.centroid, [20, 10, 10]);
    });
});

describe('closest points', () => {
    it('between skew segments', () => {
        const [a, b] = closestSegmentSegment([0, 0, 0], [10, 0, 0], [5, -5, 3], [5, 5, 3]);
        closeVec(a, [5, 0, 0]);
        closeVec(b, [5, 0, 3]);
    });

    it('between a point and a triangle', () => {
        closeVec(closestPointTriangle([1, 5, 1], [0, 0, 0], [4, 0, 0], [0, 0, 4]), [1, 0, 1]);
        closeVec(closestPointTriangle([-3, 0, -3], [0, 0, 0], [4, 0, 0], [0, 0, 4]), [0, 0, 0]);
    });

    it('triangle to triangle, and crossing triangles touch', () => {
        const t1: P3[] = [[0, 0, 0], [4, 0, 0], [0, 0, 4]];
        const t2: P3[] = [[0, 3, 0], [4, 3, 0], [0, 3, 4]];
        close(minimumDistance([t1], [t2])!.distance, 3);
        const crossing: P3[] = [[1, -1, 1], [1, 1, 1], [2, 0, 5]];
        close(minimumDistance([t1], [crossing])!.distance, 0);
    });

    it('samples large sets within the budget and still finds the minimum here', () => {
        const strip = (y: number): P3[][] => Array.from({ length: 400 }, (_, i) => [[i, y, 0], [i + 1, y, 0], [i, y, 1]] as P3[]);
        const result = minimumDistance(strip(0), strip(2), 2000)!;
        expect(result.approx).toBe(true);
        close(result.distance, 2);
    });
});

describe('angles', () => {
    it('between directions and lines', () => {
        close(angleBetween([1, 0, 0], [0, 1, 0]), 90);
        close(angleBetween([1, 0, 0], [-1, 0, 0]), 180);
        close(lineAngle([1, 0, 0], [-1, 1, 0]), 45);
    });
});

describe('measurePair and measureSections', () => {
    const mesh = boxMesh();
    const item = (kind: 'face' | 'edge', index: number) => analysePick(mesh, { kind, index })!;

    it('opposite faces: distance, parallel planes and a 0 degree angle', () => {
        const pair = measurePair(mesh, item('face', 2), item('face', 3));
        close(pair.separation!.distance, 10);
        closeVec(pair.separation!.delta, [0, 10, 0]);
        close(pair.planeDistance!, 10);
        close(pair.angle!.degrees, 0);
    });

    it('adjacent faces meet at 90 degrees', () => {
        const pair = measurePair(mesh, item('face', 0), item('face', 3));
        close(pair.separation!.distance, 0);
        close(pair.angle!.degrees, 90);
        expect(pair.planeDistance).toBeUndefined();
    });

    it('edge to face angle and edge to edge', () => {
        // Edge 8 runs along Z from the origin; face 3 is the top (normal +Y): parallel, so 0 degrees.
        const pair = measurePair(mesh, item('edge', 8), item('face', 3));
        close(pair.angle!.degrees, 0);
        expect(pair.angle!.between).toBe('line and plane');
        close(pair.separation!.distance, 10);
        const lines = measurePair(mesh, item('edge', 0), item('edge', 4));
        close(lines.angle!.degrees, 90);
    });

    it('circle to edge, with dX dY dZ', () => {
        const pair = measurePair(mesh, item('edge', 12), item('edge', 3));
        // Edge 3: (0,10,20)-(40,10,20). Circle at y 50 around (20, 50, 10), radius 5: nearest point (20, 50, 15).
        close(pair.separation!.distance, Math.hypot(40, 5), 1e-3);
    });

    it('centre to centre of two circles', () => {
        const two: MeasureMesh = { ...mesh, edges: [...(mesh.edges as number[]), ...segments(arcPoints([20, 50, 40], 3, 0, 360, 24).slice(0, 24), true)],
            segEdge: [...(mesh.segEdge as number[]), ...Array(24).fill(13)] };
        const pair = measurePair(two, analysePick(two, { kind: 'edge', index: 12 })!, analysePick(two, { kind: 'edge', index: 13 })!);
        close(pair.centres!.distance, 30, 1e-4);
        closeVec(pair.centres!.delta, [0, 0, 30], 1e-4);
    });

    it('builds readable sections', () => {
        const sections = measureSections(mesh, [{ kind: 'edge', index: 12 }, { kind: 'face', index: 3 }]);
        expect(sections.map((s) => s.title)).toEqual(['Edge 13 · circle', 'Face 4 · planar', 'Between the two']);
        expect(Object.fromEntries(sections[0].rows).Diameter).toBe('10 mm');
        expect(Object.fromEntries(sections[2].rows)['Minimum distance']).toBe('40 mm');
        const three = measureSections(mesh, [{ kind: 'edge', index: 0 }, { kind: 'edge', index: 1 }, { kind: 'face', index: 3 }]);
        expect(Object.fromEntries(three[3].rows)['Total length (2 edges)']).toBe('80 mm');
    });
});
