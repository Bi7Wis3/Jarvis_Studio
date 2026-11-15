// The FreeCAD history macro, run in FreeCAD headless: every feature must rebuild and each body must match the
// kernel's solid (volume within 0.1 %, bounding box within 0.01 mm). Skipped when FreeCAD is not installed.
// Slow: run one test at a time with -t ("feature kind", "project file"). The second exports every part of a saved
// project given by FREECAD_TEST_PROJECT (a project .json) and is skipped without it.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    DEFAULT_VIEW, type Feature, type Part, type Project, type Sketch, type SketchConstraint, type SketchCurve, type SketchPlane,
    type SketchPoint, type SketchProfile, type Vec3,
} from '@jarvis/core';
import { CadKernel } from '../cad/kernel.js';
import type { FreecadExport } from './freecadMacro.js';
import { findFreecad, runFreecad, type FreecadResult } from './freecadRun.js';

const freecad = findFreecad();
const SLOW = 1_800_000;

let kernel: CadKernel;

beforeAll(() => {
    kernel = CadKernel.start({ timeoutMs: SLOW });
});

afterAll(async () => {
    await kernel.close();
});

// ---- Sketches with geometry, as the sketcher writes them ------------------------------------------------------

type P2 = [number, number];

interface Geo {
    points: SketchPoint[];
    curves: SketchCurve[];
    constraints: SketchConstraint[];
}

let uid = 0;
const nid = (prefix: string): string => `${prefix}${++uid}`;

function pt(g: Geo, [u, v]: P2): string {
    const id = nid('p');
    g.points.push({ id, u, v });
    return id;
}

/** A rectangle: four lines, horizontal and vertical, with its width and height dimensioned. */
function rect(g: Geo, cx: number, cy: number, w: number, h: number): SketchProfile {
    const corners: P2[] = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    const ids = corners.map((c) => pt(g, c));
    const lines = ids.map((a, k) => {
        const id = nid('c');
        g.curves.push({ id, kind: 'line', a, b: ids[(k + 1) % 4] });
        return id;
    });
    g.constraints.push(
        { id: nid('k'), kind: 'horizontal', line: lines[0] }, { id: nid('k'), kind: 'horizontal', line: lines[2] },
        { id: nid('k'), kind: 'vertical', line: lines[1] }, { id: nid('k'), kind: 'vertical', line: lines[3] },
        { id: nid('k'), kind: 'length', line: lines[0], value: w }, { id: nid('k'), kind: 'length', line: lines[1], value: h },
    );
    return { kind: 'path', start: corners[0], segments: corners.slice(1).map((to) => ({ kind: 'line' as const, to })) };
}

function circle(g: Geo, cx: number, cy: number, r: number): SketchProfile {
    const center = pt(g, [cx, cy]);
    const id = nid('c');
    g.curves.push({ id, kind: 'circle', center, radius: r });
    g.constraints.push({ id: nid('k'), kind: 'diameter', curve: id, value: 2 * r });
    return { kind: 'circle', center: [cx, cy], radius: r };
}

function sketch(plane: SketchPlane, build: (g: Geo) => SketchProfile[], extra: Partial<Sketch> = {}): Sketch {
    const g: Geo = { points: [{ id: 'origin', u: 0, v: 0, fixed: true }], curves: [], constraints: [] };
    const profiles = build(g);
    return { plane, profiles, geometry: g, ...extra };
}

let fid = 0;
function step<T extends Omit<Feature, 'id' | 'name'>>(name: string, f: T): Feature {
    return { id: `s${++fid}`, name, ...f } as unknown as Feature;
}

const sketchStep = (name: string, s: Sketch): Feature => step(name, { op: 'sketch', sketch: s });

function part(id: string, features: Feature[], position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): Part {
    return {
        id, name: id, shape: { kind: 'empty' }, position, rotation, features,
        material: { color: '#888888', metalness: 0, roughness: 0.5 },
    };
}

// ---- The parts ------------------------------------------------------------------------------------------------

