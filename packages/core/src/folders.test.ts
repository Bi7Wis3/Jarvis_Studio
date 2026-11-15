import { describe, expect, it } from 'vitest';
import type { Feature, FeatureFolder, Part, Sketch } from './index';
import {
    addFolder, fitFolders, fitProjectFolders, folderId, folderLayout, folderSteps, layoutFolders, layoutSteps, moveItems,
    nextFolderName, normalizeFolders, orderProblem, removeFolders, renameFolder, repairProjectFolders, stepDeps, withAbsorbed,
    type LayoutItem,
} from './folders';

const sketch: Sketch = { plane: 'top', profiles: [] };
const sk = (id: string, plane: Sketch['plane'] = 'top'): Feature => ({ id, op: 'sketch', sketch: { ...sketch, plane } });
const fillet = (id: string): Feature => ({ id, op: 'fillet', radius: 1 });
const extrude = (id: string, sketchRef: string): Feature => ({ id, op: 'extrude', distance: 5, mode: 'add', sketchRef });
const ids = (features: Feature[]) => features.map((f) => f.id);

/** A layout as text: steps by id, folders as name[...]. */
function text(items: readonly LayoutItem[]): string {
    return items.map((item) => (item.kind === 'step' ? item.id : `${item.name}[${text(item.items)}]`)).join(' ');
}

const show = (order: readonly string[], folders: FeatureFolder[] | undefined) => text(folderLayout(order, folders));

