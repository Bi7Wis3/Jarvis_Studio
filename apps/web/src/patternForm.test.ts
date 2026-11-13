import { describe, expect, it } from 'vitest';
import type { Feature } from '@jarvis/core';
import {
    axisFromValue, axisOptions, axisValue, CIRCULAR_DEFAULTS, circularFeature, circularValues, LINEAR_DEFAULTS, linearFeature,
    linearValues, parseSkip, patternableSteps, skipText, withoutNulls,
} from './patternForm';

const sketch = { plane: 'top' as const, profiles: [] };
const history: Feature[] = [
    { id: 's', op: 'sketch', sketch },
    { id: 'boss', name: 'Boss-Extrude1', op: 'extrude', mode: 'add', distance: 5, sketchRef: 's' },
    { id: 'ax', name: 'Axis1', op: 'axis', definition: { kind: 'pointDirection', point: [0, 0, 0], direction: [0, 1, 0] } },
    { id: 'f', op: 'fillet', radius: 1 },
    { id: 'h', name: 'Hole1', op: 'hole', spec: { kind: 'plain', diameter: 3 }, position: [0, 0, 0] },
    { id: 'p', op: 'pattern', kind: 'linear', features: ['h'], direction: 'x', count: 2, spacing: 5 },
];

describe('pattern form', () => {
    it('offers only earlier steps that add or cut material', () => {
        expect(patternableSteps(history).map((f) => f.id)).toEqual(['boss', 'h']);
        expect(patternableSteps(history, 'h').map((f) => f.id)).toEqual(['boss']);
    });

    it('offers the part axes and earlier axis steps, keeping a vector direction', () => {
        expect(axisOptions(history, 'boss').map((o) => o.value)).toEqual(['x', 'y', 'z']);
        expect(axisOptions(history).map((o) => o.label)).toEqual(['X axis', 'Y axis', 'Z axis', 'Axis1']);
        expect(axisOptions([], undefined, 'vec:1,0,1').at(-1)).toEqual({ value: 'vec:1,0,1', label: 'Direction (1, 0, 1)' });
        for (const ref of ['x', { axisRef: 'ax' }, [1, 0, 1]] as const) {
            expect(axisFromValue(axisValue(ref as never))).toEqual(ref);
        }
        expect(axisFromValue('')).toBeUndefined();
    });

    it('reads and writes instances to skip', () => {
        expect(parseSkip('3, 5 2:3')).toEqual([[3, 1], [5, 1], [2, 3]]);
        expect(skipText([[3, 1], [2, 3]])).toBe('3, 2:3');
        expect(() => parseSkip('1')).toThrow(/seed/);
        expect(() => parseSkip('x')).toThrow(/not an instance number/);
    });

    it('round-trips a linear pattern with two directions', () => {
        const feature = linearFeature({
            ...LINEAR_DEFAULTS, dir: 'ref:ax', rev: true, spacing: '12', count: '4', two: true, dir2: 'z', spacing2: '8',
            count2: '3', features: ['h'], skip: '4, 2:3',
        });
        expect(feature).toEqual({
            op: 'pattern', kind: 'linear', features: ['h'], direction: { axisRef: 'ax' }, spacing: 12, count: 4, reverse: true,
            direction2: 'z', spacing2: 8, count2: 3, reverse2: false, seedOnly2: false, skip: [[4, 1], [2, 3]],
        });
        const values = linearValues({ id: 'p', ...feature } as Extract<Feature, { op: 'pattern'; kind: 'linear' }>);
        expect(linearFeature(values)).toEqual(feature);
    });

    it('removes direction 2 when it is turned off', () => {
        const feature = linearFeature({ ...LINEAR_DEFAULTS, features: ['h'] });
        expect(feature).toMatchObject({ direction2: null, count2: null, spacing2: null });
        expect(withoutNulls(feature)).not.toHaveProperty('direction2');
    });

    it('says what is missing', () => {
        expect(() => linearFeature({ ...LINEAR_DEFAULTS, features: [] })).toThrow(/features to pattern/);
        expect(() => linearFeature({ ...LINEAR_DEFAULTS, dir: '', features: ['h'] })).toThrow(/Pick a direction/);
        expect(() => linearFeature({ ...LINEAR_DEFAULTS, features: ['h'], skip: '9' })).toThrow(/not an instance of this pattern/);
        expect(() => circularFeature({ ...CIRCULAR_DEFAULTS, axis: '', features: ['h'] })).toThrow(/Pick an axis/);
    });

    it('round-trips a circular pattern with equal spacing or an angle between instances', () => {
        const equal = circularFeature({ ...CIRCULAR_DEFAULTS, total: '180', count: '3', features: ['h'] });
        expect(equal).toMatchObject({ axis: 'y', angle: 180, equal: true, count: 3 });
        const apart = circularFeature({ ...CIRCULAR_DEFAULTS, equal: false, step: '30', count: '5', rev: true, features: ['h'], skip: '2' });
        expect(apart).toMatchObject({ angle: 30, equal: false, reverse: true, skip: [[2, 1]] });
        for (const f of [equal, apart]) {
            expect(circularFeature(circularValues({ id: 'p', ...f } as Extract<Feature, { op: 'pattern'; kind: 'circular' }>))).toEqual(f);
        }
        expect(() => circularFeature({ ...CIRCULAR_DEFAULTS, equal: false, step: '100', count: '5', features: ['h'] })).toThrow(/full turn/);
    });
});
