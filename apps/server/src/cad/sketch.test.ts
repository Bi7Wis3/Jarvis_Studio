import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRINT, type Feature, type Shape, type Sketch, type SketchShape, type Vec3 } from '@jarvis/core';
import { CadKernel, meshKey, type MeshData } from './kernel.js';

const SLOW = 120_000;

let kernel: CadKernel;

beforeAll(() => {
    kernel = CadKernel.start();
});

afterAll(async () => {
    await kernel.close();
});

const mesh = (shape: Shape, features?: Feature[]): Promise<MeshData> => kernel.mesh({ shape, features }, DEFAULT_PRINT);

function bounds(m: MeshData): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], m.positions[i + k]);
            max[k] = Math.max(max[k], m.positions[i + k]);
        }
    }
    return { min, max };
}

function volume(m: MeshData): number {
    const p = m.positions;
    let v = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
        v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
            + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
}

function expectBounds(m: MeshData, min: Vec3, max: Vec3, tolerance = 0.05): void {
    const b = bounds(m);
    for (let k = 0; k < 3; k++) {
        expect(Math.abs(b.min[k] - min[k]), `min[${k}] ${b.min[k]} vs ${min[k]}`).toBeLessThan(tolerance);
        expect(Math.abs(b.max[k] - max[k]), `max[${k}] ${b.max[k]} vs ${max[k]}`).toBeLessThan(tolerance);
    }
}

const rect = (center: [number, number], width: number, height: number) => ({ kind: 'rect' as const, center, width, height });
const body = (sketch: Sketch, extrude: SketchShape['extrude'], revolve?: SketchShape['revolve']): SketchShape =>
    ({ kind: 'sketch', sketch, extrude, revolve });
const sharpBox = (size: Vec3): Shape => ({ kind: 'box', size, radius: 0 });

describe('sketch planes', () => {
    // A 10 x 20 rectangle centred at (u, v) = (5, 3): u 0..10, v -7..13.
    const profile = rect([5, 3], 10, 20);

    it('maps top: normal +Y, u = +X, v = -Z', async () => {
        expectBounds(await mesh(body({ plane: 'top', profiles: [profile] }, { distance: 2 })), [0, 0, -13], [10, 2, 7]);
    }, SLOW);

    it('maps front: normal +Z, u = +X, v = +Y', async () => {
        expectBounds(await mesh(body({ plane: 'front', profiles: [profile] }, { distance: 2 })), [0, -7, 0], [10, 13, 2]);
    }, SLOW);

    it('maps right: normal +X, u = -Z, v = +Y', async () => {
        expectBounds(await mesh(body({ plane: 'right', profiles: [profile] }, { distance: 2 })), [0, -7, -10], [2, 13, 0]);
    }, SLOW);

    it('extrudes along, against and either side of the normal, from the offset plane', async () => {
        const sketch: Sketch = { plane: 'top', offset: 5, profiles: [profile] };
        const y = async (extrude: SketchShape['extrude']): Promise<[number, number]> => {
            const b = bounds(await mesh(body(sketch, extrude)));
            return [b.min[1], b.max[1]];
        };
        const close = (actual: [number, number], expected: [number, number]): void => {
            expect(actual[0]).toBeCloseTo(expected[0], 3);
            expect(actual[1]).toBeCloseTo(expected[1], 3);
        };
        close(await y({ distance: 2 }), [5, 7]);
        close(await y({ distance: 2, direction: 'reverse' }), [3, 5]);
        close(await y({ distance: -2 }), [3, 5]);
        close(await y({ distance: 2, direction: 'symmetric' }), [4, 6]);
    }, SLOW);
});

