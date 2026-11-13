import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { loadSolver, measure, solveGeometry } from './solver';

beforeAll(async () => {
    await loadSolver();
});

/** A rough rectangle a-b-c-d (counter-clockwise) with corners shared by its four lines. */
function rect(): SketchGeometry {
    return {
        points: [
            { id: 'a', u: 3, v: 2 }, { id: 'b', u: 41, v: 1 }, { id: 'c', u: 39, v: 23 }, { id: 'd', u: 2, v: 19 },
        ],
        curves: [
            { id: 'l1', kind: 'line', a: 'a', b: 'b' }, { id: 'l2', kind: 'line', a: 'b', b: 'c' },
            { id: 'l3', kind: 'line', a: 'c', b: 'd' }, { id: 'l4', kind: 'line', a: 'd', b: 'a' },
        ],
        constraints: [
            { id: 'h1', kind: 'horizontal', line: 'l1' }, { id: 'h2', kind: 'horizontal', line: 'l3' },
            { id: 'v1', kind: 'vertical', line: 'l2' }, { id: 'v2', kind: 'vertical', line: 'l4' },
        ],
    };
}

const at = (g: SketchGeometry, id: string) => g.points.find((p) => p.id === id)!;

describe('sketch solver', () => {
    it('reports the free degrees of a rectangle with only H/V constraints', () => {
        const r = solveGeometry(rect());
        expect(r.ok).toBe(true);
        expect(r.dof).toBe(4);
    });

    it('fully constrains a rectangle with size and offsets from the origin and axes', () => {
        const g = rect();
        g.constraints.push(
            { id: 'w', kind: 'length', line: 'l1', value: 40 },
            { id: 'h', kind: 'length', line: 'l2', value: 20 },
            { id: 'ox', kind: 'distance', a: 'origin', b: 'a', axis: 'u', value: 5 },
            { id: 'oy', kind: 'distance', a: 'a', b: 'axis-u', value: 10 },
        );
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(r.dof).toBe(0);
        expect(at(r.geometry, 'a').u).toBeCloseTo(5);
        expect(at(r.geometry, 'a').v).toBeCloseTo(10);
        expect(at(r.geometry, 'c').u).toBeCloseTo(45);
        expect(at(r.geometry, 'c').v).toBeCloseTo(30);
    });

    it('sets the angle between two lines', () => {
        const g: SketchGeometry = {
            points: [{ id: 'p', u: 0, v: 0, fixed: true }, { id: 'q', u: 30, v: 1 }, { id: 'r', u: 20, v: 15 }],
            curves: [{ id: 'base', kind: 'line', a: 'p', b: 'q' }, { id: 'arm', kind: 'line', a: 'p', b: 'r' }],
            constraints: [
                { id: 'h', kind: 'horizontal', line: 'base' },
                { id: 'ang', kind: 'angle', a: 'base', b: 'arm', value: 30 },
                { id: 'len', kind: 'length', line: 'arm', value: 20 },
            ],
        };
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(at(r.geometry, 'r').u).toBeCloseTo(20 * Math.cos(Math.PI / 6));
        expect(at(r.geometry, 'r').v).toBeCloseTo(10);
        expect(measure(r.geometry, g.constraints[1])).toBeCloseTo(30);
    });

    it('drives a circle radius and an arc diameter', () => {
        const g: SketchGeometry = {
            points: [{ id: 'c', u: 0, v: 0, fixed: true }, { id: 'k', u: 50, v: 0 }, { id: 's', u: 58, v: 0 }, { id: 'e', u: 50, v: 9 }],
            curves: [
                { id: 'circle', kind: 'circle', center: 'c', radius: 7 },
                { id: 'arc', kind: 'arc', center: 'k', start: 's', end: 'e' },
            ],
            constraints: [
                { id: 'r', kind: 'radius', curve: 'circle', value: 12.5 },
                { id: 'd', kind: 'diameter', curve: 'arc', value: 20 },
            ],
        };
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(r.geometry.curves[0].kind === 'circle' && r.geometry.curves[0].radius).toBeCloseTo(12.5);
        expect(measure(r.geometry, g.constraints[1])).toBeCloseTo(20);
    });

    it('detects an over-constrained sketch and names the conflicting dimension', () => {
        const g = rect();
        g.constraints.push(
            { id: 'w', kind: 'length', line: 'l1', value: 40 },
            { id: 'w2', kind: 'length', line: 'l3', value: 30 },
        );
        const r = solveGeometry(g);
        expect(r.ok).toBe(false);
        expect([...r.conflicting, ...r.redundant].some((id) => id === 'w' || id === 'w2')).toBe(true);
    });

    it('lets a dragged free point follow and keeps constraints', () => {
        const g = rect();
        const r = solveGeometry(g, { targets: [{ point: 'c', u: 60, v: 40 }] });
        expect(r.ok).toBe(true);
        expect(at(r.geometry, 'c').u).toBeCloseTo(60, 3);
        expect(at(r.geometry, 'c').v).toBeCloseTo(40, 3);
        // b stays below c (vertical) and level with a (horizontal).
        expect(at(r.geometry, 'b').u).toBeCloseTo(60, 3);
        expect(at(r.geometry, 'b').v).toBeCloseTo(at(r.geometry, 'a').v, 3);
    });

    it('keeps a horizontal offset on the side it was measured', () => {
        const g = rect();
        const c: SketchConstraint = { id: 'off', kind: 'distance', a: 'b', b: 'origin', axis: 'u', value: 10 };
        g.constraints.push(c);
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(at(r.geometry, 'b').u).toBeCloseTo(10);
    });
});
