import { beforeAll, describe, expect, it } from 'vitest';
import { measureVolume } from 'replicad';
import { DEFAULT_PRINT, type Feature } from '@jarvis/core';
import { buildPartial, initOC } from './build.js';
import { threadRidge, type RidgeSpec } from './thread.js';

const SLOW = 300_000;

beforeAll(async () => {
    await initOC();
}, SLOW);

/** Pappus: the profile's area times the path of its centroid, per turn. */
function pappus(spec: RidgeSpec): number {
    const { rBase, rCrest, wBase, wCrest } = spec;
    const area = ((wBase + wCrest) / 2) * Math.abs(rBase - rCrest);
    const centroid = (rBase * (2 * wBase + wCrest) + rCrest * (wBase + 2 * wCrest)) / (3 * (wBase + wCrest));
    return area * 2 * Math.PI * centroid * (spec.height / (spec.lead ?? spec.pitch));
}

describe('thread ridges', () => {
    it('sweeps a long ridge to its exact volume (one helix edge per turn)', () => {
        // 40.3 turns of an internal M5.87 x 0.8 ridge: one long helix edge came out 7% off; a turn each stays exact.
        const pitch = 0.8;
        const rMajor = 5.866 / 2;
        const rBase = rMajor + 0.02;
        const rCrest = rMajor - (1.0825 * pitch) / 2;
        const wCrest = pitch / 4;
        const spec: RidgeSpec = { pitch, rBase, rCrest, wBase: wCrest + 2 * (rBase - rCrest) * Math.tan(Math.PI / 6), wCrest, y0: 0, height: 40.3 * pitch };
        const volume = measureVolume(threadRidge(spec, true).shape);
        expect(Math.abs(volume - pappus(spec))).toBeLessThan(pappus(spec) * 1e-4);
    }, SLOW);
});

describe('thread steps', () => {
    // A block 20 x 20 x 20 with an 8 mm hole along -X from x = 10.
    const part = (thread: Partial<Extract<Feature, { op: 'thread' }>>) => ({
        shape: { kind: 'box' as const, size: [20, 20, 20] as [number, number, number], radius: 0 },
        features: [
            { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] },
            { id: 't', op: 'thread', kind: 'internal', at: [10, 4.1, 0], pitch: 1.5, length: 12, ...thread },
        ] as Feature[],
    });
    const taken = (thread: Partial<Extract<Feature, { op: 'thread' }>>): number => {
        const drilled = buildPartial({ ...part({}), features: part({}).features.slice(0, 1) }, DEFAULT_PRINT);
        const built = buildPartial(part(thread), DEFAULT_PRINT);
        expect(built.error).toBeNull();
        return measureVolume(drilled.shape!) - measureVolume(built.shape!);
    };

    it('keeps every start of a multi-start thread that is trimmed to the hole', () => {
        // Two starts at the same pitch take what one start takes, trimmed (started 2 mm outside the hole) or not.
        for (const trimmed of [{}, { length2: 2 }]) {
            const one = taken(trimmed);
            const two = taken({ ...trimmed, starts: 2 });
            expect(Math.abs(two - one)).toBeLessThan(one * 0.02);
        }
    }, SLOW);
});