describe('sketch profiles', () => {
    it('turns a circle inside a rectangle into a hole', async () => {
        const m = await mesh(body({ plane: 'top', profiles: [rect([0, 0], 40, 30), { kind: 'circle', center: [5, 0], radius: 5 }] },
            { distance: 4 }));
        expect(volume(m)).toBeCloseTo(4 * (1200 - 25 * Math.PI), -1);
    }, SLOW);

    it('nests islands inside holes, and keeps separate profiles as separate regions', async () => {
        const m = await mesh(body({ plane: 'front', profiles: [
            rect([0, 0], 40, 40),
            { kind: 'circle', center: [0, 0], radius: 15 },
            rect([0, 0], 10, 10),
            { kind: 'circle', center: [40, 0], radius: 3 },
        ] }, { distance: 4 }));
        expect(volume(m)).toBeCloseTo(4 * (1600 - 225 * Math.PI + 100 + 9 * Math.PI), -1);
    }, SLOW);

    it('builds slots and rounded rectangles', async () => {
        const slot = await mesh(body({ plane: 'front', profiles: [{ kind: 'slot', from: [0, 0], to: [20, 0], radius: 5 }] },
            { distance: 2 }));
        expectBounds(slot, [-5, -5, 0], [25, 5, 2]);
        expect(volume(slot)).toBeCloseTo(2 * (200 + 25 * Math.PI), -1);
        const rounded = await mesh(body({ plane: 'front', profiles: [{ ...rect([0, 0], 20, 10), radius: 2 }] }, { distance: 1 }));
        expect(volume(rounded)).toBeCloseTo(200 - (16 - 4 * Math.PI), 0);
    }, SLOW);

    it('builds paths with arcs, whose bulge counts in the bounds', async () => {
        const m = await mesh(body({ plane: 'front', profiles: [{
            kind: 'path', start: [0, 0],
            segments: [{ kind: 'line', to: [20, 0] }, { kind: 'arc', through: [25, 5], to: [20, 10] }, { kind: 'line', to: [0, 10] }],
        }] }, { distance: 1 }));
        expectBounds(m, [0, 0, 0], [25, 10, 1]);
        expect(volume(m)).toBeCloseTo(200 + (25 * Math.PI) / 2, 0);
    }, SLOW);

    it('revolves a rectangle offset from the axis into a tube', async () => {
        const m = await mesh(body({ plane: 'front', profiles: [rect([7.5, 5], 5, 10)] }, undefined, { axis: 'v' }));
        expectBounds(m, [-10, 0, -10], [10, 10, 10]);
        expect(volume(m) / (Math.PI * (100 - 25) * 10)).toBeCloseTo(1, 2);
        const half = await mesh(body({ plane: 'front', profiles: [rect([7.5, 5], 5, 10)] }, undefined, { axis: 'v', angle: 180 }));
        expect(volume(half) / volume(m)).toBeCloseTo(0.5, 2);
    }, SLOW);
});

describe('sketch features', () => {
    it('extrudes a boss onto a box top', async () => {
        const m = await mesh(sharpBox([20, 10, 20]), [{
            id: 'boss', op: 'extrude', mode: 'add', distance: 4,
            sketch: { plane: 'top', offset: 5, profiles: [{ kind: 'circle', center: [0, 0], radius: 3 }] },
        }]);
        expect(bounds(m).max[1]).toBeCloseTo(9, 3);
        expect(volume(m)).toBeCloseTo(4000 + Math.PI * 9 * 4, 0);
    }, SLOW);

    it('cuts a through-all pocket', async () => {
        const m = await mesh(sharpBox([20, 10, 20]), [{
            id: 'p', op: 'extrude', mode: 'cut', through: true, direction: 'reverse',
            sketch: { plane: 'top', offset: 5, profiles: [rect([2, 2], 6, 6)] },
        }]);
        expect(volume(m)).toBeCloseTo(4000 - 36 * 10, 1);
        // From a plane in the middle of the part, symmetric through goes both ways.
        const both = await mesh(sharpBox([20, 10, 20]), [{
            id: 'p', op: 'extrude', mode: 'cut', through: true, direction: 'symmetric',
            sketch: { plane: 'front', profiles: [rect([0, 0], 4, 4)] },
        }]);
        expect(volume(both)).toBeCloseTo(4000 - 16 * 20, 1);
    }, SLOW);

    it('cuts a revolved groove', async () => {
        const groove: Feature = {
            id: 'g', op: 'revolve', mode: 'cut', axis: 'v', sketch: { plane: 'front', profiles: [rect([10, 0], 2, 2)] },
        };
        const cylinder: Shape = { kind: 'cylinder', radius: 10, height: 20, bevel: 0 };
        const removed = volume(await mesh(cylinder)) - volume(await mesh(cylinder, [groove]));
        expect(removed / (Math.PI * (100 - 81) * 2)).toBeCloseTo(1, 1);
    }, SLOW);

    it('reports a sketch cut that misses the part', async () => {
        await expect(mesh(sharpBox([10, 10, 10]), [{
            id: 'm', name: 'Far pocket', op: 'extrude', mode: 'cut', distance: 2,
            sketch: { plane: 'top', offset: 5, profiles: [rect([100, 0], 4, 4)] },
        }])).rejects.toThrow(/^feature "Far pocket" \(extrude\): .*does not touch the part/);
    }, SLOW);
});

describe('sketch errors', () => {
    it('names an invalid profile', async () => {
        const bowtie = { kind: 'polygon' as const, points: [[0, 0], [10, 10], [10, 0], [0, 10]] as [number, number][] };
        await expect(mesh(body({ plane: 'top', profiles: [rect([0, 0], 30, 30), bowtie] }, { distance: 1 })))
            .rejects.toThrow(/profile 1 \(polygon\): is self-intersecting/);
        await expect(mesh(body({ plane: 'top', profiles: [{ kind: 'circle', center: [0, 0], radius: 0 }] }, { distance: 1 })))
            .rejects.toThrow(/profile 0 \(circle\): radius must be positive/);
        await expect(mesh(body({ plane: 'top', profiles: [{ kind: 'path', start: [0, 0],
            segments: [{ kind: 'arc', through: [5, 0], to: [10, 0] }, { kind: 'line', to: [0, 5] }] }] }, { distance: 1 })))
            .rejects.toThrow(/profile 0 \(path\): arc points are in a straight line/);
        await expect(mesh(body({ plane: 'top', profiles: [rect([0, 0], 10, 10), rect([5, 0], 10, 10)] }, { distance: 1 })))
            .rejects.toThrow(/profile 0 \(rect\) and profile 1 \(rect\) overlap/);
        await expect(mesh(body({ plane: 'front', profiles: [rect([0, 0], 10, 10)] }, undefined, { axis: 'v' })))
            .rejects.toThrow(/crosses the Sketch V \(vertical\) axis/);
    }, SLOW);

    it('needs exactly one of extrude or revolve', async () => {
        const sketch: Sketch = { plane: 'top', profiles: [rect([0, 0], 10, 10)] };
        await expect(mesh(body(sketch, undefined))).rejects.toThrow(/exactly one of extrude or revolve/);
        await expect(mesh(body(sketch, { distance: 2 }, { axis: 'u' }))).rejects.toThrow(/exactly one of extrude or revolve/);
        await expect(mesh(sharpBox([10, 10, 10]), [{ id: 'e', op: 'extrude', mode: 'add', sketch }]))
            .rejects.toThrow(/^feature "e" \(extrude\): extrude needs a distance or through/);
    }, SLOW);
});

