import { describe, expect, it } from 'vitest';
import type { Feature, FeatureFolder, Sketch } from '@jarvis/core';
import { buildFeatureTree, gapCount, markerGap, treeGuides } from './featureTree';
import {
    barFolders, dragIds, dropPlace, folderKey, folderRows, isDragged, rangeKeys, rowIndex, rowSteps, siblingRun, treeLines,
    type FolderRow, type TreeLine,
} from './treeFolders';

const sketch: Sketch = { plane: 'top', profiles: [] };
const sk = (id: string): Feature => ({ id, op: 'sketch', sketch });
const fillet = (id: string): Feature => ({ id, op: 'fillet', radius: 1 });
const extrude = (id: string, sketchRef: string): Feature => ({ id, op: 'extrude', distance: 5, mode: 'add', sketchRef });

// a, F[ s1 e1(s1), G[ b ] ], c
const features: Feature[] = [fillet('a'), sk('s1'), extrude('e1', 's1'), fillet('b'), fillet('c')];
const folders: FeatureFolder[] = [
    { id: 'f', name: 'Mounts', items: ['s1', 'e1', 'g'] },
    { id: 'g', name: 'Holes', items: ['b'] },
];
const tree = buildFeatureTree(features);
const rows = folderRows(tree, features, folders);
const index = rowIndex(rows);

/** Lines as text: depth-indented keys, gaps as |n. */
function text(lines: TreeLine[]): string[] {
    return lines.map((l) => (l.kind === 'gap' ? `${'  '.repeat(l.depth - 1)}|${l.gap}` : `${'  '.repeat(l.depth - 1)}${l.key}`));
}

describe('tree folders', () => {
    it('wraps the top-level rows in their folders, numbering the rows for the rollback gaps', () => {
        expect(rows.map((r) => r.key)).toEqual(['a', folderKey('f'), 'c']);
        const f = rows[1] as FolderRow;
        expect([f.start, f.end]).toEqual([1, 3]);
        expect(f.items.map((r) => r.key)).toEqual(['e1', folderKey('g')]);
        const b = index.get('b');
        expect(b?.kind === 'node' ? b.pos : null).toBe(3);
        // The sketch moves with its step: the folder's steps are e1's block and b.
        expect(rowSteps(f)).toEqual(['s1', 'e1', 'b']);
        // Without folders the rows are the tree's.
        expect(folderRows(tree, features, undefined).map((r) => r.key)).toEqual(tree.map((n) => n.key));
    });

    it('shows a gap after each row, and the gap after a folder\'s last row below the folder', () => {
        const all = new Set(['e1', folderKey('f'), folderKey('g')]);
        const open = treeLines(rows, { open: (k) => all.has(k), matches: null, query: '', gaps: true });
        expect(text(open)).toEqual([
            '|0', 'a', '|1', '__folder:f', '  e1', '    s1', '  |2', '  __folder:g', '    b', '|3', 'c', '|4',
        ]);
        // Closed, a folder keeps only the gaps at its edges.
        const closed = treeLines(rows, { open: () => false, matches: null, query: '', gaps: true });
        expect(text(closed)).toEqual(['|0', 'a', '|1', '__folder:f', '|3', 'c', '|4']);
        // The connector lines run through a gap inside a folder at its depth.
        const depths = open.map((l) => (l.kind === 'gap' ? null : l.depth));
        const guides = treeGuides(depths, (i) => (open[i].kind === 'gap' ? open[i].depth : 1));
        expect(guides[6].through).toEqual([1, 2]);
        expect(treeGuides(depths)[6].through).toEqual([1]);
    });

    it('opens the folders the rollback bar is in and counts the gaps as the flat tree does', () => {
        // The bar after e1 (2 rows built) is inside F only; after b (3) it is below F.
        expect([...barFolders(rows, 2)]).toEqual([folderKey('f')]);
        expect([...barFolders(rows, 3)]).toEqual([]);
        expect(gapCount(tree, 2)).toBe(3);
        expect(markerGap(tree, 3)).toBe(2);
    });

    it('filters into folders, and shows all of a folder whose name matches', () => {
        const hit = treeLines(rows, { open: () => true, matches: new Set(['b']), query: 'b', gaps: false });
        expect(text(hit)).toEqual(['__folder:f', '  __folder:g', '    b']);
        const named = treeLines(rows, { open: () => true, matches: new Set(), query: 'holes', gaps: false });
        expect(text(named)).toEqual(['__folder:f', '  __folder:g', '    b']);
    });

    it('places drops: above a row after the row above it, below it, and into a folder by where the items come from', () => {
        const f = index.get(folderKey('f'))!;
        const g = index.get(folderKey('g'))!;
        const none = new Set<string>();
        expect(dropPlace(rows, index.get('c')!, 'before', none, false)).toEqual({ after: 'f' });
        expect(dropPlace(rows, index.get('e1')!, 'before', none, false)).toEqual({ into: 'f', at: 'start' });
        expect(dropPlace(rows, g, 'before', none, false)).toEqual({ after: 'e1' });
        // The row above is itself dragged: the next one up.
        expect(dropPlace(rows, g, 'before', new Set(['e1']), false)).toEqual({ into: 'f', at: 'start' });
        expect(dropPlace(rows, index.get('a')!, 'after', none, false)).toEqual({ after: 'a' });
        expect(dropPlace(rows, f, 'into', none, true)).toEqual({ into: 'f', at: 'start' });
        expect(dropPlace(rows, f, 'into', none, false)).toEqual({ into: 'f', at: 'end' });
        expect(dragIds([index.get('e1')!, g])).toEqual(['s1', 'e1', 'g']);
        // Nothing lands inside a dragged folder.
        expect(isDragged(index.get('b'), new Set([folderKey('f')]))).toBe(true);
        expect(isDragged(index.get('c'), new Set([folderKey('f')]))).toBe(false);
    });

    it('lets only rows that follow one another at one level make a folder', () => {
        expect(siblingRun(index, rows, ['c', folderKey('f')])?.map((r) => r.key)).toEqual([folderKey('f'), 'c']);
        expect(siblingRun(index, rows, ['a', 'c'])).toBeNull();
        expect(siblingRun(index, rows, ['a', 'e1'])).toBeNull();
        expect(siblingRun(index, rows, ['s1'])).toBeNull();
        const lines = treeLines(rows, { open: () => true, matches: null, query: '', gaps: true });
        expect(rangeKeys(lines, 'c', 'e1')).toEqual(['e1', folderKey('g'), 'b', 'c']);
    });
});
