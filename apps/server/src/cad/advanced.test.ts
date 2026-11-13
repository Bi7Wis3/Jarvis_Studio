import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    DEFAULT_PRINT, DEFAULT_VIEW, type Feature, type Part, type Project, type Shape, type Sketch, type Vec3,
} from '@jarvis/core';
import { CadKernel, combineContext, meshKey, type CombineContext, type MeshData } from './kernel.js';

const SLOW = 180_000;

let kernel: CadKernel;

beforeAll(() => {
    kernel = CadKernel.start();
});

afterAll(async () => {
    await kernel.close();
});

const mesh = (shape: Shape, features?: Feature[], context?: CombineContext): Promise<MeshData> =>
    kernel.mesh({ shape, features }, DEFAULT_PRINT, context);

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
    // Odd use counts are holes; solids touching on a face (a split kept whole) share its edges four times.
    return [...uses.values()].filter((c) => c % 2 !== 0).length;
}

function expectBounds(m: MeshData, min: Vec3, max: Vec3, tolerance = 0.06): void {
    const b = bounds(m);
    for (let k = 0; k < 3; k++) {
        expect(Math.abs(b.min[k] - min[k]), `min[${k}] ${b.min[k]} vs ${min[k]}`).toBeLessThan(tolerance);
        expect(Math.abs(b.max[k] - max[k]), `max[${k}] ${b.max[k]} vs ${max[k]}`).toBeLessThan(tolerance);
    }
}

const sharpBox = (size: Vec3): Shape => ({ kind: 'box', size, radius: 0 });
const empty: Shape = { kind: 'empty' };
const rect = (center: [number, number], width: number, height: number) => ({ kind: 'rect' as const, center, width, height });
const circle = (center: [number, number], radius: number) => ({ kind: 'circle' as const, center, radius });
const plainHole = (id: string, position: Vec3, diameter = 3): Feature =>
    ({ id, op: 'hole', spec: { kind: 'plain', diameter }, position });
const holeArea = (diameter: number): number => Math.PI * ((diameter + DEFAULT_PRINT.holeTolerance) / 2) ** 2;

describe('reference geometry', () => {
    it('builds nothing by itself', async () => {
        const box: Shape = { kind: 'box', size: [10, 10, 10] };
        const plain = await mesh(box);
        const refs = await mesh(box, [
            { id: 'p', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 3 } },
            { id: 'a', op: 'axis', definition: { kind: 'pointDirection', point: [1, 2, 3], direction: [0, 1, 0] } },
            { id: 'o', op: 'point', position: [1, 1, 1] },
        ]);
        expect(volume(refs)).toBeCloseTo(volume(plain), 4);
    }, SLOW);

    it('puts sketches on construction planes, resolved from earlier steps', async () => {
        const m = await mesh(empty, [
            { id: 'p', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 10 } },
            { id: 's', op: 'sketch', sketch: { plane: { planeRef: 'p' }, profiles: [rect([0, 0], 4, 6)] } },
            { id: 'e', op: 'extrude', mode: 'add', distance: 2, sketchRef: 's' },
            { id: 'e2', op: 'extrude', mode: 'add', distance: 1, sketch: { plane: { planeRef: 'p' }, offset: -1, profiles: [rect([0, 0], 2, 2)] } },
        ]);
        expectBounds(m, [-2, 9, -3], [2, 12, 3]);
        // A plane turned 90 degrees about the front plane's u axis faces down, like a bottom view.
        const turned = await mesh(empty, [
            { id: 'p', op: 'plane', definition: { kind: 'angle', base: 'front', about: 'u', angle: 90 } },
            { id: 'e', op: 'extrude', mode: 'add', distance: 3, sketch: { plane: { planeRef: 'p' }, profiles: [rect([0, 0], 4, 4)] } },
        ]);
        expectBounds(turned, [-2, -3, -2], [2, 0, 2]);
        await expect(mesh(empty, [
            { id: 'e', name: 'Base', op: 'extrude', mode: 'add', distance: 1, sketch: { plane: { planeRef: 'later' }, profiles: [rect([0, 0], 2, 2)] } },
            { id: 'later', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 1 } },
        ])).rejects.toThrow(/^feature "Base" \(extrude\): .*plane "later" not found/);
    }, SLOW);
});

