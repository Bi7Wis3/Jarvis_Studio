import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    DEFAULT_PRINT, DEFAULT_VIEW, shapeHalfExtents, type Feature, type Part, type Project, type Shape, type Vec3,
} from '@jarvis/core';
import { CadBuildError, CadKernel, meshKey, replicadApiNames, type MeshData } from './kernel.js';

const SLOW = 180_000;

let kernel: CadKernel;

beforeAll(() => {
    kernel = CadKernel.start();
});

afterAll(async () => {
    await kernel.close();
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

function volume(mesh: MeshData): number {
    const p = mesh.positions;
    let v = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
        v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
            - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
            + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
}

/**
 * Edges used by other than exactly two triangles, after welding the per-face vertices by position (to 0.1 um,
 * as B-rep vertices carry a small tolerance, e.g. where a closed spline meets itself).
 */
function openEdges(mesh: MeshData): number {
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
    let open = 0;
    for (const count of uses.values()) {
        if (count !== 2) {
            open++;
        }
    }
    return open;
}

function hasVertexNear(mesh: MeshData, point: Vec3, tolerance = 0.01): boolean {
    for (let i = 0; i < mesh.positions.length; i += 3) {
        if (Math.hypot(mesh.positions[i] - point[0], mesh.positions[i + 1] - point[1], mesh.positions[i + 2] - point[2])
            < tolerance) {
            return true;
        }
    }
    return false;
}

function expectBounds(mesh: MeshData, min: Vec3, max: Vec3, tolerance = 0.05): void {
    const b = bounds(mesh);
    for (let k = 0; k < 3; k++) {
        expect(Math.abs(b.min[k] - min[k]), `min[${k}] ${b.min[k]} vs ${min[k]}`).toBeLessThan(tolerance);
        expect(Math.abs(b.max[k] - max[k]), `max[${k}] ${b.max[k]} vs ${max[k]}`).toBeLessThan(tolerance);
    }
}

const sharpBox = (size: Vec3): Shape => ({ kind: 'box', size, radius: 0 });

/**
 * Whether a point lies in the solid of a closed mesh, or within `tolerance` of its surface: rays along +X, +Y and +Z
 * must all cross the surface an odd number of times, from the point nudged out by the tolerance in each direction.
 */
function insideMesh(mesh: MeshData, point: Vec3, tolerance: number): boolean {
    const p = mesh.positions;
    const crossings = (q: Vec3, axis: number): number => {
        const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
        let n = 0;
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
            const d = (p[b + u] - p[a + u]) * (p[c + v] - p[a + v]) - (p[b + v] - p[a + v]) * (p[c + u] - p[a + u]);
            if (Math.abs(d) < 1e-14) {
                continue;
            }
            const [qu, qv] = [q[u] + 1.234e-7, q[v] + 2.345e-7];
            const s = ((qu - p[a + u]) * (p[c + v] - p[a + v]) - (qv - p[a + v]) * (p[c + u] - p[a + u])) / d;
            const w = ((p[b + u] - p[a + u]) * (qv - p[a + v]) - (p[b + v] - p[a + v]) * (qu - p[a + u])) / d;
            if (s < 0 || w < 0 || s + w > 1) {
                continue;
            }
            if (p[a + axis] + s * (p[b + axis] - p[a + axis]) + w * (p[c + axis] - p[a + axis]) > q[axis]) {
                n++;
            }
        }
        return n;
    };
    // Inside (or on the surface) if, nudged by the tolerance in some direction, it is inside along all three rays.
    return [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some((step) => {
        const q: Vec3 = [point[0] + step[0] * tolerance, point[1] + step[1] * tolerance, point[2] + step[2] * tolerance];
        return [0, 1, 2].every((axis) => crossings(q, axis) % 2 === 1);
    });
}
const mesh = (shape: Shape, features?: Feature[]): Promise<MeshData> => kernel.mesh({ shape, features }, DEFAULT_PRINT);

describe('primitive shapes', () => {
    const shapes: Shape[] = [
        { kind: 'box', size: [10, 20, 30] },
        sharpBox([4, 6, 8]),
        { kind: 'cylinder', radius: 5, height: 10 },
        { kind: 'cylinder', radius: 5, radiusTop: 2, height: 10, bevel: 0 },
        { kind: 'tube', outerRadius: 10, innerRadius: 8, height: 5 },
        { kind: 'sphere', radius: 5 },
        { kind: 'torus', radius: 10, tube: 2 },
        { kind: 'cone', radius: 4, height: 8 },
        { kind: 'capsule', radius: 3, length: 10 },
        { kind: 'lathe', profile: [[0, -5], [5, -5], [3, 0], [5, 5], [0, 5]] },
        { kind: 'lathe', profile: [[2, -4], [4, -2], [4, 3], [1, 4]] },
        { kind: 'extrude', outline: [[-10, -5], [10, -5], [10, 5], [0, 12], [-10, 5]], height: 4 },
    ];

    for (const shape of shapes) {
        it(`builds a ${shape.kind} matching shapeHalfExtents`, async () => {
            const m = await mesh(shape);
            const half = shapeHalfExtents(shape);
            const b = bounds(m);
            if (shape.kind === 'extrude') {
                // Extrusions keep their outline coordinates rather than being centred on X/Z.
                expectBounds(m, [-10, -2, -5], [10, 2, 12]);
            } else {
                expectBounds(m, [-half[0], -half[1], -half[2]], half);
            }
            expect(b.max[1]).toBeGreaterThan(b.min[1]);
            expect(openEdges(m)).toBe(0);
            expect(volume(m)).toBeGreaterThan(0);
            expect(m.normals.length).toBe(m.positions.length);
            expect(m.edges.length % 6).toBe(0);
        }, SLOW);
    }

    it('gives a sharp box its exact volume and 12 outline edges', async () => {
        const m = await mesh(sharpBox([10, 20, 30]));
        expect(volume(m)).toBeCloseTo(6000, 3);
        expect(m.edges.length / 6).toBe(12);
    }, SLOW);

    it('leaves the seam of a cylinder out of its outline', async () => {
        const m = await mesh({ kind: 'cylinder', radius: 5, height: 10, bevel: 0 });
        for (let i = 0; i < m.edges.length; i += 6) {
            // Every outline segment lies on the top or bottom rim.
            expect(Math.abs(m.edges[i + 1])).toBeCloseTo(5, 5);
            expect(Math.abs(m.edges[i + 4])).toBeCloseTo(5, 5);
            const length = Math.hypot(m.edges[i] - m.edges[i + 3], m.edges[i + 1] - m.edges[i + 4], m.edges[i + 2] - m.edges[i + 5]);
            expect(length).toBeGreaterThan(1e-4);
        }
    }, SLOW);

    it('tags every triangle with its face and every outline segment with its edge', async () => {
        const distinct = (a: Uint32Array): number[] => [...new Set(a)].sort((x, y) => x - y);
        const box = await mesh(sharpBox([10, 20, 30]));
        expect(box.triFace.length).toBe(box.indices.length / 3);
        expect(distinct(box.triFace)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(box.segEdge.length).toBe(box.edges.length / 6);
        expect(distinct(box.segEdge)).toEqual([...Array(12).keys()]);
        const cylinder = await mesh({ kind: 'cylinder', radius: 5, height: 10, bevel: 0 });
        expect(cylinder.triFace.length).toBe(cylinder.indices.length / 3);
        expect(distinct(cylinder.triFace)).toEqual([0, 1, 2]);
        // Two rims; the seam is left out.
        expect(cylinder.segEdge.length).toBe(cylinder.edges.length / 6);
        expect(distinct(cylinder.segEdge)).toEqual([0, 1]);
    }, SLOW);
});

describe('features', () => {
    it('makes watertight meshes', async () => {
        const shelled = await mesh({ kind: 'box', size: [40, 20, 30] }, [{ id: 's', op: 'shell', thickness: 2, open: ['top'] }]);
        const holed = await mesh(sharpBox([30, 10, 30]), [
            { id: 'h', op: 'hole', spec: { kind: 'counterbore', size: 'M3' }, position: [0, 5, 0] },
        ]);
        const screw = await mesh({ kind: 'fastener', type: 'socketCap', size: 'M3', length: 12 });
        for (const m of [shelled, holed, screw]) {
            expect(openEdges(m)).toBe(0);
            expect(volume(m)).toBeGreaterThan(0);
        }
    }, SLOW);

    it('builds an enclosure: vertical fillets, open-top shell, counterbored holes', async () => {
        // No explicit radius: with a feature history the body starts sharp, so the vertical edges can be filleted.
        const body: Shape = { kind: 'box', size: [80, 30, 50] };
        const features: Feature[] = [
            { id: 'a', op: 'fillet', radius: 4, edges: 'vertical' },
            { id: 'b', op: 'shell', thickness: 2, open: ['top'] },
            { id: 'c', name: 'Floor screws', op: 'hole', spec: { kind: 'counterbore', size: 'M3' }, position: [-30, -15, 0],
                direction: [0, 1, 0], repeat: { kind: 'linear', count: 2, step: [60, 0, 0] } },
        ];
        const noHoles = await mesh(body, features.slice(0, 2));
        const m = await mesh(body, features);
        expect(openEdges(m)).toBe(0);
        expectBounds(m, [-40, -15, -25], [40, 15, 25]);
        // Through the 2 mm floor: clearance holes, counterbores (deeper than the floor) at the entry.
        const dims = { clearance: 3.4 + DEFAULT_PRINT.holeTolerance, counterbore: 5.5 + 0.6 + DEFAULT_PRINT.holeTolerance };
        const removed = volume(noHoles) - volume(m);
        const perHole = Math.PI * (dims.counterbore / 2) ** 2 * 2;
        expect(removed / (2 * perHole)).toBeCloseTo(1, 1);
        for (const x of [-30, 30]) {
            expect(hasVertexNear(m, [x + dims.clearance / 2, -15, 0], 1.5)).toBe(true);
        }
        // Default rounding still applies to a bare box.
        const bare = bounds(await mesh(body));
        expect(hasVertexNear(await mesh(body), [40, 15, 25], 0.1)).toBe(false);
        expect(bare.max[0]).toBeCloseTo(40, 2);
    }, SLOW);

    it('drills a through hole that removes about pi r^2 h', async () => {
        const plain = await mesh(sharpBox([20, 10, 20]));
        const holed = await mesh(sharpBox([20, 10, 20]), [
            { id: 'h', name: 'Bore', op: 'hole', spec: { kind: 'plain', diameter: 5 }, position: [0, 5, 0] },
        ]);
        const r = (5 + DEFAULT_PRINT.holeTolerance) / 2;
        const removed = volume(plain) - volume(holed);
        expect(removed / (Math.PI * r * r * 10)).toBeCloseTo(1, 1);
        expect(Math.abs(removed - Math.PI * r * r * 10)).toBeLessThan(Math.PI * r * r * 10 * 0.02);
    }, SLOW);

    it('drills along a direction and to a depth', async () => {
        const plain = await mesh(sharpBox([20, 10, 20]));
        const side = await mesh(sharpBox([20, 10, 20]), [
            { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 3.8 }, position: [10, 0, 0], direction: [-1, 0, 0], depth: 6 },
        ]);
        expect((volume(plain) - volume(side)) / (Math.PI * 4 * 6)).toBeCloseTo(1, 1);
    }, SLOW);

    it('shells an open-topped box with walls of the given thickness', async () => {
        const m = await mesh(sharpBox([40, 20, 30]), [{ id: 's', op: 'shell', thickness: 2, open: ['top'] }]);
        expect(volume(m)).toBeCloseTo(40 * 20 * 30 - 36 * 18 * 26, 0);
        expectBounds(m, [-20, -10, -15], [20, 10, 15]);
        // Inner rim corner at the top (the opening) and the inner floor corner 2 mm up.
        expect(hasVertexNear(m, [18, 10, 13])).toBe(true);
        expect(hasVertexNear(m, [18, -8, 13])).toBe(true);
    }, SLOW);

    it('shells a closed hollow body when no face is open', async () => {
        const m = await mesh(sharpBox([20, 20, 20]), [{ id: 's', op: 'shell', thickness: 2 }]);
        expect(volume(m)).toBeCloseTo(8000 - 16 ** 3, 0);
    }, SLOW);

    it('fillets only the vertical edges when asked', async () => {
        const m = await mesh(sharpBox([20, 10, 20]), [{ id: 'f', op: 'fillet', radius: 3, edges: 'vertical' }]);
        const expected = 4000 - 4 * (9 - (Math.PI * 9) / 4) * 10;
        expect(volume(m)).toBeCloseTo(expected, 0);
        // Top edges stay sharp (the top face reaches the side walls); the vertical corners are gone.
        expect(hasVertexNear(m, [10, 5, 7])).toBe(true);
        expect(hasVertexNear(m, [10, 5, 10], 0.5)).toBe(false);
        expect(hasVertexNear(m, [10, 0, 10], 0.5)).toBe(false);
    }, SLOW);

    it('chamfers the top edges only', async () => {
        const m = await mesh(sharpBox([20, 10, 20]), [{ id: 'c', op: 'chamfer', size: 1, edges: 'top' }]);
        expect(volume(m)).toBeLessThan(4000);
        expect(hasVertexNear(m, [10, -5, 10])).toBe(true);
        expect(hasVertexNear(m, [10, 5, 10], 0.5)).toBe(false);
    }, SLOW);

    it('skips suppressed features', async () => {
        const plain = await mesh(sharpBox([20, 10, 20]));
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 5 }, position: [0, 5, 0], suppressed: true };
        const suppressed = await mesh(sharpBox([20, 10, 20]), [hole, { id: 'x', op: 'fillet', radius: 99, suppressed: true }]);
        expect(volume(suppressed)).toBeCloseTo(volume(plain), 3);
    }, SLOW);

    it('cuts one hole per repeat', async () => {
        const plain = await mesh(sharpBox([60, 5, 20]));
        const holes = await mesh(sharpBox([60, 5, 20]), [{
            id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 4 }, position: [-20, 2.5, 0],
            repeat: { kind: 'linear', count: 3, step: [20, 0, 0] },
        }]);
        const r = (4 + DEFAULT_PRINT.holeTolerance) / 2;
        expect((volume(plain) - volume(holes)) / (3 * Math.PI * r * r * 5)).toBeCloseTo(1, 1);
        const radial = await mesh({ kind: 'cylinder', radius: 20, height: 4, bevel: 0 }, [{
            id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 4 }, position: [12, 2, 0],
            repeat: { kind: 'radial', count: 6 },
        }]);
        const disc = Math.PI * 400 * 4;
        expect((disc - volume(radial)) / (6 * Math.PI * r * r * 4)).toBeCloseTo(1, 1);
    }, SLOW);

    it('adds and cuts shapes with position, rotation and repeat', async () => {
        const m = await mesh(sharpBox([20, 4, 20]), [
            { id: 'a', op: 'add', shape: { kind: 'cylinder', radius: 2, height: 6, bevel: 0 }, position: [0, 5, 0] },
            { id: 'c', op: 'cut', shape: sharpBox([2, 2, 30]), position: [0, -2, 0], rotation: [0, 90, 0],
                repeat: { kind: 'linear', count: 2, step: [0, 0, 6] } },
        ]);
        expectBounds(m, [-10, -2, -10], [10, 8, 10]);
        // One boss (pi*4*6, with 1 mm inside the plate... it overlaps 0 mm: boss spans y 2..8) minus two grooves.
        const expected = 20 * 4 * 20 + Math.PI * 4 * 6 - 2 * (20 * 2 * 1);
        expect(volume(m)).toBeCloseTo(expected, 0);
    }, SLOW);

    it('cuts counterbores, countersinks and nut traps at the entry', async () => {
        for (const kind of ['counterbore', 'countersink', 'nutTrap', 'heatset', 'tap', 'clearance'] as const) {
            const m = await mesh(sharpBox([20, 10, 20]), [
                { id: kind, op: 'hole', spec: { kind, size: 'M3' }, position: [0, 5, 0] },
            ]);
            expect(openEdges(m)).toBe(0);
            expect(volume(m)).toBeLessThan(4000);
        }
    }, SLOW);

    it('models printable threads', async () => {
        const rod = await mesh({ kind: 'cylinder', radius: 3, height: 4, bevel: 0 }, [
            { id: 't', op: 'thread', kind: 'external', diameter: 12, pitch: 2, length: 6, position: [0, 2, 0] },
        ]);
        expect(bounds(rod).max[1]).toBeCloseTo(8, 1);
        expect(bounds(rod).max[0]).toBeGreaterThan(5.8);
        const nutBody = await mesh(sharpBox([20, 6, 20]), [
            { id: 't', op: 'thread', kind: 'internal', diameter: 10, pitch: 2, length: 6, position: [0, -3, 0] },
        ]);
        expect(volume(nutBody)).toBeLessThan(2400 - Math.PI * 16 * 6);
        expect(volume(nutBody)).toBeGreaterThan(2400 - Math.PI * 25.5 * 6);
    }, SLOW);

    // A shaft of diameter 10 along +X, from x = 0 to 20 (a circle on the right plane, extruded).
    const shaft: Feature = {
        id: 'rod', op: 'extrude', mode: 'add', distance: 20, sketch: { plane: 'right', profiles: [{ kind: 'circle', center: [0, 0], radius: 5 }] },
    };

    it('threads a horizontal shaft from a picked circular edge, along the shaft only', async () => {
        const plain = await mesh({ kind: 'empty' }, [shaft]);
        const threaded = await mesh({ kind: 'empty' }, [shaft, { id: 't', op: 'thread', kind: 'external', at: [20, 5, 0], pitch: 1.5, length: 10 }]);
        // Axis, diameter and start come from the edge at x = 20: the thread runs back along the shaft, nothing
        // sticks out past its end, and the crest stays at the shaft's diameter.
        const b = bounds(threaded);
        expect(b.max[0]).toBeCloseTo(20, 1);
        expect(b.min[0]).toBeCloseTo(0, 1);
        expect(b.max[1]).toBeLessThan(5.05);
        expect(b.max[1]).toBeGreaterThan(4.9);
        expect(volume(threaded)).toBeLessThan(volume(plain) - 50);
        expect(openEdges(threaded)).toBe(0);
        // Left hand, two starts and a revolutions end condition build too; a thread longer than the shaft stops at its end.
        const left = await mesh({ kind: 'empty' }, [shaft, {
            id: 't', op: 'thread', kind: 'external', at: [20, 5, 0], pitch: 1.5, revolutions: 4, starts: 2, leftHanded: true, offset: 2,
        }]);
        expect(bounds(left).max[0]).toBeCloseTo(20, 1);
        expect(volume(left)).not.toBeCloseTo(volume(threaded), 0);
        const full = await mesh({ kind: 'empty' }, [shaft, { id: 't', op: 'thread', kind: 'external', at: [20, 5, 0], pitch: 1.5, length: 25 }]);
        const whole = await mesh({ kind: 'empty' }, [shaft, { id: 't', op: 'thread', kind: 'external', at: [20, 5, 0], pitch: 1.5, length: 20 }]);
        expect(openEdges(full)).toBe(0);
        expect(bounds(full).min[0]).toBeCloseTo(0, 1);
        expect(bounds(full).max[0]).toBeCloseTo(20, 1);
        // Trimmed at the shaft's end, at full depth to the end: close to, not the same as, a thread of exactly 20.
        expect(Math.abs(volume(full) - volume(whole))).toBeLessThan(volume(whole) * 0.02);
        // Starting before the edge runs in at full depth and adds nothing outside the shaft.
        const early = await mesh({ kind: 'empty' }, [shaft, { id: 't', op: 'thread', kind: 'external', at: [20, 5, 0], pitch: 1.5, length: 10, offset: -2 }]);
        expect(openEdges(early)).toBe(0);
        expect(bounds(early).max[0]).toBeCloseTo(20, 1);
        expect(volume(early)).toBeLessThan(volume(plain));
        // Direction 2 carries the same thread the other way from its start: 6 mm in, started 4 mm along, with 4 mm back
        // towards the edge, is the thread of 10 mm from the edge.
        const both = await mesh({ kind: 'empty' }, [shaft, { id: 't', op: 'thread', kind: 'external', at: [20, 5, 0], pitch: 1.5, length: 6, offset: 4, length2: 4 }]);
        expect(volume(both)).toBeCloseTo(volume(threaded), 0);
        await expect(mesh({ kind: 'empty' }, [shaft, { id: 't', op: 'thread', kind: 'external', at: [20, 5, 0], pitch: 1.5, length: 5, offset: 30 }]))
            .rejects.toThrow(/misses the cylinder/);
        await expect(mesh({ kind: 'empty' }, [shaft, { id: 't', op: 'thread', kind: 'internal', at: [20, 5, 0], pitch: 1.5, length: 10 }]))
            .rejects.toThrow(/on a shaft: use an external thread/);
    }, SLOW);

    it('taps a hole from its picked edge, sized from the hole', async () => {
        const block = sharpBox([20, 20, 20]);
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] };
        const drilled = await mesh(block, [hole]);
        const r = (8 + DEFAULT_PRINT.holeTolerance) / 2;
        const tapped = await mesh(block, [hole, { id: 't', op: 'thread', kind: 'internal', at: [10, r, 0], pitch: 1.5, length: 12 }]);
        // Bored out to the major diameter (hole + 1.0825 x pitch) over 12 mm, with the ridge left standing.
        expect(volume(tapped)).toBeLessThan(volume(drilled));
        expect(volume(tapped)).toBeGreaterThan(volume(drilled) - Math.PI * ((r + 0.82 + 0.1) ** 2 - r * r) * 12);
        expectBounds(tapped, [-10, -10, -10], [10, 10, 10]);
        // Started 1 mm outside the hole and asked longer than it: trimmed to the hole, nothing sticks out of the block.
        const through = await mesh(block, [hole, { id: 't', op: 'thread', kind: 'internal', at: [10, r, 0], pitch: 1.5, length: 40, offset: -1 }]);
        expectBounds(through, [-10, -10, -10], [10, 10, 10]);
        expect(openEdges(through)).toBe(0);
        expect(volume(through)).toBeLessThan(volume(tapped));
        await expect(mesh(block, [hole, { id: 't', op: 'thread', kind: 'external', at: [10, r, 0], pitch: 1.5, length: 12 }]))
            .rejects.toThrow(/on a hole: use an internal thread/);
        await expect(mesh(block, [hole, { id: 't', op: 'thread', kind: 'internal', at: [10, 10, 10], pitch: 1.5, length: 12 }]))
            .rejects.toThrow(/not a full circle/);
    }, SLOW);

    it('threads a hole whose mouth was chamfered first, and asks for the thread last when a chamfer comes after it', async () => {
        const block = sharpBox([20, 20, 20]);
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] };
        const r = (8 + DEFAULT_PRINT.holeTolerance) / 2;
        const thread: Feature = { id: 't', name: 'Thread1', op: 'thread', kind: 'internal', at: [10, r, 0], pitch: 1.5, length: 12 };
        const mouth: Feature = { id: 'c', op: 'chamfer', size: 2, at: [[10, r, 0]] };
        // The picked edge is gone after the chamfer: the thread starts behind it, on the same hole.
        const chamfered = await mesh(block, [hole, mouth]);
        const lead = await mesh(block, [hole, mouth, thread]);
        expect(openEdges(lead)).toBe(0);
        expectBounds(lead, [-10, -10, -10], [10, 10, 10]);
        expect(volume(lead)).toBeLessThan(volume(chamfered));
        // A chamfer after the thread is made as the countersink it is: it takes about the same cone off the mouth.
        const tapped = await mesh(block, [hole, thread]);
        const sunk = await mesh(block, [hole, thread, mouth]);
        expect(openEdges(sunk)).toBe(0);
        expectBounds(sunk, [-10, -10, -10], [10, 10, 10]);
        const drilled = await mesh(block, [hole]);
        const cone = volume(drilled) - volume(chamfered);
        expect(volume(tapped) - volume(sunk)).toBeGreaterThan(cone * 0.5);
        expect(volume(tapped) - volume(sunk)).toBeLessThan(cone * 1.05);
        // Distance and angle chamfers on the thread's mouth build too, and a fillet there still says what to do.
        const steep = await mesh(block, [hole, thread, { id: 'c', op: 'chamfer', size: 1, angle: 60, at: [[10, r, 0]] }]);
        expect(volume(steep)).toBeLessThan(volume(tapped));
        await expect(mesh(block, [hole, thread, { id: 'f', op: 'fillet', radius: 1, at: [[10, r, 0]] }]))
            .rejects.toThrow(/runs along a thread \(Thread1\).*drag Thread1 below this step/);
    }, SLOW);

    it('cuts a thread only where there is material, and runs it out through the start face', async () => {
        const block = sharpBox([20, 20, 20]);
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] };
        const r = (8 + DEFAULT_PRINT.holeTolerance) / 2;
        // The far top edge cut off at 45 degrees, 12 mm deep: the hole comes out through that slanted face (y - x = 8).
        const slant: Feature = { id: 's', op: 'chamfer', size: 12, at: [[-10, 10, 0]] };
        const thread: Feature = { id: 't', op: 'thread', kind: 'internal', at: [10, r, 0], pitch: 1.5, length: 19 };
        const before = await mesh(block, [slant, hole]);
        const tapped = await mesh(block, [slant, hole, thread]);
        expect(openEdges(tapped)).toBe(0);
        expect(volume(tapped)).toBeLessThan(volume(before));
        // Nothing stands in the air past the slanted face, where the old ridges used to hang.
        let past = -Infinity;
        for (let i = 0; i < tapped.positions.length; i += 3) {
            past = Math.max(past, tapped.positions[i + 1] - tapped.positions[i]);
        }
        expect(past).toBeLessThan(8 + 1e-3);
        expectBounds(tapped, [-10, -10, -10], [10, 10, 10]);

        // Where the thread meets its start face (x = 10): trimmed with the face, the ridge reaches it (the opening comes
        // in to the crest); untrimmed, the thread starts a little inside behind a plain bore at the major diameter.
        const opening = (m: MeshData): number => {
            let least = Infinity;
            for (let i = 0; i < m.positions.length; i += 3) {
                const radius = Math.hypot(m.positions[i + 1], m.positions[i + 2]);
                if (Math.abs(m.positions[i] - 10) < 1e-4 && radius < 7) {
                    least = Math.min(least, radius);
                }
            }
            return least;
        };
        const major = r + (1.0825 * 1.5) / 2 + DEFAULT_PRINT.holeTolerance / 2;
        const plain = await mesh(block, [hole, { ...thread, length: 12 }]);
        const blunt = await mesh(block, [hole, { ...thread, length: 12, trimStart: false }]);
        expect(opening(plain)).toBeLessThan(r + 0.2);
        expect(opening(blunt)).toBeGreaterThan(major - 0.05);
    }, SLOW);

    it('offers Cut thread and Extrude thread, and keeps older threads as they were built', async () => {
        const block = sharpBox([20, 20, 20]);
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] };
        const r = (8 + DEFAULT_PRINT.holeTolerance) / 2;
        const drilled = await mesh(block, [hole]);
        // A thread as wide as the hole: nothing for a tap to cut; extruded, the ridges are added on the wall.
        const wide = { id: 't', op: 'thread', kind: 'internal', at: [10, r, 0] as Vec3, pitch: 1.5, length: 12, diameter: 2 * r } as const;
        await expect(mesh(block, [hole, { ...wide, method: 'cut' }])).rejects.toThrow(/Cut thread: the hole .* nothing to cut.*tap size.*Extrude thread/);
        const added = await mesh(block, [hole, { ...wide, method: 'extrude' }]);
        expect(volume(added)).toBeGreaterThan(volume(drilled) + 10);
        expect(openEdges(added)).toBe(0);
        // Without a method (a thread made before the choice existed) it is built as before: the ridges added.
        const older = await mesh(block, [hole, wide]);
        expect(volume(older)).toBeCloseTo(volume(added), 3);

        // A hollow shaft keeps its bore when a thread is cut on it.
        const tube: Shape = { kind: 'tube', outerRadius: 5, innerRadius: 3, height: 20 };
        const bare = await mesh(tube, []);
        const threaded = await mesh(tube, [{ id: 't', op: 'thread', kind: 'external', at: [5, 10, 0], pitch: 1.5, length: 10 }]);
        expect(openEdges(threaded)).toBe(0);
        expect(volume(threaded)).toBeLessThan(volume(bare));
        expect(volume(threaded)).toBeGreaterThan(volume(bare) - Math.PI * (25 - 4.08 ** 2) * 10);
    }, SLOW);

    it('adds an extruded thread only where the wall stands, not past a slanted face the hole comes out through', async () => {
        const block = sharpBox([20, 20, 20]);
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] };
        const r = (8 + DEFAULT_PRINT.holeTolerance) / 2;
        // The far top edge cut off at 45 degrees: the hole comes out through that slanted face (y - x = 8).
        const slant: Feature = { id: 's', op: 'chamfer', size: 12, at: [[-10, 10, 0]] };
        const thread: Feature = { id: 't', op: 'thread', kind: 'internal', at: [10, r, 0], pitch: 1.5, length: 30, diameter: 8, method: 'extrude' };
        const drilled = await mesh(block, [slant, hole]);
        const threaded = await mesh(block, [slant, hole, thread]);
        expect(openEdges(threaded)).toBe(0);
        expect(volume(threaded)).toBeGreaterThan(volume(drilled) + 20);
        // No ridge stands in the air past the slanted face.
        let past = -Infinity;
        // The hole's wall runs on to the far face (x = -10) below the slant: the thread runs as far as the wall does.
        let far = Infinity;
        for (let i = 0; i < threaded.positions.length; i += 3) {
            const [x, y, z] = [threaded.positions[i], threaded.positions[i + 1], threaded.positions[i + 2]];
            past = Math.max(past, y - x);
            if (y < 0 && Math.hypot(y, z) < r - 0.3) {
                far = Math.min(far, x);
            }
        }
        expect(past).toBeLessThan(8 + 1e-3);
        expect(far).toBeLessThan(-8.5);
        expectBounds(threaded, [-10, -10, -10], [10, 10, 10]);
        // Asked 30 mm in a hole 20 mm long at most: it stops at the end, and the build says so.
        expect(threaded.notes?.join(' ')).toMatch(/cut to the length of the hole: 20 mm \(30 mm asked\)/);
    }, SLOW);

    it('keeps an extruded thread inside the part where the hole grazes a thin curved wall', async () => {
        // A block 30 x 20 x 20 with a 5 mm hole along X; a large round cut (radius 60, axis along Y) passes over the
        // hole at a grazing angle: for x > 0 it leaves a wall over the hole that thins to nothing, for x < 0 the hole
        // is open along its top.
        const block = sharpBox([30, 20, 20]);
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 4.8 }, position: [15, 0, 0], direction: [-1, 0, 0] };
        const r = (4.8 + DEFAULT_PRINT.holeTolerance) / 2;
        const round: Feature = { id: 'c', op: 'cut', shape: { kind: 'cylinder', radius: 60, height: 40, bevel: 0 }, position: [-8.9, 0, 61.93] };
        const thread: Feature = { id: 't', op: 'thread', kind: 'internal', at: [15, r, 0], pitch: 0.8, length: 30, diameter: 4.8, method: 'extrude' };
        const plugged = await mesh(block, [round]);
        const drilled = await mesh(block, [round, hole]);
        const threaded = await mesh(block, [round, hole, thread]);
        // (The mesher folds a few triangles on the long bore face split by the ridges here; the solid itself is valid.)
        expect(volume(threaded)).toBeGreaterThan(volume(drilled) + 5);
        // Every point of the ridges lies in the part as it was before the hole was drilled: nothing stands out past
        // the curved face, however thin the wall beside the hole gets.
        let ridge = 0;
        let outside = 0;
        for (let i = 0; i < threaded.positions.length; i += 3) {
            const p: Vec3 = [threaded.positions[i], threaded.positions[i + 1], threaded.positions[i + 2]];
            if (Math.hypot(p[1], p[2]) < r - 0.05) {
                ridge++;
                if (!insideMesh(plugged, p, 1e-3)) {
                    outside++;
                }
            }
        }
        expect(ridge).toBeGreaterThan(100);
        expect(outside).toBe(0);
    }, SLOW);

    it('threads several holes in one step, each from its own edge, and names the edge that fails', async () => {
        const block = sharpBox([30, 20, 20]);
        const holes: Feature[] = [-5, 5].map((z, i) => ({
            id: `h${i}`, op: 'hole', spec: { kind: 'plain', diameter: 5 }, position: [0, 10, z], direction: [0, -1, 0], depth: i ? 8 : 12,
        } as Feature));
        const r = (5 + DEFAULT_PRINT.holeTolerance) / 2;
        const thread = (at: Vec3, alsoAt?: Vec3[]): Feature => ({
            id: 't', op: 'thread', kind: 'internal', at, ...(alsoAt ? { alsoAt } : {}), pitch: 0.8, length: 20,
        } as Feature);
        const drilled = await mesh(block, holes);
        const first = await mesh(block, [...holes, thread([r, 10, -5])]);
        const second = await mesh(block, [...holes, thread([r, 10, 5])]);
        const both = await mesh(block, [...holes, thread([r, 10, -5], [[r, 10, 5]])]);
        expect(openEdges(both)).toBe(0);
        // Each hole decides its own thread length (12 and 8 mm deep): the two together take what each takes alone.
        const taken = (m: MeshData): number => volume(drilled) - volume(m);
        expect(taken(first)).toBeGreaterThan(taken(second) * 1.2);
        expect(Math.abs(taken(both) - taken(first) - taken(second))).toBeLessThan(0.02 * (taken(first) + taken(second)));
        await expect(mesh(block, [...holes, thread([r, 10, -5], [[14, 9, 9]])])).rejects.toThrow(/Edge<2>: .*circular edge/);
    }, SLOW);

    it('shows a thread being edited as its ridges on the body, at once, for a preview', async () => {
        const block = sharpBox([20, 20, 20]);
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 8 }, position: [10, 0, 0], direction: [-1, 0, 0] };
        const r = (8 + DEFAULT_PRINT.holeTolerance) / 2;
        const drilled = await mesh(block, [hole]);
        const started = Date.now();
        const ghost = await mesh(block, [hole, { id: 't', op: 'thread', kind: 'internal', at: [10, r, 0], pitch: 1.5, length: 30, preview: true }]);
        expect(Date.now() - started).toBeLessThan(10_000);
        // The body as it was, with the ridge laid in the hole: 30 mm asked, trimmed to the 20 mm hole.
        expect(ghost.indices.length).toBeGreaterThan(drilled.indices.length);
        let [least, most] = [Infinity, -Infinity];
        for (let i = drilled.positions.length; i < ghost.positions.length; i += 3) {
            least = Math.min(least, ghost.positions[i]);
            most = Math.max(most, ghost.positions[i]);
            // Sized from the hole: its major diameter is the hole plus 1.0825 x pitch.
            expect(Math.hypot(ghost.positions[i + 1], ghost.positions[i + 2])).toBeLessThan(r + (1.0825 * 1.5) / 2 + 0.15);
        }
        expect(least).toBeGreaterThan(-10.01);
        expect(most).toBeLessThan(10.01);

        // The ghost shows only what the build keeps: nothing past a slanted face the hole comes out through, and the
        // build says the thread stops at the end of the hole.
        const slant: Feature = { id: 's', op: 'chamfer', size: 12, at: [[-10, 10, 0]] };
        const slanted = await mesh(block, [slant, hole, { id: 't', name: 'Thread1', op: 'thread', kind: 'internal', at: [10, r, 0], pitch: 1.5,
            length: 40, diameter: 8, method: 'extrude', preview: true }]);
        let past = -Infinity;
        for (let i = 0; i < slanted.positions.length; i += 3) {
            past = Math.max(past, slanted.positions[i + 1] - slanted.positions[i]);
        }
        expect(past).toBeLessThan(8 + 1e-3);
        expect(slanted.notes?.join(' ')).toMatch(/Thread1: cut to the length of the hole: [\d.]+ mm \(40 mm asked\)/);
    }, SLOW);
});

