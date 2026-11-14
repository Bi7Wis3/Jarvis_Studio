import { describe, expect, it } from 'vitest';
import type { Feature, Part, SketchRegion, Vec3 } from '@jarvis/core';
import {
    axisParam, beginDrag, dragLabel, dragStep, dragValues, gimbalAxes, gripShapes, handlesFor, pickGrip, profileCentre, ringAngle, rotateAbout, snapValue,
    tipOf, wrapDegrees, type Handle, type HandleEnv, type Ray,
} from './toolHandles';
import type { Ctx, Values } from './toolDefs';

const close = (a: Vec3, b: Vec3) => a.forEach((c, i) => expect(c).toBeCloseTo(b[i], 6));
const rect = (center: [number, number], width: number, height: number): SketchRegion => ({
    loops: [{ kind: 'rect', center, width, height }], at: [center[0] + width / 4, center[1] + height / 4],
});

function part(features: Feature[], position: Vec3 = [10, 5, 0], rotation: Vec3 = [0, 0, 0]): Part {
    return {
        id: 'p1', name: 'Plate', shape: { kind: 'box', size: [60, 10, 40] }, position, rotation,
        material: { color: '#999999', metalness: 0, roughness: 0.6 }, features,
    } as Part;
}

const sketchStep = (regions: SketchRegion[]): Feature => ({
    id: 'sketch-1', op: 'sketch', name: 'Sketch1',
    sketch: { plane: 'top', offset: 10, profiles: regions.map((r) => r.loops[0]), regions },
} as Feature);

const noEnv: HandleEnv = { picks: [], pickKey: null, sketch: null };
const ctxOf = (p: Part | null): Ctx => ({ part: p, project: null, edit: null });
const extrudeValues = (patch: Values = {}): Values => ({ sketch: 'sketch-1', mode: 'add', distance: '12', direction: 'normal', through: false, ...patch });

/** A ray from `from` along `dir`. */
const ray = (from: Vec3, dir: Vec3): Ray => ({ origin: from, direction: dir });