function extrudes(): Part {
    const s1 = sketchStep('Base sketch', sketch('top', (g) => [rect(g, 0, 0, 60, 40)]));
    const s2 = sketchStep('Hole sketch', sketch('top', (g) => [circle(g, 10, 5, 6)], { offset: 20 }));
    const s3 = sketchStep('Slot sketch', sketch('front', (g) => [rect(g, -15, 10, 10, 8)]));
    const s4 = sketchStep('Boss sketch', sketch('top', (g) => [rect(g, -15, 8, 12, 10)], { offset: 20 }));
    const s5 = sketchStep('Cross hole sketch', sketch('right', (g) => [circle(g, 10, 6, 3)]));
    const s6 = sketchStep('Peg sketch', sketch('top', (g) => [circle(g, 20, -10, 4)], { offset: 40 }));
    const s7 = sketchStep('Pocket sketch', sketch('top', (g) => [rect(g, 22, 12, 6, 6)], { offset: 20 }));
    // Two separate circles; only the left one is padded (a picked region).
    const twin = sketch('top', (g) => [circle(g, -24, -12, 3), circle(g, -12, -14, 2)], { offset: 20 });
    twin.regions = [{ loops: [twin.profiles[0]], at: [-24, -12] }, { loops: [twin.profiles[1]], at: [-12, -14] }];
    const s8 = sketchStep('Twin sketch', twin);
    // Two overlapping circles; the lens between them is cut (regions split from crossing curves).
    const lens = sketch('front', (g) => [circle(g, 3, 10, 5), circle(g, 9, 10, 5)], { offset: 20 });
    const lensLoop: SketchProfile = {
        kind: 'path', start: [6, 6], segments: [{ kind: 'arc', to: [6, 14], through: [4, 10] }, { kind: 'arc', to: [6, 6], through: [8, 10] }],
    };
    lens.profiles = [];
    lens.regions = [{ loops: [lensLoop], at: [6, 10] }];
    const s9 = sketchStep('Lens sketch', lens);
    return part('Extrudes', [
        s1,
        step('Base', { op: 'extrude', sketchRef: s1.id, distance: 20, mode: 'add' }),
        s2,
        step('Hole', { op: 'extrude', sketchRef: s2.id, end: 'throughAll', direction: 'reverse', mode: 'cut' }),
        s3,
        step('Slot', { op: 'extrude', sketchRef: s3.id, distance: 8, direction: 'symmetric', mode: 'cut' }),
        s4,
        step('Drafted boss', { op: 'extrude', sketchRef: s4.id, distance: 10, mode: 'add', draft: 5 }),
        s5,
        step('Cross hole', { op: 'extrude', sketchRef: s5.id, distance: 10, mode: 'cut', second: { end: 'blind', distance: 12 } }),
        s6,
        step('Peg', { op: 'extrude', sketchRef: s6.id, direction: 'reverse', end: 'upToNext', mode: 'add' }),
        s7,
        step('Pocket', { op: 'extrude', sketchRef: s7.id, direction: 'reverse', end: 'upToNext', mode: 'cut' }),
        s8,
        step('Twin boss', { op: 'extrude', sketchRef: s8.id, distance: 3, mode: 'add', regions: [[-24, -12]] }),
        s9,
        step('Lens cut', { op: 'extrude', sketchRef: s9.id, distance: 6, direction: 'reverse', mode: 'cut', regions: [[6, 10]] }),
        step('Outward cut', {
            op: 'extrude', sketch: sketch('top', (g) => [rect(g, 0, -15, 8, 4)], { offset: 20 }), end: 'throughAll', direction: 'reverse',
            mode: 'cut', draft: 3, draftOutward: true,
        }),
    ]);
}

