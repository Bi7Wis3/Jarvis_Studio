import { describe, expect, it } from 'vitest';
import type { Feature, SketchGeometry } from '@jarvis/core';
import {
    axisFromValue, axisOptions, axisValue, defaultAxis, latheProfile, readRevolve, revolveSpan, revolveStepFields, revolveValues,
} from './revolveAxis';

const geometry = (construction: boolean[]): SketchGeometry => ({
    points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 0, v: 10 }],
    curves: construction.map((c, i) => ({ id: `l${i}`, kind: 'line' as const, a: 'a', b: 'b', construction: c })),
    constraints: [],
});

describe('revolve axis', () => {
    it('round-trips the axis through the form value', () => {
        for (const axis of ['u', 'v', 'y', { line: 'l1' }, { axisRef: 'ax' }] as const) {
            expect(axisFromValue(axisValue(axis))).toEqual(axis);
        }
        expect(axisFromValue(undefined)).toBe('v');
    });

    it('defaults to the only centreline, else the sketch V axis', () => {
        expect(defaultAxis(geometry([false, true]))).toBe('line:l1');
        expect(defaultAxis(geometry([true, true]))).toBe('v');
        expect(defaultAxis(undefined)).toBe('v');
    });

    it('offers the sketch axes, its lines and centrelines, and axis steps', () => {
        const steps = [
            { id: 'ax', op: 'axis', name: 'Axis1', definition: { kind: 'twoPoints', a: [0, 0, 0], b: [0, 1, 0] } },
            { id: 'off', op: 'axis', name: 'Axis2', suppressed: true, definition: { kind: 'twoPoints', a: [0, 0, 0], b: [0, 1, 0] } },
        ] as Feature[];
        expect(axisOptions(geometry([false, true]), steps, 'x').map((o) => o.label))
            .toEqual(['Sketch V (vertical)', 'Sketch U (horizontal)', 'Line 1', 'Centreline 1', 'Axis1', 'X axis']);
    });

    it('lays a profile out around an axis for the lathe preview, on either side', () => {
        const right = latheProfile([[5, 0], [8, 0], [8, 4]], { point: [2, 0], direction: [0, 1] });
        expect(right.side).toEqual([1, -0]);
        expect(right.points).toEqual([[3, 0], [6, 0], [6, 4]]);
        const left = latheProfile([[-5, 1]], { point: [0, 0], direction: [0, 1] });
        expect(left.side).toEqual([-1, 0]);
        expect(left.points).toEqual([[5, 1]]);
    });

    it('sends every option on an edit, so going back to 360 degrees or turning options off sticks', () => {
        // features_update merges the fields it is given into the stored step.
        const stored = { id: 'r', op: 'revolve', mode: 'add', sketchRef: 's', axis: 'u', angle: 180, type: 'midPlane', reverse: true, angle2: 30 } as Feature;
        const back = revolveStepFields({ axis: 'v', angle: 360, type: 'blind', reverse: false, angle2: null }, stored);
        expect({ ...stored, ...back }).toMatchObject({ axis: 'v', angle: 360, type: 'blind', reverse: false, angle2: null });
        // A new step leaves the defaults out.
        expect(revolveStepFields({ axis: { line: 'c' }, angle: 360, type: 'blind', reverse: false, angle2: null }, null)).toEqual({ axis: { line: 'c' } });
        expect(revolveStepFields({ axis: 'v', angle: 90, type: 'blind', reverse: true, angle2: 45 }, null))
            .toEqual({ axis: 'v', angle: 90, reverse: true, angle2: 45 });
        // The form values round-trip.
        const values = { ...revolveValues({ angle: 120, type: 'blind', reverse: true, angle2: 40 }) };
        expect(readRevolve(values, 'line:c', (k) => Number(values[k]), true)).toEqual({ axis: { line: 'c' }, angle: 120, type: 'blind', reverse: true, angle2: 40 });
        expect(() => readRevolve({ ...values, angle: '330' }, 'v', (k) => Number(({ ...values, angle: '330' } as Record<string, unknown>)[k]), true))
            .toThrow(/more than 360/);
    });

    it('spans the angle like the kernel: blind, reversed, mid plane and two directions', () => {
        expect(revolveSpan(90, 'blind', false, 0)).toEqual([-0, 90]);
        expect(revolveSpan(90, 'blind', true, 0)).toEqual([0, -90]);
        expect(revolveSpan(180, 'midPlane', true, 30)).toEqual([-90, 180]);
        expect(revolveSpan(90, 'blind', false, 45)).toEqual([-45, 135]);
    });
});
