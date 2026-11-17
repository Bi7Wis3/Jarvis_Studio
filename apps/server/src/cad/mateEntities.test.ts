import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRINT, type Feature, type Shape } from '@jarvis/core';
import { buildPartial, initOC } from './build.js';
import { mateEntities } from './mateEntities.js';

const SLOW = 120_000;

const solid = (shape: Shape, features: Feature[] = []) => buildPartial({ shape, features }, DEFAULT_PRINT).shape;

beforeAll(async () => {
    await initOC();
}, SLOW);

describe('mate entities (kernel)', () => {
    it('reads a plate\'s top face, a drilled hole, a straight edge, a hole\'s rim and a corner', () => {
        // A 40 x 10 x 20 plate centred on the origin, with a 6 mm hole down through it at x = 10.
        const plate = solid({ kind: 'box', size: [40, 10, 20], radius: 0 }, [
            { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 6 }, position: [10, 5, 0] },
        ]);
        const [top, hole, edge, rim, corner, gone] = mateEntities(plate, [
            { kind: 'face', at: [-10, 5, 5], normal: [0, 1, 0] },
            { kind: 'face', at: [13, 0, 0], normal: [-1, 0, 0] },
            { kind: 'edge', at: [0, 5, 10] },
            { kind: 'edge', at: [13, 5, 0] },
            { kind: 'vertex', at: [20, 5, 10] },
            { kind: 'face', at: [100, 100, 100], normal: [0.6, 0.64, 0.48] },
        ]);
        expect(top).toMatchObject({ type: 'plane', normal: [0, 1, 0] });
        expect((top as { origin: number[] }).origin[1]).toBeCloseTo(5, 9);
        expect(hole).toMatchObject({ type: 'cylinder', inside: true });
        const h = hole as { point: number[]; direction: number[]; radius: number };
        expect(h.radius).toBeGreaterThan(2.95);
        expect(h.radius).toBeLessThan(3.3);
        expect(h.point[0]).toBeCloseTo(10, 6);
        expect(h.point[2]).toBeCloseTo(0, 6);
        expect(Math.abs(h.direction[1])).toBeCloseTo(1, 9);
        expect(edge).toMatchObject({ type: 'line' });
        expect(Math.abs((edge as { direction: number[] }).direction[0])).toBeCloseTo(1, 9);
        expect(rim).toMatchObject({ type: 'circle' });
        expect((rim as { centre: number[] }).centre[1]).toBeCloseTo(5, 6);
        expect(corner).toEqual({ type: 'point', point: [20, 5, 10] });
        expect(gone).toHaveProperty('error');
    }, SLOW);

    it('reads a shaft, a cone and a ball', () => {
        const shaft = solid({ kind: 'cylinder', radius: 4, height: 30, bevel: 0 });
        const [side] = mateEntities(shaft, [{ kind: 'face', at: [4, 0, 0], normal: [1, 0, 0] }]);
        expect(side).toMatchObject({ type: 'cylinder', inside: false });
        expect((side as { radius: number }).radius).toBeCloseTo(4, 9);
        const cone = solid({ kind: 'cone', radius: 10, height: 20 });
        const [conical] = mateEntities(cone, [{ kind: 'face', at: [5, 0, 0], normal: [0.89, 0.45, 0] }]);
        expect(conical).toMatchObject({ type: 'cone', inside: false });
        expect((conical as { halfAngle: number }).halfAngle).toBeCloseTo((Math.atan(10 / 20) * 180) / Math.PI, 6);
        const ball = solid({ kind: 'sphere', radius: 7 });
        const [round] = mateEntities(ball, [{ kind: 'face', at: [0, 7, 0], normal: [0, 1, 0] }]);
        expect(round).toMatchObject({ type: 'sphere', inside: false });
        expect((round as { radius: number }).radius).toBeCloseTo(7, 9);
    }, SLOW);

    it('finds a hole from a point on its cylinder without a normal, also past the hole\'s ends (a mate from SolidWorks)', () => {
        const plate = solid({ kind: 'box', size: [40, 10, 20], radius: 0 }, [
            { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 6 }, position: [10, 5, 0] },
        ]);
        const [first] = mateEntities(plate, [{ kind: 'face', at: [13, 0, 0], normal: [-1, 0, 0] }]);
        const r = (first as { radius: number }).radius;
        const [wrongWay, above] = mateEntities(plate, [
            { kind: 'face', at: [10 + r, 0, 0] },
            { kind: 'face', at: [10, 20, r] },
        ]);
        expect(wrongWay).toMatchObject({ type: 'cylinder', inside: true });
        expect(above).toMatchObject({ type: 'cylinder' });
        expect((above as { radius: number }).radius).toBeCloseTo(r, 9);
    }, SLOW);
});