describe('handle registry', () => {
    const p = part([sketchStep([rect([5, -3], 20, 10)])]);

    it('puts the extrude arrow at the profile centre on the top plane of the part, along the normal', () => {
        const [h] = handlesFor('extrude', extrudeValues(), ctxOf(p), noEnv);
        expect(h.kind).toBe('distance');
        if (h.kind !== 'distance') return;
        // Top plane at offset 10: (u, v) = (5, -3) is part (5, 10, 3); the part sits at (10, 5, 0).
        close(h.origin, [15, 15, 3]);
        close(h.direction, [0, 1, 0]);
        expect(h).toMatchObject({ key: 'distance', value: 12, min: 0, symmetric: false });
        close(tipOf(h), [15, 27, 3]);
    });

    it('turns the arrow with the part', () => {
        const [h] = handlesFor('extrude', extrudeValues(), ctxOf(part(p.features!, [0, 0, 0], [90, 0, 0])), noEnv);
        if (h.kind !== 'distance') throw new Error('distance handle expected');
        close(h.direction, [0, 0, 1]);
        close(h.origin, [5, -3, 10]);
    });

    it('reverses the arrow, and for symmetric puts mirrored tips at half the distance', () => {
        const [rev] = handlesFor('extrude', extrudeValues({ direction: 'reverse' }), ctxOf(p), noEnv);
        if (rev.kind !== 'distance') throw new Error('distance handle expected');
        close(rev.direction, [0, -1, 0]);
        close(tipOf(rev), [15, 3, 3]);
        const [sym] = handlesFor('extrude', extrudeValues({ direction: 'symmetric' }), ctxOf(p), noEnv);
        if (sym.kind !== 'distance') throw new Error('distance handle expected');
        expect(sym.symmetric).toBe(true);
        close(tipOf(sym, 1), [15, 21, 3]);
        close(tipOf(sym, -1), [15, 9, 3]);
        expect(gripShapes(sym, 0.1)).toHaveLength(2);
    });

    it('shows no arrow for a cut through all, or while the distance is not a number', () => {
        expect(handlesFor('cut', extrudeValues({ mode: 'cut', through: true }), ctxOf(p), noEnv)).toEqual([]);
        expect(handlesFor('cut', extrudeValues({ mode: 'cut', through: false }), ctxOf(p), noEnv)).toHaveLength(1);
        expect(handlesFor('extrude', extrudeValues({ distance: '' }), ctxOf(p), noEnv)).toEqual([]);
        expect(handlesFor('extrude', extrudeValues({ sketch: 'nope' }), ctxOf(p), noEnv)).toEqual([]);
        expect(handlesFor('fillet', { r: '2' }, ctxOf(p), noEnv)).toEqual([]);
    });

    it('centres on the picked regions of that sketch only', () => {
        const two = part([sketchStep([rect([-20, 0], 10, 10), rect([20, 0], 10, 10)])], [0, 0, 0]);
        const all = handlesFor('extrude', extrudeValues(), ctxOf(two), noEnv)[0];
        const picked = handlesFor('extrude', extrudeValues(), ctxOf(two), { picks: [[21, 1]], pickKey: 'p1/sketch-1' })[0];
        const other = handlesFor('extrude', extrudeValues(), ctxOf(two), { picks: [[21, 1]], pickKey: 'p1/sketch-9' })[0];
        if (all.kind !== 'distance' || picked.kind !== 'distance' || other.kind !== 'distance') throw new Error('distance handles expected');
        close(all.origin, [0, 10, 0]);
        close(picked.origin, [20, 10, 0]);
        close(other.origin, [0, 10, 0]);
    });

    it('uses the open sketch for Exit sketch, only for extrude, cut and revolve', () => {
        const env: HandleEnv = {
            picks: [], pickKey: null,
            sketch: { plane: 'front', offset: 0, context: [], regions: [], points: [[0, 0], [10, 20]], part: null },
        };
        const [h] = handlesFor('sk-finish', { op: 'extrude', distance: '8', direction: 'normal', through: false }, ctxOf(null), env);
        if (h.kind !== 'distance') throw new Error('distance handle expected');
        close(h.origin, [5, 10, 0]);
        close(h.direction, [0, 0, 1]);
        expect(handlesFor('sk-finish', { op: 'sketch', distance: '8' }, ctxOf(null), env)).toEqual([]);
        expect(handlesFor('sk-finish', { op: 'cut', distance: '8', through: true }, ctxOf(null), env)).toEqual([]);
        expect(handlesFor('sk-finish', { op: 'cut', distance: '8', through: false, direction: 'reverse' }, ctxOf(null), env)).toHaveLength(1);
        expect(handlesFor('sk-finish', { op: 'extrude', distance: '8' }, ctxOf(null), noEnv)).toEqual([]);
        const [arc] = handlesFor('sk-finish', { op: 'revolve', axis: 'v', angle: '270' }, ctxOf(null), {
            ...env, sketch: { ...env.sketch!, regions: [rect([20, 5], 10, 10)] },
        });
        expect(arc).toMatchObject({ kind: 'angle', key: 'angle', value: 270, min: 0, max: 360 });
        if (arc.kind !== 'angle') return;
        close(arc.origin, [0, 5, 0]);
        close(arc.axis, [0, 1, 0]);
        close(arc.start, [1, 0, 0]);
        expect(arc.radius).toBeCloseTo(20);
    });

    it('turns the revolve arc about a centreline or an axis step, reversed, and shows none for mid plane', () => {
        const geometry = {
            points: [{ id: 'a', u: 10, v: 0 }, { id: 'b', u: 10, v: 10 }],
            curves: [{ id: 'cl', kind: 'line' as const, a: 'a', b: 'b', construction: true }],
            constraints: [],
        };
        const env: HandleEnv = {
            picks: [], pickKey: null,
            sketch: { plane: 'front', offset: 0, context: [], regions: [rect([20, 5], 10, 10)], points: [], part: null, geometry },
        };
        const [arc] = handlesFor('sk-finish', { op: 'revolve', axis: 'line:cl', angle: '90' }, ctxOf(null), env);
        if (arc?.kind !== 'angle') throw new Error('angle handle expected');
        close(arc.origin, [10, 5, 0]);
        close(arc.axis, [0, 1, 0]);
        expect(arc.radius).toBeCloseTo(10);
        const [back] = handlesFor('sk-finish', { op: 'revolve', axis: 'line:cl', angle: '90', reverse: true }, ctxOf(null), env);
        if (back?.kind !== 'angle') throw new Error('angle handle expected');
        close(back.axis, [0, -1, 0]);
        expect(handlesFor('sk-finish', { op: 'revolve', axis: 'line:cl', angle: '90', revolveType: 'midPlane' }, ctxOf(null), env)).toEqual([]);
        // Revolve on a sketch step: the axis is that sketch's own field; here an axis step along Z at x = 30.
        const p = part([
            sketchStep([rect([5, -3], 20, 10)]),
            { id: 'ax', op: 'axis', definition: { kind: 'twoPoints', a: [30, 10, 0], b: [30, 10, 1] } } as Feature,
        ], [0, 0, 0]);
        const [step] = handlesFor('revolve', { sketch: 'sketch-1', axis_sketch_1: 'v', 'axis_sketch-1': 'axis:ax', angle: '45' }, ctxOf(p), noEnv);
        if (step?.kind !== 'angle') throw new Error('angle handle expected');
        close(step.axis, [0, 0, 1]);
        close(step.origin, [30, 10, 3]);
    });

    it('describes Move, Rotate, Duplicate and Hole', () => {
        const p0 = part([], [1, 2, 3], [10, 20, 30]);
        expect(handlesFor('move', { pos0: '4', pos1: '5', pos2: '6', step: '10' }, ctxOf(p0), noEnv))
            .toEqual([{ kind: 'translate', keys: ['pos0', 'pos1', 'pos2'], position: [4, 5, 6], step: 1 }]);
        expect(handlesFor('move', { pos0: '4', pos1: '', pos2: '6' }, ctxOf(p0), noEnv)).toEqual([]);
        expect(handlesFor('rotate', { rot0: '10', rot1: '20', rot2: '30' }, ctxOf(p0), noEnv))
            .toEqual([{ kind: 'rotate', keys: ['rot0', 'rot1', 'rot2'], position: [1, 2, 3], rotation: [10, 20, 30], step: 1 }]);
        expect(handlesFor('duplicate', { off0: '50', off1: '0', off2: '0' }, ctxOf(p0), noEnv)[0])
            .toMatchObject({ kind: 'translate', position: [51, 2, 3], keys: ['off0', 'off1', 'off2'] });
        const [hole] = handlesFor('hole', { face: 'top', pos0: '0', pos1: '5', pos2: '0', through: false, depth: '6' }, ctxOf(part([], [0, 0, 0])), noEnv);
        if (hole.kind !== 'distance') throw new Error('distance handle expected');
        close(hole.origin, [0, 5, 0]);
        close(hole.direction, [0, -1, 0]);
        expect(handlesFor('hole', { face: 'top', pos0: '0', pos1: '5', pos2: '0', through: true, depth: '6' }, ctxOf(p0), noEnv)).toEqual([]);
    });

    it('finds profile centres by area, and falls back to the bounding box', () => {
        const c = profileCentre([rect([0, 0], 10, 10), rect([30, 0], 20, 20)], [], []);
        expect(c[0]).toBeCloseTo(24);
        expect(profileCentre([], [], [[-4, 2], [6, 8], [0, 0]])).toEqual([1, 4]);
        expect(profileCentre([], [], [])).toEqual([0, 0]);
    });
});