function relations(): Part {
    // An obround of two lines and two tangent arcs, with a triangle inside dimensioned by an angle.
    const s = sketch('front', (g) => {
        const [a, b, c, d] = ([[-10, -5], [10, -5], [10, 5], [-10, 5]] as P2[]).map((p) => pt(g, p));
        const [ca, cb] = ([[10, 0], [-10, 0]] as P2[]).map((p) => pt(g, p));
        g.curves.push(
            { id: 'l1', kind: 'line', a, b }, { id: 'a1', kind: 'arc', center: ca, start: b, end: c },
            { id: 'l2', kind: 'line', a: c, b: d }, { id: 'a2', kind: 'arc', center: cb, start: d, end: a },
            { id: 'cl', kind: 'line', a: cb, b: ca, construction: true },
        );
        const [t1, t2, t3] = ([[-4, -2], [4, -2], [-4 + 4 * Math.SQRT1_2, -2 + 4 * Math.SQRT1_2]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 't1', kind: 'line', a: t1, b: t2 }, { id: 't2', kind: 'line', a: t2, b: t3 }, { id: 't3', kind: 'line', a: t3, b: t1 });
        g.curves.push({ id: 't4', kind: 'line', a: t1, b: t3, construction: true });
        g.constraints.push(
            { id: nid('k'), kind: 'tangent', a: 'l1', b: 'a1' }, { id: nid('k'), kind: 'tangent', a: 'a1', b: 'l2' },
            { id: nid('k'), kind: 'tangent', a: 'l2', b: 'a2' }, { id: nid('k'), kind: 'tangent', a: 'a2', b: 'l1' },
            { id: nid('k'), kind: 'horizontal', line: 'l1' }, { id: nid('k'), kind: 'equal', a: 'a1', b: 'a2' },
            { id: nid('k'), kind: 'radius', curve: 'a1', value: 5 }, { id: nid('k'), kind: 'midpoint', point: 'origin', line: 'cl' },
            { id: nid('k'), kind: 'distance', a: cb, b: ca, value: 20, axis: 'u' },
            { id: nid('k'), kind: 'horizontal', line: 't1' }, { id: nid('k'), kind: 'length', line: 't1', value: 8 },
            { id: nid('k'), kind: 'angle', a: 't1', b: 't4', value: 45 }, { id: nid('k'), kind: 'length', line: 't4', value: 4 },
            { id: nid('k'), kind: 'distance', a: t1, b: 'axis-u', value: 2 }, { id: nid('k'), kind: 'distance', a: t1, b: 'origin', value: Math.hypot(4, 2), driven: true },
            { id: nid('k'), kind: 'distance', a: t2, b: 'axis-v', value: 4 },
        );
        return [
            { kind: 'path', start: [-10, -5], segments: [
                { kind: 'line', to: [10, -5] }, { kind: 'arc', to: [10, 5], through: [15, 0] },
                { kind: 'line', to: [-10, 5] }, { kind: 'arc', to: [-10, -5], through: [-15, 0] },
            ] },
            { kind: 'path', start: [-4, -2], segments: [{ kind: 'line', to: [4, -2] }, { kind: 'line', to: [-4 + 4 * Math.SQRT1_2, -2 + 4 * Math.SQRT1_2] }] },
        ];
    });
    const s1 = sketchStep('Obround', s);
    return part('Relations', [s1, step('Plate', { op: 'extrude', sketchRef: s1.id, distance: 5, mode: 'add' })]);
}