describe('sweep', () => {
    const springProfile: Sketch = { plane: 'front', profiles: [circle([8, 0], 1)] };

    it('makes a 10-turn spring along a helix, watertight and quickly', async () => {
        const start = performance.now();
        const m = await mesh(empty, [{
            id: 'coil', op: 'sweep', mode: 'add', profile: { sketch: springProfile }, path: { helix: { axis: 'y', pitch: 4, turns: 10 } },
        }]);
        const ms = performance.now() - start;
        expect(ms).toBeLessThan(30_000);
        expect(openEdges(m)).toBe(0);
        expectBounds(m, [-9, -1, -9], [9, 41, 9], 0.2);
        const length = 10 * Math.hypot(2 * Math.PI * 8, 4);
        expect(volume(m) / (Math.PI * length)).toBeCloseTo(1, 1);
    }, SLOW);

    it('makes left-handed, tapered and explicit-radius helices', async () => {
        const cone = await mesh(empty, [{
            id: 'c', op: 'sweep', mode: 'add', profile: { sketch: springProfile },
            path: { helix: { axis: 'y', pitch: 5, turns: 3, taper: 15, leftHanded: true } },
        }]);
        // Radius grows by 15 mm * tan 15 over the 15 mm rise.
        expect(bounds(cone).max[0]).toBeGreaterThan(8 + 15 * Math.tan(Math.PI / 12) - 0.5);
        expect(openEdges(cone)).toBe(0);
        await expect(mesh(empty, [{
            id: 'c', op: 'sweep', mode: 'add', profile: { sketch: { plane: 'top', profiles: [circle([0, 0], 1)] } },
            path: { helix: { axis: 'y', pitch: 5, turns: 3 } },
        }])).rejects.toThrow(/helix radius must be positive/);
    }, SLOW);

    it('sweeps along an open path of lines and arcs', async () => {
        const path: Sketch = { plane: 'front', profiles: [{
            kind: 'path', start: [0, 0], segments: [
                { kind: 'line', to: [0, 20] },
                { kind: 'arc', through: [10 - 10 * Math.SQRT1_2, 20 + 10 * Math.SQRT1_2], to: [10, 30] },
                { kind: 'line', to: [30, 30] },
            ],
        }] };
        const m = await mesh(empty, [{
            id: 's', op: 'sweep', mode: 'add', profile: { sketch: { plane: 'top', profiles: [circle([0, 0], 2)] } }, path: { sketch: path },
        }]);
        expect(openEdges(m)).toBe(0);
        expectBounds(m, [-2, 0, -2], [30, 32, 2], 0.1);
        expect(volume(m) / (4 * Math.PI * (40 + 5 * Math.PI))).toBeCloseTo(1, 1);
    }, SLOW);

    it('twists along a straight path and cuts a helical groove', async () => {
        const square: Sketch = { plane: 'top', profiles: [rect([0, 0], 4, 4)] };
        const line: Sketch = { plane: 'front', profiles: [{ kind: 'path', start: [0, 0], segments: [{ kind: 'line', to: [0, 20] }] }] };
        const twisted = await mesh(empty, [{ id: 't', op: 'sweep', mode: 'add', twist: 90, profile: { sketch: square }, path: { sketch: line } }]);
        expect(volume(twisted)).toBeCloseTo(320, -1);
        expect(bounds(twisted).max[1]).toBeCloseTo(20, 2);
        const cylinder: Shape = { kind: 'cylinder', radius: 10, height: 40 };
        const groove: Feature = {
            id: 'g', op: 'sweep', mode: 'cut', profile: { sketch: { plane: 'front', profiles: [circle([10, -15], 1)] } },
            path: { helix: { axis: 'y', pitch: 6, turns: 4 } },
        };
        const before = volume(await mesh(cylinder, [{ id: 'x', op: 'point', position: [0, 0, 0] }]));
        const after = await mesh(cylinder, [groove]);
        expect(volume(after)).toBeLessThan(before - 100);
        expect(openEdges(after)).toBe(0);
    }, SLOW);
});

