import { describe, expect, it } from 'vitest';
import type { AxisDefinition, Feature, PlaneDefinition } from '@jarvis/core';
import {
    axisDefaults, axisDefinition, axisValues, checkReference, lineKey, linePickTarget, planeDefaults, planeDefinition, planeValues,
    refPickPatch,
} from './referenceDefs';

describe('plane form', () => {
    it('round-trips every plane definition through the form values', () => {
        const definitions: PlaneDefinition[] = [
            { kind: 'offset', base: { planeRef: 'p1' }, distance: -12.5 },
            { kind: 'angle', base: 'front', about: { axisRef: 'ax' }, angle: 30 },
            { kind: 'angle', base: 'top', about: 'u', angle: -45 },
            { kind: 'midplane', a: 'top', b: { planeRef: 'p2' } },
            { kind: 'parallel', base: 'right', point: { pointRef: 'pt' } },
            { kind: 'threePoints', points: [[0, 0, 0], { pointRef: 'pt' }, [0, 5, 1]] },
            { kind: 'normal', axis: 'y', point: [1, 2, 3] },
            { kind: 'normal', axis: { axisRef: 'ax' } },
            { kind: 'pointNormal', point: [1, 2, 3], normal: [0, 0, 1] },
        ];
        for (const d of definitions) {
            expect(planeDefinition(planeValues(d))).toEqual(d);
        }
    });

    it('makes the n-th of several offset planes, and says what is missing', () => {
        const v = { ...planeDefaults(), distance: '10', count: '3' };
        expect(planeDefinition(v, 3)).toEqual({ kind: 'offset', base: 'top', distance: 30 });
        expect(() => planeDefinition({ ...planeDefaults(), kind: 'midplane', b: '' })).toThrow(/second plane/);
        expect(() => planeDefinition({ ...planeDefaults(), distance: 'x' })).toThrow(/Distance must be a number/);
    });

    it('checks a definition against the steps before it', () => {
        const steps: Feature[] = [{ id: 'p', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 5 } }];
        expect(() => checkReference('plane', { kind: 'midplane', a: 'top', b: 'front' }, steps)).toThrow(/^A midplane needs two parallel planes/);
        expect(() => checkReference('plane', { kind: 'midplane', a: 'top', b: { planeRef: 'p' } }, steps)).not.toThrow();
        expect(() => checkReference('axis', { kind: 'planeIntersection', a: 'top', b: { planeRef: 'p' } }, steps)).toThrow(/parallel/);
    });
});

describe('axis form', () => {
    it('round-trips every axis definition through the form values', () => {
        const definitions: AxisDefinition[] = [
            { kind: 'sketchLine', sketchRef: 'sk', line: 'c1' },
            { kind: 'planeIntersection', a: 'top', b: { planeRef: 'p' } },
            { kind: 'twoPoints', a: { pointRef: 'pt' }, b: [1, 2, 3] },
            { kind: 'pointPlane', point: [0, 0, 1], plane: 'front' },
            { kind: 'pointDirection', point: [0, 0, 1], direction: [1, 0, 0] },
        ];
        for (const d of definitions) {
            expect(axisDefinition(axisValues(d))).toEqual(d);
        }
        expect(() => axisDefinition({ ...axisDefaults(), sketch: 'sk' })).toThrow(/Pick a sketch and one of its lines/);
    });
});

describe('picks in the view', () => {
    it('fills the open form from clicked planes, axes and points, in turn where it takes several', () => {
        const mid = { ...planeDefaults(), kind: 'midplane' };
        const first = refPickPatch('plane', mid, 'plane', 'p1')!;
        expect(first).toEqual({ a: 'p1', refTurn: true });
        expect(refPickPatch('plane', { ...mid, ...first }, 'plane', 'p2')).toEqual({ b: 'p2', refTurn: false });
        expect(refPickPatch('plane', planeDefaults(), 'plane', 'p1')).toEqual({ base: 'p1' });
        expect(refPickPatch('plane', { ...planeDefaults(), kind: 'angle' }, 'axis', 'ax')).toEqual({ about: 'axis:ax' });
        expect(refPickPatch('plane', { ...planeDefaults(), kind: 'threePoints' }, 'point', 'pt')).toEqual({ p1src: 'pt', refCount: '1' });
        expect(refPickPatch('plane', planeDefaults(), 'point', 'pt')).toBeNull();
        expect(refPickPatch('axis', { ...axisDefaults(), kind: 'pointPlane' }, 'plane', 'p')).toEqual({ plane: 'p' });
        expect(refPickPatch('revolve', { sketch: 'sk' }, 'axis', 'ax')).toEqual({ axis_sk: 'axis:ax' });
        expect(refPickPatch('fillet', {}, 'plane', 'p')).toBeNull();
    });

    it('offers the sketch lines to click for Revolve and for the Axis tool', () => {
        expect(linePickTarget('revolve', { sketch: 'sk' })).toEqual({ sketch: 'sk', key: 'axis_sk', prefix: 'line:' });
        expect(linePickTarget('axis', { kind: 'sketchLine', sketch: 'sk' })).toEqual({ sketch: 'sk', key: lineKey('sk'), prefix: '' });
        expect(linePickTarget('axis', { kind: 'twoPoints', sketch: 'sk' })).toBeNull();
        expect(linePickTarget('extrude', { sketch: 'sk' })).toBeNull();
    });
});
