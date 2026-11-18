import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT, DEFAULT_VIEW, type Feature, type MeshStatus, type Part, type Project } from '@jarvis/core';
import { meshKey, type CadKernel, type MeshData, type MeshOptions } from './cad/kernel.js';
import { qualityKey, type MeshQuality } from './cad/meshQuality.js';
import { MeshService } from './meshes.js';
import { builtSpec, draftPart } from './meshStages.js';
import { quickThreads } from './preview.js';

/** A kernel whose jobs the test finishes by hand. */
class FakeKernel {
    jobs: { features: Feature[]; quality: MeshQuality; options: MeshOptions; resolve: (m: MeshData) => void; reject: (e: Error) => void }[] = [];

    mesh(part: Pick<Part, 'shape' | 'features'>, _print: unknown, _context: unknown, quality: MeshQuality = 'normal', options: MeshOptions = {}): Promise<MeshData> {
        return new Promise((resolve, reject) => this.jobs.push({ features: part.features ?? [], quality, options, resolve, reject }));
    }
}

const mesh = (): MeshData => ({
    positions: new Float32Array(9), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), edges: new Float32Array(0),
    triFace: new Uint32Array(1), segEdge: new Uint32Array(0),
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] };
const thread: Feature = { id: 't', op: 'thread', kind: 'internal', at: [10, 4.1, 0], diameter: 10, pitch: 1.5, length: 12 };
const fillet = (radius: number): Feature => ({ id: 'f', op: 'fillet', radius, edges: 'vertical' });

function project(features: Feature[]): Project {
    const part: Part = {
        id: 'p1', name: 'Block', shape: { kind: 'box', size: [20, 20, 20], radius: 0 }, position: [0, 0, 0], rotation: [0, 0, 0],
        material: { color: '#cccccc', metalness: 0, roughness: 0.5 }, features,
    };
    return { name: 'Stages', parts: [part], view: { ...DEFAULT_VIEW } };
}

function setup() {
    const kernel = new FakeKernel();
    const shown: (string | null)[] = [];
    const service = new MeshService(kernel as unknown as CadKernel, (status: MeshStatus) => {
        shown.push(status.keys.p1 ?? null);
    });
    return { kernel, shown, service };
}

const keyOf = (features: Feature[], quality: MeshQuality = 'normal') =>
    qualityKey(meshKey(project(features).parts[0], DEFAULT_PRINT), quality);

describe('meshes shown while a part builds', () => {
    it('shows a coarse mesh first, then the real one, and never the coarse one after it', async () => {
        const { kernel, shown, service } = setup();
        const features = [hole, fillet(2)];
        service.update(project(features));
        expect(kernel.jobs).toHaveLength(1);
        const [job] = kernel.jobs;
        expect(job.options.interim).toBeTypeOf('function');
        job.options.interim!(mesh());
        expect(shown.at(-1)).toBe(keyOf(features, 'coarse'));
        job.resolve(mesh());
        await tick();
        expect(shown.at(-1)).toBe(keyOf(features));
        // A late coarse mesh of the same build does not replace the real one.
        job.options.interim!(mesh());
        service.update(project(features));
        expect(shown.at(-1)).toBe(keyOf(features));
        expect(shown.filter((k) => k === keyOf(features, 'coarse'))).toHaveLength(1);
    });

    it('shows a draft with the threads drawn as hidden ones first when a modelled thread is built again, then the real part', async () => {
        const { kernel, shown, service } = setup();
        const before = [hole, thread];
        service.update(project(before));
        // Nothing was built yet: a draft (the thread as its helix on the surface) goes first, and no coarse mesh with it.
        expect(kernel.jobs).toHaveLength(2);
        const [draft, full] = kernel.jobs;
        expect(draft.features.find((f) => f.op === 'thread')).toMatchObject({ cosmetic: true });
        expect(full.features.find((f) => f.op === 'thread')).not.toHaveProperty('cosmetic');
        expect(full.options.interim).toBeUndefined();
        draft.resolve(mesh());
        await tick();
        expect(shown.at(-1)).toBe(keyOf(draft.features));
        full.resolve(mesh());
        await tick();
        expect(shown.at(-1)).toBe(keyOf(before));

        // An edit after the thread needs no draft (the thread comes from the kernel's cache).
        const after = [...before, fillet(1)];
        service.update(project(after));
        expect(kernel.jobs).toHaveLength(3);
        expect(kernel.jobs[2].features.find((f) => f.op === 'thread')).not.toHaveProperty('preview');
        kernel.jobs[2].resolve(mesh());
        await tick();
        // An edit before it does.
        const edited = [{ ...hole, spec: { kind: 'plain', diameter: 8.2 } } as Feature, thread, fillet(1)];
        service.update(project(edited));
        expect(kernel.jobs).toHaveLength(5);
        const [draft2, full2] = kernel.jobs.slice(3);
        // The real part arriving first leaves the draft unshown.
        full2.resolve(mesh());
        await tick();
        draft2.resolve(mesh());
        await tick();
        expect(shown.at(-1)).toBe(keyOf(edited));
        expect(shown).not.toContain(keyOf(draft2.features));
    });

    it('never shows a coarse mesh in place of a finer one of the same solid (a change of display quality)', async () => {
        const { kernel, shown, service } = setup();
        const features = [hole];
        const p = project(features);
        service.update(p);
        kernel.jobs[0].resolve(mesh());
        await tick();
        expect(shown.at(-1)).toBe(keyOf(features));
        service.setQuality('fine', p);
        const job = kernel.jobs[1];
        expect(job.quality).toBe('fine');
        job.options.interim?.(mesh());
        expect(shown.at(-1)).toBe(keyOf(features));
        job.resolve(mesh());
        await tick();
        expect(shown.at(-1)).toBe(keyOf(features, 'fine'));
    });

    it('marks the builds of a state edited again as stale, and keeps showing the best picture of the wanted one', async () => {
        const { kernel, shown, service } = setup();
        service.update(project([hole, fillet(2)]));
        const first = kernel.jobs[0];
        expect(first.options.stale!()).toBe(false);
        service.update(project([hole, fillet(3)]));
        expect(first.options.stale!()).toBe(true);
        const second = kernel.jobs[1];
        expect(second.options.stale!()).toBe(false);
        second.options.interim!(mesh());
        const coarse = keyOf([hole, fillet(3)], 'coarse');
        expect(shown.at(-1)).toBe(coarse);
        // The same state again (another part changed, say) keeps the coarse mesh up rather than what was there before.
        service.update(project([hole, fillet(3)]));
        expect(shown.at(-1)).toBe(coarse);
        // Back to the first state: its build is wanted again.
        service.update(project([hole, fillet(2)]));
        expect(first.options.stale!()).toBe(false);
    });
});