describe('mirror', () => {
    const offsetBox: Feature = { id: 'm0', op: 'add', shape: sharpBox([10, 4, 6]), position: [15, 0, 0] };

    it('mirrors across YZ and keeps the original', async () => {
        const m = await mesh(sharpBox([10, 4, 6]), [offsetBox, { id: 'm', op: 'mirror', plane: 'YZ' }]);
        // The body is the centred box plus the box at +X; mirrored, the +X box appears at -X too.
        expectBounds(m, [-20, -2, -3], [20, 2, 3]);
        expect(volume(m)).toBeCloseTo(3 * 240, 1);
    }, SLOW);

    it('replaces the body with its image when keepOriginal is false, through an offset plane', async () => {
        const flipped = await mesh(sharpBox([10, 4, 6]), [offsetBox, { id: 'm', op: 'mirror', plane: 'YZ', keepOriginal: false }]);
        expectBounds(flipped, [-20, -2, -3], [5, 2, 3]);
        expect(volume(flipped)).toBeCloseTo(480, 1);
        const up = await mesh(sharpBox([10, 4, 6]), [{ id: 'm', op: 'mirror', plane: 'XZ', offset: 5, keepOriginal: false }]);
        expectBounds(up, [-5, 8, -3], [5, 12, 3]);
        // Disjoint copies stay a compound: both pieces are there.
        const both = await mesh(sharpBox([10, 4, 6]), [{ id: 'm', op: 'mirror', plane: 'XY', offset: 10 }]);
        expectBounds(both, [-5, -2, -3], [5, 2, 23]);
        expect(volume(both)).toBeCloseTo(480, 1);
    }, SLOW);

    it('mirrors holes made before it', async () => {
        // Half a part (x -10..10) with a hole at x = 5, mirrored about its right face: x -10..30, holes at 5 and 15.
        const hole: Feature = { id: 'h', op: 'hole', spec: { kind: 'plain', diameter: 3 }, position: [5, 2, 0] };
        const m = await mesh(sharpBox([20, 4, 10]), [hole, { id: 'm', op: 'mirror', plane: 'YZ', offset: 10 }]);
        const r = (3 + DEFAULT_PRINT.holeTolerance) / 2;
        expectBounds(m, [-10, -2, -5], [30, 2, 5]);
        expect((40 * 4 * 10 - volume(m)) / (2 * Math.PI * r * r * 4)).toBeCloseTo(1, 1);
        // Replacing the body moves the hole to the other side.
        const flipped = await mesh(sharpBox([20, 4, 10]), [hole, { id: 'm', op: 'mirror', plane: 'YZ', keepOriginal: false }]);
        expect(volume(flipped)).toBeCloseTo(800 - Math.PI * r * r * 4, 0);
        const near = (x: number): boolean => {
            for (let i = 0; i < flipped.positions.length; i += 3) {
                if (Math.hypot(flipped.positions[i] - x, flipped.positions[i + 2]) < r + 0.01
                    && Math.abs(flipped.positions[i + 1] - 2) < 1e-3) return true;
            }
            return false;
        };
        expect(near(-5)).toBe(true);
        expect(near(5)).toBe(false);
    }, SLOW);
});

