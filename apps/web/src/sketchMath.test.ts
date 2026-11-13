import { describe, expect, it } from 'vitest';
import {
    angledPlane, arcPoints, circleThrough, entitiesToProfiles, nestProfiles, planeForFace, planeFrame, sketchToEntities, toPartFrame,
    type Entity,
} from './sketchMath';

const line = (id: string, a: [number, number], b: [number, number]): Entity => ({ id, kind: 'line', a, b });

describe('sketch math', () => {
    it('maps planes as documented in core', () => {
        expect(toPartFrame('top', 5, [1, 2])).toEqual([1, 5, -2]);
        expect(toPartFrame('front', 5, [1, 2])).toEqual([1, 2, 5]);
        expect(toPartFrame('right', 5, [1, 2])).toEqual([5, 2, -1]);
    });

    it('keeps named planes for faces parallel to top, front or right', () => {
        expect(planeForFace([0, 1, 0], [3, 10, 4])).toEqual({ plane: 'top', offset: 10 });
        expect(planeForFace([0.001, 0, -1], [3, 10, -7])).toEqual({ plane: 'front', offset: -7 });
        expect(planeForFace([-1, 0, 0], [-20, 1, 1])).toEqual({ plane: 'right', offset: -20 });
    });

    it('puts angled faces on a custom plane with u level and v pointing up', () => {
        const s2 = Math.SQRT1_2;
        const { plane, offset } = planeForFace([s2, 0, s2], [10, 5, 10]);
        expect(offset).toBe(0);
        const f = planeFrame(plane);
        expect(f.n[0]).toBeCloseTo(s2);
        expect(f.u[1]).toBeCloseTo(0);
        expect(f.v[1]).toBeCloseTo(1);
        // Through the part origin's projection onto the face: origin = n (n · p).
        expect(f.origin[0]).toBeCloseTo(10);
        expect(f.origin[2]).toBeCloseTo(10);
        // Right-handed: u × v = n.
        const c = [f.u[1] * f.v[2] - f.u[2] * f.v[1], f.u[2] * f.v[0] - f.u[0] * f.v[2], f.u[0] * f.v[1] - f.u[1] * f.v[0]];
        c.forEach((x, i) => expect(x).toBeCloseTo(f.n[i]));
    });

    it('uses the clicked point for a tangent plane and maps sketch points into the part frame', () => {
        const { plane } = planeForFace([0, 0.6, 0.8], [0, 30, 40], true);
        const p = toPartFrame(plane, 0, [0, 0]);
        expect(p[1]).toBeCloseTo(30);
        expect(p[2]).toBeCloseTo(40);
        const up = toPartFrame(plane, 0, [0, 10]);
        expect(up[1]).toBeGreaterThan(30);
    });

    it('tilts a named plane about its own axis for construction planes', () => {
        const f = planeFrame(angledPlane('top', 'u', 30));
        expect(f.n[1]).toBeCloseTo(Math.cos(Math.PI / 6));
        expect(f.u).toEqual([1, 0, 0]);
        expect(angledPlane('front', 'v', 0)).toBe('front');
        const g = planeFrame(angledPlane('front', 'v', 90), 5);
        expect(g.n[0]).toBeCloseTo(1);
        expect(g.origin[0]).toBeCloseTo(5);
    });

    it('chains lines and arcs into closed paths, in any direction', () => {
        const entities: Entity[] = [
            line('a', [0, 0], [10, 0]),
            line('b', [10, 10], [10, 0]),
            { id: 'c', kind: 'arc', a: [10, 10], b: [0, 10], m: [5, 15] },
            line('d', [0, 10], [0, 0]),
            line('open', [20, 0], [30, 0]),
        ];
        const { profiles, open } = entitiesToProfiles(entities);
        expect(open).toBe(1);
        expect(profiles).toHaveLength(1);
        const path = profiles[0];
        expect(path.kind).toBe('path');
        if (path.kind === 'path') {
            expect(path.start).toEqual([0, 0]);
            expect(path.segments.map((s) => s.kind)).toEqual(['line', 'line', 'arc', 'line']);
            expect(path.segments[3].to).toEqual([0, 0]);
        }
    });

    it('round-trips a sketch through entities', () => {
        const sketch = {
            plane: 'top' as const,
            profiles: [
                { kind: 'rect' as const, center: [0, 0] as [number, number], width: 40, height: 20 },
                { kind: 'circle' as const, center: [5, 0] as [number, number], radius: 3 },
            ],
        };
        expect(entitiesToProfiles(sketchToEntities(sketch)).profiles).toEqual(sketch.profiles);
    });

    it('nests a circle inside a rectangle as a hole', () => {
        const nested = nestProfiles([
            { kind: 'rect', center: [0, 0], width: 40, height: 20 },
            { kind: 'circle', center: [5, 0], radius: 3 },
        ]);
        expect(nested).toHaveLength(1);
        expect(nested[0].holes).toHaveLength(1);
    });

    it('finds the circle through three points and samples the arc through the middle point', () => {
        const c = circleThrough([-10, 0], [0, 10], [10, 0])!;
        expect(c.c[0]).toBeCloseTo(0);
        expect(c.c[1]).toBeCloseTo(0);
        expect(c.r).toBeCloseTo(10);
        const points = arcPoints([-10, 0], [0, -10], [10, 0], 4);
        expect(points[2][1]).toBeCloseTo(-10);
    });
});