function curves(): Part {
    // An ellipse, and closed areas bounded by a spline, a Bezier style spline, a conic and a parabola.
    const s = sketch('top', (g) => {
        const [c, m, n] = ([[0, 0], [10, 0], [0, 6]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'el', kind: 'ellipse', center: c, major: m, minor: n });
        const closeWith = (id: string, from: string, to: string): void => {
            g.curves.push({ id, kind: 'line', a: from, b: to });
        };
        const sp = ([[20, -5], [22, 3], [28, 4], [30, -5]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'sp', kind: 'spline', points: sp });
        closeWith('spl', sp[3], sp[0]);
        const st = ([[40, -5], [42, 5], [48, 5], [50, -5]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'st', kind: 'styleSpline', points: st });
        closeWith('stl', st[3], st[0]);
        const [k0, k1, ka] = ([[60, -5], [70, -5], [65, 5]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'cn', kind: 'conic', start: k0, end: k1, apex: ka, rho: 0.4 });
        closeWith('cnl', k1, k0);
        // A spline cut from a longer one keeps its spacing; a style spline its uneven knots.
        const sq = ([[100, -5], [102, 3], [108, 4], [110, -5]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'sq', kind: 'spline', points: sq, spacing: [1.3, 0.9, 1.1] });
        closeWith('sql', sq[3], sq[0]);
        const sk = ([[120, -5], [121, 4], [125, 6], [129, 4], [130, -5]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'sk', kind: 'styleSpline', points: sk, degree: 3, knots: [0.3] });
        closeWith('skl', sk[4], sk[0]);
        const [pv, pf, ps, pe] = ([[85, 0], [85, 2], [81, 2], [89, 2]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'pb', kind: 'parabola', focus: pf, vertex: pv, start: ps, end: pe });
        closeWith('pbl', pe, ps);
        return [
            { kind: 'ellipse', center: [0, 0], major: [10, 0], minor: 6 },
            { kind: 'path', start: [20, -5], segments: [{ kind: 'spline', to: [30, -5], through: [[22, 3], [28, 4]] }] },
            { kind: 'path', start: [40, -5], segments: [{ kind: 'bspline', to: [50, -5], poles: [[42, 5], [48, 5]], degree: 3 }] },
            { kind: 'path', start: [60, -5], segments: [{ kind: 'conic', to: [70, -5], apex: [65, 5], rho: 0.4 }] },
            { kind: 'path', start: [81, 2], segments: [{ kind: 'conic', to: [89, 2], apex: [85, -2], rho: 0.5 }] },
            { kind: 'path', start: [100, -5], segments: [{ kind: 'spline', to: [110, -5], through: [[102, 3], [108, 4]], spacing: [1.3, 0.9, 1.1] }] },
            { kind: 'path', start: [120, -5], segments: [{ kind: 'bspline', to: [130, -5], poles: [[121, 4], [125, 6], [129, 4]], degree: 3, knots: [0.3] }] },
        ];
    });
    const s1 = sketchStep('Curves', s);
    return part('Curves', [s1, step('Shapes', { op: 'extrude', sketchRef: s1.id, distance: 3, mode: 'add' })]);
}

function derived(): Part {
    const s1 = sketchStep('Footprint', sketch('top', (g) => [rect(g, 0, 0, 20, 16), circle(g, 4, 2, 3)]));
    const s2 = sketchStep('Footprint above', { plane: 'top', offset: 5, profiles: [], derived: { from: s1.id } });
    return part('Derived', [
        s1, step('Base', { op: 'extrude', sketchRef: s1.id, distance: 5, mode: 'add' }),
        s2, step('Top', { op: 'extrude', sketchRef: s2.id, distance: 3, mode: 'add' }),
    ]);
}

function revolves(): Part {
    const s1 = sketchStep('Profile', sketch('front', (g) => {
        const axis = [pt(g, [0, 0]), pt(g, [0, 40])];
        g.curves.push({ id: 'axis', kind: 'line', a: axis[0], b: axis[1], construction: true });
        return [rect(g, 15, 15, 10, 30)];
    }));
    const s2 = sketchStep('Groove profile', sketch('front', (g) => [rect(g, 20, 12, 4, 4)]));
    const s3 = sketchStep('Lug profile', sketch('front', (g) => [rect(g, 22, 23, 4, 6)]));
    return part('Revolves', [
        s1,
        step('Body', { op: 'revolve', sketchRef: s1.id, axis: { line: 'axis' }, angle: 270, mode: 'add' }),
        s2,
        step('Groove', { op: 'revolve', sketchRef: s2.id, axis: 'v', angle: 360, mode: 'cut' }),
        s3,
        step('Lug', { op: 'revolve', sketchRef: s3.id, axis: 'y', angle: 45, reverse: true, angle2: 30, mode: 'add' }),
        step('Side lug', { op: 'revolve', sketchRef: s3.id, axis: 'v', angle: 40, type: 'midPlane', mode: 'add' }),
    ]);
}