describe('pattern', () => {
    it('repeats holes in a line and around an axis', async () => {
        const plain = volume(await mesh(sharpBox([60, 4, 60])));
        const linear = await mesh(sharpBox([60, 4, 60]), [
            plainHole('h', [-20, 2, 0]),
            { id: 'p', op: 'pattern', kind: 'linear', features: ['h'], direction: 'x', count: 3, spacing: 20 },
        ]);
        expect((plain - volume(linear)) / (3 * holeArea(3) * 4)).toBeCloseTo(1, 1);
        const circular = await mesh(sharpBox([60, 4, 60]), [
            { id: 'ax', op: 'axis', definition: { kind: 'pointDirection', point: [0, 0, 0], direction: [0, 1, 0] } },
            plainHole('h', [20, 2, 0]),
            { id: 'p', op: 'pattern', kind: 'circular', features: ['h'], axis: { axisRef: 'ax' }, count: 6 },
        ]);
        expect((plain - volume(circular)) / (6 * holeArea(3) * 4)).toBeCloseTo(1, 1);
        // A half turn with 3 copies puts them at 0, 90 and 180 degrees.
        const half = await mesh(sharpBox([60, 4, 60]), [
            plainHole('h', [20, 2, 0]),
            { id: 'p', op: 'pattern', kind: 'circular', features: ['h'], axis: 'y', count: 3, angle: 180 },
        ]);
        expect((plain - volume(half)) / (3 * holeArea(3) * 4)).toBeCloseTo(1, 1);
        expect(openEdges(half)).toBe(0);
    }, SLOW);

    it('makes grids in two directions, skips instances and spaces circular copies by angle', async () => {
        const plain = volume(await mesh(sharpBox([60, 4, 60])));
        const hole = holeArea(3) * 4;
        // 3 x 2 grid with one instance skipped: 5 holes.
        const grid = await mesh(sharpBox([60, 4, 60]), [
            plainHole('h', [-20, 2, -10]),
            {
                id: 'p', op: 'pattern', kind: 'linear', features: ['h'], direction: 'x', count: 3, spacing: 20,
                direction2: 'z', count2: 2, spacing2: 20, skip: [[3, 2]],
            },
        ]);
        expect((plain - volume(grid)) / (5 * hole)).toBeCloseTo(1, 1);
        // Seed only along direction 2, and direction 1 reversed from the right-hand side.
        const seedOnly = await mesh(sharpBox([60, 4, 60]), [
            plainHole('h', [20, 2, -10]),
            {
                id: 'p', op: 'pattern', kind: 'linear', features: ['h'], direction: 'x', count: 3, spacing: 20, reverse: true,
                direction2: 'z', count2: 2, spacing2: 20, seedOnly2: true,
            },
        ]);
        expect((plain - volume(seedOnly)) / (4 * hole)).toBeCloseTo(1, 1);
        expect(openEdges(seedOnly)).toBe(0);
        // 4 instances 30 degrees apart (not shared over 360).
        const fan = await mesh(sharpBox([60, 4, 60]), [
            plainHole('h', [20, 2, 0]),
            { id: 'p', op: 'pattern', kind: 'circular', features: ['h'], axis: 'y', count: 4, angle: 30, equal: false },
        ]);
        expect((plain - volume(fan)) / (4 * hole)).toBeCloseTo(1, 1);
    }, SLOW);

    it('says what is missing instead of failing with a type error', async () => {
        await expect(mesh(sharpBox([20, 4, 20]), [
            plainHole('h', [0, 2, 0]),
            { id: 'p', op: 'pattern', kind: 'linear', features: ['h'], count: 2, spacing: 5 } as unknown as Feature,
        ])).rejects.toThrow(/a linear pattern needs direction 1/);
        await expect(mesh(sharpBox([20, 4, 20]), [
            plainHole('h', [0, 2, 0]),
            { id: 'p', op: 'pattern', kind: 'circular', features: ['h'], count: 2 } as unknown as Feature,
        ])).rejects.toThrow(/a circular pattern needs an axis/);
    }, SLOW);

    it('repeats sketch extrusions and rejects steps without a tool', async () => {
        const bosses = await mesh(sharpBox([60, 4, 20]), [
            { id: 'b', op: 'extrude', mode: 'add', distance: 5, sketch: { plane: 'top', offset: 2, profiles: [circle([-20, 0], 3)] } },
            { id: 'p', op: 'pattern', kind: 'linear', features: ['b'], direction: [1, 0, 0], count: 3, spacing: 20 },
        ]);
        expect(volume(bosses)).toBeCloseTo(60 * 4 * 20 + 3 * Math.PI * 9 * 5, -1);
        await expect(mesh(sharpBox([20, 4, 20]), [
            { id: 'f', name: 'Soft edges', op: 'fillet', radius: 1 },
            { id: 'p', name: 'Row', op: 'pattern', kind: 'linear', features: ['f'], direction: 'x', count: 2, spacing: 5 },
        ])).rejects.toThrow(/^feature "Row" \(pattern\): step "Soft edges" \(fillet\) cannot be patterned/);
        await expect(mesh(sharpBox([20, 4, 20]), [
            { id: 'p', op: 'pattern', kind: 'linear', features: ['nope'], direction: 'x', count: 2, spacing: 5 },
        ])).rejects.toThrow(/step "nope" not found/);
    }, SLOW);
});

