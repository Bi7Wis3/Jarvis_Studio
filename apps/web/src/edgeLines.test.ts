import { describe, expect, it } from 'vitest';
import { lineDistances, outlineCandidates } from './edgeLines';

describe('lineDistances', () => {
    it('measures along each edge, starting again where an edge or a run of segments starts', () => {
        const edges = [
            0, 0, 0, 3, 0, 0, // edge 0: 3 long
            3, 0, 0, 3, 4, 0, // continues: 4 more
            9, 9, 9, 9, 9, 10, // a new run: starts at 0
            9, 9, 10, 9, 9, 12, // the same point but another edge: starts at 0
        ];
        expect([...lineDistances(edges, [0, 0, 0, 1])]).toEqual([0, 3, 3, 7, 0, 1, 0, 2]);
        expect([...lineDistances(edges)].slice(6)).toEqual([1, 3]);
    });
});

/** An open cylinder of radius 1 along y, `n` sides, as an indexed mesh with shared vertices (one face). */
function tube(n: number): { positions: number[]; indices: number[] } {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        positions.push(Math.cos(a), 0, Math.sin(a), Math.cos(a), 1, Math.sin(a));
    }
    for (let i = 0; i < n; i++) {
        const [b0, t0, b1, t1] = [2 * i, 2 * i + 1, 2 * ((i + 1) % n), 2 * ((i + 1) % n) + 1];
        indices.push(b0, t0, b1, b1, t0, t1);
    }
    return { positions, indices };
}

describe('outlineCandidates', () => {
    it('keeps the edges between sides of a curved face, not the diagonals of a flat piece nor the open ends', () => {
        const { positions, indices } = tube(8);
        const found = outlineCandidates(positions, indices);
        // Eight vertical edges between the sides; the quads' diagonals are flat, the rims have one triangle each.
        expect(found.positions.length / 6).toBe(8);
        for (let i = 0; i < found.positions.length; i += 6) {
            // Vertical, from y 0 to y 1, at the radius.
            expect(found.positions[i]).toBeCloseTo(found.positions[i + 3], 6);
            expect(Math.abs(found.positions[i + 1] - found.positions[i + 4])).toBeCloseTo(1, 6);
            expect(Math.hypot(found.positions[i], found.positions[i + 2])).toBeCloseTo(1, 6);
            // Both ends carry the same midpoint and normals, so they are kept or dropped together.
            expect([...found.centre.slice(i, i + 3)]).toEqual([...found.centre.slice(i + 3, i + 6)]);
            expect([...found.normalA.slice(i, i + 3)]).toEqual([...found.normalA.slice(i + 3, i + 6)]);
            const dot = found.normalA[i] * found.normalB[i] + found.normalA[i + 1] * found.normalB[i + 1] + found.normalA[i + 2] * found.normalB[i + 2];
            expect(dot).toBeCloseTo(Math.cos((2 * Math.PI) / 8), 6);
        }
    });

    it('finds nothing on a flat face', () => {
        const positions = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
        expect(outlineCandidates(positions, [0, 1, 2, 0, 2, 3]).positions.length).toBe(0);
    });
});