function loftAndSweep(): Part {
    const plane = step('Top plane', { op: 'plane', definition: { kind: 'offset', base: 'top', distance: 40 } });
    const s1 = sketchStep('Square', sketch('top', (g) => [rect(g, 0, 0, 30, 30)]));
    const s2 = sketchStep('Round', sketch({ planeRef: plane.id }, (g) => [circle(g, 0, 0, 10)]));
    const s3 = sketchStep('Rod profile', sketch({ planeRef: plane.id }, (g) => [circle(g, 0, 0, 3)]));
    const k = 15 - 15 * Math.SQRT1_2;
    const path = sketch('front', (g) => {
        const [a, b, c, centre] = ([[0, 40], [0, 55], [15, 70], [15, 55]] as P2[]).map((p) => pt(g, p));
        g.curves.push({ id: 'pl', kind: 'line', a, b }, { id: 'pa', kind: 'arc', center: centre, start: c, end: b });
        g.constraints.push({ id: nid('k'), kind: 'vertical', line: 'pl' }, { id: nid('k'), kind: 'tangent', a: 'pl', b: 'pa' });
        return [];
    }, {
        open: [{ kind: 'path', start: [0, 40], segments: [{ kind: 'line', to: [0, 55] }, { kind: 'arc', to: [15, 70], through: [k, 55 + 15 * Math.SQRT1_2] }] }],
    });
    const s4 = sketchStep('Rod path', path);
    return part('Loft and sweep', [
        plane, s1, s2,
        step('Loft', { op: 'loft', sections: [{ sketchRef: s1.id }, { sketchRef: s2.id }], mode: 'add' }),
        s3, s4,
        step('Rod', { op: 'sweep', profile: { sketchRef: s3.id }, path: { sketchRef: s4.id }, mode: 'add' }),
    ]);
}

function coil(): Part {
    const s1 = sketchStep('Wire', sketch('front', (g) => [circle(g, 10, 0, 1.5)]));
    return part('Coil', [s1, step('Spring', { op: 'sweep', profile: { sketchRef: s1.id }, path: { helix: { axis: 'y', pitch: 5, turns: 3 } }, mode: 'add' })]);
}

function finishes(): Part {
    const s1 = sketchStep('Block', sketch('top', (g) => [rect(g, 0, 0, 40, 30)]));
    return part('Finishes', [
        s1,
        step('Block', { op: 'extrude', sketchRef: s1.id, distance: 20, mode: 'add' }),
        step('Shell', { op: 'shell', thickness: 2, open: ['top'] }),
        step('Corners', { op: 'fillet', radius: 3, edges: 'vertical', at: [[20, 10, 15], [-20, 10, -15]] }),
        step('Rim', { op: 'chamfer', size: 0.5, edges: 'bottom' }),
        step('Angled chamfer', { op: 'chamfer', size: 1, angle: 30, at: [[20, 20, 0]], side: [1, 0, 0] }),
    ]);
}

function drafts(): Part {
    const s1 = sketchStep('Block', sketch('top', (g) => [rect(g, 0, 0, 40, 40)]));
    return part('Draft', [
        s1,
        step('Block', { op: 'extrude', sketchRef: s1.id, distance: 20, mode: 'add' }),
        step('Draft', { op: 'draft', angle: 5, faces: ['front', 'back'], neutral: 'top' }),
        step('Mirror body', { op: 'mirror', plane: 'top' }),
    ]);
}

function patterns(): Part {
    const s1 = sketchStep('Plate', sketch('top', (g) => [rect(g, 0, 0, 80, 40)]));
    const s2 = sketchStep('Hole', sketch('top', (g) => [circle(g, -30, 10, 3)], { offset: 10 }));
    const s3 = sketchStep('Boss', sketch('top', (g) => [rect(g, 30, -12, 6, 6)], { offset: 10 }));
    const s4 = sketchStep('Small hole', sketch('top', (g) => [circle(g, 12, 0, 2)], { offset: 10 }));
    const hole = step('Hole', { op: 'extrude', sketchRef: s2.id, end: 'throughAll', direction: 'reverse', mode: 'cut' });
    const boss = step('Boss', { op: 'extrude', sketchRef: s3.id, distance: 5, mode: 'add' });
    const small = step('Small hole', { op: 'extrude', sketchRef: s4.id, end: 'throughAll', direction: 'reverse', mode: 'cut' });
    const axis = step('Tilted axis', { op: 'axis', definition: { kind: 'pointDirection', point: [0, 0, 0], direction: [0, 1, 0] } });
    return part('Patterns', [
        s1, step('Plate', { op: 'extrude', sketchRef: s1.id, distance: 10, mode: 'add' }),
        s2, hole,
        step('Hole rows', { op: 'pattern', features: [hole.id], kind: 'linear', direction: 'x', count: 4, spacing: 15, direction2: 'z', count2: 2, spacing2: 15 }),
        s3, boss,
        step('Mirror boss', { op: 'mirror', plane: 'right', features: [boss.id] }),
        s4, small, axis,
        step('Hole circle', { op: 'pattern', features: [small.id], kind: 'circular', axis: { axisRef: axis.id }, count: 6, angle: 360 }),
        step('Half circle', { op: 'pattern', features: [small.id], kind: 'circular', axis: 'y', count: 3, angle: 30, equal: false, reverse: true }),
    ]);
}

