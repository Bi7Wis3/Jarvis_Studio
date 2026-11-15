import { describe, expect, it } from 'vitest';
import { Euler, MathUtils, Vector3 } from 'three';
import type { Vec3 } from '@jarvis/core';
import {
    eulerOf, frameOfEuler, halfAxis, pickedPlacement, placementValues, primitiveFrame, primitiveShape, primitiveSizeValues, primitiveStep,
    PRIMITIVE_KINDS, reanchor, SIZE_DEFAULTS, spinOf, type PrimitiveValues,
} from './primitiveFeature';

const placed = (extra: PrimitiveValues = {}): PrimitiveValues => ({
    pos0: '0', pos1: '0', pos2: '0', dir0: '0', dir1: '1', dir2: '0', flip: false, spin: '0', anchor: 'base', result: 'add', ...extra,
});

/** Where the step's rotation (three.js XYZ, as the kernel's place() applies it) takes a local vector. */
function turned(rotation: Vec3, v: Vec3): Vec3 {
    return new Vector3(...v).applyEuler(new Euler(...(rotation.map(MathUtils.degToRad) as Vec3), 'XYZ')).toArray() as Vec3;
}

function expectVec(a: Vec3, b: Vec3, digits = 9): void {
    a.forEach((c, i) => expect(c).toBeCloseTo(b[i], digits));
}

describe('primitive shapes', () => {
    it('every primitive builds its shape from the defaults and reads it back unchanged', () => {
        for (const kind of PRIMITIVE_KINDS) {
            const shape = primitiveShape(kind, SIZE_DEFAULTS[kind]);
            expect(shape.kind).toBe(kind);
            expect(primitiveShape(kind, primitiveSizeValues(shape)!)).toEqual(shape);
            // A straight cylinder opens with the top diameter equal to the base, ready for a taper.
            const { top: _top, ...rest } = SIZE_DEFAULTS[kind];
            expect(primitiveSizeValues(shape)).toMatchObject(rest);
        }
    });

    it('keeps fine values exactly: diameters halve to radii and back', () => {
        const shape = primitiveShape('cylinder', { dia: '12.3457', h: '0.0001', taper: true, top: '6.0001', bevel: '0' });
        expect(shape).toEqual({ kind: 'cylinder', radius: 6.17285, height: 0.0001, radiusTop: 3.00005, bevel: 0 });
        expect(primitiveSizeValues(shape)).toMatchObject({ dia: '12.3457', top: '6.0001' });
    });

    it('refuses sizes that make no solid, naming the field', () => {
        expect(() => primitiveShape('box', { ...SIZE_DEFAULTS.box, w: '0' })).toThrow(/Width/);
        expect(() => primitiveShape('tube', { ...SIZE_DEFAULTS.tube, id: '30' })).toThrow(/inner diameter/);
        expect(() => primitiveShape('torus', { ring: '10', tube: '10' })).toThrow(/tube diameter/);
        // A sharp edge is allowed; a negative round is not.
        expect(primitiveShape('box', { ...SIZE_DEFAULTS.box, r: '0' })).toMatchObject({ radius: 0 });
        expect(() => primitiveShape('box', { ...SIZE_DEFAULTS.box, r: '-1' })).toThrow(/Edge round/);
    });
});

describe('primitive placement', () => {
    it('stands on the point along +Y by default: the centre is half the height above it, no rotation', () => {
        const step = primitiveStep('box', { ...SIZE_DEFAULTS.box, ...placed({ pos0: '5', pos1: '10', pos2: '-2.5' }) });
        expect(step).toMatchObject({ op: 'add', position: [5, 20, -2.5], rotation: [0, 0, 0] });
        const centred = primitiveStep('box', { ...SIZE_DEFAULTS.box, ...placed({ anchor: 'centre' }) });
        expect(centred.position).toEqual([0, 0, 0]);
    });

    it('turns the shape so its axis follows the direction, the spin turning it about that axis', () => {
        for (const dir of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, -1, 0], [1, 2, -3], [0.3, -0.1, 0.9]] as Vec3[]) {
            for (const spin of [0, 30, -135.5, 90]) {
                const f = primitiveFrame(dir, spin);
                const rotation = eulerOf(f);
                const axis = new Vector3(...dir).normalize().toArray() as Vec3;
                expectVec(turned(rotation, [0, 1, 0]), axis);
                expectVec(turned(rotation, [1, 0, 0]), f.x);
                expectVec(turned(rotation, [0, 0, 1]), f.z);
                // Read back from the stored angles: the same axis and spin.
                const back = frameOfEuler(rotation);
                expectVec(back.y, axis);
                expect(spinOf(back.y, back.x)).toBeCloseTo(spin, 9);
            }
        }
    });

    it('reverse direction and a cut: the shape goes the other way, into the face', () => {
        const step = primitiveStep('cylinder', { ...SIZE_DEFAULTS.cylinder, ...placed({ pos1: '20', flip: true, result: 'cut' }) });
        expect(step.op).toBe('cut');
        expectVec(step.position, [0, 5, 0]);
        expectVec(turned(step.rotation, [0, 1, 0]), [0, -1, 0]);
    });

    it('a pick on a face puts the base there, the axis along the outward normal (into it for a cut)', () => {
        const values = pickedPlacement({ point: [10, 3.25, -4], normal: [0, 0, 2] }, false);
        expect(values).toMatchObject({ pos0: '10', pos1: '3.25', pos2: '-4', dir0: '0', dir1: '0', dir2: '1', flip: false, anchor: 'base' });
        const step = primitiveStep('sphere', { ...SIZE_DEFAULTS.sphere, ...placed(values) });
        expectVec(step.position, [10, 3.25, 6]);
        expect(pickedPlacement({ point: [0, 0, 0], normal: [1, 0, 0] }, true).flip).toBe(true);
    });

    it('a stored step opens with the same point, axis and spin, and saves back to the same step', () => {
        for (const kind of PRIMITIVE_KINDS) {
            const shape = primitiveShape(kind, SIZE_DEFAULTS[kind]);
            const values = placed({ pos0: '1.5', pos1: '-2', pos2: '7.25', dir0: '0.6', dir1: '0', dir2: '0.8', spin: '22.5' });
            const step = primitiveStep(kind, { ...SIZE_DEFAULTS[kind], ...values });
            const opened = placementValues(shape, step.position, step.rotation, 'base');
            const again = primitiveStep(kind, { ...SIZE_DEFAULTS[kind], ...placed(opened) });
            expectVec(again.position, step.position);
            expectVec(again.rotation, step.rotation);
            expect(Number(opened.pos0)).toBeCloseTo(1.5, 6);
            expect(Number(opened.spin)).toBeCloseTo(22.5, 9);
            expect(halfAxis(shape)).toBeGreaterThan(0);
        }
    });

    it('changing the anchor moves the point so the shape stays where it is', () => {
        const v = { ...SIZE_DEFAULTS.cone, ...placed({ pos1: '4', dir0: '1', dir1: '0' }) };
        const moved = reanchor({ ...v, anchor: 'centre' }, 'cone', 'centre');
        expect(moved).toEqual({ pos0: '15', pos1: '4', pos2: '0' });
        const step = primitiveStep('cone', { ...v, ...moved, anchor: 'centre' });
        expectVec(step.position, primitiveStep('cone', v).position);
    });
});
