import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFolder, Part } from '@jarvis/core';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-folders-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import { ProjectStore } from './store.js';
import { createTools, type StudioTool } from './tools.js';

let store: ProjectStore;
let tools: StudioTool[];

function run(name: string, args: unknown = {}): string {
    const found = tools.find((t) => t.name === name);
    if (!found) {
        throw new Error(`no tool ${name}`);
    }
    return found.run(args);
}

const part = (): Part => store.get().parts.find((p) => p.id === 'plate')!;
const order = () => (part().features ?? []).map((f) => f.id);
const folders = (): FeatureFolder[] | undefined => part().folders;

beforeEach(() => {
    store = new ProjectStore();
    tools = createTools(store);
    store.remove('scratch');
    run('project_new', { name: 'Scratch' });
    run('parts_add', {
        parts: [{
            name: 'Plate',
            shape: { kind: 'box', size: [40, 4, 40] },
            position: [0, 2, 0],
            material: { color: '#333333', metalness: 0, roughness: 0.6 },
            features: [
                { op: 'fillet', radius: 1, name: 'A' },
                { op: 'sketch', name: 'S', sketch: { plane: 'top', profiles: [] } },
                { op: 'extrude', name: 'E', distance: 2, mode: 'add', sketchRef: 's' },
                { op: 'chamfer', size: 1, name: 'B' },
                { op: 'chamfer', size: 1, name: 'C' },
            ],
        }],
    });
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('folder tools', () => {
    it('adds a folder round a step and its sketch, and undo takes it away again', () => {
        expect(run('folders_add', { partId: 'plate', items: ['e'] })).toBe('Added folder "Folder1" (id folder1) to plate.');
        expect(folders()).toEqual([{ id: 'folder1', name: 'Folder1', items: ['s', 'e'] }]);
        expect(order()).toEqual(['a', 's', 'e', 'b', 'c']);
        expect(store.undo()).toBe(true);
        expect(folders()).toBeUndefined();
        expect(store.redo()).toBe(true);
        expect(folders()).toHaveLength(1);
    });

    it('refuses steps that do not follow one another, and an unknown part', () => {
        expect(() => run('folders_add', { partId: 'plate', items: ['a', 'b'] })).toThrow(/follow one another/);
        expect(() => run('folders_add', { partId: 'nope' })).toThrow(/No part/);
        expect(folders()).toBeUndefined();
    });

    it('moves steps into and out of folders and nests folders', () => {
        run('folders_add', { partId: 'plate', name: 'Edges', items: ['b'] });
        expect(run('features_move', { partId: 'plate', ids: ['c'], into: 'edges' })).toBe('Moved.');
        expect(folders()).toEqual([{ id: 'edges', name: 'Edges', items: ['b', 'c'] }]);
        // Moving a step out to the top of the tree changes the history order with it.
        run('features_move', { partId: 'plate', ids: ['b'], into: null, at: 'start' } as never);
        expect(order()).toEqual(['b', 'a', 's', 'e', 'c']);
        expect(folders()).toEqual([{ id: 'edges', name: 'Edges', items: ['c'] }]);
        run('folders_add', { partId: 'plate', name: 'Outer', after: 'edges' });
        run('features_move', { partId: 'plate', ids: ['edges'], into: 'outer' });
        expect(folders()).toEqual([{ id: 'outer', name: 'Outer', items: ['edges'] }, { id: 'edges', name: 'Edges', items: ['c'] }]);
        // A move that changes nothing is no undo step.
        const undoDepth = JSON.stringify(store.get());
        expect(run('features_move', { partId: 'plate', ids: ['edges'], into: 'outer' })).toBe('Nothing moved.');
        expect(JSON.stringify(store.get())).toBe(undoDepth);
    });

    it('refuses a move that puts a step above what it builds on, and a folder into itself', () => {
        expect(() => run('features_move', { partId: 'plate', ids: ['s'], after: 'c' })).toThrow(/A step can only use steps above it/);
        run('folders_add', { partId: 'plate', name: 'F', items: ['b'] });
        expect(() => run('features_move', { partId: 'plate', ids: ['f'], into: 'f' })).toThrow(/itself/);
    });

    it('renames, and removes a folder keeping its steps in place', () => {
        run('folders_add', { partId: 'plate', items: ['b', 'c'] });
        expect(run('folders_rename', { partId: 'plate', id: 'folder1', name: 'Chamfers' })).toBe('Renamed.');
        expect(folders()?.[0].name).toBe('Chamfers');
        run('folders_remove', { partId: 'plate', ids: ['folder1'] });
        expect(folders()).toBeUndefined();
        expect(order()).toEqual(['a', 's', 'e', 'b', 'c']);
    });
});

describe('folders and other history edits', () => {
    it('keeps an empty folder when its last step is deleted', () => {
        run('folders_add', { partId: 'plate', items: ['b'] });
        run('features_remove', { partId: 'plate', ids: ['b'] });
        expect(folders()).toEqual([{ id: 'folder1', name: 'Folder1', items: [], before: 'c' }]);
    });

    it('fits folders to a reorder: a step moved between two of a folder\'s steps joins it', () => {
        run('folders_add', { partId: 'plate', items: ['e', 'b'] });
        run('features_reorder', { partId: 'plate', ids: ['s', 'e', 'a', 'b', 'c'] });
        expect(folders()).toEqual([{ id: 'folder1', name: 'Folder1', items: ['s', 'e', 'a', 'b'] }]);
    });

    it('puts a step added at a rollback bar inside a folder into that folder', () => {
        run('folders_add', { partId: 'plate', items: ['b', 'c'] });
        store.mutate((draft) => {
            draft.view.rollback = { partId: 'plate', count: 4 };
        }, { undoable: false });
        run('features_add', { partId: 'plate', features: [{ op: 'fillet', radius: 2, name: 'New' }] });
        expect(order()).toEqual(['a', 's', 'e', 'b', 'new', 'c']);
        expect(folders()?.[0].items).toEqual(['b', 'new', 'c']);
        // Added at the end, below the folder: outside it.
        store.mutate((draft) => {
            draft.view.rollback = null;
        }, { undoable: false });
        run('features_add', { partId: 'plate', features: [{ op: 'fillet', radius: 2, name: 'Last' }] });
        expect(folders()?.[0].items).toEqual(['b', 'new', 'c']);
    });

    it('keeps folders on a copy of the part', () => {
        run('folders_add', { partId: 'plate', items: ['b'] });
        const { id: _id, ...copy } = part();
        run('parts_add', { parts: [{ ...copy, name: 'Copy' }] });
        expect(store.get().parts.find((p) => p.id === 'copy')?.folders).toEqual(folders());
    });

    it('repairs the folders of a project read from disk', () => {
        const saved = JSON.parse(JSON.stringify(store.get()));
        saved.name = 'Broken';
        saved.parts[0].folders = [
            { id: 'f', name: 'F', items: ['a', 'ghost', 'c'] },
            { id: 'g', name: 'G', items: 'junk' },
        ];
        writeFileSync(join(dir, 'broken.json'), JSON.stringify(saved));
        expect(store.open('Broken')).toBe(true);
        // a and c are not one run: two folders of the same name; the bad item list is dropped.
        expect(folders()).toEqual([
            { id: 'f', name: 'F', items: ['a'] },
            { id: 'f-2', name: 'F', items: ['c'] },
            { id: 'g', name: 'G', items: [] },
        ]);
    });
});