describe('sketch steps, loft and empty parts', () => {
    const plate: Sketch = { plane: 'top', profiles: [rect([0, 0], 20, 10), { kind: 'circle', center: [0, 0], radius: 2 }] };
    const empty: Shape = { kind: 'empty' };

    it('extrudes a referenced sketch like an inline one, and follows edits to it', async () => {
        const inline = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 3, sketch: plate }]);
        const steps: Feature[] = [
            { id: 's1', op: 'sketch', sketch: plate },
            { id: 'e', op: 'extrude', mode: 'add', distance: 3, sketchRef: 's1' },
        ];
        const byRef = await mesh(empty, steps);
        expect(volume(byRef)).toBeCloseTo(volume(inline), 3);
        expect(volume(byRef)).toBeCloseTo(3 * (200 - 4 * Math.PI), 0);
        const edited: Feature[] = [{ id: 's1', op: 'sketch', sketch: { ...plate, profiles: [rect([0, 0], 30, 10)] } }, steps[1]];
        expect(meshKey({ shape: empty, features: edited }, DEFAULT_PRINT)).not.toBe(meshKey({ shape: empty, features: steps }, DEFAULT_PRINT));
        expect(volume(await mesh(empty, edited))).toBeCloseTo(900, 1);
        // A suppressed sketch step still feeds the features that use it.
        const suppressed = await mesh(empty, [{ ...steps[0], suppressed: true }, steps[1]]);
        expect(volume(suppressed)).toBeCloseTo(volume(byRef), 3);
        await expect(mesh(empty, [{ id: 'e', name: 'Base', op: 'extrude', mode: 'add', distance: 3, sketchRef: 'nope' }]))
            .rejects.toThrow(/^feature "Base" \(extrude\): sketch "nope" not found/);
    }, SLOW);

    it('starts a body from an empty part and meshes a sketch-only part as nothing', async () => {
        const m = await mesh(empty, [
            { id: 's', op: 'sketch', sketch: plate },
            { id: 'e', op: 'extrude', mode: 'add', distance: 3, sketchRef: 's' },
            { id: 'f', op: 'fillet', radius: 0.5, edges: 'top' },
        ]);
        expectBounds(m, [-10, 0, -5], [10, 3, 5]);
        const nothing = await mesh(empty, [{ id: 's', op: 'sketch', sketch: plate }]);
        expect(nothing.positions.length).toBe(0);
        expect(nothing.indices.length).toBe(0);
        expect((await mesh(empty)).indices.length).toBe(0);
        await expect(mesh(empty, [{ id: 'f', name: 'Round', op: 'fillet', radius: 1 }]))
            .rejects.toThrow(/^feature "Round" \(fillet\): needs a body first/);
        await expect(mesh(empty, [{ id: 'c', op: 'extrude', mode: 'cut', distance: 2, sketch: plate }]))
            .rejects.toThrow(/needs a body first/);
        await expect(mesh(empty, [{ id: 't', op: 'extrude', mode: 'add', through: true, sketch: plate }]))
            .rejects.toThrow(/through needs a body/);
    }, SLOW);

    it('lofts a rectangle into a circle', async () => {
        const square: Sketch = { plane: 'top', profiles: [rect([0, 0], 20, 20)] };
        const round: Sketch = { plane: 'top', offset: 30, profiles: [{ kind: 'circle', center: [0, 0], radius: 8 }] };
        const m = await mesh(empty, [{ id: 'l', op: 'loft', mode: 'add', sections: [{ sketch: square }, { sketch: round }] }]);
        expectBounds(m, [-10, 0, -10], [10, 30, 10]);
        const v = volume(m);
        expect(v).toBeGreaterThan(Math.PI * 64 * 30);
        expect(v).toBeLessThan(400 * 30);
        expect(openEdges(m)).toBe(0);
    }, SLOW);

    it('makes ruled and smooth lofts differ', async () => {
        const sections = [
            { sketch: { plane: 'top' as const, profiles: [rect([0, 0], 20, 20)] } },
            { sketch: { plane: 'top' as const, offset: 15, profiles: [{ kind: 'circle' as const, center: [0, 0] as [number, number], radius: 4 }] } },
            { sketch: { plane: 'top' as const, offset: 30, profiles: [rect([0, 0], 20, 20)] } },
        ];
        const ruled = volume(await mesh(empty, [{ id: 'l', op: 'loft', mode: 'add', ruled: true, sections }]));
        const smooth = volume(await mesh(empty, [{ id: 'l', op: 'loft', mode: 'add', sections }]));
        expect(Math.abs(ruled - smooth)).toBeGreaterThan(100);
    }, SLOW);

    it('cuts a loft from a box, and rejects bad sections', async () => {
        const sections = [
            { sketch: { plane: 'top' as const, offset: -20, profiles: [rect([0, 0], 10, 10)] } },
            { sketch: { plane: 'top' as const, offset: 20, profiles: [{ kind: 'circle' as const, center: [0, 0] as [number, number], radius: 3 }] } },
        ];
        const m = await mesh(sharpBox([40, 40, 40]), [{ id: 'l', op: 'loft', mode: 'cut', sections }]);
        const removed = 64000 - volume(m);
        expect(removed).toBeGreaterThan(Math.PI * 9 * 40);
        expect(removed).toBeLessThan(100 * 40);
        await expect(mesh(empty, [{ id: 'l', name: 'Bad loft', op: 'loft', mode: 'add', sections: sections.slice(0, 1) }]))
            .rejects.toThrow(/^feature "Bad loft" \(loft\): a loft needs at least 2 sections/);
        await expect(mesh(empty, [{ id: 'l', op: 'loft', mode: 'add', sections: [{ sketch: plate }, sections[1]] }]))
            .rejects.toThrow(/section 0: needs exactly one closed profile/);
    }, SLOW);
});

