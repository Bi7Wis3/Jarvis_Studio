import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRINT, type Feature } from '@jarvis/core';
import { buildPartial, initOC, meshSolid } from './build.js';
import { forgetMeshedFaces } from './incrementalMesh.js';
import { meshKey } from './key.js';
import { qualityKey, toleranceFor } from './meshQuality.js';
import type { MeshQuality } from './meshQuality.js';

const SLOW = 300_000;

beforeAll(async () => {
    await initOC();
}, SLOW);

describe('mesh tolerances', () => {
    it('keeps normal as it was and makes coarse coarser and fine finer', () => {
        // 0.02% of the diagonal between 0.01 and 0.2 mm, 0.2 rad: the kernel's tolerance before display quality existed.
        expect(toleranceFor(100, 'normal')).toEqual({ tolerance: 0.02, angularTolerance: 0.2 });
        expect(toleranceFor(5000, 'normal').tolerance).toBe(0.2);
        expect(toleranceFor(1, 'normal').tolerance).toBe(0.01);
        for (const diagonal of [1, 100, 5000]) {
            expect(toleranceFor(diagonal, 'coarse').tolerance).toBeGreaterThan(toleranceFor(diagonal, 'normal').tolerance);
            expect(toleranceFor(diagonal, 'fine').tolerance).toBeLessThan(toleranceFor(diagonal, 'normal').tolerance);
        }
    });

    it('keys normal meshes as before and the other qualities apart', () => {
        const key = meshKey({ shape: { kind: 'box', size: [1, 2, 3], radius: 0 } }, DEFAULT_PRINT);
        expect(qualityKey(key, 'normal')).toBe(key);
        const keys = new Set((['coarse', 'normal', 'fine'] as MeshQuality[]).map((q) => qualityKey(key, q)));
        expect(keys.size).toBe(3);
        for (const k of keys) {
            expect(k).toMatch(/^[a-f0-9]{24}$/);
        }
    });
});

describe('display quality of a threaded part', () => {
    it('meshes a modelled thread markedly faster at coarse, and finer at fine', () => {
        // A 40 x 20 x 20 block with an M8 x 1.25 internal thread 30 mm deep: 24 turns of helical faces.
        const part = {
            shape: { kind: 'box' as const, size: [40, 20, 20] as [number, number, number], radius: 0 },
            features: [
                { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 6.75 }, position: [20, 0, 0], direction: [-1, 0, 0] },
                { id: 't', op: 'thread', kind: 'internal', at: [20, 3.4, 0], pitch: 1.25, diameter: 8, length: 30, method: 'cut' },
            ] as Feature[],
        };
        const built = buildPartial(part, DEFAULT_PRINT);
        expect(built.error).toBeNull();
        const shape = built.shape!;
        const time = (quality: MeshQuality) => {
            let best = Infinity;
            let triangles = 0;
            for (let i = 0; i < 2; i++) {
                // Each time afresh: a solid meshed before keeps its triangles (incrementalMesh.ts).
                forgetMeshedFaces();
                const start = performance.now();
                triangles = meshSolid(shape, quality).indices.length / 3;
                best = Math.min(best, performance.now() - start);
            }
            return { ms: Math.round(best), triangles };
        };
        const coarse = time('coarse');
        const normal = time('normal');
        const fine = time('fine');
        console.log(`[mesh quality] coarse ${coarse.ms} ms / ${coarse.triangles} triangles; normal ${normal.ms} ms / `
            + `${normal.triangles}; fine ${fine.ms} ms / ${fine.triangles}`);
        expect(coarse.triangles).toBeLessThan(normal.triangles * 0.6);
        expect(fine.triangles).toBeGreaterThan(normal.triangles);
        expect(coarse.ms).toBeLessThan(normal.ms * 0.7);
    }, SLOW);
});
