import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { makeBox, setOC } from 'replicad';
import { DEFAULT_PRINT, type Part } from '@jarvis/core';
import { combineProps, massProperties, principalAxes, type Mat3, type MassProps } from './props.js';
import { CadKernel } from './kernel.js';
import { massReport } from '../hostTools.js';

const SLOW = 120_000;
const [A, B, C] = [60, 10, 40];

const within = (actual: number, expected: number, fraction: number): void => {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(Math.abs(expected) * fraction, 1e-9));
};

let box: MassProps;
let kernel: CadKernel;

beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
    // 60 x 10 x 40 with a corner at the origin: centre (30, 5, 20).
    box = massProperties(makeBox([0, 0, 0], [A, B, C]))!;
    kernel = CadKernel.start();
}, SLOW);

afterAll(async () => {
    await kernel.close();
});

describe('massProperties', () => {
    it('gives volume, area, centre and inertia of a box', () => {
        within(box.volume, 24000, 1e-9);
        within(box.area, 6800, 1e-9);
        box.centre.forEach((v, i) => within(v, [30, 5, 20][i], 1e-9));
        box.bounds.max.forEach((v, i) => within(v, [A, B, C][i], 1e-6));
        const m = box.volume;
        const expected = [(B * B + C * C), (A * A + C * C), (A * A + B * B)].map((s) => (m * s) / 12);
        within(box.inertia[0][0], expected[0], 1e-3);
        within(box.inertia[1][1], expected[1], 1e-3);
        within(box.inertia[2][2], expected[2], 1e-3);
        expect(Math.abs(box.inertia[0][1]) + Math.abs(box.inertia[0][2]) + Math.abs(box.inertia[1][2])).toBeLessThan(1e-3 * expected[0]);
        // Principal moments come ascending.
        const sorted = [...expected].sort((a, b) => a - b);
        box.principal.moments.forEach((v, i) => within(v, sorted[i], 1e-3));
    });

    it('reports no body for an empty part instead of failing', async () => {
        const result = await kernel.properties({ shape: { kind: 'empty' } }, DEFAULT_PRINT);
        expect(result.props).toBeNull();
        const text = massReport([{ id: 'p1', name: 'Empty', copies: 1, note: 'it has no solid body yet (only sketches or references)' }],
            [], 1.24);
        expect(text).toContain('Note: it has no solid body yet');
        const json = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
        expect(json.parts[0]).toMatchObject({ id: 'p1', note: expect.any(String) });
    }, SLOW);

    it('measures a part through the kernel', async () => {
        const result = await kernel.properties({ shape: { kind: 'box', size: [A, B, C], radius: 0 } }, DEFAULT_PRINT);
        within(result.props!.volume, 24000, 1e-6);
        result.props!.centre.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-6));
    }, SLOW);
});

describe('principalAxes', () => {
    it('diagonalises a rotated tensor', () => {
        const c = Math.cos(0.4);
        const s = Math.sin(0.4);
        const r: Mat3 = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
        const d = [1, 5, 9];
        const m = [0, 1, 2].map((i) => [0, 1, 2].map((j) => r[i][0] * d[0] * r[j][0] + r[i][1] * d[1] * r[j][1] + r[i][2] * d[2] * r[j][2])) as Mat3;
        const { moments, axes } = principalAxes(m);
        moments.forEach((v, i) => within(v, d[i], 1e-9));
        within(Math.abs(axes[0][0]), c, 1e-9);
        within(Math.abs(axes[0][1]), s, 1e-9);
    });
});

describe('combineProps', () => {
    it('adds two placed copies with the parallel axis theorem', () => {
        const identity: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        // Copy 2 turned 90 degrees about Y and moved 100 mm along X.
        const turn: Mat3 = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
        const total = combineProps([{ props: box, placements: [
            { rotation: identity, translation: [-30, -5, -20] },
            { rotation: turn, translation: [100 - 20, -5, 30] },
        ] }])!;
        within(total.volume, 48000, 1e-9);
        total.centre.forEach((v, i) => within(v, [50, 0, 0][i], 1e-9));
        const m = box.volume;
        // About X: copy 1 has (B² + C²)/12, copy 2 is turned so its X extent is C and Z extent A: (B² + A²)/12.
        within(total.inertia[0][0], (m * (B * B + C * C)) / 12 + (m * (B * B + A * A)) / 12, 1e-6);
        // About Y: both own (A² + C²)/12 plus m·50² each.
        within(total.inertia[1][1], (2 * m * (A * A + C * C)) / 12 + 2 * m * 2500, 1e-6);
    });

    it('is used for the total in the report', () => {
        const part = { id: 'b', name: 'Box', position: [0, 0, 0], rotation: [0, 0, 0], repeat: { kind: 'linear', count: 2, step: [100, 0, 0] } } as unknown as Part;
        const text = massReport([{ id: 'b', name: 'Box', copies: 2, props: box }], [part], 1);
        const json = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
        within(json.total.mass, 48, 1e-6);
        within(json.total.centre[0], 80, 1e-6);
    });
});
