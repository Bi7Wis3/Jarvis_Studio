import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-import-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import { DEFAULT_PRINT, DEFAULT_VIEW, type Feature, type Part, type Project, type Vec3 } from '@jarvis/core';
import { CadKernel, meshKey, type MeshData } from '../cad/kernel.js';
import { ProjectStore } from '../store.js';
import { importIntoProject } from './project.js';
import { importerFor } from './registry.js';
import { meshPieces, parseStl, stlBytes } from './stl.js';
import { DESIGNS } from '../testSamples.js';

const SLOW = 240_000;

let kernel: CadKernel;

beforeAll(() => {
    kernel = CadKernel.start();
});

afterAll(async () => {
    await kernel.close();
    rmSync(dir, { recursive: true, force: true });
});

function bounds(mesh: MeshData): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], mesh.positions[i + k]);
            max[k] = Math.max(max[k], mesh.positions[i + k]);
        }
    }
    return { min, max };
}

/** Corners of a w x d x h box from the origin, outward facing (12 facets). */
function boxFacets(w: number, d: number, h: number): Float32Array {
    const p = (x: number, y: number, z: number): number[] => [x * w, y * d, z * h];
    const quads = [
        [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)], // bottom (-z)
        [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)], // top
        [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)], // -y
        [p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1)], // +y
        [p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1)], // -x
        [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)], // +x
    ];
    return Float32Array.from(quads.flatMap(([a, b, c, e]) => [...a, ...b, ...c, ...a, ...c, ...e]));
}

/** The facets with the first one's winding reversed. */
function flipFirst(positions: Float32Array): Float32Array {
    const out = positions.slice();
    out.set(positions.subarray(6, 9), 3);
    out.set(positions.subarray(3, 6), 6);
    return out;
}

function asciiStl(positions: Float32Array, name = 'cube'): Uint8Array {
    const lines = [`solid ${name}`];
    for (let t = 0; t < positions.length; t += 9) {
        lines.push('  facet normal 0 0 0', '    outer loop');
        for (let c = 0; c < 3; c++) {
            lines.push(`      vertex ${positions[t + c * 3]} ${positions[t + c * 3 + 1]} ${positions[t + c * 3 + 2]}`);
        }
        lines.push('    endloop', '  endfacet');
    }
    lines.push(`endsolid ${name}`);
    return new TextEncoder().encode(lines.join('\n'));
}

const part = (id: string, features: Feature[]): Part => ({
    id, name: id, shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0],
    material: { color: '#888888', metalness: 0, roughness: 0.5 }, features,
});

function expectBox(box: [Vec3, Vec3] | null, expected: [Vec3, Vec3]): void {
    expect(box).not.toBeNull();
    [0, 1].forEach((end) => [0, 1, 2].forEach((k) => expect(box![end][k]).toBeCloseTo(expected[end][k], 5)));
}

function importStep(id: string, step: Partial<Extract<Feature, { op: 'import' }>>): Feature {
    return { id, name: 'Imported1', op: 'import', file: { name: 'x', format: 'step', asset: '000000000000000000000000.step' }, ...step } as Feature;
}

describe('STL reading', () => {
    it('reads binary and ASCII files alike, and finds closed pieces', () => {
        const cube = boxFacets(10, 20, 30);
        const binary = parseStl(stlBytes(cube));
        const ascii = parseStl(asciiStl(cube));
        expect(binary.positions.length).toBe(12 * 9);
        expect(Array.from(ascii.positions)).toEqual(Array.from(binary.positions));
        expect(ascii.name).toBe('cube');
        expect(meshPieces(cube)).toEqual([{ triangles: Array.from({ length: 12 }, (_, i) => i), closed: true, wound: true }]);
        // Without its top the box is open.
        expect(meshPieces(cube.slice(9 * 2)).every((p) => !p.closed)).toBe(true);
        // One facet wound the wrong way: still closed, no longer wound alike.
        expect(meshPieces(flipFirst(cube))).toEqual([{ triangles: Array.from({ length: 12 }, (_, i) => i), closed: true, wound: false }]);
    });

    it('knows the formats by extension', () => {
        expect(importerFor('a.STEP')?.format).toBe('step');
        expect(importerFor('a.stp')?.format).toBe('step');
        expect(importerFor('b.stl')?.format).toBe('stl');
        expect(importerFor('c.iges')?.format).toBe('iges');
        expect(importerFor('d.dxf')).toBeNull();
    });
});

