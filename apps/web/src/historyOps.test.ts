import { describe, expect, it } from 'vitest';
import type { Feature, Part, Project } from '@jarvis/core';
import { ancestors, deletionIds, dependants, stepAtBar, suppressUpdates, unsuppressUpdates } from './historyOps';
import { markFor } from './sketchState';

const fillet = (id: string): Feature => ({ id, op: 'fillet', radius: 1 });
const part = (features: Feature[]): Part => ({
    id: 'p', name: 'P', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0],
    material: { color: '#fff', metalness: 0, roughness: 1 }, features,
});
const project = (features: Feature[], rollback: Project['view']['rollback']) =>
    ({ parts: [part(features)], view: { rollback } }) as unknown as Project;

const sketch = { plane: 'top' as const, profiles: [] };
// Plane -> sketch on it -> extrude from the sketch -> fillet; a pattern of the extrude; an unrelated hole.
const history: Feature[] = [
    { id: 'pl', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 5 } },
    { id: 's', op: 'sketch', sketch: { ...sketch, plane: { planeRef: 'pl' } } },
    { id: 'e', op: 'extrude', mode: 'add', distance: 5, sketchRef: 's' },
    { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 3 }, position: [0, 0, 0] },
    { id: 'p', op: 'pattern', kind: 'linear', features: ['e'], direction: 'x', count: 2, spacing: 5 },
];

describe('dependants and suppression', () => {
    it('finds the steps built on a step, through other steps', () => {
        expect(dependants(history, 'pl').map((f) => f.id)).toEqual(['s', 'e', 'p']);
        expect(dependants(history, 'h')).toEqual([]);
        expect(ancestors(history, 'p').map((f) => f.id)).toEqual(['pl', 's', 'e']);
    });

    it('suppressing a sketch suppresses what is built from it', () => {
        expect(suppressUpdates(history, 's')).toEqual([
            { id: 's', suppressed: true }, { id: 'e', suppressed: true }, { id: 'p', suppressed: true },
        ]);
    });

    it('unsuppressing brings back the parents, and the children only when asked', () => {
        const all = history.map((f) => ({ ...f, suppressed: true }));
        expect(unsuppressUpdates(all, 'e', false).map((u) => u.id)).toEqual(['pl', 's', 'e']);
        expect(unsuppressUpdates(all, 'e', true).map((u) => u.id)).toEqual(['pl', 's', 'e', 'p']);
    });

    it('deleting takes the children along, and absorbed sketches when asked', () => {
        expect(deletionIds(history, 'e', false)).toEqual(['e', 'p']);
        expect(deletionIds(history, 'e', true)).toEqual(['s', 'e', 'p']);
        expect(deletionIds(history, 'h', true)).toEqual(['h']);
    });
});

describe('sketch marks', () => {
    it('marks a sketch that cannot be solved with (?)', () => {
        expect(markFor({ ok: false, dof: 0, conflicting: [] })).toBe('(?) ');
        expect(markFor({ ok: false, dof: 0, conflicting: ['c1'] })).toBe('(+) ');
        expect(markFor({ ok: true, dof: 2, conflicting: [] })).toBe('(-) ');
        expect(markFor({ ok: true, dof: 0, conflicting: [] })).toBe('');
    });
});

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
