import { describe, expect, it } from 'vitest';
import type { Part, Vec3 } from '@jarvis/core';
import type { ImportedMates } from '@jarvis/core/imported';
import { convertSwMates, fixedStates, SW_MATE_TYPES } from './swMates.js';
import type { SwMate } from './format.js';

const material = { color: '#888888', metalness: 0, roughness: 1 };
const part = (id: string, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0], features: Part['features'] = []): Part =>
    ({ id, name: id, shape: { kind: 'empty' }, position, rotation, material, features });

const imported = (mates: SwMate[]): ImportedMates => ({
    assembly: 'a.SLDASM', source: 'a.jarvis-sw.json', components: { 'base-1': 'base', 'pin-1': 'pin', 'side-1': 'side' }, mates,
});
const mate = (type: number, entities: SwMate['entities'], extra: Partial<SwMate> = {}): SwMate =>
    ({ name: `M${type}`, suppressed: false, type, alignment: 1, flipped: false, entities, errors: [], ...extra });

describe('SolidWorks mates as studio mates', () => {
    // The pin stands at (10, 20, 0) mm; the side part is turned 90 degrees about Y at (100, 0, 0).
    const parts = [part('base'), part('pin', [10, 20, 0]), part('side', [100, 0, 0], [0, 90, 0], [
        { id: 'p1', op: 'plane', name: 'Plane1', definition: { kind: 'offset', base: 'right', distance: 7 } },
    ])];

    it('reads the swMateType_e values of the standard mates', () => {
        expect(SW_MATE_TYPES).toEqual({ 0: 'coincident', 1: 'concentric', 2: 'perpendicular', 3: 'parallel', 4: 'tangent', 5: 'distance', 6: 'angle', 16: 'lock' });
    });

    it('turns faces into picks and geometry in each part\'s frame, metres into mm and radians into degrees', () => {
        const { mates, skipped } = convertSwMates(imported([
            mate(0, [{ referenceType: 2, component: 'base-1', params: [0, 0.005, 0, 0, 1, 0, 0, 0] }, { referenceType: 2, component: 'pin-1', params: [0.01, 0.005, 0, 0, -1, 0, 0, 0] }]),
            mate(1, [{ referenceType: 2, component: 'base-1', params: [0.01, 0, 0, 0, 1, 0, 0.003, 0] }, { referenceType: 2, component: 'pin-1', params: [0.01, 0.02, 0, 0, 1, 0, 0.0029, 0] }], { alignment: 0 }),
            mate(5, [{ referenceType: 2, component: 'base-1', params: [0, 0.005, 0, 0, 1, 0, 0, 0] }, { referenceType: 3, component: 'pin-1', params: [0.01, 0.03, 0, 0, 0, 0, 0, 0] }], { value: 0.0125, alignment: 2 }),
            mate(6, [{ referenceType: 1, component: 'base-1', params: [0, 0.005, 0, 1, 0, 0, 0, 0] }, { referenceType: 1, component: 'side-1', params: [0.1, 0, 0, 0, 0, 1, 0, 0] }], { value: Math.PI / 6 }),
        ]), parts);
        expect(skipped).toEqual([]);
        const [coincident, concentric, distance, angle] = mates;
        expect(coincident).toMatchObject({ type: 'coincident', alignment: 'antiAligned' });
        expect(coincident.refs[1]).toEqual({ part: 'pin', pick: { kind: 'face', at: [0, -15, 0], normal: [0, -1, 0] }, found: { type: 'plane', origin: [0, -15, 0], normal: [0, -1, 0] } });
        expect(concentric).toMatchObject({ type: 'concentric', alignment: 'aligned' });
        expect(concentric.refs[0].found).toEqual({ type: 'cylinder', point: [10, 0, 0], direction: [0, 1, 0], radius: 3 });
        expect(concentric.refs[1].found).toEqual({ type: 'cylinder', point: [0, 0, 0], direction: [0, 1, 0], radius: 2.9 });
        expect(distance).toMatchObject({ type: 'distance', value: 12.5 });
        expect(distance.alignment).toBeUndefined();
        expect(distance.refs[1].pick).toEqual({ kind: 'vertex', at: [0, 10, 0] });
        expect(angle.value).toBeCloseTo(30, 9);
        // The side part is turned a quarter about Y: the world's +Z edge runs along its own -X... as its frame says.
        expect(angle.refs[1].found).toMatchObject({ type: 'line', point: [0, 0, 0] });
        const d = (angle.refs[1].found as { direction: Vec3 }).direction;
        expect(Math.abs(d[0])).toBeCloseTo(1, 9);
    });

    it('matches planes, axes and origins to the part\'s own; turns the alignment when a plane faces the other way', () => {
        const { mates, skipped } = convertSwMates(imported([
            // The pin's Top plane, given facing down, with the base's Front plane.
            mate(2, [{ referenceType: 4, component: 'pin-1', params: [0.01, 0.02, 0, 0, -1, 0, 0, 0] }, { referenceType: 4, component: 'base-1', params: [0, 0, 0, 0, 0, 1, 0, 0] }], { alignment: 0 }),
            // The side part's Plane1 (7 mm off its Right plane), and the assembly's own Top plane.
            mate(0, [{ referenceType: 4, component: 'side-1', params: [0.1, 0, -0.007, 0, 0, -1, 0, 0] }, { referenceType: 4, params: [0, 0, 0, 0, 1, 0, 0, 0] }], { alignment: 1 }),
            mate(0, [{ referenceType: 25, component: 'pin-1', params: [0.01, 0.02, 0, 0, 0, 0, 0, 0] }, { referenceType: 25, component: 'base-1', params: [0, 0, 0, 0, 0, 0, 0, 0] }]),
            mate(3, [{ referenceType: 5, component: 'pin-1', params: [0.01, 0.05, 0, 0, 1, 0, 0, 0] }, { referenceType: 5, component: 'base-1', params: [0.003, 0, 0, 1, 0, 0, 0, 0] }]),
        ]), parts);
        expect(skipped.map((s) => s.reason)).toEqual([]);
        expect(mates[0].refs.map((r) => r.pick)).toEqual([{ kind: 'plane', plane: 'top' }, { kind: 'plane', plane: 'front' }]);
        expect(mates[0].alignment).toBe('antiAligned');
        expect(mates[1].refs.map((r) => [r.part, r.pick])).toEqual([['side', { kind: 'plane', plane: { step: 'p1' } }], [undefined, { kind: 'plane', plane: 'top' }]]);
        expect(mates[2].refs.map((r) => r.pick)).toEqual([{ kind: 'point', point: 'origin' }, { kind: 'point', point: 'origin' }]);
        expect(mates[3].refs.map((r) => r.pick)).toEqual([{ kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'x' }]);
    });

    it('keeps what it cannot convert, saying why', () => {
        const face: NonNullable<SwMate['entities']>[number] = { referenceType: 2, component: 'base-1', params: [0, 0, 0, 0, 1, 0, 0, 0] };
        const { mates, skipped } = convertSwMates(imported([
            mate(10, [face, face]),
            mate(5, [face, { ...face, component: 'pin-1' }], { min: 0.001, max: 0.004, value: 0.002 }),
            mate(0, [face, { ...face, component: 'gone-1' }]),
            mate(0, [face, { referenceType: 2, component: 'pin-1', params: [0, 0, 0, 0, 1, 0, 0.002, 0.004] }]),
            mate(0, [face, { referenceType: 4, component: 'pin-1', params: [0, 0, 0.005, 0, 0, 1, 0, 0] }]),
            mate(0, [face]),
            mate(1, [face, { ...face, component: 'pin-1' }]),
            mate(16, [{ referenceType: 20, component: 'pin-1', params: null }, { referenceType: 20, component: 'side-1', params: null }]),
        ]), parts);
        expect(skipped.map((s) => s.reason)).toEqual([
            'not a standard mate the studio has yet',
            'a limit mate (advanced mates are not in the studio yet)',
            'gone-1 was not imported',
            'a conical, spherical or other curved face (its parameters are not described in the API help)',
            'a plane the studio part has no match for',
            '1 entities where a standard mate has two',
            'a concentric mate between entities the studio does not take it for',
        ]);
        expect(mates.map((m) => [m.type, m.refs.map((r) => r.pick.kind)])).toEqual([['lock', ['component', 'component']]]);
    });

    it('fixes the components SolidWorks fixed, and all when the export does not say', () => {
        expect(fixedStates({ 'a-1': 'a', 'b-1': 'b', 'c-1': 'c' }, new Map([['a-1', true], ['b-1', false], ['c-1', undefined]])))
            .toEqual({ fixed: ['a', 'c'], floating: ['b'] });
        expect(fixedStates({ 'a-1': 'a' }, new Map())).toEqual({ fixed: ['a'], floating: [] });
    });
});
