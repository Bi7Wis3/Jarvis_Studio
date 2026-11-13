import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import { ProjectStore } from './store.js';
import { createTools, sceneDigest, type StudioTool } from './tools.js';

const steel = { color: '#c9d1d9', metalness: 1, roughness: 0.3 };

function box(name: string, y = 0) {
    return { name, shape: { kind: 'box', size: [10, 10, 10] }, position: [0, y, 0], material: steel };
}

let store: ProjectStore;
let tools: StudioTool[];

function tool(name: string): StudioTool {
    const found = tools.find((t) => t.name === name);
    if (!found) {
        throw new Error(`no tool ${name}`);
    }
    return found;
}

function run(name: string, args: unknown = {}): string {
    return tool(name).run(args);
}

function emptyProject(): void {
    // A fresh name would otherwise get a number, since project_new never overwrites a saved project.
    store.remove('scratch');
    run('project_new', { name: 'Scratch' });
}

beforeEach(() => {
    store = new ProjectStore();
    tools = createTools(store);
    emptyProject();
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('parts_add', () => {
    it('assigns distinct ids to parts with the same name', () => {
        const result = run('parts_add', { parts: [box('Bolt'), box('Bolt'), box('Bolt')] });
        expect(store.get().parts.map((p) => p.id)).toEqual(['bolt', 'bolt-2', 'bolt-3']);
        expect(result).toBe('Added 3 part(s): bolt, bolt-2, bolt-3.');
    });

    it('avoids ids already in the project across calls', () => {
        run('parts_add', { parts: [box('Bolt')] });
        run('parts_add', { parts: [box('Bolt')] });
        expect(store.get().parts.map((p) => p.id)).toEqual(['bolt', 'bolt-2']);
    });

    it('defaults rotation to [0, 0, 0] and keeps a given rotation', () => {
        run('parts_add', { parts: [box('A'), { ...box('B'), rotation: [90, 0, 45] }] });
        const [a, b] = store.get().parts;
        expect(a.rotation).toEqual([0, 0, 0]);
        expect(b.rotation).toEqual([90, 0, 45]);
    });

    it('is undoable', () => {
        run('parts_add', { parts: [box('A')] });
        run('undo');
        expect(store.get().parts).toEqual([]);
    });
});

describe('parts_update', () => {
    it('merges material fields instead of replacing the material', () => {
        run('parts_add', { parts: [box('A')] });
        expect(run('parts_update', { updates: [{ id: 'a', material: { color: '#ff0000' } }] })).toBe('Updated.');
        expect(store.get().parts[0].material).toEqual({ ...steel, color: '#ff0000' });
    });

    it('replaces only the fields given', () => {
        run('parts_add', { parts: [box('A', 5)] });
        run('parts_update', { updates: [{ id: 'a', position: [1, 2, 3] }] });
        const part = store.get().parts[0];
        expect(part.position).toEqual([1, 2, 3]);
        expect(part.name).toBe('A');
        expect(part.shape).toEqual({ kind: 'box', size: [10, 10, 10] });
    });

    it('reports unknown ids and still applies the valid updates', () => {
        run('parts_add', { parts: [box('A')] });
        const result = run('parts_update', {
            updates: [{ id: 'ghost', name: 'X' }, { id: 'a', name: 'Renamed' }, { id: 'phantom', name: 'Y' }],
        });
        expect(result).toBe('Updated, but these ids do not exist: ghost, phantom.');
        expect(store.get().parts[0].name).toBe('Renamed');
    });
});

describe('parts_remove', () => {
    it('removes the listed parts and reports how many', () => {
        run('parts_add', { parts: [box('A'), box('B'), box('C')] });
        expect(run('parts_remove', { ids: ['a', 'c', 'nope'] })).toBe('Removed 2 part(s).');
        expect(store.get().parts.map((p) => p.id)).toEqual(['b']);
    });

    it('clears view.focus when the focused part is removed', () => {
        run('parts_add', { parts: [box('A'), box('B')] });
        run('view_set', { focus: 'a' });
        run('parts_remove', { ids: ['a'] });
        expect(store.get().view.focus).toBeNull();
    });

    it('keeps view.focus when a different part is removed', () => {
        run('parts_add', { parts: [box('A'), box('B')] });
        run('view_set', { focus: 'a' });
        run('parts_remove', { ids: ['b'] });
        expect(store.get().view.focus).toBe('a');
    });
});

describe('assembly_explode', () => {
    it('sets factor, spacing and labels', () => {
        run('parts_add', { parts: [box('A', 0), box('B', 20)] });
        const result = run('assembly_explode', { factor: 1, spacing: 25, labels: true });
        const view = store.get().view;
        expect([view.explode, view.explodeSpacing, view.labels]).toEqual([1, 25, true]);
        expect(result).toContain('Exploded to 1.');
        expect(result).toContain('"b":[0,25,0]');
    });

    it('leaves spacing and labels alone when they are omitted', () => {
        run('assembly_explode', { factor: 0.5, spacing: 12, labels: true });
        run('assembly_explode', { factor: 0.2 });
        const view = store.get().view;
        expect([view.explode, view.explodeSpacing, view.labels]).toEqual([0.2, 12, true]);
    });

    it('reports Assembled. for factor 0', () => {
        expect(run('assembly_explode', { factor: 0 })).toBe('Assembled.');
    });

    it('is not undoable: undo reverts the previous model change instead', () => {
        run('parts_add', { parts: [box('A')] });
        run('assembly_explode', { factor: 1 });
        expect(run('undo')).toBe('Undone.');
        expect(store.get().parts).toEqual([]);
    });

    it('keeps the explode factor when a model change is undone afterwards', () => {
        run('parts_add', { parts: [box('A')] });
        run('assembly_explode', { factor: 1 });
        run('undo');
        expect(store.get().view.explode).toBe(1);
    });
});

describe('view_set', () => {
    it('rejects a focus id that does not exist and changes nothing', () => {
        const before = JSON.stringify(store.get());
        expect(run('view_set', { focus: 'ghost', labels: true })).toBe('No part with id "ghost".');
        expect(JSON.stringify(store.get())).toBe(before);
    });

    it('changes only the fields given', () => {
        run('parts_add', { parts: [box('A')] });
        run('view_set', { labels: true, azimuth: 90 });
        run('view_set', { focus: 'a' });
        const view = store.get().view;
        expect(view).toMatchObject({ labels: true, azimuth: 90, focus: 'a', explode: 0, elevation: null });
    });

    it('clears focus with null', () => {
        run('parts_add', { parts: [box('A')] });
        run('view_set', { focus: 'a' });
        run('view_set', { focus: null });
        expect(store.get().view.focus).toBeNull();
    });
});

describe('undo and redo', () => {
    it('report when there is nothing to undo or redo', () => {
        expect(run('undo')).toBe('Nothing to undo.');
        expect(run('redo')).toBe('Nothing to redo.');
    });

    it('step back and forward through model changes', () => {
        run('parts_add', { parts: [box('A')] });
        expect(run('undo')).toBe('Undone.');
        expect(store.get().parts).toHaveLength(0);
        expect(run('redo')).toBe('Redone.');
        expect(store.get().parts).toHaveLength(1);
    });
});

describe('projects', () => {
    it('project_new then project_get returns an empty parts list', () => {
        run('parts_add', { parts: [box('A')] });
        run('project_new', { name: 'Brand New' });
        const got = JSON.parse(run('project_get'));
        expect(got.name).toBe('Brand New');
        expect(got.parts).toEqual([]);
    });

    it('project_open reports unknown names and opens saved ones', () => {
        expect(run('project_open', { name: 'nothing here' })).toBe('No project named "nothing here".');
        run('project_new', { name: 'Second' });
        expect(run('project_open', { name: 'Scratch' })).toBe('Opened "Scratch".');
    });

    it('project_list includes saved project slugs', () => {
        run('project_new', { name: 'Listed Project' });
        expect(JSON.parse(run('project_list'))).toContain('listed-project');
    });
});

describe('sceneDigest', () => {
    it('lists parts, explode, labels and focus', () => {
        run('parts_add', { parts: [box('A')] });
        run('view_set', { focus: 'a', labels: true });
        expect(sceneDigest(store.get())).toBe('project "Scratch"; parts: a (A); explode=0; labels=on; focus=a');
    });

    it('says none for an empty project', () => {
        expect(sceneDigest(store.get())).toBe('project "Scratch"; parts: none; explode=0; labels=off; focus=none');
    });
});

describe('tool schemas', () => {
    function parse(name: string, args: unknown) {
        return z.object(tool(name).schema).safeParse(args);
    }

    it('accepts a realistic parts_add call with every shape kind', () => {
        const shapes = [
            { kind: 'box', size: [10, 20, 30], radius: 1 },
            { kind: 'cylinder', radius: 5, radiusTop: 3, height: 10 },
            { kind: 'tube', outerRadius: 5, innerRadius: 4, height: 10 },
            { kind: 'sphere', radius: 5 },
            { kind: 'torus', radius: 10, tube: 1 },
            { kind: 'cone', radius: 5, height: 10 },
            { kind: 'capsule', radius: 5, length: 10 },
            { kind: 'lathe', profile: [[0, 0], [5, 2], [3, 8]] },
        ];
        const parts = shapes.map((shape, i) => ({
            name: `Part ${i}`,
            description: 'A part',
            shape,
            position: [0, i * 10, 0],
            rotation: [0, 90, 0],
            material: { ...steel, emissive: '#00ff00', emissiveIntensity: 2, opacity: 0.5 },
            explodeOffset: [0, 5, 0],
            labelSide: 'left',
        }));
        expect(parse('parts_add', { parts }).success).toBe(true);
    });

    it('rejects an invalid shape kind for parts_add', () => {
        const bad = { ...box('A'), shape: { kind: 'pyramid', size: [1, 1, 1] } };
        expect(parse('parts_add', { parts: [bad] }).success).toBe(false);
    });

    it('rejects an empty parts list and out-of-range material values for parts_add', () => {
        expect(parse('parts_add', { parts: [] }).success).toBe(false);
        const bad = { ...box('A'), material: { ...steel, metalness: 2 } };
        expect(parse('parts_add', { parts: [bad] }).success).toBe(false);
    });

    it('accepts a partial update for parts_update', () => {
        const args = { updates: [{ id: 'a', position: [1, 2, 3], material: { color: '#fff' } }] };
        expect(parse('parts_update', args).success).toBe(true);
        expect(parse('parts_update', { updates: [{ name: 'no id' }] }).success).toBe(false);
    });

    it('accepts realistic arguments for the remaining tools', () => {
        expect(parse('parts_remove', { ids: ['a', 'b'] }).success).toBe(true);
        expect(parse('assembly_explode', { factor: 0.5, spacing: 20, labels: true }).success).toBe(true);
        expect(parse('assembly_explode', { factor: 1.5 }).success).toBe(false);
        expect(parse('assembly_explode', { factor: 1, spacing: 0 }).success).toBe(false);
        expect(parse('view_set', { labels: true, focus: null, autoRotate: true, azimuth: 45, elevation: 20 })
            .success).toBe(true);
        expect(parse('project_new', { name: 'X' }).success).toBe(true);
        expect(parse('project_open', { name: 'X' }).success).toBe(true);
        expect(parse('project_new', {}).success).toBe(false);
        for (const name of ['project_get', 'project_list', 'undo', 'redo']) {
            expect(parse(name, {}).success).toBe(true);
        }
    });
});

describe('feature history', () => {
    const addBody = () => run('parts_add', {
        parts: [{
            name: 'Body',
            shape: { kind: 'box', size: [60, 20, 40] },
            position: [0, 10, 0],
            material: { color: '#333333', metalness: 0, roughness: 0.6 },
            features: [{ op: 'shell', thickness: 2, open: ['top'], name: 'Hollow' }],
        }],
    });

    it('assigns feature ids from names and ops, unique within the part', () => {
        addBody();
        expect(run('features_add', {
            partId: 'body',
            features: [
                { op: 'fillet', radius: 2, edges: 'vertical' },
                { op: 'fillet', radius: 1, edges: 'top' },
                { op: 'hole', spec: { kind: 'counterbore', size: 'M3' }, position: [25, 0, 15] },
            ],
        })).toBe('Added 3 feature(s) to body: fillet, fillet-2, hole.');
        expect(store.get().parts[0].features?.map((f) => f.id)).toEqual(['hollow', 'fillet', 'fillet-2', 'hole']);
    });

    it('inserts before a given feature', () => {
        addBody();
        run('features_add', { partId: 'body', features: [{ op: 'fillet', radius: 2 }], before: 'hollow' });
        expect(store.get().parts[0].features?.map((f) => f.id)).toEqual(['fillet', 'hollow']);
    });

    it('inserts new features at the rollback bar and moves the bar below them', () => {
        addBody();
        run('features_add', { partId: 'body', features: [{ op: 'fillet', radius: 1 }, { op: 'fillet', radius: 2 }] });
        store.mutate((d) => {
            d.view.rollback = { partId: 'body', count: 1 };
        });
        run('features_add', { partId: 'body', features: [{ op: 'chamfer', size: 1 }] });
        expect(store.get().parts[0].features?.map((f) => f.id)).toEqual(['hollow', 'chamfer', 'fillet', 'fillet-2']);
        expect(store.get().view.rollback).toEqual({ partId: 'body', count: 2 });
        // An explicit `before` above the bar keeps the same steps built.
        run('features_add', { partId: 'body', features: [{ op: 'fillet', radius: 3, name: 'First' }], before: 'hollow' });
        expect(store.get().view.rollback).toEqual({ partId: 'body', count: 3 });
        // Removing a built step takes the bar up with it.
        run('features_remove', { partId: 'body', ids: ['first'] });
        expect(store.get().view.rollback).toEqual({ partId: 'body', count: 2 });
    });

    it('refuses a pattern without its direction or axis, or skipping the seed', () => {
        addBody();
        const add = (pattern: Record<string, unknown>) => () => run('features_add', {
            partId: 'body', features: [{ op: 'pattern', features: ['hollow'], count: 3, ...pattern }],
        });
        expect(add({ kind: 'linear', spacing: 5 })).toThrow(/needs a direction/);
        expect(add({ kind: 'circular' })).toThrow(/needs an axis/);
        expect(add({ kind: 'circular', axis: 'y', equal: false })).toThrow(/angle between instances/);
        expect(add({ kind: 'linear', direction: 'x', spacing: 5, skip: [[1, 1]] })).toThrow(/seed/);
        expect(add({ kind: 'linear', direction: 'x', spacing: 5, direction2: 'z' })).toThrow(/direction 2/);
        expect(add({ kind: 'linear', direction: 'x', spacing: 5, direction2: 'z', count2: 2, spacing2: 4, skip: [[2, 2]] })()).toContain('Added 1');
    });

    it('removes optional fields an update sets to null', () => {
        addBody();
        run('features_add', { partId: 'body', features: [{
            op: 'pattern', kind: 'linear', features: ['hollow'], direction: 'x', spacing: 5, count: 2, direction2: 'z', count2: 2, spacing2: 5,
        }] });
        run('features_update', { partId: 'body', updates: [{ id: 'pattern', direction2: null, count2: null, spacing2: null }] });
        const f = store.get().parts[0].features?.[1];
        expect(f).toMatchObject({ op: 'pattern', direction: 'x' });
        expect(f).not.toHaveProperty('direction2');
    });

    it('appends at the end when the part is not rolled back', () => {
        addBody();
        store.mutate((d) => {
            d.view.rollback = { partId: 'body', count: 1 };
        });
        run('features_add', { partId: 'body', features: [{ op: 'fillet', radius: 1 }] });
        expect(store.get().parts[0].features?.map((f) => f.id)).toEqual(['hollow', 'fillet']);
        expect(() => run('features_add', { partId: 'body', features: [{ op: 'fillet', radius: 1 }], before: 'nope' })).toThrow();
    });

    it('updates, suppresses and removes features by id', () => {
        addBody();
        expect(run('features_update', { partId: 'body', updates: [{ id: 'hollow', thickness: 3, suppressed: true }] }))
            .toBe('Updated.');
        expect(store.get().parts[0].features?.[0]).toMatchObject({ op: 'shell', thickness: 3, suppressed: true });
        expect(run('features_update', { partId: 'body', updates: [{ id: 'nope', radius: 1 }] }))
            .toContain('nope');
        expect(run('features_remove', { partId: 'body', ids: ['hollow'] })).toBe('Removed 1 feature(s).');
        expect(store.get().parts[0].features).toEqual([]);
    });

    it('removes optional fields set to null in an update', () => {
        addBody();
        run('features_add', { partId: 'body', features: [{ op: 'chamfer', size: 1, angle: 30, at: [[0, 20, 20]] }] });
        expect(run('features_update', { partId: 'body', updates: [{ id: 'chamfer', angle: null, at: [], distance2: 2 }] }))
            .toBe('Updated.');
        const chamfer = store.get().parts[0].features?.[1];
        expect(chamfer).toMatchObject({ op: 'chamfer', size: 1, at: [], distance2: 2 });
        expect(chamfer).not.toHaveProperty('angle');
    });

    it('rejects an update that breaks the feature', () => {
        addBody();
        expect(() => run('features_update', { partId: 'body', updates: [{ id: 'hollow', thickness: -1 }] })).toThrow();
        expect(store.get().parts[0].features?.[0]).toMatchObject({ thickness: 2 });
    });

    it('adds fasteners as ordinary parts, with no hardware flag', () => {
        run('parts_add', {
            parts: [{
                name: 'Lid screw',
                shape: { kind: 'fastener', type: 'socketCap', size: 'M3', length: 12 },
                position: [0, 0, 0],
                material: { color: '#222222', metalness: 0.9, roughness: 0.4 },
            }],
        });
        expect(store.get().parts[0].purchased).toBeUndefined();
    });

    it('lists the timeline and reads and writes print settings', () => {
        addBody();
        expect(run('history_get')).toBe('1. Body [body, box]\n2.   shell "Hollow" [body/hollow]');
        expect(JSON.parse(run('print_settings', { holeTolerance: 0.15 }))).toMatchObject({ holeTolerance: 0.15, nozzle: 0.4 });
        expect(store.get().print?.holeTolerance).toBe(0.15);
    });
});

describe('patterns', () => {
    it('removes a pattern with repeat: null', () => {
        run('parts_add', {
            parts: [{
                name: 'Foot',
                shape: { kind: 'cylinder', radius: 5, height: 3 },
                position: [0, 1.5, 0],
                material: { color: '#111111', metalness: 0, roughness: 0.9 },
                repeat: { kind: 'linear', count: 4, step: [20, 0, 0] },
            }],
        });
        expect(store.get().parts[0].repeat).toBeDefined();
        expect(run('parts_update', { updates: [{ id: 'foot', repeat: null }] })).toBe('Updated.');
        expect('repeat' in store.get().parts[0]).toBe(false);
    });
});

describe('features_reorder', () => {
    it('reorders and rejects incomplete lists', () => {
        run('parts_add', {
            parts: [{
                name: 'Plate',
                shape: { kind: 'box', size: [40, 4, 40] },
                position: [0, 2, 0],
                material: { color: '#333333', metalness: 0, roughness: 0.6 },
                features: [{ op: 'fillet', radius: 1, name: 'A' }, { op: 'chamfer', size: 1, name: 'B' }],
            }],
        });
        expect(run('features_reorder', { partId: 'plate', ids: ['b', 'a'] })).toBe('Reordered.');
        expect(store.get().parts[0].features?.map((f) => f.id)).toEqual(['b', 'a']);
        expect(() => run('features_reorder', { partId: 'plate', ids: ['a'] })).toThrow();
    });
});

describe('decals', () => {
    it('keeps decals given to parts_add, assigning ids', () => {
        run('parts_add', {
            parts: [{
                name: 'Deck',
                shape: { kind: 'box', size: [200, 6, 60] },
                position: [0, 3, 0],
                material: { color: '#e8d4b0', metalness: 0, roughness: 0.6 },
                decals: [
                    { image: 'a'.repeat(24) + '.png', position: [0, 3, 0], normal: [0, 1, 0], size: [100, 40] },
                    { id: 'logo', image: 'b'.repeat(24) + '.png', position: [50, 3, 0], normal: [0, 1, 0], size: [20, 20] },
                ],
            }],
        });
        expect(store.get().parts[0].decals?.map((d) => d.id)).toEqual(['decal-1', 'logo']);
        expect(run('decals_remove', { partId: 'deck', ids: ['logo'] })).toBe('Removed.');
        expect(store.get().parts[0].decals).toHaveLength(1);
    });
});

describe('constrained sketches', () => {
    it('keeps the sketcher geometry on a sketch step', () => {
        run('parts_add', {
            parts: [{
                name: 'Bracket',
                shape: { kind: 'empty' },
                position: [0, 0, 0],
                material: { color: '#333333', metalness: 0, roughness: 0.6 },
                features: [{
                    op: 'sketch',
                    name: 'Sketch 1',
                    sketch: {
                        plane: 'top',
                        profiles: [{ kind: 'rect', center: [0, 0], width: 60, height: 40 }],
                        geometry: {
                            points: [{ id: 'p1', u: -30, v: -20 }],
                            curves: [{ id: 'l1', kind: 'line', a: 'p1', b: 'p2' }],
                            constraints: [{ id: 'd1', kind: 'length', line: 'l1', value: 60 }],
                        },
                    },
                }],
            }],
        });
        const step = store.get().parts[0].features?.[0];
        expect(step?.op === 'sketch' && step.sketch.geometry?.constraints[0]).toMatchObject({ kind: 'length', value: 60 });
    });
});

describe('reference geometry and instances', () => {
    const body = (features: unknown[]) => run('parts_add', {
        parts: [{
            name: 'Body',
            shape: { kind: 'box', size: [40, 10, 40] },
            position: [0, 5, 0],
            material: { color: '#333333', metalness: 0, roughness: 0.6 },
            features,
        }],
    });

    it('accepts sketches on earlier plane steps and rejects forward references', () => {
        body([
            { op: 'plane', name: 'Top + 10', definition: { kind: 'offset', base: 'top', distance: 10 } },
            {
                op: 'extrude', mode: 'add', distance: 5,
                sketch: { plane: { planeRef: 'top-10' }, profiles: [{ kind: 'circle', center: [0, 0], radius: 5 }] },
            },
        ]);
        expect(store.get().parts[0].features?.map((f) => f.op)).toEqual(['plane', 'extrude']);
        expect(() => run('features_add', {
            partId: 'body',
            features: [{ op: 'split', plane: { planeRef: 'later' }, keep: 'positive' }],
        })).toThrow(/not an earlier plane step/);
    });

    it('checks sweep sources and pattern targets', () => {
        body([{ op: 'hole', name: 'Hole', spec: { kind: 'clearance', size: 'M3' }, position: [10, 5, 0] }]);
        expect(run('features_add', {
            partId: 'body',
            features: [{ op: 'pattern', features: ['hole'], kind: 'circular', axis: 'y', count: 6 }],
        })).toContain('Added 1');
        expect(() => run('features_add', {
            partId: 'body',
            features: [{ op: 'pattern', features: ['ghost'], kind: 'linear', direction: 'x', count: 2, spacing: 5 }],
        })).toThrow(/not an earlier step/);
        expect(run('features_add', {
            partId: 'body',
            features: [{
                op: 'sweep', mode: 'add',
                profile: { sketch: { plane: 'front', profiles: [{ kind: 'circle', center: [15, 0], radius: 1 }] } },
                path: { helix: { axis: 'y', pitch: 4, turns: 5 } },
            }],
        })).toContain('Added 1');
        const path = { sketch: { plane: 'front', profiles: [], open: [{ kind: 'path', start: [0, 0], segments: [{ kind: 'line', to: [0, 20] }] }] } };
        expect(run('features_add', { partId: 'body', features: [{ op: 'sweep', mode: 'add', diameter: 3, path }] })).toContain('Added 1');
        expect(() => run('features_add', { partId: 'body', features: [{ op: 'sweep', mode: 'add', path }] }))
            .toThrow(/give a profile or a diameter/);
    });

    it('clears optional fields an update sets to null', () => {
        body([{ op: 'thread', id: 't', kind: 'external', diameter: 8, pitch: 1.25, length: 10, position: [0, 0, 0] }]);
        run('features_update', { partId: 'body', updates: [{ id: 't', at: [4, 0, 0], position: null, length: null, revolutions: 6 }] });
        const f = store.get().parts[0].features?.find((x) => x.id === 't');
        expect(f).toMatchObject({ at: [4, 0, 0], revolutions: 6 });
        expect(f).not.toHaveProperty('position');
        expect(f).not.toHaveProperty('length');
    });

    it('accepts point steps in plane and axis definitions, and revolves about a sketch line or an axis step', () => {
        body([
            { op: 'point', name: 'Point1', position: [5, 0, 0] },
            { op: 'plane', name: 'Plane1', definition: { kind: 'parallel', base: 'top', point: { pointRef: 'point1' } } },
            { op: 'axis', name: 'Axis1', definition: { kind: 'pointPlane', point: { pointRef: 'point1' }, plane: 'front' } },
            { op: 'plane', name: 'Plane2', definition: { kind: 'normal', axis: { axisRef: 'axis1' } } },
            {
                op: 'revolve', name: 'Revolve1', mode: 'add', axis: { axisRef: 'axis1' }, type: 'midPlane', angle: 90,
                sketch: { plane: 'top', profiles: [{ kind: 'circle', center: [20, 0], radius: 2 }] },
            },
        ]);
        expect(store.get().parts[0].features?.map((f) => f.id)).toEqual(['point1', 'plane1', 'axis1', 'plane2', 'revolve1']);
        expect(() => run('features_add', {
            partId: 'body',
            features: [{ op: 'axis', definition: { kind: 'twoPoints', a: { pointRef: 'later' }, b: [0, 1, 0] } }],
        })).toThrow(/not an earlier point step/);
        // An edit back to 360 degrees, Blind, sticks: the fields given replace the stored ones.
        run('features_update', { partId: 'body', updates: [{ id: 'revolve1', angle: 360, type: 'blind', reverse: false, angle2: null, axis: { line: 'c' } }] });
        // A field sent as null is removed (features_update clears optional fields that way).
        expect(store.get().parts[0].features?.[4]).toMatchObject({ angle: 360, type: 'blind', axis: { line: 'c' } });
        expect(store.get().parts[0].features?.[4]).not.toHaveProperty('angle2');
    });

    it('places instances that share the source design', () => {
        body([]);
        expect(run('parts_instance', { partId: 'body', instances: [{ position: [50, 5, 0] }, { position: [100, 5, 0] }] }))
            .toBe('Placed 2 instance(s): body-2, body-3.');
        const copies = store.get().parts.filter((p) => p.instanceOf === 'body');
        expect(copies).toHaveLength(2);
        expect(() => run('features_add', { partId: 'body-2', features: [{ op: 'fillet', radius: 1 }] })).toThrow(/instance/);
        expect(() => run('parts_remove', { ids: ['body'] })).toThrow(/Still instanced/);
    });
});
