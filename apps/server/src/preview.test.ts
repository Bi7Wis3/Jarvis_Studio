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

import type { Part } from '@jarvis/core';
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
