import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, loadSolver, pointOf, solveGeometry } from './solver';
import { addConstraint, addLine, EMPTY_GEOMETRY } from './sketchGeometry';
import { extendAt, trimAt } from './sketchEdit';
import { unmetConstraints } from './sketchCheck';
import type { Pt } from './sketchMath';

beforeAll(async () => {
    await loadSolver();
});

const at = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const lines = (g: SketchGeometry) => g.curves.filter((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line');

describe('extend after trim', () => {
    it('moves a trimmed end to the next line, off the line it was cut at', () => {
        const base = addLine(EMPTY_GEOMETRY, { at: [-30, 0] }, { at: [30, 0] }, 'horizontal');
        let g = base.g;
        g = addLine(g, { at: [0, -20] }, { at: [0, 20] }).g;
        const far = addLine(g, { at: [-40, -20] }, { at: [-40, 20] });
        g = far.g;
        const trimmed = solveGeometry(trimAt(g, base.id, [-10, 0])!.g);
        expect(trimmed.ok).toBe(true);
        const plan = extendAt(trimmed.geometry, base.id, [1, 0])!;
        expect(plan).not.toBeNull();
        const r = solveGeometry(plan.g);
        expect(r.ok).toBe(true);
        const line = curveOf(r.geometry, base.id) as Extract<SketchCurve, { kind: 'line' }>;
        const [a, b] = [at(r.geometry, line.a), at(r.geometry, line.b)];
        expect(Math.min(a[0], b[0])).toBeCloseTo(-40, 5);
        expect(Math.max(a[0], b[0])).toBeCloseTo(30, 5);
        expect(a[1]).toBeCloseTo(0, 5);
        expect(b[1]).toBeCloseTo(0, 5);
        expect(lines(r.geometry)).toHaveLength(3);
        expect(unmetConstraints(r.geometry)).toEqual([]);
    });
});

describe('checking a solve', () => {
    it('finds the relations and dimensions a sketch does not meet', () => {
        // A line held on another it does not touch, a horizontal line that is not, and a length that is off.
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 5] }).g;
        const other = addLine(g, { at: [0, 20] }, { at: [10, 20] });
        g = other.g;
        const line = lines(g)[0];
        const k1 = addConstraint(g, { kind: 'pointOnCurve', point: line.a, curve: other.id });
        const k2 = addConstraint(k1.g, { kind: 'horizontal', line: line.id });
        const k3 = addConstraint(k2.g, { kind: 'length', line: other.id, value: 10 });
        expect(unmetConstraints(k3.g).sort()).toEqual([k1.id, k2.id].sort());
        // Once solved, all hold.
        const r = solveGeometry(k3.g);
        expect(r.ok).toBe(true);
        expect(unmetConstraints(r.geometry)).toEqual([]);
    });
});
