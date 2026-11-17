import { describe, expect, it } from 'vitest';
import type { FeatureFolder, Part, Project } from './index';
import {
    addComponentFolder, applyComponentChange, componentFolderId, componentFolderParts, componentLayout, componentRowOf, componentRows,
    fitComponentFolders, keepFixedParts, moveComponents, partsInRowOrder, removeComponentFolders, reorderComponents, repairComponentFolders,
} from './componentFolders';
import type { LayoutItem } from './folders';
import { fixedParts } from './mates/solver';

const material = { color: '#888888', metalness: 0, roughness: 1 };
const part = (id: string, instanceOf?: string): Part => ({
    id, name: id.toUpperCase(), shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0], material, ...(instanceOf ? { instanceOf } : {}),
});
const ids = (parts: readonly Part[]) => parts.map((p) => p.id);

/** A layout as text: rows by id, folders as name[...]. */
function text(items: readonly LayoutItem[]): string {
    return items.map((item) => (item.kind === 'step' ? item.id : `${item.name}[${text(item.items)}]`)).join(' ');
}

// a, wheel, b, wheel-2 (an instance of wheel), c
const parts = [part('a'), part('wheel'), part('b'), part('wheel-2', 'wheel'), part('c')];

function project(list: Part[] = parts, componentFolders?: FeatureFolder[]): Pick<Project, 'parts' | 'componentFolders' | 'assembly'> {
    return { parts: list.map((p) => ({ ...p })), ...(componentFolders ? { componentFolders } : {}) };
}

describe('the assembly tree order', () => {
    it('has a row per design, its instances under it', () => {
        expect(componentRows(parts)).toEqual(['a', 'wheel', 'b', 'c']);
        expect(componentRowOf(parts).get('wheel-2')).toBe('wheel');
        // An instance whose design is gone shows as a row of its own.
        expect(componentRows([part('x', 'gone'), part('y')])).toEqual(['x', 'y']);
    });

    it('reorders the parts so the rows stand in the new order, an instance going with its design', () => {
        expect(ids(partsInRowOrder(parts, ['a', 'wheel', 'b', 'c']))).toEqual(ids(parts));
        // Only what moved changes place: c to the top, the rest as they were.
        expect(ids(partsInRowOrder(parts, ['c', 'a', 'wheel', 'b']))).toEqual(['c', 'a', 'wheel', 'b', 'wheel-2']);
        // The wheel moves with its instance, design first.
        expect(ids(partsInRowOrder(parts, ['a', 'b', 'c', 'wheel']))).toEqual(['a', 'b', 'c', 'wheel', 'wheel-2']);
        // Which rows moved decides where the instances go when it is not plain from the order.
        expect(ids(partsInRowOrder(parts, ['wheel', 'a', 'b', 'c'], ['wheel']))).toEqual(['wheel', 'wheel-2', 'a', 'b', 'c']);
        expect(ids(partsInRowOrder(parts, ['wheel', 'a', 'b', 'c'], ['a']))).toEqual(['wheel', 'a', 'b', 'wheel-2', 'c']);
        expect(() => partsInRowOrder(parts, ['a', 'b'])).toThrow(/every component/);
    });

    it('moves components before, after and into, several at once and anywhere in the tree', () => {
        const move = (list: string[], place: Parameters<typeof moveComponents>[3], folders?: FeatureFolder[]) => {
            const p = project(parts, folders);
            applyComponentChange(p, moveComponents(p.parts, p.componentFolders, list, place));
            return { order: ids(p.parts), tree: text(componentLayout(p.parts, p.componentFolders)) };
        };
        expect(move(['c'], { before: 'wheel' }).order).toEqual(['a', 'c', 'wheel', 'b', 'wheel-2']);
        expect(move(['a', 'c'], { after: 'b' }).order).toEqual(['wheel', 'b', 'wheel-2', 'a', 'c']);
        // Next to an instance means next to its design's row.
        expect(move(['a'], { after: 'wheel-2' }).order).toEqual(['wheel', 'a', 'b', 'wheel-2', 'c']);
        expect(move(['wheel'], { into: null, at: 'start' }).order).toEqual(['wheel', 'wheel-2', 'a', 'b', 'c']);
        const folders: FeatureFolder[] = [{ id: 'folder_f', name: 'F', items: ['b'] }];
        expect(move(['c', 'a'], { into: 'folder_f', at: 'start' }, folders).tree).toBe('wheel F[a c b]');
        expect(move(['b'], { into: null, at: 'start' }, folders).tree).toBe('b a wheel F[] c');
        expect(() => moveComponents(parts, undefined, ['wheel-2'], { before: 'a' })).toThrow(/instance of wheel/);
        expect(() => moveComponents(parts, undefined, ['nope'], { before: 'a' })).toThrow(/No component or folder "nope"/);
        expect(() => moveComponents(parts, folders, ['folder_f'], { into: 'folder_f' })).toThrow(/itself/);
        expect(() => moveComponents(parts, undefined, ['a'], { into: 'nope' })).toThrow(/No component folder/);
    });

    it('takes a whole new order as a list of designs, or of every part', () => {
        const folders: FeatureFolder[] = [{ id: 'folder_f', name: 'F', items: ['wheel', 'b'] }];
        const designs = reorderComponents(parts, folders, ['c', 'a', 'wheel', 'b']);
        expect(designs.parts).toEqual(['c', 'a', 'wheel', 'b', 'wheel-2']);
        expect(designs.folders).toEqual(folders);
        expect(reorderComponents(parts, undefined, ['wheel-2', 'wheel', 'a', 'b', 'c']).parts).toEqual(['wheel-2', 'wheel', 'a', 'b', 'c']);
        expect(() => reorderComponents(parts, undefined, ['a', 'b'])).toThrow(/missing wheel, c/);
    });
});