function openEdges(m: MeshData): number {
    const q = (v: number): number => Math.round(v * 1e4);
    const ids = new Map<string, number>();
    const vertex: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
        const key = `${q(m.positions[i])},${q(m.positions[i + 1])},${q(m.positions[i + 2])}`;
        if (!ids.has(key)) ids.set(key, ids.size);
        vertex.push(ids.get(key)!);
    }
    const uses = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
            const a = vertex[m.indices[t + e]];
            const b = vertex[m.indices[t + ((e + 1) % 3)]];
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            uses.set(key, (uses.get(key) ?? 0) + 1);
        }
    }
    return [...uses.values()].filter((c) => c !== 2).length;
}

describe('custom sketch planes', () => {
    const profile = rect([5, 3], 10, 20);

    it('matches the named plane when it describes the same plane', async () => {
        const named = await mesh(body({ plane: 'front', offset: 2, profiles: [profile] }, { distance: 3 }));
        const custom = await mesh(body({ plane: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, offset: 2,
            profiles: [profile] }, { distance: 3 }));
        expect(bounds(custom)).toEqual(bounds(named));
        expect(volume(custom)).toBeCloseTo(volume(named), 6);
    }, SLOW);

    it('extrudes along a tilted normal, normalising and orthogonalising its vectors', async () => {
        // Normal halfway between +Y and +Z; u = +X, v = normal x u = (0, 1, -1) / sqrt 2.
        const s = Math.SQRT1_2;
        const expected = { min: [-5, -5 * s, -5 * s] as Vec3, max: [5, 9 * s, 9 * s] as Vec3 };
        for (const plane of [
            { origin: [0, 0, 0] as Vec3, normal: [0, 1, 1] as Vec3, xDir: [1, 0, 0] as Vec3 },
            { origin: [0, 0, 0] as Vec3, normal: [0, 2, 2] as Vec3, xDir: [3, 1, 1] as Vec3 },
        ]) {
            const m = await mesh(body({ plane, profiles: [rect([0, 0], 10, 10)] }, { distance: 4 }));
            expectBounds(m, expected.min, expected.max);
            expect(volume(m)).toBeCloseTo(400, 1);
        }
    }, SLOW);

    it('rejects degenerate planes', async () => {
        const bad = (plane: { origin: Vec3; normal: Vec3; xDir: Vec3 }) => mesh(body({ plane, profiles: [rect([0, 0], 4, 4)] }, { distance: 1 }));
        await expect(bad({ origin: [0, 0, 0], normal: [0, 0, 0], xDir: [1, 0, 0] })).rejects.toThrow(/normal must be a non-zero vector/);
        await expect(bad({ origin: [0, 0, 0], normal: [0, 1, 0], xDir: [0, 0, 0] })).rejects.toThrow(/xDir must be a non-zero vector/);
        await expect(bad({ origin: [0, 0, 0], normal: [0, 1, 0], xDir: [0, -3, 0] })).rejects.toThrow(/xDir must not be parallel/);
    }, SLOW);

    it('cuts through-all from a sketch on the angled face of a wedge', async () => {
        // Wedge: triangle (-20,0) (20,0) (20,20) in the front plane, 20 deep; the sloped face rises 1 in 2.
        const wedge: Feature = { id: 'w', op: 'extrude', mode: 'add', distance: 20, direction: 'symmetric',
            sketch: { plane: 'front', profiles: [{ kind: 'polygon', points: [[-20, 0], [20, 0], [20, 20]] }] } };
        const base = await mesh({ kind: 'empty' }, [wedge]);
        expect(volume(base)).toBeCloseTo(8000, 1);
        const m = await mesh({ kind: 'empty' }, [wedge, {
            id: 'h', name: 'Angled bore', op: 'extrude', mode: 'cut', through: true, direction: 'reverse',
            sketch: { plane: { origin: [0, 10, 0], normal: [-1, 2, 0], xDir: [2, 1, 0] },
                profiles: [{ kind: 'circle', center: [0, 0], radius: 3 }] },
        }]);
        // The bore runs along (1, -2) / sqrt 5 from the face centre to the floor at y = 0: 10 * sqrt 5 / 2 long.
        const removed = volume(base) - volume(m);
        expect(removed / (Math.PI * 9 * ((10 * Math.sqrt(5)) / 2))).toBeCloseTo(1, 1);
    }, SLOW);

    it('revolves about an axis of a custom plane', async () => {
        // Plane through (0, 5, 0) facing +X: u = +Z, v = normal x u = -Y.
        const m = await mesh(body({ plane: { origin: [0, 5, 0], normal: [1, 0, 0], xDir: [0, 0, 1] },
            profiles: [rect([7.5, 5], 5, 10)] }, undefined, { axis: 'v' }));
        expectBounds(m, [-10, -5, -10], [10, 5, 10]);
        expect(volume(m) / (Math.PI * 75 * 10)).toBeCloseTo(1, 2);
    }, SLOW);
});

