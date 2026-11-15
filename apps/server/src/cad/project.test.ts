import { beforeAll, describe, expect, it } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { makeBox, makeCylinder, setOC, type Shape3D } from 'replicad';
import type { ModelCurve, PlaneFrame3, TaggedCurve } from '@jarvis/core/projection';
import { convertPicks, piercePoints, planeFaceLoops, projectEdges, sectionCurves, silhouetteCurves } from './project.js';

const SLOW = 120_000;

// Box 40 x 10 x 20 (x 0..40, y 0..10 up, z 0..20) with a through hole of radius 5 at x 20, z 10.
let plate: Shape3D;
// Cylinder of radius 5, 10 high, on the origin along +y.
let cylinder: Shape3D;

/** The app's top plane at a height: u = +x, v = -z, normal +y. */
const top = (y: number): PlaneFrame3 => ({ origin: [0, y, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] });
/** Tilted 30 degrees from the top plane about x, through the origin. */
const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);
const tilted: PlaneFrame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, S, -C], n: [0, C, S] };

beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
    plate = makeBox([0, 0, 0], [40, 10, 20]).cut(makeCylinder(5, 10, [20, 0, 10], [0, 1, 0]));
    cylinder = makeCylinder(5, 10, [0, 0, 0], [0, 1, 0]);
}, SLOW);

const key = (c: ModelCurve): string => JSON.stringify(c.kind === 'line'
    ? { ...c, a: c.a[0] < c.b[0] || (c.a[0] === c.b[0] && c.a[1] < c.b[1]) ? c.a : c.b, b: c.a[0] < c.b[0] || (c.a[0] === c.b[0] && c.a[1] < c.b[1]) ? c.b : c.a }
    : c);
const plain = (curves: TaggedCurve[]): ModelCurve[] => curves.map(({ edge: _e, face: _f, loop: _l, ...c }) => c as ModelCurve);
const unique = (curves: TaggedCurve[]): string[] => [...new Set(plain(curves).map(key))].sort();

describe('projectEdges', () => {
    it('projects a plate with a hole onto its top plane: four lines and a circle at the exact coordinates', () => {
        const result = projectEdges(plate, top(10));
        expect(result.skipped).toEqual([]);
        expect(unique(result.curves)).toEqual([
            { kind: 'circle', center: [20, -10], radius: 5 },
            { kind: 'line', a: [0, -20], b: [0, 0] },
            { kind: 'line', a: [0, -20], b: [40, -20] },
            { kind: 'line', a: [0, 0], b: [40, 0] },
            { kind: 'line', a: [40, -20], b: [40, 0] },
        ].map((c) => key(c as ModelCurve)).sort());
        expect(result.points).toEqual(expect.arrayContaining([[0, 0], [40, 0], [40, -20], [0, -20]]));
    }, SLOW);

    it('gives the same outline on a plane 25 mm up', () => {
        expect(unique(projectEdges(plate, top(25)).curves)).toEqual(unique(projectEdges(plate, top(10)).curves));
    }, SLOW);

    it('turns the hole into an exact ellipse on a tilted plane', () => {
        const result = projectEdges(plate, tilted);
        const ellipses = result.curves.filter((c) => c.kind === 'ellipse');
        expect(ellipses.length).toBe(2);
        for (const e of ellipses) {
            if (e.kind !== 'ellipse') {
                continue;
            }
            // Major axis along u, radius 5; minor radius 5 cos 30.
            expect(Math.hypot(e.major[0] - e.center[0], e.major[1] - e.center[1])).toBeCloseTo(5, 9);
            expect(Math.abs(e.major[1] - e.center[1])).toBeLessThan(1e-9);
            expect(e.minor).toBeCloseTo(5 * C, 9);
            expect(e.center[0]).toBeCloseTo(20, 9);
        }
        // The hole's top circle (y 10, z 10): v = 10 sin 30 - 10 cos 30.
        const vs = ellipses.map((e) => (e.kind === 'ellipse' ? e.center[1] : 0)).sort((a, b) => a - b);
        expect(vs[0]).toBeCloseTo(-10 * C, 9);
        expect(vs[1]).toBeCloseTo(10 * S - 10 * C, 9);
        // The box's twelve edges stay lines (none are seen end-on).
        expect(result.curves.filter((c) => c.kind === 'line').length).toBe(12);
    }, SLOW);

    it('projects a cylinder: one circle on the top plane (both rims coincide), the seam left out', () => {
        const result = projectEdges(cylinder, top(10));
        expect(unique(result.curves)).toEqual([key({ kind: 'circle', center: [0, 0], radius: 5 })]);
        expect(result.curves.length).toBe(2);
    }, SLOW);

    it('projects a cylinder onto a side plane as its two rims seen edge-on', () => {
        const front: PlaneFrame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
        const result = projectEdges(cylinder, front);
        expect(unique(result.curves)).toEqual([
            key({ kind: 'line', a: [-5, 0], b: [5, 0] }),
            key({ kind: 'line', a: [-5, 10], b: [5, 10] }),
        ].sort());
    }, SLOW);
});

