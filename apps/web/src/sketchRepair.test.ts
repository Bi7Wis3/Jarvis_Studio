import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { curveOf, loadSolver, solveGeometry } from './solver';
import { addCircle, addConstraint, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { findProblems, fixAll, fixProblem, fullyDefine, mergePoints } from './sketchRepair';

beforeAll(async () => {
    await loadSolver();
});

/** Two lines whose ends nearly meet at (10, 0), 0.2 mm apart. */
function gapped(): SketchGeometry {
    let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
    g = addLine(g, { at: [10.2, 0] }, { at: [10, 10] }).g;
    return g;
}

describe('repair sketch', () => {
    it('finds a small gap between end points and closes it by merging them', () => {
        const g = gapped();
        const problems = findProblems(g);
        expect(problems.map((p) => p.kind)).toEqual(['gap']);
        const fixed = fixProblem(g, problems[0]);
        expect(fixed.points).toHaveLength(3);
        const [a, b] = fixed.curves as { a: string; b: string }[];
        expect(a.b).toBe(b.a);
        expect(findProblems(fixed)).toEqual([]);
    });

    it('leaves end points alone that are joined, far apart, or held coincident', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [20, 10]).g;
        expect(findProblems(rect)).toEqual([]);
        let g = gapped();
        const [l1, l2] = g.curves as { a: string; b: string }[];
        g = addConstraint(g, { kind: 'coincident', a: l1.b, b: l2.a }).g;
        expect(findProblems(g)).toEqual([]);
    });

    it('finds a line lying on another, and identical circles, and removes the extra one', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 0] }).g;
        g = addLine(g, { at: [5, 0] }, { at: [12, 0] }).g;
        g = addCircle(g, { at: [0, 30] }, 4).g;
        g = addCircle(g, { at: [0, 30] }, 4).g;
        const short = g.curves[1].id;
        const problems = findProblems(g).filter((p) => p.kind === 'duplicate');
        expect(problems).toHaveLength(2);
        expect(problems[0].refs[0]).toBe(short);
        const fixed = fixProblem(g, problems[0]);
        expect(curveOf(fixed, short)).toBeUndefined();
        expect(fixed.curves).toHaveLength(3);
        // Its points went with it, as no other curve used them.
        expect(fixed.points).toHaveLength(g.points.length - 2);
    });

    it('removes a zero-length line and keeps its neighbours joined', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        const first = g.curves[0] as { b: string };
        const tiny = addLine(g, { at: [10, 0], point: first.b }, { at: [10, 0] });
        g = addLine(tiny.g, { at: [10, 0], point: tiny.b }, { at: [10, 10] }).g;
        const problems = findProblems(g);
        expect(problems.map((p) => p.kind)).toEqual(['zero']);
        const fixed = fixProblem(g, problems[0]);
        expect(fixed.curves).toHaveLength(2);
        const [a, b] = fixed.curves as { a: string; b: string }[];
        expect(a.b).toBe(b.a);
    });

    it('finds relations that refer to deleted geometry and removes them', () => {
        const g = addConstraint(addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g, { kind: 'horizontal', line: 'c-gone' }).g;
        const problems = findProblems(g);
        expect(problems).toMatchObject([{ kind: 'dangling' }]);
        expect(fixProblem(g, problems[0]).constraints).toEqual([]);
    });

    it('fixes everything at once', () => {
        let g = gapped();
        g = addLine(g, { at: [0, 0] }, { at: [5, 0] }).g;
        g = addConstraint(g, { kind: 'vertical', line: 'nothing' }).g;
        const r = fixAll(g);
        expect(r.fixed).toBeGreaterThanOrEqual(3);
        expect(findProblems(r.g)).toEqual([]);
        expect(solveGeometry(r.g).ok).toBe(true);
    });

    it('merging drops relations that say nothing any more', () => {
        let g = gapped();
        const [l1, l2] = g.curves as { id: string; a: string; b: string }[];
        g = addConstraint(g, { kind: 'distance', a: l1.b, b: l2.a, value: 0.2 }).g;
        g = addConstraint(g, { kind: 'pointOnCurve', point: l2.a, curve: l1.id }).g;
        const merged = mergePoints(g, l1.b, l2.a);
        // The distance is between one point now, and the point is an end of the line it was held on.
        expect(merged.constraints).toEqual([]);
    });
});

describe('fully define sketch', () => {
    it('adds dimensions until nothing is free, each one needed', () => {
        const g = addRect(EMPTY_GEOMETRY, [5, 5], [25, 15]).g;
        const r = fullyDefine(g);
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.dof).toBe(0);
        // Two to place it, two for its sides.
        expect(r.added).toBe(4);
        const check = solveGeometry(r.g);
        expect(check).toMatchObject({ ok: true, dof: 0, redundant: [] });
    });

    it('handles circles, a sketch at the origin and loose geometry', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [10, 5] }).g;
        g = addCircle(g, { at: [-10, 3] }, 2).g;
        const r = fullyDefine(g);
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.dof).toBe(0);
        expect(solveGeometry(r.g)).toMatchObject({ ok: true, dof: 0, redundant: [] });
    });
});
