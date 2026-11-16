import { beforeAll, describe, expect, it } from 'vitest';
import { cast, getOC, makeBox, makeCompound, makeCylinder, type Shape3D } from 'replicad';
import { DEFAULT_PRINT, type Feature, type Vec3 } from '@jarvis/core';
import { buildPartial, initOC, meshSolid } from './build.js';
import { forgetMeshedFaces, lastPlan } from './incrementalMesh.js';
import { interimMesh } from './interimMesh.js';
import type { MeshData } from './kernel.js';

const SLOW = 600_000;

beforeAll(async () => {
    await initOC();
}, SLOW);

/** Triangle sides used other than twice once the vertices are welded: open (once) and overused (more). */
function seams(mesh: MeshData): { open: number; over: number; triangles: number } {
    const ids = new Map<string, number>();
    const vertex: number[] = [];
    const q = (v: number): number => Math.round(v * 1e4);
    for (let i = 0; i < mesh.positions.length; i += 3) {
        const key = `${q(mesh.positions[i])},${q(mesh.positions[i + 1])},${q(mesh.positions[i + 2])}`;
        if (!ids.has(key)) {
            ids.set(key, ids.size);
        }
        vertex.push(ids.get(key)!);
    }
    const uses = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
            const a = vertex[mesh.indices[t + e]];
            const b = vertex[mesh.indices[t + ((e + 1) % 3)]];
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            uses.set(key, (uses.get(key) ?? 0) + 1);
        }
    }
    const counts = [...uses.values()];
    return { open: counts.filter((n) => n === 1).length, over: counts.filter((n) => n > 2).length, triangles: mesh.indices.length / 3 };
}

/** The outline segments of a mesh, each as its two ends, sorted. */
function segments(mesh: MeshData): string[] {
    const point = (i: number): string => [0, 1, 2].map((k) => mesh.edges[i + k].toFixed(4)).join(',');
    const out: string[] = [];
    for (let i = 0; i < mesh.edges.length; i += 6) {
        out.push([point(i), point(i + 3)].sort().join(' '));
    }
    return out.sort();
}

/** A copy with faces of its own (no triangles yet), meshed as if for the first time. */
function freshMesh(shape: Shape3D): MeshData {
    const oc = getOC() as unknown as { BRepBuilderAPI_Transform: new (s: unknown, t: unknown, g: boolean, m: boolean) => { Shape(): unknown; delete(): void }; gp_Trsf: new () => unknown };
    const copier = new oc.BRepBuilderAPI_Transform(shape.wrapped, new oc.gp_Trsf(), true, false);
    const copy = cast(copier.Shape() as never) as Shape3D;
    copier.delete();
    try {
        return meshSolid(copy);
    } finally {
        copy.delete();
    }
}

function build(shape: { kind: 'box'; size: Vec3; radius: number }, features: Feature[]): Shape3D {
    const built = buildPartial({ shape, features }, DEFAULT_PRINT);
    expect(built.error).toBeNull();
    return built.shape!;
}

const block = { kind: 'box' as const, size: [40, 20, 20] as Vec3, radius: 0 };
const drilled: Feature[] = [
    { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [0, 10, 0], direction: [0, -1, 0] },
    { id: 'f', op: 'fillet', radius: 3, edges: 'vertical' },
];
const pocket = (depth: number): Feature => ({ id: 'p', op: 'cut', shape: { kind: 'box', size: [6, depth * 2, 6], radius: 0 }, position: [12, 10, 0] });