describe('fasteners', () => {
    it('builds an M3x12 socket cap to the table', async () => {
        const m = await mesh({ kind: 'fastener', type: 'socketCap', size: 'M3', length: 12 });
        expectBounds(m, [-2.75, -12, -2.75], [2.75, 3, 2.75]);
    }, SLOW);

    it('falls back to the table sizes for every hardware type', async () => {
        const cases: [Shape, Vec3, Vec3][] = [
            [{ kind: 'fastener', type: 'socketCap', size: 'M3', length: 12, thread: 'plain' }, [-2.75, -12, -2.75], [2.75, 3, 2.75]],
            [{ kind: 'fastener', type: 'countersunk', size: 'M4', length: 16 }, [-4.48, -16, -4.48], [4.48, 0, 4.48]],
            [{ kind: 'fastener', type: 'hexBolt', size: 'M5', length: 20 }, [-4.62, -20, -4], [4.62, 3.5, 4]],
            [{ kind: 'fastener', type: 'hexNut', size: 'M3' }, [-3.175, 0, -2.75], [3.175, 2.4, 2.75]],
            [{ kind: 'fastener', type: 'squareNut', size: 'M3' }, [-2.75, 0, -2.75], [2.75, 1.8, 2.75]],
            [{ kind: 'fastener', type: 'washer', size: 'M3' }, [-3.5, 0, -3.5], [3.5, 0.5, 3.5]],
            [{ kind: 'fastener', type: 'heatsetInsert', size: 'M3' }, [-2.3, 0, -2.3], [2.3, 5.7, 2.3]],
            [{ kind: 'fastener', type: 'nylocNut', size: 'M4' }, [-4.04, 0, -3.5], [4.04, 5, 3.5]],
        ];
        for (const [shape, min, max] of cases) {
            const m = await mesh(shape);
            expectBounds(m, min, max);
            expect(openEdges(m)).toBe(0);
        }
        const button = bounds(await mesh({ kind: 'fastener', type: 'buttonHead', size: 'M3', length: 10 }));
        expect(button.min[1]).toBeCloseTo(-10, 2);
        // The dome peaks at the head height, minus the hex socket in its centre.
        expect(button.max[1]).toBeLessThan(1.66);
        expect(button.max[0]).toBeCloseTo(2.85, 1);
    }, SLOW);

    it('models a helical thread on the shank', async () => {
        const modelled = await mesh({ kind: 'fastener', type: 'socketCap', size: 'M3', length: 12 });
        const plain = await mesh({ kind: 'fastener', type: 'socketCap', size: 'M3', length: 12, thread: 'plain' });
        expect(modelled.indices.length).toBeGreaterThan(plain.indices.length * 2);
        // Thread crests reach the major diameter; the core sits at the root.
        const shankRadii: number[] = [];
        for (let i = 0; i < modelled.positions.length; i += 3) {
            const y = modelled.positions[i + 1];
            if (y < -3 && y > -9) {
                shankRadii.push(Math.hypot(modelled.positions[i], modelled.positions[i + 2]));
            }
        }
        expect(Math.max(...shankRadii)).toBeCloseTo(1.5, 1);
        expect(Math.min(...shankRadii)).toBeLessThan(1.2);
    }, SLOW);
});

