import { describe, expect, it } from 'vitest';
import type { Feature, Shape } from '@jarvis/core';
import { boxShape, boxValues, BOX_DEFAULTS, cylinderShape, cylinderValues, CYLINDER_DEFAULTS } from './primitiveForm';
import { chamferTypeFields, chamferTypeValues } from './chamferForm';

describe('editing base shapes keeps every field', () => {
    it('a box with automatic edge rounding stays automatic', () => {
        const auto: Shape = { kind: 'box', size: [40, 20, 30] };
        expect(boxShape(boxValues(auto))).toEqual(auto);
        const sharp: Shape = { kind: 'box', size: [40, 20, 30], radius: 0 };
        expect(boxShape(boxValues(sharp))).toEqual(sharp);
        expect(boxShape(BOX_DEFAULTS)).toEqual({ kind: 'box', size: [40, 20, 30], radius: 0.5 });
    });

    it('a cylinder keeps its taper and bevel', () => {
        const tapered: Shape = { kind: 'cylinder', radius: 15, radiusTop: 10, height: 30, bevel: 1 };
        expect(cylinderShape(cylinderValues(tapered))).toEqual(tapered);
        const plain: Shape = { kind: 'cylinder', radius: 15, height: 30 };
        expect(cylinderShape(cylinderValues(plain))).toEqual(plain);
        expect(cylinderShape(CYLINDER_DEFAULTS)).toEqual({ kind: 'cylinder', radius: 15, height: 30 });
    });
});

describe('chamfer type', () => {
    const chamfer = (extra: object): Extract<Feature, { op: 'chamfer' }> => ({ id: 'c', op: 'chamfer', size: 2, ...extra });

    it('opens a distance-angle chamfer as one and saves its angle', () => {
        const values = chamferTypeValues(chamfer({ angle: 30 }));
        expect(values).toMatchObject({ ctype: 'angle', angle: '30' });
        expect(chamferTypeFields(values)).toEqual({ distance2: null, angle: 30 });
    });

    it('opens a two-distance chamfer as one, and going back to equal removes the extras', () => {
        const values = chamferTypeValues(chamfer({ distance2: 3 }));
        expect(values).toMatchObject({ ctype: 'distances', d2: '3' });
        expect(chamferTypeFields(values)).toEqual({ distance2: 3, angle: null });
        expect(chamferTypeFields({ ...values, ctype: 'equal' })).toEqual({ distance2: null, angle: null });
        expect(() => chamferTypeFields({ ctype: 'angle', angle: '95' })).toThrow(/Angle/);
    });
});
