import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry } from 'three';
import type { Decal } from '@jarvis/core';
import { buildDecalGeometry, decalBasis, defaultDecalSize, surfaceExtent } from './decalMath';

const decal = (fields: Partial<Decal>): Decal => ({ id: 'd', image: 'i', position: [0, 5, 0], normal: [0, 1, 0], size: [50, 20], ...fields });

function vertices(geometry: ReturnType<typeof buildDecalGeometry>): number[][] {
    const pos = geometry!.getAttribute('position');
    return Array.from({ length: pos.count }, (_, i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
}

describe('projected decals', () => {
    const box = new BoxGeometry(100, 10, 40, 8, 1, 4);

    it('runs the picture along the part\'s long axis', () => {
        const { u, v } = decalBasis(box, [0, 5, 0], [0, 1, 0]);
        expect(Math.abs(u.x)).toBeCloseTo(1);
        expect(Math.abs(v.z)).toBeCloseTo(1);
    });

    it('clips to the picture rectangle on the facing surface only', () => {
        const out = vertices(buildDecalGeometry(box, decal({})));
        expect(out.length).toBeGreaterThan(0);
        for (const [x, y, z] of out) {
            expect(Math.abs(x)).toBeLessThanOrEqual(25.001);
            expect(Math.abs(z)).toBeLessThanOrEqual(10.001);
            expect(y).toBeGreaterThan(5);
        }
    });

    it('never reaches the underside, however large', () => {
        const out = vertices(buildDecalGeometry(box, decal({ size: [500, 500] })));
        expect(out.every(([, y]) => y > 0)).toBe(true);
    });

    it('wraps over curved surfaces facing the decal', () => {
        // A lying cylinder: the picture follows the upper half of its round side.
        const tube = new CylinderGeometry(20, 20, 100, 48, 1, true).rotateZ(Math.PI / 2);
        const out = vertices(buildDecalGeometry(tube, decal({ position: [0, 20, 0], size: [60, 60] })));
        const lowest = Math.min(...out.map(([, y]) => y));
        expect(lowest).toBeLessThan(5);
        expect(lowest).toBeGreaterThan(-1);
    });

    it('fills and sizes from the surface extent', () => {
        const fill = surfaceExtent(box, [10, 5, 3], [0, 1, 0]);
        expect(fill!.size[0]).toBeCloseTo(100);
        expect(fill!.size[1]).toBeCloseTo(40);
        expect(fill!.center[0]).toBeCloseTo(0);
        expect(defaultDecalSize(box, [0, 5, 0], [0, 1, 0], 2)).toEqual([56, 28]);
    });
});