describe('scripts', () => {
    const script = (code: string, params?: Record<string, number>): Shape => ({ kind: 'script', code, params, size: [10, 10, 10] });

    it('authors in replicad Z-up and turns the result to Y-up', async () => {
        const m = await mesh(script('return r.makeBaseBox(10, 20, 30);'));
        // makeBaseBox is centred in X/Y with Z from 0 to 30: script Z becomes Y, script Y becomes -Z.
        expectBounds(m, [-5, 0, -10], [5, 30, 10], 1e-4);
    }, SLOW);

    it('lofts two sketches and uses params', async () => {
        const m = await mesh(script(
            'return r.sketchCircle(params.radius).loftWith(r.sketchRectangle(8, 8, { origin: params.height }));',
            { radius: 6, height: 20 },
        ));
        expectBounds(m, [-6, 0, -6], [6, 20, 6]);
        expect(openEdges(m)).toBe(0);
    }, SLOW);

    it('sweeps a profile along a spline', async () => {
        const m = await mesh(script(`
            const spine = r.assembleWire([r.makeBSplineApproximation([[0, 0, 0], [0, 0, 10], [5, 0, 20], [15, 0, 25]])]);
            const profile = r.assembleWire([r.makeCircle(2, [0, 0, 0], [0, 0, 1])]);
            return r.genericSweep(profile, spine, { frenet: true });
        `));
        const b = bounds(m);
        expect(b.max[0]).toBeGreaterThan(15);
        expect(b.max[1]).toBeGreaterThan(24);
        expect(volume(m)).toBeGreaterThan(Math.PI * 4 * 25);
    }, SLOW);

    it('supports features on a script body', async () => {
        const plain = await mesh(script('return r.makeBaseBox(20, 20, 10);'));
        const holed = await mesh(script('return r.makeBaseBox(20, 20, 10);'), [
            { id: 'h', name: 'Centre hole', op: 'hole', spec: { kind: 'plain', diameter: 4 }, position: [0, 10, 0] },
        ]);
        expect(volume(holed)).toBeLessThan(volume(plain) - 100);
    }, SLOW);

    it('unwraps a boolean compound so features apply, and rejects an empty one', async () => {
        const code = `
            const side = r.drawRectangle(40, 20).sketchOnPlane('XZ').extrude(-30);
            const top = r.drawRectangle(30, 30).sketchOnPlane('XY').extrude(30);
            const both = side.intersect(top);
            if (both.constructor.name !== 'Compound' && both.constructor.name !== 'Solid') throw new Error('odd type');
            return both;`;
        const m = await mesh(script(code), [{ id: 'f', name: 'Soften', op: 'fillet', radius: 4 }]);
        expect(openEdges(m)).toBe(0);
        // Script box x +-15, y 0..15, z 0..10, every edge rounded: script Z becomes Y and script Y becomes -Z.
        expectBounds(m, [-15, 0, -15], [15, 10, 0]);
        expect(volume(m)).toBeLessThan(30 * 15 * 10 - 50);
        await expect(mesh(script(`
            return r.makeBaseBox(10, 10, 10).intersect(r.makeBaseBox(10, 10, 10).translate([50, 0, 0]));
        `))).rejects.toThrow(/^script: result is empty/);
        // Several separate solids are fine on their own, but features that need one solid say why.
        const twoCode = 'return r.makeBaseBox(10, 10, 10).fuse(r.makeBaseBox(10, 10, 10).translate([30, 0, 0]));';
        const two = await mesh(script(twoCode));
        expect(volume(two)).toBeCloseTo(2000, 2);
        await expect(mesh(script(twoCode), [{ id: 'f', name: 'Round', op: 'fillet', radius: 1 }]))
            .rejects.toThrow(/^feature "Round" \(fillet\): fillet needs a single solid/);
    }, SLOW);

    it('meshes a large spline extrusion quickly, with a coarser tolerance', async () => {
        const deck = script(`
            const outline = r.drawPointsInterpolation(
                [[-405, 0], [-300, 90], [0, 102], [300, 90], [405, 0], [300, -90], [0, -102], [-300, -90]],
                {}, { closeShape: true });
            return outline.sketchOnPlane('XY').extrude(78);`);
        const start = performance.now();
        const m = await mesh(deck);
        expect(performance.now() - start).toBeLessThan(8_000);
        expect(m.indices.length / 3).toBeLessThan(20_000);
        expect(openEdges(m)).toBe(0);
        expect(bounds(m).max[0]).toBeGreaterThan(400);
    }, SLOW);

    it('reports script errors', async () => {
        await expect(mesh(script('throw new Error("bad wing");'))).rejects.toThrow(/^script: bad wing/);
        await expect(mesh(script('return 42;'))).rejects.toThrow(/^script: must return a solid, got number/);
        await expect(mesh(script('return r.sketchCircle(3);'))).rejects.toThrow(/^script: must return a solid, got Sketch/);
        await expect(mesh(script('return r.makeBox([0, 0, 0], [1, 1, 1]).fillet(5);'))).rejects.toThrow(/^script: /);
    }, SLOW);

    it('cannot reach the host', async () => {
        await expect(mesh(script('process.exit(1);'))).rejects.toThrow(/^script: .*process/);
        await expect(mesh(script('return require("fs");'))).rejects.toThrow(/^script: .*require/);
        await expect(mesh(script('return r.makeBox.constructor("return process")();'))).rejects.toThrow(/^script: /);
        await expect(mesh(script('return Object.getPrototypeOf(r.makeBox).constructor("return process")();')))
            .rejects.toThrow(/^script: /);
        await expect(mesh(script('return new Function("return process")();'))).rejects.toThrow(/^script: /);
        await expect(mesh(script('return eval("process");'))).rejects.toThrow(/^script: /);
        await expect(mesh(script(`
            try { r.makeBox(); } catch (e) { return e.constructor.constructor("return process")(); }
        `))).rejects.toThrow(/^script: /);
        await expect(mesh(script('return typeof fetch + typeof setTimeout + typeof globalThis.process;')))
            .rejects.toThrow(/got string/);
        // The worker survived all of that.
        expect(volume(await mesh(sharpBox([1, 2, 3])))).toBeCloseTo(6, 3);
    }, SLOW);

    it('lists the replicad API', () => {
        const names = replicadApiNames();
        expect(names).toContain('makeBaseBox');
        expect(names).toContain('loft');
    });
});

