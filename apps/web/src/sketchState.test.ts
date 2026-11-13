import { beforeAll, describe, expect, it } from 'vitest';
import type { Feature, SketchGeometry } from '@jarvis/core';
import { loadSolver } from './solver';
import { definitionMark, updateRecent } from './sketchState';

beforeAll(async () => {
    await loadSolver();
});

/** A rough rectangle with H/V constraints only: free to move and resize. */
function rect(): SketchGeometry {
    return {
        points: [
            { id: 'a', u: 3, v: 2 }, { id: 'b', u: 41, v: 1 }, { id: 'c', u: 39, v: 23 }, { id: 'd', u: 2, v: 19 },
        ],
        curves: [
            { id: 'l1', kind: 'line', a: 'a', b: 'b' }, { id: 'l2', kind: 'line', a: 'b', b: 'c' },
            { id: 'l3', kind: 'line', a: 'c', b: 'd' }, { id: 'l4', kind: 'line', a: 'd', b: 'a' },
        ],
        constraints: [
            { id: 'h1', kind: 'horizontal', line: 'l1' }, { id: 'h2', kind: 'horizontal', line: 'l3' },
            { id: 'v1', kind: 'vertical', line: 'l2' }, { id: 'v2', kind: 'vertical', line: 'l4' },
        ],
    };
}

describe('sketch definition mark', () => {
    it('marks an under-defined rectangle with (-)', () => {
        expect(definitionMark(rect())).toBe('(-) ');
    });

    it('marks nothing on a fully dimensioned rectangle anchored to the origin', () => {
        const g = rect();
        g.constraints.push(
            { id: 'w', kind: 'length', line: 'l1', value: 40 },
            { id: 'h', kind: 'length', line: 'l2', value: 20 },
            { id: 'o', kind: 'coincident', a: 'a', b: 'origin' },
        );
        expect(definitionMark(g)).toBe('');
    });

    it('marks a conflicting sketch with (+)', () => {
        const g = rect();
        g.constraints.push(
            { id: 'w', kind: 'length', line: 'l1', value: 40 },
            { id: 'w2', kind: 'length', line: 'l1', value: 30 },
        );
        expect(definitionMark(g)).toBe('(+) ');
    });

    it('marks nothing on a sketch without geometry', () => {
        expect(definitionMark(undefined)).toBe('');
    });

    it('caches by geometry object and by content', () => {
        const g = rect();
        expect(definitionMark(g)).toBe('(-) ');
        expect(definitionMark(g)).toBe('(-) ');
        expect(definitionMark(structuredClone(g))).toBe('(-) ');
    });
});

describe('recent steps', () => {
    const fillet = (id: string, radius = 1): Feature => ({ id, op: 'fillet', radius });

    it('starts empty, then lists new and edited steps, most recent first', () => {
        let state = updateRecent(null, [fillet('a'), fillet('b')]);
        expect(state.recent).toEqual([]);
        state = updateRecent(state, [fillet('a'), fillet('b'), fillet('c')]);
        expect(state.recent).toEqual(['c']);
        state = updateRecent(state, [fillet('a', 2), fillet('b'), fillet('c')]);
        expect(state.recent).toEqual(['a', 'c']);
        state = updateRecent(state, [fillet('a', 2), fillet('b'), fillet('c')]);
        expect(state.recent).toEqual(['a', 'c']);
    });

    it('drops deleted steps and keeps at most the limit', () => {
        let state = updateRecent(null, []);
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
            state = updateRecent(state, [...state.seen.keys()].map((k) => fillet(k)).concat(fillet(id)));
        }
        expect(state.recent).toEqual(['f', 'e', 'd', 'c', 'b']);
        state = updateRecent(state, ['a', 'b', 'c', 'd', 'f'].map((k) => fillet(k)));
        expect(state.recent).toEqual(['f', 'd', 'c', 'b']);
    });
});