describe('folder layout', () => {
    it('wraps folders and sub-folders round their steps', () => {
        const folders: FeatureFolder[] = [
            { id: 'f', name: 'F', items: ['b', 'g'] },
            { id: 'g', name: 'G', items: ['c', 'd'] },
        ];
        expect(show(['a', 'b', 'c', 'd', 'e'], folders)).toBe('a F[b G[c d]] e');
    });

    it('keeps empty folders in place: top level by the step below, nested by item order', () => {
        const folders: FeatureFolder[] = [
            { id: 'f', name: 'F', items: ['b', 'g', 'c'] },
            { id: 'g', name: 'G', items: [] },
            { id: 'h', name: 'H', items: [], before: 'd' },
            { id: 'end', name: 'End', items: [] },
        ];
        expect(show(['a', 'b', 'c', 'd'], folders)).toBe('a F[b G[] c] H[] d End[]');
        // Written back, an empty top-level folder notes the step it sits above.
        expect(layoutFolders(folderLayout(['a', 'b', 'c', 'd'], folders))).toEqual([
            { id: 'f', name: 'F', items: ['b', 'g', 'c'] },
            { id: 'g', name: 'G', items: [] },
            { id: 'h', name: 'H', items: [], before: 'd' },
            { id: 'end', name: 'End', items: [] },
        ]);
    });

    it('repairs what it is given: unknown ids, steps claimed twice, cycles, and folders whose steps are not one run', () => {
        const folders = [
            { id: 'f', name: 'F', items: ['a', 'ghost', 'c'] },
            { id: 'g', name: '', items: ['c', 'b', 'h'] },
            { id: 'h', name: 'H', items: ['g'] },
            { id: 'f', name: 'Again', items: [] },
            { id: 'a', name: 'Clash', items: [] },
        ] as FeatureFolder[];
        const layout = folderLayout(['a', 'b', 'c', 'd'], folders);
        // c belongs to F (named first); F's a and c are split by b (in G), so F becomes two folders. H is in G, so
        // G in H would be a cycle: H stays an empty sub-folder of G.
        expect(text(layout)).toBe('F[a] Folder[b H[]] F[c] d');
        expect(layoutFolders(layout)!.map((f) => f.id)).toEqual(['f', 'g', 'h', 'f-2']);
        expect(layoutSteps(layout)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('normalises to nothing when there are no folders', () => {
        expect(normalizeFolders(['a'], [])).toBeUndefined();
        expect(normalizeFolders(['a'], undefined)).toBeUndefined();
    });
});

describe('fitting folders to a new step order', () => {
    const folders: FeatureFolder[] = [{ id: 'f', name: 'F', items: ['b', 'c', 'd'] }];
    const order = ['a', 'b', 'c', 'd', 'e'];

    it('keeps a reorder inside the folder in it', () => {
        expect(show(['a', 'c', 'b', 'd', 'e'], fitFolders(order, ['a', 'c', 'b', 'd', 'e'], folders))).toBe('a F[c b d] e');
    });

    it('takes in a step moved between two of its steps, and lets go of one moved away', () => {
        const inside = ['a', 'b', 'e', 'c', 'd'];
        expect(show(inside, fitFolders(order, inside, folders))).toBe('a F[b e c d]');
        const away = ['c', 'a', 'b', 'd', 'e'];
        expect(show(away, fitFolders(order, away, folders))).toBe('c a F[b d] e');
    });

    it('keeps a step moved to its edge in the folder it came from', () => {
        const last = ['a', 'c', 'd', 'b', 'e'];
        expect(show(last, fitFolders(order, last, folders))).toBe('a F[c d b] e');
    });

    it('moves a folder with its steps when they all move together', () => {
        const moved = ['a', 'e', 'b', 'c', 'd'];
        expect(show(moved, fitFolders(order, moved, folders))).toBe('a e F[b c d]');
        const nested: FeatureFolder[] = [{ id: 'f', name: 'F', items: ['g'] }, { id: 'g', name: 'G', items: ['b', 'c'] }];
        const to = ['a', 'd', 'e', 'b', 'c'];
        expect(show(to, fitFolders(['a', 'b', 'c', 'd', 'e'], to, nested))).toBe('a d e F[G[b c]]');
    });

    it('puts a new step inside a folder only when it lands between two of its steps', () => {
        expect(show(['a', 'b', 'n', 'c', 'd', 'e'], fitFolders(order, ['a', 'b', 'n', 'c', 'd', 'e'], folders))).toBe('a F[b n c d] e');
        expect(show(['a', 'b', 'c', 'd', 'n', 'e'], fitFolders(order, ['a', 'b', 'c', 'd', 'n', 'e'], folders))).toBe('a F[b c d] n e');
        expect(show(['a', 'n', 'b', 'c', 'd', 'e'], fitFolders(order, ['a', 'n', 'b', 'c', 'd', 'e'], folders))).toBe('a n F[b c d] e');
    });

    it('leaves an empty folder where it was when its last step is deleted', () => {
        const one: FeatureFolder[] = [{ id: 'f', name: 'F', items: ['b'] }];
        const fitted = fitFolders(['a', 'b', 'c'], ['a', 'c'], one);
        expect(fitted).toEqual([{ id: 'f', name: 'F', items: [], before: 'c' }]);
        expect(show(['a', 'c'], fitted)).toBe('a F[] c');
    });

    it('fits every part of a project after an edit that did not touch the folders, and drops none silently', () => {
        const part = (features: Feature[], folderList?: FeatureFolder[]): Part => ({
            id: 'p', name: 'P', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0],
            material: { color: '#fff', metalness: 0, roughness: 0.5 }, features, folders: folderList,
        });
        const prev = { parts: [part([fillet('a'), fillet('b'), fillet('c')], [{ id: 'f', name: 'F', items: ['a', 'b'] }])] };
        const next = { parts: [part([fillet('a'), fillet('x'), fillet('b'), fillet('c')], [{ id: 'f', name: 'F', items: ['a', 'b'] }])] };
        fitProjectFolders(prev, next);
        expect(next.parts[0].folders).toEqual([{ id: 'f', name: 'F', items: ['a', 'x', 'b'] }]);
        // A part whose folders all go away loses the field.
        const gone = { parts: [part([fillet('a')], [{ id: 'f', name: 'F', items: ['zzz', 'nope'] }])] };
        repairProjectFolders(gone);
        expect(gone.parts[0].folders).toEqual([{ id: 'f', name: 'F', items: [] }]);
        const broken = { parts: [{ ...part([fillet('a')]), folders: 'junk' as unknown as FeatureFolder[] }] };
        repairProjectFolders(broken);
        expect(broken.parts[0]).not.toHaveProperty('folders');
    });
});

describe('folder edits', () => {
    // s1 and s2 are drawn first, then each is extruded: the tree shows e1 [s1], e2 [s2].
    const features: Feature[] = [fillet('a'), sk('s1'), sk('s2'), extrude('e1', 's1'), extrude('e2', 's2'), fillet('z')];

    it('adds a folder round steps next to each other, gathering the sketch each is built from', () => {
        const made = addFolder(features, undefined, { id: 'f', name: 'F', items: ['e1'] });
        // s2 (e2's sketch) sat between s1 and e1: it stays out of the folder, below it (still above e2).
        expect(show(made.order, made.folders)).toBe('a F[s1 e1] s2 e2 z');
        const two = addFolder(features, undefined, { id: 'f', name: 'F', items: ['e1', 'e2'] });
        expect(show(two.order, two.folders)).toBe('a F[s1 s2 e1 e2] z');
    });

    it('refuses steps that do not follow one another, and places an empty folder', () => {
        expect(() => addFolder(features, undefined, { id: 'f', name: 'F', items: ['a', 'e2'] })).toThrow(/follow one another/);
        const empty = addFolder(features, undefined, { id: 'f', name: 'F', place: { before: 'z' } });
        expect(show(empty.order, empty.folders)).toBe('a s1 s2 e1 e2 F[] z');
        expect(() => addFolder(features, undefined, { id: 'a', name: 'A' })).toThrow(/in use/);
    });

    it('groups a plane with the sketch on it and keeps a later sketch on that plane after the folder', () => {
        const withPlane: Feature[] = [
            { id: 'p1', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 5 } },
            sk('s3', { planeRef: 'p1' }),
            sk('s1', { planeRef: 'p1' }),
            extrude('e1', 's1'),
            extrude('e3', 's3'),
        ];
        const made = addFolder(withPlane, undefined, { id: 'f', name: 'F', items: ['p1', 'e1'] });
        expect(show(made.order, made.folders)).toBe('F[p1 s1 e1] s3 e3');
    });

    it('moves steps into a folder, out of it, and folders into folders', () => {
        const folders: FeatureFolder[] = [{ id: 'f', name: 'F', items: ['s1', 'e1'] }];
        const order = ['a', 's1', 'e1', 's2', 'e2', 'z'];
        const base = features.filter((f) => order.includes(f.id)).sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
        const into = moveItems(base, folders, ['e2'], { into: 'f' });
        expect(show(into.order, into.folders)).toBe('a F[s1 e1 s2 e2] z');
        const out = moveItems(base, folders, ['e1'], { after: 'z' });
        expect(show(out.order, out.folders)).toBe('a F[] s2 e2 z s1 e1');
        const start = moveItems(base, folders, ['a'], { into: 'f', at: 'start' });
        expect(show(start.order, start.folders)).toBe('F[a s1 e1] s2 e2 z');
        const withG = addFolder(base, folders, { id: 'g', name: 'G', place: { after: 'z' } });
        const nested = moveItems(base, withG.folders, ['g'], { into: 'f' });
        expect(show(nested.order, nested.folders)).toBe('a F[s1 e1 G[]] s2 e2 z');
        expect(() => moveItems(base, nested.folders, ['f'], { into: 'g' })).toThrow(/itself/);
    });

    it('refuses a move that puts a step above what it builds on', () => {
        expect(() => moveItems(features, undefined, ['s2'], { after: 'z' })).toThrow(/A step can only use steps above it/);
        expect(() => moveItems(features, undefined, ['nope'], { after: 'z' })).toThrow(/No step or folder "nope"/);
    });

    it('removes a folder and keeps what it held in place, sub-folders included', () => {
        const folders: FeatureFolder[] = [
            { id: 'f', name: 'F', items: ['s1', 'g'] },
            { id: 'g', name: 'G', items: ['s2'] },
        ];
        const removed = removeFolders(features, folders, ['f']);
        expect(removed.order).toEqual(ids(features));
        expect(show(removed.order, removed.folders)).toBe('a s1 G[s2] e1 e2 z');
        expect(folderSteps(ids(features), folders, 'f')).toEqual(['s1', 's2']);
        expect(() => removeFolders(features, folders, ['s1'])).toThrow(/No folder/);
    });

    it('renames, names and numbers folders', () => {
        expect(renameFolder([{ id: 'f', name: 'F', items: [] }], 'f', ' Brackets ')).toEqual([{ id: 'f', name: 'Brackets', items: [] }]);
        expect(nextFolderName([{ id: 'x', name: 'Folder2', items: [] }, { id: 'y', name: 'Mine', items: [] }])).toBe('Folder3');
        expect(folderId('Folder1', [fillet('folder1')], undefined)).toBe('folder1-2');
    });
});

describe('steps and what they build on', () => {
    it('lists references and the steps a pattern repeats', () => {
        expect(stepDeps(extrude('e', 's'))).toEqual(['s']);
        expect(stepDeps({ id: 'p', op: 'pattern', kind: 'linear', features: ['e'], count: 2, direction: { axisRef: 'ax' }, spacing: 3 } as Feature).sort())
            .toEqual(['ax', 'e']);
        expect(orderProblem([extrude('e', 's'), sk('s')])).toMatch(/e uses s/);
        expect(orderProblem([sk('s'), extrude('e', 's')])).toBeNull();
    });

    it('takes along only the sketches nothing else uses', () => {
        const features = [sk('s'), sk('t'), extrude('e', 's'), extrude('f', 't'), extrude('g', 't')];
        expect(withAbsorbed(features, ['e'])).toEqual(['e', 's']);
        expect(withAbsorbed(features, ['f'])).toEqual(['f']);
        expect(withAbsorbed(features, ['f', 'g']).sort()).toEqual(['f', 'g', 't']);
    });
});
