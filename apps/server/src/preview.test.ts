import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-preview-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import { DEFAULT_PRINT, type Feature, type Part, type Project } from '@jarvis/core';
import { CadKernel } from './cad/kernel.js';
import { MeshService } from './meshes.js';
import { PreviewRejected, quickThreads, runPreview } from './preview.js';
import { ProjectStore, slug } from './store.js';
import { createTools } from './tools.js';

const SLOW = 120_000;

let kernel: CadKernel;
let meshes: MeshService;
let published = 0;
let store: ProjectStore;

beforeAll(() => {
    kernel = CadKernel.start();
    meshes = new MeshService(kernel, () => {
        published++;
    });
    store = new ProjectStore();
    const tools = createTools(store);
    const run = (name: string, args: unknown) => tools.find((t) => t.name === name)!.run(args);
    run('project_new', { name: 'Preview' });
    run('parts_add', { parts: [{ name: 'Block', shape: { kind: 'box', size: [20, 10, 20] }, position: [0, 5, 0],
        material: { color: '#9aa3b5', metalness: 0, roughness: 0.6 } }] });
});

afterAll(async () => {
    await kernel.close();
    rmSync(dir, { recursive: true, force: true });
});

function file(): string {
    return readFileSync(join(dir, `${slug(store.get().name)}.json`), 'utf8');
}

describe('runPreview', () => {
    it('previews a fillet on a copy: new mesh key, real store, file and undo untouched, nothing published', { timeout: SLOW }, async () => {
        meshes.update(store.get());
        await meshes.ready(store.get());
        await new Promise((resolve) => setTimeout(resolve, 0));
        const committed = meshes.current().keys.block;
        expect(committed).toBeTruthy();
        const before = JSON.stringify(store.get());
        const saved = file();
        const publishedBefore = published;

        const result = await runPreview(store.get(), [{ name: 'features_add', args: {
            partId: 'block', features: [{ op: 'fillet', name: 'Fillet1', radius: 2, edges: 'vertical' }],
        } }], meshes);

        expect(result.error).toBeUndefined();
        expect(result.errors).toEqual({});
        expect(result.parts.map((p) => p.id)).toEqual(['block']);
        expect(result.parts[0].features?.[0]).toMatchObject({ op: 'fillet', radius: 2 });
        const key = result.keys.block;
        expect(key).toBeTruthy();
        expect(key).not.toBe(committed);
        const mesh = meshes.get(key)!;
        expect(mesh).toBeTruthy();
        expect(mesh.equals(meshes.get(committed!)!)).toBe(false);

        expect(JSON.stringify(store.get())).toBe(before);
        expect(file()).toBe(saved);
        expect(store.undo()).toBe(true); // the parts_add from setup, not the preview
        expect(store.get().parts).toEqual([]);
        expect(store.redo()).toBe(true);
        expect(published).toBe(publishedBefore);
        expect(meshes.current().keys.block).toBe(committed);
    });

    it('lists a part whose only change is not geometric, without a new build', async () => {
        const result = await runPreview(store.get(), [{ name: 'parts_update', args: {
            updates: [{ id: 'block', repeat: { kind: 'linear', count: 5, step: [25, 0, 0] } }],
        } }], meshes);
        expect(result.parts[0].repeat).toMatchObject({ count: 5 });
        expect(result.keys.block).toBe(meshes.current().keys.block);
        expect(store.get().parts[0].repeat).toBeUndefined();
    });

    it('rejects tools that are not model edits', async () => {
        for (const name of ['export_stl', 'project_open', 'undo', 'view_set', 'parts_remove', 'nope']) {
            await expect(runPreview(store.get(), [{ name, args: {} }], meshes)).rejects.toBeInstanceOf(PreviewRejected);
        }
        await expect(runPreview(store.get(), 'parts_add', meshes)).rejects.toBeInstanceOf(PreviewRejected);
    });

    it('previews a thread at once and says when it is cut to the length of its hole', { timeout: SLOW }, async () => {
        const started = Date.now();
        const result = await runPreview(store.get(), [{ name: 'features_add', args: {
            partId: 'block', features: [
                { op: 'hole', name: 'Hole1', spec: { kind: 'plain', diameter: 5 }, position: [0, 5, 0], direction: [0, -1, 0] },
                { op: 'thread', name: 'Thread1', kind: 'internal', at: [2.6, 5, 0], pitch: 0.8, length: 30 },
            ],
        } }], meshes);
        expect(result.errors).toEqual({});
        expect(result.notes?.block?.join(' ')).toMatch(/Thread1: cut to the length of the hole: 10 mm \(30 mm asked\)/);
        expect(Date.now() - started).toBeLessThan(60_000);
        // The previewed part is the step as saved: the quick look is only how it is built.
        expect(result.parts[0].features?.find((f) => f.op === 'thread')).not.toHaveProperty('preview');
    });

    it('reports a call that fails validation as an error, without throwing', async () => {
        const invalid = await runPreview(store.get(), [{ name: 'features_add', args: { partId: 'block', features: [{ op: 'fillet' }] } }], meshes);
        expect(invalid.error).toMatch(/features/);
        expect(invalid.parts).toEqual([]);
        const thrown = await runPreview(store.get(), [{ name: 'parts_instance', args: { partId: 'missing', instances: [{ position: [0, 0, 0] }] } }], meshes);
        expect(thrown.error).toMatch(/No part with id "missing"/);
    });
});