describe('revolve axes and directions', () => {
    // A 5 x 10 rectangle at u 15..20, v 0..10 on the front plane (u = +X, v = +Y), and a vertical centreline at u = 10.
    const sketch: Sketch = {
        plane: 'front',
        profiles: [rect([17.5, 5], 5, 10)],
        geometry: {
            points: [{ id: 'c0', u: 10, v: 0 }, { id: 'c1', u: 10, v: 10 }],
            curves: [{ id: 'cl', kind: 'line', a: 'c0', b: 'c1', construction: true }],
            constraints: [],
        },
    };
    const empty: Shape = { kind: 'empty' };
    const tube = Math.PI * (100 - 25) * 10;

    it('revolves about a centreline of the sketch and about an axis step', async () => {
        const about = await mesh(body(sketch, undefined, { axis: { line: 'cl' } }));
        expectBounds(about, [0, 0, -10], [20, 10, 10]);
        expect(volume(about) / tube).toBeCloseTo(1, 2);
        const step = await mesh(empty, [
            { id: 'ax', op: 'axis', definition: { kind: 'twoPoints', a: [10, 0, 0], b: [10, 1, 0] } },
            { id: 'sk', op: 'sketch', sketch },
            { id: 'r', op: 'revolve', mode: 'add', sketchRef: 'sk', axis: { axisRef: 'ax' } },
        ]);
        expect(volume(step) / tube).toBeCloseTo(1, 2);
        await expect(mesh(body(sketch, undefined, { axis: { line: 'nope' } }))).rejects.toThrow(/no line "nope"/);
        // The centreline at u = 10 runs through a profile at u 5..15.
        await expect(mesh(body({ ...sketch, profiles: [rect([10, 5], 10, 10)] }, undefined, { axis: { line: 'cl' } })))
            .rejects.toThrow(/crosses the axis line/);
    }, SLOW);

    it('revolves blind one way or reversed, mid plane, and in two directions', async () => {
        const at = (extra: { angle?: number; reverse?: boolean; type?: 'midPlane'; angle2?: number }) => mesh(empty, [{
            id: 'r', op: 'revolve', mode: 'add', axis: 'v', angle: 90, sketch: { plane: 'front', profiles: [rect([7.5, 5], 5, 10)] }, ...extra,
        } as Feature]);
        const quarter = Math.PI * 75 * 10 / 4;
        // +X turned +90 degrees about +Y points to -Z.
        const blind = await at({});
        expectBounds(blind, [0, 0, -10], [10, 10, 0]);
        expect(volume(blind) / quarter).toBeCloseTo(1, 2);
        expectBounds(await at({ reverse: true }), [0, 0, 0], [10, 10, 10]);
        const mid = await at({ type: 'midPlane', angle: 180 });
        expectBounds(mid, [0, 0, -10], [10, 10, 10]);
        expect(volume(mid) / (2 * quarter)).toBeCloseTo(1, 2);
        const two = await at({ angle2: 90 });
        expectBounds(two, [0, 0, -10], [10, 10, 10]);
        expect(volume(two) / (2 * quarter)).toBeCloseTo(1, 2);
        await expect(at({ angle: 300, angle2: 90 })).rejects.toThrow(/more than 360/);
    }, SLOW);
});

describe('sketch regions', () => {
    // Two 10 mm squares sharing the edge u = 10, on the top plane (u = +X, v = -Z).
    const square = (u0: number) => ({ kind: 'polygon' as const, points: [[u0, 0], [u0 + 10, 0], [u0 + 10, 10], [u0, 10]] as [number, number][] });
    const pair: Sketch = {
        plane: 'top',
        profiles: [{ kind: 'polygon', points: [[0, 0], [20, 0], [20, 10], [0, 10]] }],
        regions: [{ loops: [square(0)], at: [5, 5] }, { loops: [square(10)], at: [15, 5] }],
    };
    const empty: Shape = { kind: 'empty' };
    const faces = (m: MeshData): number => new Set(m.triFace).size;

    it('extrudes only the picked regions, fused without seam faces', async () => {
        const left = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 4, sketch: pair, regions: [[2, 2]] }]);
        expect(volume(left)).toBeCloseTo(400, 1);
        expectBounds(left, [0, 0, -10], [10, 4, 0]);
        const both = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 4, sketch: pair, regions: [[2, 2], [18, 8]] }]);
        expect(volume(both)).toBeCloseTo(800, 1);
        expectBounds(both, [0, 0, -10], [20, 4, 0]);
        expect(faces(both)).toBe(6);
        expect(openEdges(both)).toBe(0);
    }, SLOW);

    it('feeds several steps from one sketch step, and builds the whole sketch without picks', async () => {
        const steps: Feature[] = [
            { id: 's', op: 'sketch', sketch: pair },
            { id: 'base', op: 'extrude', mode: 'add', distance: 10, sketchRef: 's' },
        ];
        expect(volume(await mesh(empty, steps))).toBeCloseTo(2000, 1);
        const cut = await mesh(empty, [...steps, { id: 'c', op: 'extrude', mode: 'cut', distance: 4, sketchRef: 's', regions: [[15, 5]] }]);
        expect(volume(cut)).toBeCloseTo(1600, 1);
        // Picks on a sketch without regions: the whole sketch.
        const plain = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 4,
            sketch: { plane: 'top', profiles: pair.profiles }, regions: [[2, 2]] }]);
        expect(volume(plain)).toBeCloseTo(800, 1);
    }, SLOW);

    it('names the feature whose picks land in no region', async () => {
        await expect(mesh(empty, [{ id: 'e', name: 'Boss', op: 'extrude', mode: 'add', distance: 4, sketch: pair, regions: [[50, 50]] }]))
            .rejects.toThrow(/^feature "Boss" \(extrude\): its selected sketch regions no longer exist; pick them again/);
    }, SLOW);
});

