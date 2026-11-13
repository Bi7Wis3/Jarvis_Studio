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