describe('mirror features', () => {
    it('mirrors chosen features about a plane step, leaving the rest of the body alone', async () => {
        const plain = volume(await mesh(sharpBox([60, 4, 60])));
        const hole = holeArea(3) * 4;
        // Plane x = 5; a hole at x = 15 mirrors to x = -5. A hole not chosen is not mirrored.
        const m = await mesh(sharpBox([60, 4, 60]), [
            { id: 'pl', op: 'plane', definition: { kind: 'offset', base: 'right', distance: 5 } },
            plainHole('h', [15, 2, 0]),
            plainHole('other', [0, 2, 20]),
            { id: 'm', op: 'mirror', plane: { planeRef: 'pl' }, features: ['h'] },
        ]);
        expect((plain - volume(m)) / (3 * hole)).toBeCloseTo(1, 1);
        expect(openEdges(m)).toBe(0);
        // A boss mirrored about the Top plane lands under the body.
        const boss = await mesh(sharpBox([20, 4, 20]), [
            { id: 'b', op: 'extrude', mode: 'add', distance: 5, sketch: { plane: 'top', offset: 2, profiles: [circle([0, 0], 3)] } },
            { id: 'm', op: 'mirror', plane: 'top', features: ['b'] },
        ]);
        expect(volume(boss)).toBeCloseTo(20 * 4 * 20 + 2 * Math.PI * 9 * 5, -1);
    }, SLOW);

    it('mirrors the body about a base plane by its SolidWorks name, as the older spelling did', async () => {
        const older = await mesh(sharpBox([10, 4, 6]), [{ id: 'm', op: 'mirror', plane: 'XY', offset: 10 }]);
        const named = await mesh(sharpBox([10, 4, 6]), [{ id: 'm', op: 'mirror', plane: 'front', offset: 10 }]);
        expect(volume(named)).toBeCloseTo(volume(older), 3);
        await expect(mesh(sharpBox([20, 4, 20]), [
            { id: 'f', name: 'Soft', op: 'fillet', radius: 1 },
            { id: 'm', op: 'mirror', plane: 'right', features: ['f'] },
        ])).rejects.toThrow(/cannot be mirrored/);
    }, SLOW);
});

describe('combine', () => {
    const part = (id: string, shape: Shape, position: Vec3, rotation: Vec3 = [0, 0, 0], features?: Feature[]): Part => ({
        id, name: id, shape, position, rotation, features, material: { color: '#888888', metalness: 0, roughness: 0.5 },
    });

    it('cuts, joins and intersects another part as placed in the assembly', async () => {
        // A pin along Z (cylinder turned 90 degrees about X), placed at x = 5 relative to the block at x = 100.
        const pin = part('pin', { kind: 'cylinder', radius: 3, height: 30, bevel: 0 }, [105, 0, 0], [90, 0, 0]);
        const block = (operation: 'join' | 'cut' | 'intersect', at: Vec3 = [100, 0, 0]) =>
            part('block', sharpBox([20, 10, 20]), at, [0, 0, 0], [{ id: 'c', op: 'combine', part: 'pin', operation }]);
        const build = (b: Part, parts: Part[]) => mesh(b.shape, b.features, combineContext(b, parts));
        const cut = await build(block('cut'), [block('cut'), pin]);
        expect((4000 - volume(cut)) / (Math.PI * 9 * 20)).toBeCloseTo(1, 1);
        expectBounds(cut, [-10, -5, -10], [10, 5, 10]);
        const joined = await build(block('join'), [block('join'), pin]);
        expectBounds(joined, [-10, -5, -15], [10, 5, 15]);
        const both = await build(block('intersect'), [block('intersect'), pin]);
        expect(volume(both) / (Math.PI * 9 * 20)).toBeCloseTo(1, 1);
        // Moving the other part changes the key, so dependants rebuild.
        const moved = { ...pin, position: [106, 0, 0] as Vec3 };
        const b = block('cut');
        expect(meshKey(b, DEFAULT_PRINT, combineContext(b, [b, moved]))).not.toBe(meshKey(b, DEFAULT_PRINT, combineContext(b, [b, pin])));
        // Moving both together keeps the relative placement, and the key.
        const bothMoved = [{ ...b, position: [0, 0, 0] as Vec3 }, { ...pin, position: [5, 0, 0] as Vec3 }];
        expect(meshKey(b, DEFAULT_PRINT, combineContext(bothMoved[0], bothMoved))).toBe(meshKey(b, DEFAULT_PRINT, combineContext(b, [b, pin])));
    }, SLOW);

    it('reports cycles and missing parts', async () => {
        const a = part('a', sharpBox([10, 10, 10]), [0, 0, 0], [0, 0, 0], [{ id: 'c', name: 'Use B', op: 'combine', part: 'b', operation: 'join' }]);
        const b = part('b', sharpBox([10, 10, 10]), [5, 0, 0], [0, 0, 0], [{ id: 'c', op: 'combine', part: 'a', operation: 'join' }]);
        await expect(mesh(a.shape, a.features, combineContext(a, [a, b]))).rejects.toThrow(/combine cycle: a -> b -> a/);
        await expect(mesh(a.shape, a.features, combineContext(a, [a]))).rejects.toThrow(/^feature "Use B" \(combine\): part "b" is not available/);
    }, SLOW);

    it('exports instances and combined parts to STEP', async () => {
        const source = part('src', sharpBox([10, 10, 10]), [0, 5, 0], [0, 0, 0], [plainHole('h', [0, 5, 0])]);
        const copy: Part = { ...part('copy', empty, [30, 5, 0]), instanceOf: 'src' };
        const pin = part('pin', { kind: 'cylinder', radius: 1, height: 30 }, [60, 5, 0]);
        const user = part('user', sharpBox([10, 10, 10]), [60, 5, 0], [0, 0, 0], [{ id: 'c', op: 'combine', part: 'pin', operation: 'cut' }]);
        const project: Project = { name: 'instances', parts: [source, copy, pin, user], view: { ...DEFAULT_VIEW } };
        const text = (await kernel.step(project)).toString('latin1');
        expect(text.startsWith('ISO-10303-21')).toBe(true);
        expect(text).toContain('copy');
        expect(text).toContain('user');
    }, SLOW);
});

