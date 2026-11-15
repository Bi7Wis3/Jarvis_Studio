import { describe, expect, it } from 'vitest';
import type { Feature, SketchGeometry } from '@jarvis/core';
import { sketchExtent } from './partExtent';

const circle: SketchGeometry = { points: [{ id: 'c', u: 10, v: 0 }], curves: [{ id: 'k', kind: 'circle', center: 'c', radius: 5 }], constraints: [] };
const step = (id: string, offset: number, geometry: SketchGeometry): Feature =>
    ({ id, op: 'sketch', sketch: { plane: 'top', offset, profiles: [], geometry } }) as Feature;

describe('sketchExtent', () => {
    it('spans the sketches of a part that has no solid yet, circles by their full size', () => {
        const box = sketchExtent([step('sketch-1', 0, circle), step('sketch-2', 25, circle)])!;
        // Top plane: its normal is Y, so the two sketches are 25 mm apart in Y.
        expect(box.max[1] - box.min[1]).toBeCloseTo(25);
        const flat = [0, 2].map((i) => box.max[i] - box.min[i]);
        expect(flat[0]).toBeCloseTo(10);
        expect(flat[1]).toBeCloseTo(10);
    });

    it('gives null without sketches, and skips suppressed and empty ones', () => {
        expect(sketchExtent([])).toBeNull();
        expect(sketchExtent(undefined)).toBeNull();
        expect(sketchExtent([{ ...step('sketch-1', 0, circle), suppressed: true } as Feature])).toBeNull();
        expect(sketchExtent([step('sketch-1', 0, { points: [], curves: [], constraints: [] })])).toBeNull();
    });
});
