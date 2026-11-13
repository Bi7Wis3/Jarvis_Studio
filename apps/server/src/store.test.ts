import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-store-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import { ProjectStore, slug } from './store.js';

function clearDir(): void {
    for (const f of readdirSync(dir)) {
        rmSync(join(dir, f), { recursive: true, force: true });
    }
}

function rename(store: ProjectStore, name: string): void {
    store.mutate((d) => {
        d.name = name;
    });
}

beforeEach(clearDir);

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('slug', () => {
    it('lowercases and joins words with dashes', () => {
        expect(slug('Desk Speaker')).toBe('desk-speaker');
    });

    it('collapses runs of symbols and trims dashes from the ends', () => {
        expect(slug('  --Hello,   World!!  ')).toBe('hello-world');
    });

    it('falls back to untitled when nothing usable remains', () => {
        expect(slug('')).toBe('untitled');
        expect(slug('***')).toBe('untitled');
    });
});

describe('ProjectStore', () => {
    it('keeps the temp directory in use for this file', () => {
        expect(dir.startsWith(tmpdir())).toBe(true);
        expect(existsSync(dir)).toBe(true);
    });

    it('starts with the demo project when the directory is empty', () => {
        const store = new ProjectStore();
        expect(store.get().name).toBe('Desk Speaker');
        expect(store.get().parts.length).toBeGreaterThan(0);
        expect(store.list()).toEqual(['desk-speaker']);
    });

    it('changes the project, notifies subscribers and persists to disk', () => {
        const store = new ProjectStore();
        const seen: string[] = [];
        store.subscribe((p) => seen.push(p.name));
        rename(store, 'Renamed');
        expect(store.get().name).toBe('Renamed');
        expect(seen).toEqual(['Renamed']);
        expect(JSON.parse(readFileSync(join(dir, 'renamed.json'), 'utf8')).name).toBe('Renamed');
        expect(new ProjectStore().get()).toEqual(store.get());
    });

    it('stops notifying after unsubscribe', () => {
        const store = new ProjectStore();
        const seen: string[] = [];
        const off = store.subscribe((p) => seen.push(p.name));
        off();
        rename(store, 'Quiet');
        expect(seen).toEqual([]);
    });

    it('does not mutate the previous project object', () => {
        const store = new ProjectStore();
        const before = store.get();
        const count = before.parts.length;
        store.mutate((d) => {
            d.parts = [];
        });
        expect(before.parts.length).toBe(count);
    });

    it('undoes and redoes model changes', () => {
        const store = new ProjectStore();
        const original = store.get().parts.length;
        store.mutate((d) => {
            d.parts = [];
        });
        expect(store.get().parts).toHaveLength(0);
        expect(store.undo()).toBe(true);
        expect(store.get().parts).toHaveLength(original);
        expect(store.redo()).toBe(true);
        expect(store.get().parts).toHaveLength(0);
    });

    it('returns false when there is nothing to undo or redo', () => {
        const store = new ProjectStore();
        expect(store.undo()).toBe(false);
        expect(store.redo()).toBe(false);
    });

    it('does not undo a mutation marked undoable: false', () => {
        const store = new ProjectStore();
        store.mutate((d) => {
            d.view.labels = true;
        }, { undoable: false });
        expect(store.undo()).toBe(false);
        expect(store.get().view.labels).toBe(true);
    });

    it('keeps earlier undo history when a non-undoable mutation happens in between', () => {
        const store = new ProjectStore();
        const original = store.get().parts.length;
        store.mutate((d) => {
            d.parts = [];
        });
        store.mutate((d) => {
            d.view.labels = true;
        }, { undoable: false });
        expect(store.undo()).toBe(true);
        expect(store.get().parts).toHaveLength(original);
    });

    it('clears the redo stack on a new mutation', () => {
        const store = new ProjectStore();
        rename(store, 'One');
        store.undo();
        rename(store, 'Two');
        expect(store.redo()).toBe(false);
        expect(store.get().name).toBe('Two');
    });

    it('does not clear the redo stack on a non-undoable mutation', () => {
        const store = new ProjectStore();
        rename(store, 'One');
        store.undo();
        store.mutate((d) => {
            d.view.labels = true;
        }, { undoable: false });
        expect(store.redo()).toBe(true);
    });

    it('creates an empty project and resets history', () => {
        const store = new ProjectStore();
        rename(store, 'Before');
        store.create('Fresh Start');
        expect(store.get().name).toBe('Fresh Start');
        expect(store.get().parts).toEqual([]);
        expect(store.undo()).toBe(false);
        expect(existsSync(join(dir, 'fresh-start.json'))).toBe(true);
    });

    it('opens a saved project by name and resets history', () => {
        const store = new ProjectStore();
        store.create('Other');
        expect(store.open('Desk Speaker')).toBe(true);
        expect(store.get().name).toBe('Desk Speaker');
        expect(store.undo()).toBe(false);
    });

    it('returns false and keeps the current project when opening an unknown name', () => {
        const store = new ProjectStore();
        expect(store.open('does not exist')).toBe(false);
        expect(store.get().name).toBe('Desk Speaker');
    });

    it('fills in missing view fields when opening an older file', () => {
        const store = new ProjectStore();
        writeFileSync(join(dir, 'old.json'), JSON.stringify({ name: 'Old', parts: [], view: { explode: 0.5 } }));
        expect(store.open('old')).toBe(true);
        expect(store.get().view).toMatchObject({ explode: 0.5, labels: false, focus: null, autoRotate: false });
    });

    it('lists saved project slugs and ignores other files', () => {
        const store = new ProjectStore();
        store.create('Alpha One');
        store.create('Beta');
        expect(store.list().sort()).toEqual(['alpha-one', 'beta', 'desk-speaker']);
    });

    it('numbers a new project instead of overwriting a saved one with the same name', () => {
        const store = new ProjectStore();
        store.create('Lamp');
        rename(store, 'Lamp');
        store.create('Lamp');
        expect(store.get().name).toBe('Lamp 2');
        expect(store.list().sort()).toEqual(['desk-speaker', 'lamp', 'lamp-2']);
    });

    it('moves a deleted project to the trash and opens another', () => {
        const store = new ProjectStore();
        store.create('Doomed');
        expect(store.remove('doomed')).toBe(true);
        expect(store.list()).toEqual(['desk-speaker']);
        expect(store.get().name).toBe('Desk Speaker');
        expect(readdirSync(join(dir, '.trash')).some((f) => f.startsWith('doomed-'))).toBe(true);
        expect(store.remove('doomed')).toBe(false);
    });

    it('starts an empty project when the last one is deleted', () => {
        const store = new ProjectStore();
        expect(store.remove('desk-speaker')).toBe(true);
        expect(store.get().name).toBe('Untitled');
        expect(store.list()).toEqual(['untitled']);
    });

    it('reopens the last project after a restart', () => {
        const store = new ProjectStore();
        store.create('Last One');
        expect(new ProjectStore().get().name).toBe('Last One');
    });

    it('limits the undo history to 100 steps', () => {
        const store = new ProjectStore();
        for (let i = 0; i < 105; i++) {
            store.mutate((d) => {
                d.view.explode = i;
            });
        }
        let undone = 0;
        while (store.undo()) {
            undone++;
        }
        expect(undone).toBe(100);
    });
});

describe('rename and save as', () => {
    it('renames the open project and its file', () => {
        const store = new ProjectStore();
        store.create('Old Name');
        expect(store.rename('New Name')).toBe(true);
        expect(store.get().name).toBe('New Name');
        expect(store.list()).toContain('new-name');
        expect(store.list()).not.toContain('old-name');
    });

    it('refuses a name another project has', () => {
        const store = new ProjectStore();
        store.create('Mine');
        expect(store.rename('Desk Speaker')).toBe(false);
        expect(store.get().name).toBe('Mine');
    });

    it('saves a copy under a new name and opens it', () => {
        const store = new ProjectStore();
        const parts = store.get().parts.length;
        store.saveAs('Speaker v2');
        expect(store.get().name).toBe('Speaker v2');
        expect(store.get().parts).toHaveLength(parts);
        expect(store.list().sort()).toEqual(['desk-speaker', 'speaker-v2']);
    });
});