describe('errors and keys', () => {
    it('names the failing feature and keeps the solid up to it', async () => {
        const features: Feature[] = [
            { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 3 }, position: [0, 5, 0] },
            { id: 'f', name: 'Lid round-over', op: 'fillet', radius: 50, edges: 'top' },
        ];
        const error = await mesh(sharpBox([20, 10, 20]), features).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CadBuildError);
        expect((error as Error).message).toMatch(/^feature "Lid round-over" \(fillet\): /);
        const partial = (error as CadBuildError).partial!;
        expect(partial).toBeDefined();
        expectBounds(partial, [-10, -5, -10], [10, 5, 10]);
        const missing = await mesh(sharpBox([20, 10, 20]), [
            { id: 'm', name: 'Lost hole', op: 'hole', spec: { kind: 'plain', diameter: 3 }, position: [100, 5, 0] },
        ]).then(() => new Error('built'), (e: unknown) => e as Error);
        expect(missing.message).toMatch(/^feature "Lost hole" \(hole\): .*does not touch/);
        const shell = await mesh({ kind: 'sphere', radius: 5 }, [{ id: 's', op: 'shell', thickness: 1, open: ['top'] }])
            .then(() => new Error('built'), (e: unknown) => e as Error);
        expect(shell.message).toMatch(/^feature "s" \(shell\): no flat face faces top/);
    }, SLOW);

    it('changes the mesh key only when geometry changes', () => {
        const part: Pick<Part, 'shape' | 'features'> = {
            shape: { kind: 'box', size: [10, 10, 10] },
            features: [{ id: 'a', name: 'Round', op: 'fillet', radius: 1 }],
        };
        const key = meshKey(part, DEFAULT_PRINT);
        expect(meshKey(structuredClone(part), DEFAULT_PRINT)).toBe(key);
        expect(meshKey({ ...part, features: [{ id: 'b', name: 'Renamed', op: 'fillet', radius: 1 }] }, DEFAULT_PRINT)).toBe(key);
        expect(meshKey({ shape: { size: [10, 10, 10], kind: 'box' }, features: part.features }, DEFAULT_PRINT)).toBe(key);
        expect(meshKey({ ...part, features: [{ id: 'a', op: 'fillet', radius: 2 }] }, DEFAULT_PRINT)).not.toBe(key);
        expect(meshKey({ ...part, features: [{ id: 'a', op: 'fillet', radius: 1, edges: 'top' }] }, DEFAULT_PRINT)).not.toBe(key);
        expect(meshKey({ ...part, features: [{ id: 'a', op: 'fillet', radius: 1, suppressed: true }] }, DEFAULT_PRINT))
            .toBe(meshKey({ shape: part.shape }, DEFAULT_PRINT));
        expect(meshKey(part, { ...DEFAULT_PRINT, holeTolerance: 0.3 })).not.toBe(key);
        expect(meshKey({ ...part, shape: { kind: 'box', size: [10, 10, 11] } }, DEFAULT_PRINT)).not.toBe(key);
    });

    it('shares one job between concurrent requests and caches the result', async () => {
        const part = { shape: sharpBox([3, 4, 5]) };
        const [a, b] = await Promise.all([kernel.mesh(part, DEFAULT_PRINT), kernel.mesh(structuredClone(part), DEFAULT_PRINT)]);
        expect(a).toBe(b);
        expect(await kernel.mesh(part, DEFAULT_PRINT)).toBe(a);
    }, SLOW);
});