function datums(): Part {
    const tilted = step('Tilted plane', { op: 'plane', definition: { kind: 'angle', base: 'front', about: 'u', angle: 30 } });
    const flipped = step('Back plane', { op: 'plane', definition: { kind: 'offset', base: 'front', distance: 6, flipNormal: true } });
    const s1 = sketchStep('Tab', sketch({ planeRef: tilted.id }, (g) => [rect(g, 0, 10, 20, 12)]));
    const s2 = sketchStep('Back tab', sketch({ planeRef: flipped.id }, (g) => [rect(g, 0, -8, 10, 6)]));
    return part('Datums', [
        tilted, s1, step('Tab', { op: 'extrude', sketchRef: s1.id, distance: 4, mode: 'add' }),
        flipped, s2, step('Back tab', { op: 'extrude', sketchRef: s2.id, distance: 3, mode: 'add' }),
        step('Point', { op: 'point', position: [1, 2, 3] }),
    ]);
}

function threads(): Part {
    const s1 = sketchStep('Shaft', sketch('top', (g) => [circle(g, 0, 0, 5)]));
    const s2 = sketchStep('Flange', sketch('top', (g) => [rect(g, 0, 0, 30, 30)]));
    const s3 = sketchStep('Bore', sketch('top', (g) => [circle(g, 8, 8, 3)], { offset: -10 }));
    return part('Threads', [
        s2, step('Flange', { op: 'extrude', sketchRef: s2.id, distance: 10, direction: 'reverse', mode: 'add' }),
        s1, step('Shaft', { op: 'extrude', sketchRef: s1.id, distance: 20, mode: 'add' }),
        step('Outer thread', { op: 'thread', kind: 'external', at: [5, 20, 0], pitch: 1, length: 12, starts: 2 }),
        s3, step('Bore', { op: 'extrude', sketchRef: s3.id, distance: 10, mode: 'cut' }),
        step('Inner thread', { op: 'thread', kind: 'internal', at: [11, 0, -8], pitch: 1.25, length: 14, length2: 2 }),
    ], [100, 5, -20], [0, 30, 0]);
}

function solids(): Part {
    const s1 = sketchStep('Block', sketch('top', (g) => [rect(g, 0, 0, 40, 30)]));
    const s2 = sketchStep('Offset boss', sketch('top', (g) => [circle(g, 0, 0, 5)], { offset: 20 }));
    return part('Solids', [
        s1, step('Block', { op: 'extrude', sketchRef: s1.id, distance: 20, mode: 'add' }),
        s2, step('Raised boss', { op: 'extrude', sketchRef: s2.id, distance: 5, from: -2, mode: 'add' }),
        step('Varying fillet', { op: 'fillet', radius: 2, radius2: 4, at: [[20, 10, 15]] }),
        step('Hole', { op: 'hole', spec: { kind: 'counterbore', size: 'M4' }, position: [10, 20, 5] }),
        step('Sunk holes', { op: 'hole', spec: { kind: 'countersink', size: 'M3' }, position: [-12, 20, -7], depth: 8, repeat: { kind: 'linear', count: 3, step: [0, 0, 7] } }),
        step('Nut trap', { op: 'hole', spec: { kind: 'nutTrap', size: 'M3' }, position: [12, 20, -8] }),
        step('Split', { op: 'split', plane: 'right', keep: 'positive' }),
    ]);
}

// ---- Running and comparing ------------------------------------------------------------------------------------

function project(parts: Part[]): Project {
    return { name: 'FreeCAD export test', parts, view: { ...DEFAULT_VIEW } };
}