describe('import through the CAD worker', () => {
    it('round-trips a part through STEP: same volume and bounding box', async () => {
        const source: Part = {
            ...part('bracket', [{ id: 'f1', op: 'fillet', radius: 2, edges: 'vertical' }]),
            shape: { kind: 'box', size: [40, 12, 25] }, position: [5, 0, 0],
        };
        const project: Project = { name: 'p', parts: [source], view: { ...DEFAULT_VIEW } };
        const before = await kernel.properties(source, DEFAULT_PRINT);
        const step = await kernel.step(project);
        const imported = await kernel.importFile({ filename: 'bracket.step', bytes: new Uint8Array(step), options: {} });
        expect(imported.format).toBe('step');
        expect(imported.parts).toHaveLength(1);
        const [one] = imported.parts;
        expect(one.solids).toBe(1);
        expect(one.volume).toBeCloseTo(before.props!.volume, 3);
        // The export moved the part by its position and turned it Z up; the import turns it back to Y up.
        const box = before.props!.bounds;
        [0, 1, 2].forEach((k) => {
            expect(one.box![0][k]).toBeCloseTo(box.min[k] + source.position[k], 3);
            expect(one.box![1][k]).toBeCloseTo(box.max[k] + source.position[k], 3);
        });
        // As a step of a new part, with a fillet on top.
        const rebuilt = part('copy', [importStep('imp', { brep: one.brep }), { id: 'r', op: 'fillet', radius: 1, edges: 'top' }]);
        const props = await kernel.properties(rebuilt, DEFAULT_PRINT);
        expect(props.error).toBeUndefined();
        expect(props.props!.volume).toBeLessThan(one.volume);
        expect(props.props!.volume).toBeGreaterThan(one.volume * 0.95);
    }, SLOW);

    it('imports a binary STL as a graphics body, shown but not solid', async () => {
        const imported = await kernel.importFile({ filename: 'cube.stl', bytes: stlBytes(boxFacets(10, 10, 10)), options: { up: 'y' } });
        const [one] = imported.parts;
        expect(one.solids).toBe(0);
        expect(one.facets).toBe(12);
        expect(one.mesh).toMatch(/\.stl$/);
        const mesh = await kernel.mesh(part('g', [importStep('g1', { mesh: one.mesh })]), DEFAULT_PRINT);
        expect(mesh.indices.length).toBe(36);
        expect(mesh.bodies).toEqual([{ key: 'g1:graphics', by: 'g1' }]);
        expect(Array.from(mesh.faceBody!)).toEqual([0]);
        expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
        const props = await kernel.properties(part('g', [importStep('g1', { mesh: one.mesh })]), DEFAULT_PRINT);
        expect(props.props).toBeNull();
    }, SLOW);

    it('imports ASCII and binary STL as solids, in the unit chosen, coplanar facets merged', async () => {
        for (const bytes of [asciiStl(boxFacets(1, 2, 3)), stlBytes(boxFacets(1, 2, 3))]) {
            const imported = await kernel.importFile({ filename: 'cube.stl', bytes, options: { meshAs: 'solid', unit: 'cm', up: 'z' } });
            const [one] = imported.parts;
            expect(imported.warnings).toEqual([]);
            expect(one.solids).toBe(1);
            expect(one.volume).toBeCloseTo(10 * 20 * 30, 6);
            // Z up turned to Y up: the 30 mm height runs along Y, the 20 mm depth along -Z.
            expectBox(one.box, [[0, 0, -20], [10, 30, 0]]);
            const mesh = await kernel.mesh(part('s', [importStep('s1', { brep: one.brep }), { id: 'c', op: 'chamfer', size: 1, edges: 'top' }]), DEFAULT_PRINT);
            // Six faces merged from twelve facets, then four chamfer faces.
            expect(Math.max(...mesh.triFace) + 1).toBe(10);
        }
        // Group facets off: one face per facet.
        const raw = await kernel.importFile({ filename: 'cube.stl', bytes: stlBytes(boxFacets(1, 2, 3)), options: { meshAs: 'solid', groupFacets: false } });
        const mesh = await kernel.mesh(part('r', [importStep('r1', { brep: raw.parts[0].brep })]), DEFAULT_PRINT);
        expect(Math.max(...mesh.triFace) + 1).toBe(12);
        // Facets wound inward, or one against its neighbours: still a solid of the right volume.
        const inward = boxFacets(10, 10, 10).map((v, i, a) => (i % 9 < 3 ? v : a[i + (i % 9 < 6 ? 3 : -3)]));
        for (const facets of [inward, flipFirst(boxFacets(10, 10, 10))]) {
            const fixed = await kernel.importFile({ filename: 'cube.stl', bytes: stlBytes(facets), options: { meshAs: 'solid' } });
            expect(fixed.parts[0].solids).toBe(1);
            expect(fixed.parts[0].volume).toBeCloseTo(1000, 6);
        }
    }, SLOW);

    it('brings an open mesh in as a graphics body when solids are asked for, and says so', async () => {
        const open = boxFacets(10, 10, 10).slice(9 * 2);
        const imported = await kernel.importFile({ filename: 'open.stl', bytes: stlBytes(open), options: { meshAs: 'solid' } });
        expect(imported.parts[0].solids).toBe(0);
        expect(imported.parts[0].facets).toBe(10);
        expect(imported.warnings.join(' ')).toMatch(/not closed.*graphics body/);
    }, SLOW);

    it('builds the imported step with prefix-cache keys that follow the asset', async () => {
        const small = (await kernel.importFile({ filename: 'a.stl', bytes: stlBytes(boxFacets(10, 10, 10)), options: { meshAs: 'solid' } })).parts[0];
        const big = (await kernel.importFile({ filename: 'b.stl', bytes: stlBytes(boxFacets(20, 10, 10)), options: { meshAs: 'solid' } })).parts[0];
        const fillet: Feature = { id: 'f', op: 'fillet', radius: 1, edges: 'vertical' };
        const a = part('p', [importStep('i', { brep: small.brep }), fillet]);
        const b = part('p', [importStep('i', { brep: big.brep }), fillet]);
        expect(meshKey(a, DEFAULT_PRINT)).not.toBe(meshKey(b, DEFAULT_PRINT));
        const va = (await kernel.properties(a, DEFAULT_PRINT)).props!.volume;
        const vb = (await kernel.properties(b, DEFAULT_PRINT)).props!.volume;
        // Same steps, other asset: the cached first step of `a` must not be reused for `b`.
        expect(vb).toBeGreaterThan(va * 1.9);
        // A later edit reuses the imported step and still changes the result.
        const edited = (await kernel.properties(part('p', [importStep('i', { brep: big.brep }), { ...fillet, radius: 2 }]), DEFAULT_PRINT)).props!.volume;
        expect(edited).toBeLessThan(vb);
        // A second import into the part adds a body of its own.
        const two = await kernel.mesh(part('p', [importStep('i', { brep: small.brep }), importStep('j', { brep: big.brep })]), DEFAULT_PRINT);
        expect(two.bodies?.map((x) => x.key)).toEqual(['i', 'j']);
    }, SLOW);

    it('imports into the project, survives save, reload and undo', async () => {
        const store = new ProjectStore();
        store.create('Import test');
        const sources = [{ ...part('a', []), shape: { kind: 'cylinder', radius: 5, height: 10 } }, { ...part('b', []), shape: { kind: 'box', size: [4, 4, 4] }, position: [20, 0, 0] }] as Part[];
        const step = await kernel.step({ name: 'src', view: { ...DEFAULT_VIEW }, parts: sources });
        let total = 0;
        for (const source of sources) {
            total += (await kernel.properties(source, DEFAULT_PRINT)).props!.volume;
        }
        const report = await importIntoProject(store, kernel, { filename: 'Two bodies.step', bytes: new Uint8Array(step), options: {} });
        expect(report.parts).toHaveLength(1);
        const made = store.get().parts.find((p) => p.id === report.parts[0])!;
        expect(made.name).toBe('Two bodies');
        expect(made.features?.[0]).toMatchObject({ op: 'import', name: 'Imported1', file: { name: 'Two bodies.step', format: 'step' } });
        expect(report.result.parts[0].solids).toBe(2);
        // A second import into the same part: Imported2, appended.
        const stl = await importIntoProject(store, kernel, { filename: 'cube.stl', bytes: stlBytes(boxFacets(3, 3, 3)), target: made.id });
        expect(stl.steps).toHaveLength(1);
        expect(store.get().parts.find((p) => p.id === made.id)!.features!.map((f) => f.name)).toEqual(['Imported1', 'STL Graphics1']);
        // Saved: a fresh store reads the project back, and its assets build.
        const reloaded = new ProjectStore().get();
        const again = reloaded.parts.find((p) => p.id === made.id)!;
        expect(again.features).toEqual(store.get().parts.find((p) => p.id === made.id)!.features);
        const mesh = await kernel.mesh(again, DEFAULT_PRINT);
        expect(mesh.bodies?.length).toBe(3);
        const original = readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.step'));
        expect(original.length).toBe(1);
        expect(readFileSync(join(dir, 'assets', original[0])).equals(step)).toBe(true);
        // Undo takes the second import away, then the part.
        expect(store.undo()).toBe(true);
        expect(store.get().parts.find((p) => p.id === made.id)!.features).toHaveLength(1);
        expect(store.undo()).toBe(true);
        expect(store.get().parts.some((p) => p.id === made.id)).toBe(false);
        expect(store.redo()).toBe(true);
        expect((await kernel.properties(store.get().parts.find((p) => p.id === made.id)!, DEFAULT_PRINT)).props!.volume)
            .toBeCloseTo(total, 3);
    }, SLOW);

    it('reads a step\'s own file again with other options (Edit feature)', async () => {
        const store = new ProjectStore();
        store.create('Edit test');
        const first = await importIntoProject(store, kernel, { filename: 'cube.stl', bytes: stlBytes(boxFacets(10, 10, 10)) });
        const [partId] = first.parts;
        expect(store.get().parts[0].features?.[0]).toMatchObject({ name: 'STL Graphics1', mesh: expect.any(String) });
        const again = await importIntoProject(store, kernel, {
            filename: '', bytes: new Uint8Array(0), target: partId, replace: first.steps[0], options: { meshAs: 'solid' },
        });
        expect(again.text).toMatch(/^Read cube\.stl again/);
        const step = store.get().parts[0].features![0] as Extract<Feature, { op: 'import' }>;
        expect(step).toMatchObject({ id: first.steps[0], name: 'Imported1', options: { meshAs: 'solid' } });
        expect(step.mesh).toBeUndefined();
        expect((await kernel.properties(store.get().parts[0], DEFAULT_PRINT)).props!.volume).toBeCloseTo(1000, 6);
    }, SLOW);

    it('makes a part per body when asked', async () => {
        const store = new ProjectStore();
        store.create('Parts test');
        const step = await kernel.step({
            name: 'src', view: { ...DEFAULT_VIEW },
            parts: [{ ...part('a', []), shape: { kind: 'box', size: [2, 2, 2] } }, { ...part('b', []), shape: { kind: 'box', size: [4, 4, 4] }, position: [20, 0, 0] }],
        });
        const report = await importIntoProject(store, kernel, { filename: 'pair.stp', bytes: new Uint8Array(step), options: { bodiesAsParts: true } });
        expect(report.parts).toHaveLength(2);
        expect(store.get().parts.map((p) => p.name)).toEqual(['pair 1', 'pair 2']);
    }, SLOW);

    it('says what it cannot read', async () => {
        const store = new ProjectStore();
        await expect(importIntoProject(store, kernel, { filename: 'a.dxf', bytes: new Uint8Array(10) })).rejects.toThrow(/cannot import this type/);
        await expect(kernel.importFile({ filename: 'bad.step', bytes: new TextEncoder().encode('not a step file'), options: {} })).rejects.toThrow(/could not be read as STEP/);
    }, SLOW);
});

// The owner's design folder, when JARVIS_DESIGNS names it (testSamples.ts): nothing of it is in the repository.
const OWNER = DESIGNS;

describe.skipIf(!OWNER)("the owner's STL files (read only)", () => {
    const files = OWNER ? readdirSync(OWNER).filter((f) => /\.stl$/i.test(f)).map((f) => join(OWNER, f)) : [];

    it('reads every one as a graphics body', async () => {
        for (const file of files) {
            const bytes = new Uint8Array(readFileSync(file));
            const imported = await kernel.importFile({ filename: file.split('/').pop()!, bytes, options: {} });
            expect(imported.parts[0].facets, file).toBeGreaterThan(0);
        }
    }, SLOW);

    it('makes solids of the small closed ones', async () => {
        const small = files.filter((f) => readFileSync(f).length < 200_000);
        let solids = 0;
        for (const file of small) {
            const imported = await kernel.importFile({ filename: 'owner.stl', bytes: new Uint8Array(readFileSync(file)), options: { meshAs: 'solid' } });
            solids += imported.parts[0].solids;
        }
        expect(solids).toBeGreaterThan(0);
    }, SLOW);
});