describe('split and draft', () => {
    it('keeps one side of a plane, or both', async () => {
        const box = sharpBox([20, 10, 20]);
        const positive = await mesh(box, [{ id: 's', op: 'split', plane: 'top', keep: 'positive' }]);
        expectBounds(positive, [-10, 0, -10], [10, 5, 10]);
        expect(volume(positive)).toBeCloseTo(2000, 1);
        const negative = await mesh(box, [{ id: 's', op: 'split', plane: 'top', keep: 'negative' }]);
        expectBounds(negative, [-10, -5, -10], [10, 0, 10]);
        const both = await mesh(box, [{ id: 's', op: 'split', plane: 'right', keep: 'both' }]);
        expect(volume(both)).toBeCloseTo(4000, 1);
        expect(openEdges(both)).toBe(0);
        const angled = await mesh(box, [
            { id: 'p', op: 'plane', definition: { kind: 'angle', base: 'top', about: 'z', angle: 45 } },
            { id: 's', op: 'split', plane: { planeRef: 'p' }, keep: 'positive' },
        ]);
        expect(volume(angled)).toBeCloseTo(2000, 0);
        await expect(mesh(box, [{ id: 's', name: 'Cut off', op: 'split', plane: { planeRef: 'none' }, keep: 'positive' }]))
            .rejects.toThrow(/^feature "Cut off" \(split\): /);
        await expect(mesh(box, [
            { id: 'p', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 50 } },
            { id: 's', op: 'split', plane: { planeRef: 'p' }, keep: 'positive' },
        ])).rejects.toThrow(/nothing of the body is on the positive side/);
    }, SLOW);

    it('drafts side faces about a neutral plane', async () => {
        const box = sharpBox([20, 20, 20]);
        const m = await mesh(box, [
            { id: 'n', op: 'plane', definition: { kind: 'offset', base: 'top', distance: -10 } },
            { id: 'd', op: 'draft', faces: ['right'], angle: 10, neutral: { planeRef: 'n' } },
        ]);
        expect(openEdges(m)).toBe(0);
        // The right face pivots about its bottom edge: a wedge of 20 x 20 x 20 tan(10) / 2 comes or goes.
        expect(Math.abs(volume(m) - 8000)).toBeCloseTo((20 * 20 * 20 * Math.tan(Math.PI / 18)) / 2, -1);
        await expect(mesh(box, [{ id: 'd', op: 'draft', faces: ['right'], angle: 60, neutral: 'top' }]))
            .rejects.toThrow(/draft angle must be between 0 and 45/);
    }, SLOW);
});