/** A mesh as served by /api/mesh2/:key: positions, triangles and their B-rep face ordinals. */
function served(key: string): { positions: Float32Array; indices: Uint32Array; edges: Float32Array; triFace: Uint32Array } {
    const buffer = meshes.get(key)!;
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const [p, i, e] = new Uint32Array(bytes, 0, 3);
    return {
        positions: new Float32Array(bytes, 12, p),
        indices: new Uint32Array(bytes, 12 + p * 8, i),
        edges: new Float32Array(bytes, 12 + p * 8 + i * 4, e),
        triFace: new Uint32Array(bytes, 12 + p * 8 + i * 4 + e * 4, i / 3),
    };
}

function boundsOf(mesh: { positions: Float32Array }): { min: number[]; max: number[] } {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], mesh.positions[i + k]);
            max[k] = Math.max(max[k], mesh.positions[i + k]);
        }
    }
    return { min, max };
}

/** Enclosed volume of a closed triangle mesh (divergence theorem). */
function volumeOf(mesh: { positions: Float32Array; indices: Uint32Array }): number {
    const p = mesh.positions;
    let v = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
        v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
            + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return Math.abs(v / 6);
}

const faceCount = (mesh: { triFace: Uint32Array }): number => new Set(mesh.triFace).size;

describe('runPreview highlights only what the steps do', () => {
    const square = { kind: 'rect', center: [0, 0], width: 6, height: 6 };
    const add = (features: unknown[]) => [{ name: 'features_add', args: { partId: 'block', features } }];
    const changeOf = async (calls: { name: string; args: Record<string, unknown> }[], project: Project = store.get()) => {
        const result = await runPreview(project, calls, meshes);
        expect(result.error).toBeUndefined();
        expect(result.errors).toEqual({});
        const key = result.changes.block;
        expect(key).toMatch(/^[a-f0-9]{24}$/); // served by /api/mesh2 like any mesh
        expect(key).not.toBe(result.keys.block);
        return served(key!);
    };

    it('a boss: the volume it adds, above the block', { timeout: SLOW }, async () => {
        const change = await changeOf(add([{ op: 'extrude', mode: 'add', distance: 4, sketch: { plane: 'top', offset: 5, profiles: [square] } }]));
        expect(volumeOf(change)).toBeCloseTo(6 * 6 * 4, 3);
        const { min, max } = boundsOf(change);
        expect(min[1]).toBeCloseTo(5, 4);
        expect(max[1]).toBeCloseTo(9, 4);
    });

    it('a cut: the volume it removes, where it is inside the block', { timeout: SLOW }, async () => {
        const change = await changeOf(add([{ op: 'extrude', mode: 'cut', distance: 3, direction: 'reverse', sketch: { plane: 'top', offset: 5, profiles: [square] } }]));
        expect(volumeOf(change)).toBeCloseTo(6 * 6 * 3, 3);
        const { min, max } = boundsOf(change);
        expect([min[1], max[1]]).toEqual([expect.closeTo(2, 4), expect.closeTo(5, 4)]);
        // A cut deeper than the block removes only the block's material.
        const through = await changeOf(add([{ op: 'extrude', mode: 'cut', distance: 50, direction: 'reverse', sketch: { plane: 'top', offset: 5, profiles: [square] } }]));
        expect(volumeOf(through)).toBeCloseTo(6 * 6 * 10, 3);
    });

    it('a hole: the drilled material', { timeout: SLOW }, async () => {
        const change = await changeOf(add([{ op: 'hole', spec: { kind: 'plain', diameter: 5 }, position: [0, 5, 0] }]));
        // Drilled to the print's hole tolerance, through the 10 mm block.
        const r = (5 + DEFAULT_PRINT.holeTolerance) / 2;
        expect(boundsOf(change).max[0]).toBeCloseTo(r, 2);
        expect(volumeOf(change) / (Math.PI * r * r * 10)).toBeCloseTo(1, 2);
    });

    it('a fillet or chamfer: only the faces it makes, not the faces it trims', { timeout: SLOW }, async () => {
        const fillet = await changeOf(add([{ op: 'fillet', radius: 2, edges: 'vertical' }]));
        expect(faceCount(fillet)).toBe(4);
        for (let i = 0; i < fillet.positions.length; i += 3) {
            // Every point of the round faces lies in a corner, 2 mm from both sides.
            expect(Math.min(Math.abs(fillet.positions[i]), Math.abs(fillet.positions[i + 2]))).toBeGreaterThan(8 - 1e-4);
        }
        const chamfer = await changeOf(add([{ op: 'chamfer', size: 1, edges: 'top' }]));
        expect(faceCount(chamfer)).toBe(4);
        expect(boundsOf(chamfer).min[1]).toBeCloseTo(4, 4);
    });

    it('a shell: the inside walls it makes, not the outside of the block', { timeout: SLOW }, async () => {
        const change = await changeOf(add([{ op: 'shell', thickness: 1, open: ['top'] }]));
        expect(boundsOf(change).min[1]).toBeCloseTo(-4, 4);
        expect(faceCount(change)).toBeGreaterThanOrEqual(5);
    });

    it('a thread: its ridges in the hole', { timeout: SLOW }, async () => {
        const change = await changeOf(add([
            { op: 'hole', name: 'Hole1', spec: { kind: 'plain', diameter: 5 }, position: [0, 5, 0], direction: [0, -1, 0] },
            { op: 'thread', name: 'Thread1', kind: 'internal', at: [2.6, 5, 0], pitch: 0.8, length: 6 },
        ]));
        const { min, max } = boundsOf(change);
        // The hole's material and the ridges inside it, nothing of the block outside.
        expect(max[0]).toBeLessThan(3.5);
        expect(min[1]).toBeGreaterThan(-5 - 1e-4);
        expect(volumeOf(change)).toBeGreaterThan(0);
    });

    it('a thread hidden in the view (cosmetic): its marks, as lines', { timeout: SLOW }, async () => {
        const block = store.get().parts[0];
        const steps = [
            { id: 'h', name: 'Hole1', op: 'hole', spec: { kind: 'plain', diameter: 5 }, position: [0, 5, 0], direction: [0, -1, 0] },
            { id: 't', name: 'Thread1', op: 'thread', kind: 'internal', at: [2.6, 5, 0], pitch: 0.8, length: 6 },
        ] as Feature[];
        const project: Project = { ...store.get(), parts: [{ ...block, features: steps }], view: { ...store.get().view, hiddenSketches: ['block/t'] } };
        const change = await changeOf([{ name: 'features_update', args: { partId: 'block', updates: [{ id: 't', length: 8 }] } }], project);
        // No ridges: only the marks of where it runs.
        expect(change.indices.length).toBe(0);
        expect(change.edges.length).toBeGreaterThan(0);
    });

    it('editing a step in the middle shows that step, not the steps after it', { timeout: SLOW }, async () => {
        const block = store.get().parts[0];
        const boss = { id: 'boss', name: 'Boss', op: 'extrude', mode: 'add', distance: 4, sketch: { plane: 'top', offset: 5, profiles: [square] } };
        const project: Project = { ...store.get(), parts: [{ ...block, features: [boss, { id: 'f', op: 'fillet', radius: 1, edges: 'vertical' }] as Feature[] }] };
        const change = await changeOf([{ name: 'features_update', args: { partId: 'block', updates: [{ id: 'boss', distance: 8 }] } }], project);
        // The whole boss at its new height (before the fillet rounds it), not the block it stands on.
        expect(volumeOf(change)).toBeCloseTo(6 * 6 * 8, 3);
    });

    it('editing a sketch shows what the extrude made from it now makes', { timeout: SLOW }, async () => {
        const block = store.get().parts[0];
        const steps = [
            { id: 'sk', name: 'Sketch1', op: 'sketch', sketch: { plane: 'top', offset: 5, profiles: [square] } },
            { id: 'boss', name: 'Boss', op: 'extrude', mode: 'add', distance: 4, sketchRef: 'sk' },
        ] as Feature[];
        const project: Project = { ...store.get(), parts: [{ ...block, features: steps }] };
        const wider = { kind: 'rect', center: [0, 0], width: 8, height: 6 };
        const change = await changeOf([{ name: 'features_update', args: { partId: 'block', updates: [{ id: 'sk', sketch: { plane: 'top', offset: 5, profiles: [wider] } }] } }], project);
        expect(volumeOf(change)).toBeCloseTo(8 * 6 * 4, 3);
    });

    it('shows a new part whole, and nothing for a step that only gets a new name', { timeout: SLOW }, async () => {
        const created = await runPreview(store.get(), [{ name: 'parts_add', args: { parts: [{ name: 'Peg', shape: { kind: 'box', size: [2, 2, 2] },
            position: [30, 1, 0], material: { color: '#9aa3b5', metalness: 0, roughness: 0.6 } }] } }], meshes);
        expect(created.error).toBeUndefined();
        expect(created.parts).toHaveLength(1);
        expect(created.changes).toEqual({});
        const block = store.get().parts[0];
        const fillet = { id: 'f', name: 'Fillet1', op: 'fillet', radius: 1, edges: 'vertical' } as Feature;
        const project: Project = { ...store.get(), parts: [{ ...block, features: [fillet] }] };
        const renamed = await runPreview(project, [{ name: 'features_update', args: { partId: 'block', updates: [{ id: 'f', name: 'Round' }] } }], meshes);
        expect(renamed.changes).toEqual({ block: null });
    });
});

