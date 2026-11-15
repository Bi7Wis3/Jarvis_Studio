import { describe, expect, it } from 'vitest';
import type { Feature, Part } from '@jarvis/core';
import { changeRange } from './previewRange.js';

const step = (id: string, extra: Record<string, unknown> = {}): Feature => ({ id, op: 'fillet', radius: 1, ...extra }) as Feature;

const part = (features: Feature[], extra: Partial<Part> = {}): Part => ({
    id: 'p', name: 'P', shape: { kind: 'box', size: [10, 10, 10] }, position: [0, 0, 0], rotation: [0, 0, 0],
    material: { color: '#888888', metalness: 0, roughness: 0.5 }, features, ...extra,
}) as Part;

describe('changeRange', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => step(id));

    it('covers the steps added at the end', () => {
        expect(changeRange(part([a, b]), part([a, b, c, d]))).toEqual({ from: 2, to: 3 });
        expect(changeRange(part([]), part([a]))).toEqual({ from: 0, to: 0 });
    });

    it('covers only the step edited or inserted, not the unchanged steps after it', () => {
        expect(changeRange(part([a, b, c]), part([a, step('b', { radius: 2 }), c]))).toEqual({ from: 1, to: 1 });
        expect(changeRange(part([a, b, c]), part([a, d, b, c]))).toEqual({ from: 1, to: 1 });
        expect(changeRange(part([a, b, c, d]), part([a, c, b, d]))).toEqual({ from: 1, to: 2 });
    });

    it('adds the later steps that use a changed step: an extrude of an edited sketch, a pattern of it', () => {
        const sketch = { id: 's', op: 'sketch', sketch: { plane: 'top', profiles: [] } } as unknown as Feature;
        const boss = { id: 'e', op: 'extrude', mode: 'add', distance: 5, sketchRef: 's' } as unknown as Feature;
        const pattern = { id: 'p', op: 'pattern', kind: 'linear', count: 3, features: ['e'] } as unknown as Feature;
        const edited = { ...sketch, sketch: { plane: 'top', offset: 2, profiles: [] } } as unknown as Feature;
        expect(changeRange(part([sketch, boss, a, pattern]), part([edited, boss, a, pattern]))).toEqual({ from: 0, to: 3, steps: [0, 1, 3] });
        expect(changeRange(part([sketch, boss, a]), part([edited, boss, a]))).toEqual({ from: 0, to: 1, steps: [0, 1] });
    });

    it('shows a new part, another base shape or a moved part whole', () => {
        expect(changeRange(undefined, part([a]))).toBe('whole');
        expect(changeRange(part([a]), part([a], { shape: { kind: 'box', size: [10, 20, 10] } }))).toBe('whole');
        expect(changeRange(part([a]), part([a], { position: [5, 0, 0] }))).toBe('whole');
        expect(changeRange(part([a]), part([a], { repeat: { kind: 'linear', count: 3, step: [20, 0, 0] } }))).toBe('whole');
    });

    it('shows nothing when the steps build the same body', () => {
        expect(changeRange(part([a]), part([{ ...a, name: 'Fillet1' }], { name: 'Q' }))).toBe('none');
        expect(changeRange(part([a, b]), part([a]))).toBe('none');
    });
});