describe('component folders', () => {
    it('takes picks that do not follow one another and brings them together where the first one was', () => {
        const p = project();
        applyComponentChange(p, addComponentFolder(p.parts, undefined, { id: 'folder_folder1', name: 'Folder1', items: ['c', 'wheel'] }));
        expect(text(componentLayout(p.parts, p.componentFolders))).toBe('a Folder1[wheel c] b');
        expect(ids(p.parts)).toEqual(['a', 'wheel', 'c', 'b', 'wheel-2']);
        expect(componentFolderParts(p.parts, p.componentFolders, 'folder_folder1')).toEqual(['wheel', 'c', 'wheel-2']);
        // A folder in a new folder (nesting), and an empty one placed by a neighbour.
        applyComponentChange(p, addComponentFolder(p.parts, p.componentFolders, { id: 'folder_outer', name: 'Outer', items: ['folder_folder1', 'a'] }));
        expect(text(componentLayout(p.parts, p.componentFolders))).toBe('Outer[a Folder1[wheel c]] b');
        applyComponentChange(p, addComponentFolder(p.parts, p.componentFolders, { id: 'folder_e', name: 'E', place: { before: 'b' } }));
        expect(text(componentLayout(p.parts, p.componentFolders))).toBe('Outer[a Folder1[wheel c]] E[] b');
        expect(componentFolderParts(p.parts, p.componentFolders, 'folder_outer')).toEqual(['a', 'wheel', 'c', 'wheel-2']);
        expect(() => addComponentFolder(p.parts, p.componentFolders, { id: 'a', name: 'A' })).toThrow(/in use/);
        expect(() => addComponentFolder(p.parts, p.componentFolders, { id: 'folder_x', name: 'X', items: ['wheel-2'] })).toThrow(/instance/);
    });

    it('deletes a folder and keeps what it holds in place', () => {
        const folders: FeatureFolder[] = [{ id: 'folder_o', name: 'O', items: ['wheel', 'folder_i'] }, { id: 'folder_i', name: 'I', items: ['b'] }];
        const p = project(parts, folders);
        applyComponentChange(p, removeComponentFolders(p.parts, p.componentFolders, ['folder_o']));
        expect(text(componentLayout(p.parts, p.componentFolders))).toBe('a wheel I[b] c');
        expect(ids(p.parts)).toEqual(ids(parts));
        applyComponentChange(p, removeComponentFolders(p.parts, p.componentFolders, ['folder_i']));
        expect(p.componentFolders).toBeUndefined();
        expect(() => removeComponentFolders(p.parts, undefined, ['folder_i'])).toThrow(/No component folder/);
    });

    it('gives folders ids no part can have', () => {
        expect(componentFolderId('Folder1', parts, undefined)).toBe('folder_folder1');
        expect(componentFolderId('Folder1', parts, [{ id: 'folder_folder1', name: 'Folder1', items: [] }])).toBe('folder_folder1-2');
    });

    it('repairs folders read from disk: unknown ids and repeats dropped', () => {
        const p = project(parts, [
            { id: 'folder_f', name: 'F', items: ['wheel', 'gone', 'wheel', 'wheel-2', 'b'] },
            { id: 'folder_g', name: 'G', items: ['b', 'c'] },
            { id: 'a', name: 'Clash', items: ['c'] },
        ] as FeatureFolder[]);
        repairComponentFolders(p);
        expect(text(componentLayout(p.parts, p.componentFolders))).toBe('a F[wheel b] G[c]');
        expect(p.componentFolders?.map((f) => f.items)).toEqual([['wheel', 'b'], ['c']]);
        const bad = project(parts, 'nonsense' as unknown as FeatureFolder[]);
        repairComponentFolders(bad);
        expect(bad.componentFolders).toBeUndefined();
    });

    it('lets deleted parts leave their folders and keeps new parts outside them', () => {
        const folders: FeatureFolder[] = [{ id: 'folder_f', name: 'F', items: ['wheel', 'b'] }];
        const prev = project(parts, folders);
        const next = project(parts.filter((p) => p.id !== 'b' && p.id !== 'wheel' && p.id !== 'wheel-2'), folders);
        fitComponentFolders(prev, next);
        expect(text(componentLayout(next.parts, next.componentFolders))).toBe('a F[] c');
        const added = project([...parts, part('d')], folders);
        fitComponentFolders(prev, added);
        expect(text(componentLayout(added.parts, added.componentFolders))).toBe('a F[wheel b] c d');
    });
});

describe('the fixed part', () => {
    it('stays fixed when a reorder would change which part comes first', () => {
        const p = project();
        const fixedBefore = fixedParts(p.parts, p.assembly);
        applyComponentChange(p, moveComponents(p.parts, undefined, ['c'], { into: null, at: 'start' }));
        expect(ids(p.parts)[0]).toBe('c');
        expect(p.assembly?.fixed).toEqual(['a']);
        expect(fixedParts(p.parts, p.assembly)).toEqual(fixedBefore);
        // An explicit list is left alone, mates and all.
        const q = project();
        q.assembly = { mates: [], fixed: ['b', 'c'] };
        applyComponentChange(q, moveComponents(q.parts, undefined, ['c'], { into: null, at: 'start' }));
        expect(q.assembly.fixed).toEqual(['b', 'c']);
        // The first part unchanged: nothing written.
        const r = project();
        applyComponentChange(r, moveComponents(r.parts, undefined, ['c'], { before: 'b' }));
        expect(r.assembly).toBeUndefined();
        keepFixedParts(r, []);
        expect(r.assembly).toBeUndefined();
    });
});