describe('quickThreads', () => {
    it('shows every thread from the first changed step on as its ridges, and builds the ones before for real', () => {
        const thread = { id: 't1', op: 'thread', kind: 'internal', at: [1, 2, 3], pitch: 0.8, length: 10 } as const;
        const other = { id: 't2', op: 'thread', kind: 'external', at: [4, 5, 6], pitch: 1, length: 5 } as const;
        const fillet = { id: 'f', op: 'fillet', radius: 1 } as const;
        const old = { id: 'p', name: 'P', features: [thread, fillet, other] } as unknown as Part;
        const quick = (p: Part): boolean[] => (p.features ?? []).map((f) => (f as { preview?: boolean }).preview ?? false);
        // The first thread edited: it and the later thread, which is rebuilt on top of it anyway, are quick.
        expect(quick(quickThreads({ ...old, features: [{ ...thread, pitch: 1 }, fillet, other] } as unknown as Part, old))).toEqual([true, false, true]);
        // The fillet edited: the thread before it is built already; the one after is quick.
        expect(quick(quickThreads({ ...old, features: [thread, { ...fillet, radius: 2 }, other] } as unknown as Part, old))).toEqual([false, false, true]);
        // A new part is quick throughout; an unchanged part comes back as it was.
        expect(quick(quickThreads(old, undefined))).toEqual([true, false, true]);
        expect(quickThreads(old, old)).toBe(old);
    });
});