describe('extrude options', () => {
    const empty: Shape = { kind: 'empty' };
    const top = (profiles: Sketch['profiles'], offset?: number): Sketch => ({ plane: 'top', offset, profiles });
    const block: Feature = { id: 'b', op: 'extrude', mode: 'add', distance: 10, sketch: top([rect([0, 0], 20, 20)]) };

    it('builds old-style steps as before, starts at an offset, and adds a second direction', async () => {
        const through = await mesh(empty, [block,
            { id: 'c', op: 'extrude', mode: 'cut', through: true, direction: 'reverse', sketch: top([rect([0, 0], 4, 4)], 10) }]);
        expect(volume(through)).toBeCloseTo(3840, 1);
        const offset = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 5, from: 3, sketch: top([rect([0, 0], 10, 10)]) }]);
        expectBounds(offset, [-5, 3, -5], [5, 8, 5]);
        const two = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 5, sketch: top([rect([0, 0], 10, 10)]),
            second: { end: 'blind', distance: 3 } }]);
        expect(volume(two)).toBeCloseTo(800, 1);
        expectBounds(two, [-5, -3, -5], [5, 5, 5]);
        await expect(mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 5, direction: 'symmetric',
            sketch: top([rect([0, 0], 10, 10)]), second: { end: 'blind', distance: 3 } }])).rejects.toThrow(/second direction cannot be used with mid plane/);
    }, SLOW);

    it('goes up to next: a boss to a wall, a cut through the first slab only, and fails with nothing ahead', async () => {
        const wall: Feature = { id: 'w', op: 'extrude', mode: 'add', distance: 10, sketch: top([rect([32.5, 0], 5, 10)]) };
        // Right plane: u = -Z, v = +Y, normal +X. The boss runs from x = 0 to the wall at x = 30.
        const boss = await mesh(empty, [wall, { id: 'e', op: 'extrude', mode: 'add', end: 'upToNext',
            sketch: { plane: 'right', profiles: [rect([0, 5], 4, 4)] } }]);
        expect(volume(boss)).toBeCloseTo(500 + 30 * 16, 0);
        expectBounds(boss, [0, 0, -5], [35, 10, 5]);
        // A C-shaped channel: slabs at y 0..2 and 8..10, joined at x 18..20.
        const channel: Feature = { id: 'ch', op: 'extrude', mode: 'add', distance: 20, sketch: { plane: 'front', profiles: [{
            kind: 'polygon', points: [[0, 0], [20, 0], [20, 10], [0, 10], [0, 8], [18, 8], [18, 2], [0, 2]] }] } };
        const cut = await mesh(empty, [channel, { id: 'c', op: 'extrude', mode: 'cut', end: 'upToNext', direction: 'reverse',
            sketch: top([rect([5, -10], 4, 4)], 10) }]);
        expect(volume(cut)).toBeCloseTo(1840 - 32, 0);
        await expect(mesh(empty, [{ id: 'e', name: 'Boss', op: 'extrude', mode: 'add', end: 'upToNext', sketch: top([rect([0, 0], 4, 4)]) }]))
            .rejects.toThrow(/^feature "Boss" \(extrude\): Up to next: there is nothing ahead of the sketch to stop at/);
    }, SLOW);

    it('drafts the walls (rectangle and circle within 1%), refuses a draft that closes up, and flips the cut side', async () => {
        const t = Math.tan((5 * Math.PI) / 180) * 10;
        const box = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 10, draft: 5, sketch: top([rect([0, 0], 20, 10)]) }]);
        const frustum = (10 / 6) * (200 + (20 - 2 * t) * (10 - 2 * t) + 4 * (20 - t) * (10 - t));
        expect(Math.abs(volume(box) / frustum - 1)).toBeLessThan(0.01);
        expectBounds(box, [-10, 0, -5], [10, 10, 5]);
        const cone = await mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 10, draft: 5,
            sketch: top([{ kind: 'circle', center: [0, 0], radius: 5 }]) }]);
        const r = 5 - t;
        expect(Math.abs(volume(cone) / ((Math.PI * 10 / 3) * (25 + 5 * r + r * r)) - 1)).toBeLessThan(0.01);
        await expect(mesh(empty, [{ id: 'e', op: 'extrude', mode: 'add', distance: 10, draft: 40, sketch: top([rect([0, 0], 20, 10)]) }]))
            .rejects.toThrow(/draft of 40° does not fit/);
        // Flip side: a 3 mm cut keeps only the 4 x 4 post under the profile.
        const flipped = await mesh(empty, [block, { id: 'c', op: 'extrude', mode: 'cut', distance: 3, direction: 'reverse', flipSide: true,
            sketch: top([rect([0, 0], 4, 4)], 10) }]);
        expect(volume(flipped)).toBeCloseTo(4000 - 3 * (400 - 16), 0);
    }, SLOW);
});