describe('convertPicks', () => {
    it('converts the top face of the plate: its outer loop and the hole as loop 1', () => {
        const result = convertPicks(plate, top(10), [], [{ at: [5, 10, 5], normal: [0, 1, 0] }]);
        expect(result.loops).toEqual([2]);
        const outer = result.curves.filter((c) => c.loop === 0);
        const inner = result.curves.filter((c) => c.loop === 1);
        expect(outer.length).toBe(4);
        expect(plain(inner)).toEqual([{ kind: 'circle', center: [20, -10], radius: 5 }]);
    }, SLOW);

    it('converts one picked edge', () => {
        const result = convertPicks(plate, top(10), [[20, 10, 0]], []);
        expect(plain(result.curves)).toEqual([{ kind: 'line', a: expect.any(Array), b: expect.any(Array) }]);
        expect(unique(result.curves)).toEqual([key({ kind: 'line', a: [0, 0], b: [40, 0] })]);
    }, SLOW);
});

describe('planeFaceLoops', () => {
    it('gives the loops of the faces lying in the sketch plane: the plate top with its hole, nothing half way up', () => {
        const result = planeFaceLoops(plate, top(10));
        expect(result.loops).toEqual([2]);
        expect(result.curves.filter((c) => c.loop === 0)).toHaveLength(4);
        expect(plain(result.curves.filter((c) => c.loop === 1))).toEqual([{ kind: 'circle', center: [20, -10], radius: 5 }]);
        expect(unique(result.curves.filter((c) => c.loop === 0))).toEqual([
            key({ kind: 'line', a: [0, -20], b: [0, 0] }), key({ kind: 'line', a: [0, -20], b: [40, -20] }),
            key({ kind: 'line', a: [0, 0], b: [40, 0] }), key({ kind: 'line', a: [40, -20], b: [40, 0] }),
        ].sort());
        expect(planeFaceLoops(plate, top(5)).curves).toEqual([]);
        expect(planeFaceLoops(plate, tilted).curves).toEqual([]);
        // The bottom face faces the other way but lies in the plane too.
        expect(planeFaceLoops(plate, top(0)).loops).toEqual([2]);
    }, SLOW);
});

describe('sectionCurves', () => {
    it('cuts the plate half way up: four lines and the hole circle', () => {
        const result = sectionCurves(plate, top(5), []);
        expect(unique(result.curves)).toEqual([
            { kind: 'circle', center: [20, -10], radius: 5 },
            { kind: 'line', a: [0, -20], b: [0, 0] },
            { kind: 'line', a: [0, -20], b: [40, -20] },
            { kind: 'line', a: [0, 0], b: [40, 0] },
            { kind: 'line', a: [40, -20], b: [40, 0] },
        ].map((c) => key(c as ModelCurve)).sort());
    }, SLOW);
});

describe('silhouetteCurves', () => {
    it('outlines the plate from above: the outer rectangle, and the hole unless external', () => {
        const external = silhouetteCurves(plate, top(20), true);
        expect(external.skipped).toEqual([]);
        expect(unique(external.curves)).toEqual([
            { kind: 'line', a: [0, -20], b: [0, 0] },
            { kind: 'line', a: [0, -20], b: [40, -20] },
            { kind: 'line', a: [0, 0], b: [40, 0] },
            { kind: 'line', a: [40, -20], b: [40, 0] },
        ].map((c) => key(c as ModelCurve)).sort());
        expect(external.curves.some((c) => c.kind === 'circle' || c.kind === 'arc')).toBe(false);
        const all = silhouetteCurves(plate, top(20), false);
        const round = all.curves.filter((c) => c.kind === 'circle' || c.kind === 'arc');
        expect(round.length).toBeGreaterThan(0);
        for (const c of round) {
            expect(c.center).toEqual([20, -10]);
        }
    }, SLOW);

    it('outlines a cylinder from the side as a rectangle', () => {
        const front: PlaneFrame3 = { origin: [0, 0, 20], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
        const result = silhouetteCurves(cylinder, front, true);
        expect(result.curves.every((c) => c.kind === 'line')).toBe(true);
        const xs = result.curves.flatMap((c) => (c.kind === 'line' ? [c.a[0], c.b[0]] : []));
        expect(Math.min(...xs)).toBeCloseTo(-5, 6);
        expect(Math.max(...xs)).toBeCloseTo(5, 6);
    }, SLOW);
});

describe('piercePoints', () => {
    it('finds where a vertical edge passes through a plane half way up, and skips an edge in the plane', () => {
        expect(piercePoints(plate, top(5), [[40, 5, 20]]).points).toEqual([[40, -20]]);
        const flat = piercePoints(plate, top(10), [[20, 10, 0]]);
        expect(flat.points).toEqual([]);
        expect(flat.skipped).toHaveLength(1);
    }, SLOW);
});