describe('draftPart', () => {
    const settings = [DEFAULT_PRINT, null];
    const part = project([hole, thread, fillet(1)]).parts[0];

    it('marks the threads from the first changed step on, and only when one is modelled', () => {
        expect(draftPart(part, settings, undefined)?.features?.[1]).toMatchObject({ cosmetic: true });
        const built = builtSpec(part, settings);
        expect(draftPart(part, settings, built)).toBeNull();
        const later = { ...part, features: [hole, thread, fillet(2)] };
        expect(draftPart(later, settings, built)).toBeNull();
        const earlier = { ...part, features: [{ ...hole, position: [10, 1, 0] } as Feature, thread, fillet(1)] };
        expect(draftPart(earlier, settings, built)?.features?.[1]).toMatchObject({ cosmetic: true });
        const cosmetic = { ...earlier, features: [earlier.features[0], { ...thread, cosmetic: true } as Feature, fillet(1)] };
        expect(draftPart(cosmetic, settings, built)).toBeNull();
        // A renamed step changes nothing.
        const renamed = { ...part, features: [{ ...hole, name: 'Hole1' }, thread, fillet(1)] };
        expect(draftPart(renamed, settings, built)).toBeNull();
    });

    it('is the part a tool form previews, so the preview made while typing is shown at once on OK', () => {
        const before = project([hole, thread, fillet(1)]);
        const after = project([{ ...hole, position: [10, 1, 0] } as Feature, thread, fillet(1)]);
        const old = before.parts[0];
        const edited = after.parts[0];
        const previewed = meshKey(quickThreads(edited, old), DEFAULT_PRINT);
        const draft = draftPart(edited, settings, builtSpec(old, settings), 'ridges')!;
        expect(meshKey(draft, DEFAULT_PRINT)).toBe(previewed);
    });
});

describe('hidden parts', () => {
    it('builds only the parts shown, and a hidden one once it is shown again', async () => {
        const { kernel, service } = setup();
        const base = project([fillet(2)]);
        const other: Part = { ...base.parts[0], id: 'p2', name: 'Hidden', shape: { kind: 'box', size: [30, 30, 30], radius: 0 } };
        const both = (hidden: string[]): Project => ({ ...base, parts: [base.parts[0], other], view: { ...base.view, hidden } });
        service.update(both(['p2']));
        expect(kernel.jobs).toHaveLength(1);
        expect(service.current().keys.p2).toBeNull();
        kernel.jobs[0].resolve(mesh());
        await tick();
        service.update(both([]));
        expect(kernel.jobs).toHaveLength(2);
        // Hidden again before its build starts: the queued build is dropped.
        service.update(both(['p2']));
        expect(kernel.jobs[1].options.stale!()).toBe(true);
    });
});
