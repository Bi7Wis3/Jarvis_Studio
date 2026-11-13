import { describe, expect, it } from 'vitest';
import type { Feature, Sketch } from '@jarvis/core';
import { blockIds, buildFeatureTree, filterKeys, gapCount, isRolled, markerGap, reorderIds } from './featureTree';

const sketch: Sketch = { plane: 'top', profiles: [] };
const sk = (id: string, name?: string): Feature => ({ id, name, op: 'sketch', sketch });
const fillet = (id: string): Feature => ({ id, op: 'fillet', radius: 1 });

describe('feature tree', () => {
    it('nests an inline sketch under its step', () => {
        const tree = buildFeatureTree([{ id: 'e1', op: 'extrude', distance: 5, mode: 'add', sketch }]);
        expect(tree).toHaveLength(1);
        expect(tree[0].children).toEqual([
            expect.objectContaining({ key: 'e1:sketch0', stepId: null, index: 0, parentId: 'e1', label: 'Sketch' }),
        ]);
        expect(blockIds(tree[0])).toEqual(['e1']);
    });

    it('nests a sketch step used by one step only', () => {
        const tree = buildFeatureTree([
            sk('s1', 'Sketch 1'),
            fillet('f1'),
            { id: 'e1', op: 'extrude', distance: 5, mode: 'add', sketchRef: 's1' },
        ]);
        expect(tree.map((n) => n.key)).toEqual(['f1', 'e1']);
        expect(tree[1].children).toEqual([
            expect.objectContaining({ key: 's1', stepId: 's1', index: 0, parentId: 'e1', label: 'Sketch 1' }),
        ]);
        expect(blockIds(tree[1])).toEqual(['s1', 'e1']);
    });

    it('keeps shared and unused sketch steps at top level', () => {
        const tree = buildFeatureTree([
            sk('s1'),
            { id: 'e1', op: 'extrude', distance: 5, mode: 'add', sketchRef: 's1' },
            { id: 'e2', op: 'revolve', axis: 'u', mode: 'cut', sketchRef: 's1' },
            sk('s2'),
        ]);
        expect(tree.map((n) => n.key)).toEqual(['s1', 'e1', 'e2', 's2']);
        expect(tree[0].users).toBe(2);
        expect(tree[3].users).toBe(0);
        expect(tree[1].children).toEqual([]);
        expect(tree[2].children).toEqual([]);
    });

    it('nests loft sections, inline and by reference, in section order', () => {
        const tree = buildFeatureTree([
            sk('a'),
            sk('b'),
            sk('shared'),
            { id: 'x', op: 'extrude', distance: 1, mode: 'add', sketchRef: 'shared' },
            { id: 'l1', op: 'loft', mode: 'add', sections: [{ sketchRef: 'b' }, { sketch }, { sketchRef: 'a' }, { sketchRef: 'shared' }] },
        ]);
        expect(tree.map((n) => n.key)).toEqual(['shared', 'x', 'l1']);
        expect(tree[2].children.map((c) => [c.key, c.role])).toEqual([
            ['b', 'Section 1'],
            ['l1:section1', 'Section 2'],
            ['a', 'Section 3'],
        ]);
        expect(blockIds(tree[2])).toEqual(['a', 'b', 'l1']);
    });

    it('nests sweep profile and path', () => {
        const tree = buildFeatureTree([
            sk('p'),
            sk('path'),
            { id: 'sw', op: 'sweep', mode: 'add', profile: { sketchRef: 'p' }, path: { sketchRef: 'path' } },
        ]);
        expect(tree.map((n) => n.key)).toEqual(['sw']);
        expect(tree[0].children.map((c) => c.role)).toEqual(['Profile', 'Path']);
    });

    it('maps rollback counts to marker gaps between top-level rows and back', () => {
        // History: s1, f1, e1(s1), f2. Rows: f1, e1 [s1], f2.
        const tree = buildFeatureTree([
            sk('s1'),
            fillet('f1'),
            { id: 'e1', op: 'extrude', distance: 5, mode: 'add', sketchRef: 's1' },
            fillet('f2'),
        ]);
        expect(tree.map((n) => n.index)).toEqual([1, 2, 3]);
        expect([0, 1, 2, 3].map((g) => gapCount(tree, g))).toEqual([0, 2, 3, 4]);
        expect([0, 2, 3, 4].map((k) => markerGap(tree, k))).toEqual([0, 1, 2, 3]);
        // A count that only builds the nested sketch shows the marker above the first row.
        expect(markerGap(tree, 1)).toBe(0);
        // Count 2: f1 built, and the sketch nested under the unbuilt e1 is built too.
        expect(isRolled(tree[0], 2)).toBe(false);
        expect(isRolled(tree[1], 2)).toBe(true);
        expect(isRolled(tree[1].children[0], 2)).toBe(false);
    });

    it('moves nested sketch steps together with their parent', () => {
        const features: Feature[] = [
            fillet('f1'),
            sk('s1'),
            { id: 'e1', op: 'extrude', distance: 5, mode: 'add', sketchRef: 's1' },
            fillet('f2'),
        ];
        const tree = buildFeatureTree(features);
        expect(reorderIds(features, tree, 'e1', 'f1', false)).toEqual(['s1', 'e1', 'f1', 'f2']);
        expect(reorderIds(features, tree, 'f1', 'e1', true)).toEqual(['s1', 'e1', 'f1', 'f2']);
        expect(reorderIds(features, tree, 'f2', 'e1', false)).toEqual(['f1', 'f2', 's1', 'e1']);
        expect(reorderIds(features, tree, 'f1', 'e1', false)).toBeNull();
    });

    it('moves only the step itself above a shared sketch, so the server check still refuses it', () => {
        const features: Feature[] = [
            sk('s1'),
            { id: 'e1', op: 'extrude', distance: 5, mode: 'add', sketchRef: 's1' },
            { id: 'e2', op: 'extrude', distance: 2, mode: 'cut', sketchRef: 's1' },
        ];
        const tree = buildFeatureTree(features);
        expect(reorderIds(features, tree, 'e1', 's1', false)).toEqual(['e1', 's1', 'e2']);
    });

    it('filters by name and keeps the parents of matches', () => {
        const tree = buildFeatureTree([
            sk('s1', 'Base outline'),
            { id: 'e1', op: 'extrude', name: 'Plate', distance: 5, mode: 'add', sketchRef: 's1' },
            fillet('f1'),
        ]);
        expect(filterKeys(tree, '')).toBeNull();
        expect([...filterKeys(tree, 'outline')!]).toEqual(['s1', 'e1']);
        expect([...filterKeys(tree, 'FILLET')!]).toEqual(['f1']);
    });
});
