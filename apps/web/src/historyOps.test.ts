import { describe, expect, it } from 'vitest';
import type { Feature, Part, Project } from '@jarvis/core';
import { stepAtBar } from './historyOps';

const fillet = (id: string): Feature => ({ id, op: 'fillet', radius: 1 });
const part = (features: Feature[]): Part => ({
    id: 'p', name: 'P', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0],
    material: { color: '#fff', metalness: 0, roughness: 1 }, features,
});
const project = (features: Feature[], rollback: Project['view']['rollback']) =>
    ({ parts: [part(features)], view: { rollback } }) as unknown as Project;

describe('stepAtBar', () => {
    it('is the first step below the bar while rolled back', () => {
        expect(stepAtBar(project([fillet('a'), fillet('b'), fillet('c')], { partId: 'p', count: 1 }), 'p')).toBe('b');
        expect(stepAtBar(project([fillet('a'), fillet('b')], { partId: 'p', count: 0 }), 'p')).toBe('a');
    });

    it('is null at the end, for another part, or without a bar', () => {
        expect(stepAtBar(project([fillet('a')], { partId: 'p', count: 1 }), 'p')).toBeNull();
        expect(stepAtBar(project([fillet('a'), fillet('b')], { partId: 'q', count: 1 }), 'p')).toBeNull();
        expect(stepAtBar(project([fillet('a'), fillet('b')], null), 'p')).toBeNull();
        expect(stepAtBar(null, 'p')).toBeNull();
    });
});
