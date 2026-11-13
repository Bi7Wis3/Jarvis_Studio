import { describe, expect, it } from 'vitest';
import type { Part } from '@jarvis/core';
import { designCopy } from './partCopy';

const grey = { color: '#888888', metalness: 0, roughness: 1 };
const source: Part = {
    id: 'bracket', name: 'Bracket', shape: { kind: 'box', size: [10, 10, 10] }, position: [0, 5, 0], rotation: [0, 0, 0],
    material: grey, features: [{ id: 'f', op: 'fillet', radius: 1 }],
};
const instance: Part = {
    id: 'bracket-2', name: 'Bracket 2', instanceOf: 'bracket', shape: { kind: 'empty' }, position: [40, 5, 0],
    rotation: [0, 90, 0], material: grey,
};

describe('designCopy', () => {
    it('copies the design of an instance, at the instance\'s place, as an independent part', () => {
        const copy = designCopy(instance, { name: 'Bracket 2 copy' }, [source, instance]);
        expect(copy).toMatchObject({ name: 'Bracket 2 copy', shape: source.shape, features: source.features, position: [40, 5, 0], rotation: [0, 90, 0] });
        expect(copy).not.toHaveProperty('id');
        expect(copy).not.toHaveProperty('instanceOf');
    });

    it('copies an ordinary part as it is', () => {
        const copy = designCopy(source, { position: [1, 2, 3] }, [source]);
        expect(copy).toMatchObject({ name: 'Bracket', shape: source.shape, features: source.features, position: [1, 2, 3] });
    });
});