function compare(made: FreecadExport, result: FreecadResult): void {
    expect(result.bodies.map((b) => b.label)).toEqual(made.parts.map((p) => p.name));
    made.parts.forEach((p, i) => {
        const body = result.bodies[i];
        const e = p.expected!;
        const dv = (body.volume! - e.volume) / e.volume;
        const db = Math.max(...body.box!.map((x, k) => Math.abs(x - e.box[k])));
        console.log(`${p.name}: FreeCAD ${body.volume!.toFixed(4)} mm3, Jarvis Studio ${e.volume.toFixed(4)} mm3 `
            + `(${(dv * 100).toFixed(5)} %), box off ${db.toExponential(2)} mm`);
        expect(body.invalid, `${p.name}: features FreeCAD could not rebuild`).toEqual([]);
        expect(body.valid, `${p.name}: valid solid`).toBe(true);
        expect(Math.abs(dv), `${p.name}: volume`).toBeLessThan(1e-3);
        expect(db, `${p.name}: bounding box`).toBeLessThan(0.01);
    });
}

describe.skipIf(!freecad)('FreeCAD history macro', () => {
    it('rebuilds every feature kind in FreeCAD as the kernel builds it', async () => {
        const parts = [extrudes(), relations(), curves(), derived(), revolves(), loftAndSweep(), coil(), finishes(), drafts(), patterns(), datums(), threads(), solids()];
        const made = await kernel.freecadMacro(project(parts));
        for (const p of made.parts) {
            for (const s of p.steps) console.log(`  ${p.name} / ${s.name}: ${s.how} - ${s.detail}`);
        }
        const result = runFreecad(freecad!, made.text);
        for (const n of result.notes) console.log(`  note: ${n}`);
        compare(made, result);
        expect(result.notes).toEqual([]);
        const how = (partName: string, stepName: string) => made.parts.find((p) => p.name === partName)!.steps.find((s) => s.name === stepName)!.how;
        // FreeCAD features where FreeCAD has them, solids where it has not.
        expect(['Base', 'Hole', 'Slot', 'Drafted boss', 'Cross hole', 'Peg', 'Twin boss'].map((s) => how('Extrudes', s))).toEqual(Array(7).fill('feature'));
        expect([how('Extrudes', 'Pocket'), how('Extrudes', 'Outward cut')]).toEqual(['changed', 'changed']);
        expect(how('Extrudes', 'Lens cut')).toBe('changed');
        expect(['Body', 'Groove', 'Lug', 'Side lug'].map((s) => how('Revolves', s))).toEqual(Array(4).fill('feature'));
        expect([how('Loft and sweep', 'Loft'), how('Loft and sweep', 'Rod'), how('Coil', 'Spring')]).toEqual(['feature', 'feature', 'feature']);
        expect(['Shell', 'Corners', 'Rim', 'Angled chamfer'].map((s) => how('Finishes', s))).toEqual(Array(4).fill('feature'));
        expect([how('Draft', 'Draft'), how('Draft', 'Mirror body')]).toEqual(['feature', 'feature']);
        expect(['Hole rows', 'Mirror boss', 'Hole circle', 'Half circle'].map((s) => how('Patterns', s))).toEqual(Array(4).fill('feature'));
        expect([how('Threads', 'Outer thread'), how('Threads', 'Inner thread')]).toEqual(['changed', 'changed']);
        expect([how('Derived', 'Footprint above'), how('Derived', 'Top')]).toEqual(['changed', 'feature']);
        expect(['Raised boss', 'Varying fillet', 'Nut trap', 'Split'].map((s) => how('Solids', s))).toEqual(Array(4).fill('solid'));
        expect([how('Solids', 'Hole'), how('Solids', 'Sunk holes')]).toEqual(['feature', 'feature']);
    }, SLOW);

    it.skipIf(!process.env.FREECAD_TEST_PROJECT)('rebuilds every part of the project file in FREECAD_TEST_PROJECT', async () => {
        const saved = JSON.parse(readFileSync(process.env.FREECAD_TEST_PROJECT!, 'utf8')) as Project;
        const made = await kernel.freecadMacro(saved);
        for (const p of made.parts) {
            for (const s of p.steps) console.log(`  ${p.name} / ${s.name}: ${s.how} - ${s.detail}`);
        }
        const result = runFreecad(freecad!, made.text);
        for (const n of result.notes) console.log(`  note: ${n}`);
        compare(made, result);
    }, SLOW);
});