describe('meshing only what an edit changed', () => {
    it('keeps the faces a cut leaves, meshes the new ones, and is watertight and as fine as a fresh mesh', () => {
        const before = build(block, drilled);
        const first = meshSolid(before);
        expect(lastPlan?.kept).toBe(0);
        expect(seams(first).open).toBe(0);

        const after = build(block, [...drilled, pocket(3)]);
        const mesh = meshSolid(after);
        const plan = lastPlan!;
        expect(plan.fresh).toBe(false);
        expect(plan.kept).toBeGreaterThan(plan.faces / 2);
        expect(plan.meshed).toBeGreaterThan(0);
        expect(plan.meshed).toBeLessThan(plan.faces / 2);
        const got = seams(mesh);
        const fresh = seams(freshMesh(after));
        expect(got.open).toBe(fresh.open);
        expect(got.over).toBe(fresh.over);
        expect(got.open).toBe(0);
        expect(Math.abs(got.triangles - fresh.triangles)).toBeLessThanOrEqual(fresh.triangles * 0.01);
        // Every face is there, in the order a fresh mesh numbers them.
        expect(Math.max(...mesh.triFace) + 1).toBe(plan.faces);

        // Another depth of the same pocket: the faces around it again kept.
        const deeper = build(block, [...drilled, pocket(5)]);
        const incremental = meshSolid(deeper);
        const again = seams(incremental);
        expect(lastPlan?.fresh).toBe(false);
        expect(again.open).toBe(0);
        expect(again.over).toBe(0);

        // The same solid meshed afresh: the same triangles and outlines.
        forgetMeshedFaces();
        const whole = meshSolid(deeper);
        expect(lastPlan?.fresh).toBe(true);
        expect(incremental.indices.length).toBe(whole.indices.length);
        expect(segments(incremental)).toEqual(segments(whole));
        expect(new Set(incremental.segEdge).size).toBe(new Set(whole.segEdge).size);
    }, SLOW);

    it('meshes the whole solid afresh when its triangles were made at another quality', () => {
        const body = build(block, drilled);
        meshSolid(body);
        const coarse = meshSolid(body, 'coarse');
        expect(lastPlan?.fresh).toBe(true);
        const normal = meshSolid(body);
        expect(lastPlan?.fresh).toBe(true);
        expect(seams(coarse).open).toBe(0);
        expect(seams(normal).open).toBe(0);
        expect(coarse.indices.length).toBeLessThan(normal.indices.length);
    }, SLOW);

    it('meshes the walls of a modelled thread that a later cut rebuilt as they were, from the faces they were rebuilt from', () => {
        // A block with an M8 x 1.25 thread 10 mm into a hole, and a cut far from it.
        const part: Feature[] = [
            { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 6.75 }, position: [20, 0, 0], direction: [-1, 0, 0] },
            { id: 't', op: 'thread', kind: 'internal', at: [20, 3.4, 0], pitch: 1.25, diameter: 8, length: 10, method: 'cut' },
        ];
        const shape = { kind: 'box' as const, size: [40, 20, 20] as Vec3, radius: 0 };
        meshSolid(build(shape, part));
        const cut = build(shape, [...part, { id: 'c', op: 'cut', shape: { kind: 'box', size: [4, 4, 4], radius: 0 }, position: [-18, 8, 8] }]);
        const mesh = meshSolid(cut);
        const plan = lastPlan!;
        expect(plan.fresh).toBe(false);
        expect(plan.twins).toBeGreaterThan(0);
        const got = seams(mesh);
        const fresh = seams(freshMesh(cut));
        expect(got.open).toBe(fresh.open);
        expect(got.over).toBe(fresh.over);
        expect(Math.abs(got.triangles - fresh.triangles)).toBeLessThanOrEqual(fresh.triangles * 0.01);
    }, SLOW);

    it('sends a coarse mesh first only when the real one will take a while', () => {
        expect(interimMesh(build(block, drilled))).toBeNull();
        // A plate with 400 holes: hundreds of curved faces to mesh.
        const pins = Array.from({ length: 400 }, (_, i) => makeCylinder(0.5, 4, [-38 + 4 * (i % 20), -1, -38 + 4 * Math.floor(i / 20)], [0, 1, 0]));
        const plate = makeBox([-40, 0, -40], [40, 2, 40]).cut(makeCompound(pins) as unknown as Shape3D);
        const coarse = interimMesh(plate);
        expect(coarse).not.toBeNull();
        const normal = meshSolid(plate);
        expect(coarse!.indices.length).toBeLessThan(normal.indices.length);
        expect(seams(coarse!).open).toBe(0);
        expect(Math.max(...coarse!.triFace)).toBe(Math.max(...normal.triFace));
    }, SLOW);
});