describe('handle maths', () => {
    it('finds the point on an axis nearest to a ray', () => {
        expect(axisParam(ray([100, 15, 0], [-1, 0, 0]), [0, 0, 0], [0, 1, 0])).toBeCloseTo(15);
        expect(axisParam(ray([100, 15, 7], [-1, 0, 0]), [0, 0, 0], [0, 1, 0])).toBeCloseTo(15);
        expect(axisParam(ray([0, 100, 0], [0, -1, 0]), [0, 0, 0], [0, 1, 0])).toBeNull();
    });

    it('rounds to the step, ten times coarser with Shift, not at all with Alt, and clamps', () => {
        expect(snapValue(17.3, 0.5)).toBe(17.5);
        expect(snapValue(17.3, 0.5, { shift: true })).toBe(15);
        expect(snapValue(17.3, 0.5, { alt: true })).toBe(17.3);
        expect(snapValue(17.333, 0.5, { alt: true })).toBe(17.33);
        expect(snapValue(-3, 0.5, {}, 0)).toBe(0);
        expect(snapValue(400, 5, {}, 0, 360)).toBe(360);
        // Zoomed in, a length drag steps finer than the handle's own step; Alt follows the pointer to a pixel's worth.
        expect(dragStep(0.5, 0.2)).toBe(0.5);
        expect(dragStep(0.5, 0.01)).toBe(0.1);
        expect(dragStep(0.5, 0.0001)).toBe(0.001);
        expect(dragStep(0.5)).toBe(0.5);
        expect(snapValue(17.3337, 0.001, { perPixel: 0.0001 })).toBe(17.334);
        expect(snapValue(17.33374, 0.5, { alt: true, perPixel: 0.0001 })).toBe(17.3337);
        expect(wrapDegrees(270)).toBe(-90);
        expect(wrapDegrees(-180)).toBe(180);
        expect(wrapDegrees(540)).toBe(180);
    });

    const arrow: Handle = { kind: 'distance', key: 'distance', origin: [0, 0, 0], direction: [0, 1, 0], value: 10, min: 0, step: 0.5 };
    const side = (y: number) => ray([100, y, 0], [-1, 0, 0]);

    it('drags a distance arrow by how far the grab point moves along it', () => {
        const drag = beginDrag(arrow, { kind: 'tip', sign: 1 }, side(10), { distance: '10' })!;
        expect(dragValues(drag, side(17.3))).toEqual({ distance: '17.5' });
        expect(dragValues(drag, side(17.3), { alt: true })).toEqual({ distance: '17.3' });
        expect(dragValues(drag, side(17.3), { shift: true })).toEqual({ distance: '15' });
        expect(dragValues(drag, side(-20))).toEqual({ distance: '0' });
        // Grabbed on the shaft, not the tip: no jump.
        const mid = beginDrag(arrow, { kind: 'tip', sign: 1 }, side(4), { distance: '10' })!;
        expect(dragValues(mid, side(6))).toEqual({ distance: '12' });
        expect(dragValues(mid, ray([0, 100, 0], [0, -1, 0]))).toBeNull();
        expect(dragLabel(mid, { distance: '12' })).toBe('12 mm');
    });

    it('drags either tip of a symmetric arrow by twice the move', () => {
        const sym: Handle = { ...arrow, symmetric: true } as Handle;
        const up = beginDrag(sym, { kind: 'tip', sign: 1 }, side(5), { distance: '10' })!;
        expect(dragValues(up, side(8))).toEqual({ distance: '16' });
        const down = beginDrag(sym, { kind: 'tip', sign: -1 }, side(-5), { distance: '10' })!;
        expect(dragValues(down, side(-8))).toEqual({ distance: '16' });
        expect(dragValues(down, side(-2))).toEqual({ distance: '4' });
    });

    const triad: Handle = { kind: 'translate', keys: ['pos0', 'pos1', 'pos2'], position: [0, 0, 0], step: 1 };
    const fromFront = (x: number, y: number) => ray([x, y, 100], [0, 0, -1]);

    it('moves along one axis, or in a plane', () => {
        const start = { pos0: '0', pos1: '0', pos2: '5' };
        const x = beginDrag(triad, { kind: 'axis', axis: 0 }, fromFront(50, 3), start)!;
        expect(dragValues(x, fromFront(62.4, 9))).toEqual({ pos0: '12' });
        const xy = beginDrag(triad, { kind: 'plane', normal: 2 }, fromFront(10, 10), start)!;
        expect(dragValues(xy, fromFront(13.2, 21.7))).toEqual({ pos0: '3', pos1: '12' });
        expect(dragLabel(xy, { pos0: '3', pos1: '12' })).toBe('X 3 · Y 12 mm');
        // Looking straight down the z axis: nothing to measure.
        expect(beginDrag(triad, { kind: 'axis', axis: 2 }, fromFront(0, 0), start)).toBeNull();
    });

    it('turns a ring by the angle swept around its axis, counting past 180 degrees', () => {
        const rings: Handle = { kind: 'rotate', keys: ['rot0', 'rot1', 'rot2'], position: [0, 0, 0], rotation: [0, 0, 0], step: 5 };
        const at = (y: number, z: number) => ray([100, y, z], [-1, 0, 0]);
        const drag = beginDrag(rings, { kind: 'ring', axis: 0 }, at(50, 0), { rot0: '0', rot1: '0', rot2: '0' })!;
        expect(dragValues(drag, at(0, 50))).toEqual({ rot0: '90' });
        expect(dragValues(drag, at(-50, 1))).toEqual({ rot0: '180' });
        expect(dragValues(drag, at(0, -50))).toEqual({ rot0: '-90' });
        expect(drag.turned).toBeCloseTo(270, 0);
        expect(ringAngle(at(0, 50), [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(90);
    });

    it('uses gimbal axes for Euler XYZ rings', () => {
        const [x, y, z] = gimbalAxes([90, 0, 0]);
        close(x, [1, 0, 0]);
        close(y, [0, 0, 1]);
        close(z, [0, -1, 0]);
        close(gimbalAxes([0, 90, 0])[2], [1, 0, 0]);
    });

    it('drags a revolve angle within 0 to 360 degrees', () => {
        const arc: Handle = { kind: 'angle', key: 'angle', origin: [0, 5, 0], axis: [0, 1, 0], start: [1, 0, 0], radius: 20, value: 90, min: 0, max: 360, step: 5 };
        const above = (x: number, z: number) => ray([x, 100, z], [0, -1, 0]);
        const drag = beginDrag(arc, { kind: 'arc' }, above(30, 0), { angle: '90' })!;
        // Right-handed about +y, +x turns towards -z.
        close(rotateAbout([1, 0, 0], [0, 1, 0], 90), [0, 0, -1]);
        expect(dragValues(drag, above(0, -30))).toEqual({ angle: '180' });
        expect(dragValues(drag, above(-30, 0))).toEqual({ angle: '270' });
        expect(dragValues(drag, above(0, 30))).toEqual({ angle: '360' });
        expect(dragValues(drag, above(30, 1))).toEqual({ angle: '360' });
    });

    it('picks the grip under the pointer', () => {
        // Looking down -z, one world unit per pixel, y up.
        const project = (p: Vec3): [number, number] => [p[0], -p[1]];
        const shapes = gripShapes(arrow, 1);
        expect(pickGrip(shapes, project, [4, -6])?.grip).toEqual({ kind: 'tip', sign: 1 });
        expect(pickGrip(shapes, project, [30, -6])).toBeNull();
        const triad1 = gripShapes(triad, 1);
        expect(pickGrip(triad1, project, [60, -2])?.grip).toEqual({ kind: 'axis', axis: 0 });
        expect(pickGrip(triad1, project, [35, -35])?.grip).toEqual({ kind: 'plane', normal: 2 });
        expect(pickGrip(triad1, project, [200, -200])).toBeNull();
    });
});