describe('picked edges and faces', () => {
    const empty: Shape = { kind: 'empty' };
    // A 40 x 10 x 20 block on the top plane: x -20..20, y 0..10, z -10..10.
    const block: Feature = { id: 'b', op: 'extrude', mode: 'add', distance: 10, sketch: { plane: 'top', profiles: [rect([0, 0], 40, 20)] } };

    it('fillets and chamfers only the picked edges, and fails clearly when a pick is gone', async () => {
        const r = 2;
        // The top edge along x at z = 10.
        const one = await mesh(empty, [block, { id: 'f', op: 'fillet', radius: r, at: [[0, 10, 10]] }]);
        expect(volume(one)).toBeCloseTo(8000 - (r * r - (Math.PI * r * r) / 4) * 40, 0);
        const unequal = await mesh(empty, [block, { id: 'c', op: 'chamfer', size: 2, distance2: 3, at: [[0, 10, 10]] }]);
        expect(volume(unequal)).toBeCloseTo(8000 - ((2 * 3) / 2) * 40, 0);
        await expect(mesh(empty, [block, { id: 'f', op: 'fillet', radius: r, at: [[0, 30, 10]] }]))
            .rejects.toThrow(/selected edge 1 no longer exists/);
    }, SLOW);

    it('shells with a picked face removed and drafts picked faces about a picked face', async () => {
        const tray = await mesh(empty, [block, { id: 's', op: 'shell', thickness: 2, remove: [{ at: [0, 10, 0], normal: [0, 1, 0] }] }]);
        expect(volume(tray)).toBeCloseTo(8000 - 36 * 16 * 8, 0);
        const drafted = await mesh(empty, [block, {
            id: 'd', op: 'draft', angle: 5, neutralFace: { at: [0, 0, 0], normal: [0, -1, 0] },
            picked: [{ at: [20, 5, 0], normal: [1, 0, 0] }, { at: [-20, 5, 0], normal: [-1, 0, 0] }],
        }]);
        // The two end faces lean in or out by 10·tan(5°) at the top: the volume changes by that wedge on each end.
        const wedge = (10 * 10 * Math.tan((5 * Math.PI) / 180) / 2) * 20;
        expect(Math.abs(Math.abs(volume(drafted) - 8000) - 2 * wedge)).toBeLessThan(2);
    }, SLOW);

    it('drafts in a fixed direction: away from a picked neutral face the faces lean out, Reverse leans them in', async () => {
        const ends = [{ at: [20, 5, 0] as Vec3, normal: [1, 0, 0] as Vec3 }, { at: [-20, 5, 0] as Vec3, normal: [-1, 0, 0] as Vec3 }];
        const bottom = { at: [0, 0, 0] as Vec3, normal: [0, -1, 0] as Vec3 };
        const wedge = (10 * 10 * Math.tan((5 * Math.PI) / 180) / 2) * 20;
        // Pull direction = the neutral face's outward normal (down here): the part narrows towards it, so the bottom
        // keeps its size and the top grows by 10·tan(5°) on each end.
        const out = await mesh(empty, [block, { id: 'd', op: 'draft', angle: 5, neutralFace: bottom, picked: ends }]);
        expect(volume(out)).toBeCloseTo(8000 + 2 * wedge, 0);
        expect(bounds(out).max[0]).toBeCloseTo(20 + 10 * Math.tan((5 * Math.PI) / 180), 2);
        const reversed = await mesh(empty, [block, { id: 'd', op: 'draft', angle: 5, neutralFace: bottom, picked: ends, flip: true }]);
        expect(volume(reversed)).toBeCloseTo(8000 - 2 * wedge, 0);
        expect(bounds(reversed).max[0]).toBeCloseTo(20, 2);
    }, SLOW);

    it('puts a chamfer\'s first distance on the face given by side, and on the other face when it is reversed', async () => {
        // The top edge along x at z = 10, between the top face (+y) and the front face (+z).
        const chamfer = (side: Vec3) => mesh(empty, [block, { id: 'c', op: 'chamfer', size: 1, distance2: 3, at: [[0, 10, 10]], side }]);
        const topZ = (m: MeshData) => Math.max(...Array.from({ length: m.positions.length / 3 }, (_, i) => i)
            .filter((i) => Math.abs(m.positions[i * 3 + 1] - 10) < 1e-3).map((i) => m.positions[i * 3 + 2]));
        expect(topZ(await chamfer([0, 1, 0]))).toBeCloseTo(9, 2);
        expect(topZ(await chamfer([0, -1, 0]))).toBeCloseTo(7, 2);
    }, SLOW);
});