describe('STEP export', () => {
    it('exports the assembled project as STEP', async () => {
        const part = (id: string, shape: Shape, position: Vec3, extra: Partial<Part> = {}): Part => ({
            id, name: id, shape, position, rotation: [0, 0, 0], material: { color: '#3366cc', metalness: 0, roughness: 0.5 },
            ...extra,
        });
        const project: Project = {
            name: 'step test',
            view: { ...DEFAULT_VIEW },
            parts: [
                part('Base', { kind: 'box', size: [40, 10, 30] }, [0, 5, 0], {
                    features: [{ id: 'h', op: 'hole', spec: { kind: 'clearance', size: 'M3' }, position: [15, 5, 10] }],
                }),
                part('Screw', { kind: 'fastener', type: 'socketCap', size: 'M3', length: 8 }, [15, 10, 10], {
                    repeat: { kind: 'radial', count: 2 },
                }),
            ],
        };
        const bytes = await kernel.step(project);
        const text = bytes.toString('latin1');
        expect(text.startsWith('ISO-10303-21')).toBe(true);
        expect(text).toContain('Base');
        expect(text).toContain('Screw 2');
    }, SLOW);
});

describe('blends OpenCascade cannot make itself', () => {
    // A loft from a hexagon on the top plane through a circle to a slot on front planes, and a 5 mm hole drilled from
    // the slot's end along its wall. The hole leaves the lofted side at down to about 12°, and the edge between two
    // loft faces ends on the rim just where the faces meet most shallowly: OpenCascade cannot blend the rim at any size.
    const loftedHole: Feature[] = [
        { id: 's1', op: 'sketch', sketch: { plane: 'top', profiles: [{ kind: 'path', start: [0, -34.641016], segments: [
            { kind: 'line', to: [30, -17.320508] }, { kind: 'line', to: [30, 17.320508] }, { kind: 'line', to: [0, 34.641016] },
            { kind: 'line', to: [-30, 17.320508] }, { kind: 'line', to: [-30, -17.320508] }, { kind: 'line', to: [0, -34.641016] }] }] } },
        { id: 'p1', op: 'plane', definition: { kind: 'offset', base: 'front', distance: -60 } },
        { id: 's2', op: 'sketch', sketch: { plane: { planeRef: 'p1' }, profiles: [{ kind: 'circle', center: [0, 50], radius: 13.601471 }] } },
        { id: 'p2', op: 'plane', definition: { kind: 'offset', base: { planeRef: 'p1' }, distance: -100 } },
        { id: 's3', op: 'sketch', sketch: { plane: { planeRef: 'p2' }, profiles: [{ kind: 'path', start: [-10.745731, 82.689468], segments: [
            { kind: 'line', to: [-10.745731, 20.349972] }, { kind: 'arc', to: [10.697081, 20.349972], through: [-0.024325, 9.628566] },
            { kind: 'line', to: [10.697081, 82.689468] }, { kind: 'arc', to: [-10.745731, 82.689468], through: [-0.024325, 93.410874] }] }] } },
        { id: 'loft', op: 'loft', sections: [{ sketchRef: 's1' }, { sketchRef: 's2' }, { sketchRef: 's3' }], ruled: false, mode: 'add' },
        { id: 's4', op: 'sketch', sketch: { plane: 'front', offset: -160, profiles: [{ kind: 'circle', center: [0.176808, 87.72219], radius: 2.5 }] } },
        { id: 'hole', op: 'extrude', sketchRef: 's4', direction: 'normal', mode: 'cut', end: 'upToNext' },
    ];
    // Two of the rim's three edges, picked in the view; tangent propagation takes the third.
    const rim: Vec3[] = [[-2.303704628938097, 87.62845139266044, -123.06596392782969], [2.2952299477679254, 89.03252772500524, -129.14315994117138]];

    it('fillets the rim of a hole leaving a lofted surface at a shallow angle, and says where a chamfer cannot go', async () => {
        const plain = await mesh({ kind: 'empty' }, loftedHole);
        for (const radius of [0.1, 0.5]) {
            const filleted = await mesh({ kind: 'empty' }, [...loftedHole, { id: 'f', op: 'fillet', radius, at: rim, tangent: true }]);
            expect(openEdges(filleted)).toBe(0);
            // A rolling ball of 0.5 mm takes off about 14.4 mm³, most of it at the knife-edge end of the opening, where
            // the faces meet at about 12° (0.1 mm takes 0.5 mm³, below what the mesh's volume resolves here).
            const removed = volume(plain) - volume(filleted);
            expect(removed).toBeGreaterThan(radius === 0.5 ? 10 : 0);
            expect(removed).toBeLessThan(radius === 0.5 ? 19 : 1);
        }
        // Where the loft face edge meets the rim, the rim bends: a chamfer would need a mitre on the inside of that bend.
        await expect(mesh({ kind: 'empty' }, [...loftedHole, { id: 'c', name: 'Chamfer1', op: 'chamfer', size: 0.5, at: rim, tangent: true }]))
            .rejects.toThrow(/^feature "Chamfer1" \(chamfer\): chamfer of 0\.5 mm cannot be made on the selected edges: the chamfer would fold over itself at \(-0\.009, 85\.229, -112\.854\)/);
    }, SLOW);

    it('chamfers a top edge that ends on an earlier smaller round, running the chamfer out into it', async () => {
        // Block x -20..20, y -10..10, z -15..15; the vertical edge at x = 20, z = 15 rounded by 1 mm first.
        const round: Feature = { id: 'r', name: 'Fillet2', op: 'fillet', radius: 1, at: [[20, 0, 15]] };
        const block = sharpBox([40, 20, 30]);
        const rounded = await mesh(block, [round]);
        const chamfered = await mesh(block, [round, { id: 'c', name: 'Chamfer1', op: 'chamfer', size: 3, at: [[0, 10, 15]], tangent: true }]);
        expect(openEdges(chamfered)).toBe(0);
        // Both top edges beside the round (39 and 29 mm long) lose a 3 mm chamfer of 4.5 mm² cross-section; the two
        // chamfers meet in a mitre over the round, which they run out into.
        expect(volume(rounded) - volume(chamfered)).toBeCloseTo(305.4, 0);
        expectBounds(chamfered, [-20, -10, -15], [20, 10, 15]);
        // A round there runs out the same way.
        const filleted = await mesh(block, [round, { id: 'f', op: 'fillet', radius: 3, at: [[0, 10, 15]], tangent: true }]);
        expect(openEdges(filleted)).toBe(0);
        expect(volume(rounded) - volume(filleted)).toBeGreaterThan(0.9 * 68 * (9 - 9 * Math.PI / 4));
    }, SLOW);
});

describe('timeouts', () => {
    it('restarts the worker when a job takes too long', async () => {
        const fast = CadKernel.start({ timeoutMs: 1 });
        try {
            await expect(fast.mesh({ shape: { kind: 'fastener', type: 'heatsetInsert', size: 'M8' } }, DEFAULT_PRINT))
                .rejects.toThrow(/timed out.*restarted/);
            fast.timeoutMs = 60_000;
            const m = await fast.mesh({ shape: sharpBox([1, 1, 1]) }, DEFAULT_PRINT);
            expect(volume(m)).toBeCloseTo(1, 4);
            // The timed-out part was not cached as a failure: it builds now.
            const insert = await fast.mesh({ shape: { kind: 'fastener', type: 'heatsetInsert', size: 'M8' } }, DEFAULT_PRINT);
            expect(insert.indices.length).toBeGreaterThan(0);
        } finally {
            await fast.close();
        }
    }, SLOW);
});
