import { beforeAll, describe, expect, it } from 'vitest';
import type { Feature } from '@jarvis/core';
import { bezierPieces, projectConic, splineCurves, type ModelCurve, type ModelSketch, type PlaneFrame3 } from '@jarvis/core/projection';
import { conicAt } from '@jarvis/core/curves';
import { loadSolver, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, broughtIn, pickAt } from './sketchGeometry';
import { snapCursor } from './snapping';
import {
    addModelCurves, chainOf, curveEntity, isModelLock, mergeSnapGeometry, otherSketchCurves, pierceSegment, snapGeometryOf,
} from './sketchModel';

beforeAll(async () => {
    await loadSolver();
});

const TOP: PlaneFrame3 = { origin: [0, 10, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };

/** What the kernel gives for the top face of a 40 x 20 plate with a hole of radius 5 (see project.test.ts). */
const plate: ModelSketch = {
    curves: [
        { kind: 'line', a: [0, 0], b: [40, 0], edge: 0 },
        { kind: 'line', a: [40, 0], b: [40, -20], edge: 1 },
        { kind: 'line', a: [40, -20], b: [0, -20], edge: 2 },
        { kind: 'line', a: [0, -20], b: [0, 0], edge: 3 },
        { kind: 'circle', center: [20, -10], radius: 5, edge: 4 },
    ],
    points: [[0, 0], [40, 0], [40, -20], [0, -20]],
    skipped: [],
};

describe('converted model curves', () => {
    it('become four lines sharing their corners and a circle, all locked as from the model', () => {
        const { g, ids } = addModelCurves(EMPTY_GEOMETRY, plate.curves, { lock: true });
        expect(ids).toHaveLength(5);
        expect(g.curves.map((c) => c.kind)).toEqual(['line', 'line', 'line', 'line', 'circle']);
        // Four corners and the circle centre.
        expect(g.points.map((p) => [p.u, p.v])).toEqual([[0, 0], [40, 0], [40, -20], [0, -20], [20, -10]]);
        expect(g.constraints.filter((c) => c.kind === 'fix')).toHaveLength(5);
        expect(g.constraints.filter((c) => c.kind === 'fixRadius')).toHaveLength(1);
        expect(g.constraints.every(isModelLock)).toBe(true);
        const solved = solveGeometry(g);
        expect(solved.ok).toBe(true);
        expect(solved.dof).toBe(0);
        expect(solved.geometry.points.map((p) => [p.u, p.v])).toEqual(g.points.map((p) => [p.u, p.v]));
    });

    it('keep the ids of what is already in the sketch free, and can be construction', () => {
        const first = addModelCurves(EMPTY_GEOMETRY, plate.curves.slice(0, 1), { lock: true });
        const second = addModelCurves(first.g, plate.curves.slice(4), { lock: true, construction: true });
        const ids = [...second.g.points, ...second.g.curves, ...second.g.constraints].map((x) => x.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(second.g.curves[1]).toMatchObject({ kind: 'circle', construction: true });
    });

    it('turn an ellipse into a centre, the major axis end and the minor axis end at a right angle', () => {
        const { g } = addModelCurves(EMPTY_GEOMETRY, [{ kind: 'ellipse', center: [1, 2], major: [4, 6], minor: 2 }]);
        const [c, major, minor] = g.points.map((p) => [p.u, p.v]);
        expect(major).toEqual([4, 6]);
        expect(Math.hypot(minor[0] - c[0], minor[1] - c[1])).toBeCloseTo(2, 9);
        expect((major[0] - c[0]) * (minor[0] - c[0]) + (major[1] - c[1]) * (minor[1] - c[1])).toBeCloseTo(0, 9);
    });

    it('preview as sketch entities', () => {
        expect(curveEntity({ kind: 'circle', center: [1, 1], radius: 2 })).toEqual({ kind: 'circle', c: [1, 1], r: 2 });
        const arc = curveEntity({ kind: 'arc', center: [0, 0], start: [1, 0], end: [0, 1] });
        expect(arc.kind).toBe('arc');
        if (arc.kind === 'arc') {
            expect(arc.m[0]).toBeCloseTo(Math.SQRT1_2, 9);
        }
    });
});

describe('snapping to model geometry', () => {
    it('catches the corners, edge midpoints, the hole centre and the edges', () => {
        const others = mergeSnapGeometry(undefined, snapGeometryOf(plate));
        const opts = { enabled: true, grid: 0, tolerance: 0.5, others };
        expect(snapCursor(EMPTY_GEOMETRY, [40.2, -0.1], opts)).toMatchObject({ p: [40, 0], kind: 'point' });
        expect(snapCursor(EMPTY_GEOMETRY, [0.3, -19.8], opts)).toMatchObject({ p: [0, -20], kind: 'point' });
        expect(snapCursor(EMPTY_GEOMETRY, [20.2, -10.1], opts)).toMatchObject({ p: [20, -10], kind: 'centre' });
        expect(snapCursor(EMPTY_GEOMETRY, [20.1, 0.2], opts)).toMatchObject({ p: [20, 0], kind: 'mid' });
        const edge = snapCursor(EMPTY_GEOMETRY, [31.3, -0.2], opts);
        expect(edge.kind).toBe('curve');
        expect(edge.p[1]).toBeCloseTo(0, 9);
        // Nothing is tied to the model: a point placed there is free.
        expect(snapCursor(EMPTY_GEOMETRY, [40.2, -0.1], opts).ref).toEqual({ at: [40, 0] });
    });

    it('merges with the other sketches', () => {
        const a = snapGeometryOf(plate);
        const merged = mergeSnapGeometry({ points: [{ id: 's/p1', u: 7, v: 7 }], curves: [], constraints: [] }, a)!;
        expect(merged.points.length).toBe(a.points.length + 1);
    });
});

describe('other sketches projected exactly', () => {
    const sketchStep = (id: string, plane: string, geometry: unknown): Feature => ({
        id, op: 'sketch', sketch: { plane, profiles: [], geometry },
    }) as unknown as Feature;
    const circle = sketchStep('s1', 'front', {
        points: [{ id: 'p1', u: 0, v: 10 }], curves: [{ id: 'c1', kind: 'circle', center: 'p1', radius: 5 }], constraints: [],
    });

    it('keeps a circle on a parallel plane', () => {
        const front: PlaneFrame3 = { origin: [0, 0, 7], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
        expect(otherSketchCurves([circle], front).map((c) => c.curve)).toEqual([{ kind: 'circle', center: [0, 10], radius: 5 }]);
    });

    it('turns it into an exact ellipse seen at a tilt, and a line seen edge-on', () => {
        const c = Math.cos(Math.PI / 3);
        const s = Math.sin(Math.PI / 3);
        const tilted: PlaneFrame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, c, -s], n: [0, s, c] };
        const [e] = otherSketchCurves([circle], tilted).map((x) => x.curve);
        expect(e.kind).toBe('ellipse');
        if (e.kind === 'ellipse') {
            expect(Math.hypot(e.major[0] - e.center[0], e.major[1] - e.center[1])).toBeCloseTo(5, 9);
            expect(e.minor).toBeCloseTo(5 * c, 9);
        }
        expect(otherSketchCurves([circle], TOP).map((x) => x.curve)).toEqual([{ kind: 'line', a: [-5, 0], b: [5, 0] }]);
    });

    it('chains curves joined end to end', () => {
        const lines = [[0, 0, 1, 0], [1, 0, 1, 1], [5, 5, 6, 6]].map(([a, b, c, d], i) => ({
            id: `s/${i}`, construction: false, curve: { kind: 'line', a: [a, b], b: [c, d] } as ModelCurve,
        }));
        expect(chainOf(lines, 1)).toEqual([1, 0]);
    });
});

describe('projection maths', () => {
    it('cuts a cubic B-spline into Bezier pieces that run through the same points', () => {
        const poles: [number, number][] = [[0, 0], [1, 2], [3, 3], [4, 0], [6, -1]];
        const knots = [0, 0, 0, 0, 0.5, 1, 1, 1, 1];
        const pieces = bezierPieces({ poles, weights: null, knots, degree: 3 });
        expect(pieces).toHaveLength(2);
        expect(pieces[0].poles[0]).toEqual([0, 0]);
        expect(pieces[1].poles[3]).toEqual([6, -1]);
        expect(pieces[0].poles[3]).toEqual(pieces[1].poles[0]);
    });

    it('keeps a style-spline B-spline whole and turns a rational quadratic into a conic', () => {
        const poles: [number, number][] = [[0, 0], [1, 2], [3, 3], [4, 0], [6, -1]];
        expect(splineCurves({ poles, weights: null, knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1], degree: 3 }))
            .toEqual([{ kind: 'bspline', poles, degree: 3 }]);
        // A quarter circle: weights 1, cos 45, 1.
        const w = Math.SQRT1_2;
        const [conic] = splineCurves({ poles: [[1, 0], [1, 1], [0, 1]], weights: [1, w, 1], knots: [0, 0, 0, 1, 1, 1], degree: 2 })!;
        expect(conic.kind).toBe('conic');
        if (conic.kind === 'conic') {
            const mid = conicAt(conic.start, conic.apex, conic.end, conic.rho, 0.5);
            expect(Math.hypot(...mid)).toBeCloseTo(1, 12);
        }
    });

    it('runs an arc seen from behind counter-clockwise', () => {
        const back: PlaneFrame3 = { origin: [0, 0, 0], u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] };
        // The quarter from +x to +y, seen from behind: from (0, 1) round to (-1, 0)... counter-clockwise in (u, v).
        const arc = projectConic(back, [0, 0, 0], [1, 0, 0], [0, 1, 0], 0, Math.PI / 2, false);
        expect(arc).toEqual({ kind: 'arc', center: [0, 0], start: [0, 1], end: [-1, 0] });
    });

    it('finds where an edge pierces the plane', () => {
        expect(pierceSegment(TOP, [3, 0, -4], [3, 20, -4])).toEqual([3, 4]);
        expect(pierceSegment(TOP, [3, 0, -4], [3, 5, -4])).toBeNull();
    });
});

describe('a spline copied in from the model', () => {
    // A spline edge with five poles: its ends are points of the sketch, its three control vertices only shape it.
    const poles: [number, number][] = [[0, 0], [4, 6], [10, 8], [16, 6], [20, 0]];
    const { g, ids } = addModelCurves(EMPTY_GEOMETRY, [{ kind: 'bspline', poles, degree: 3, edge: 0 } as ModelCurve], { lock: true, construction: true });

    it('keeps its control vertices out of the way: not listed as points to show, pick or snap to', () => {
        const brought = broughtIn(g);
        const curve = g.curves.find((c) => c.id === ids[0])!;
        expect(curve.kind).toBe('styleSpline');
        const points = curve.kind === 'styleSpline' ? curve.points : [];
        expect([...brought.curves]).toEqual(ids);
        expect([...brought.handles].sort()).toEqual(points.slice(1, -1).sort());
        expect(brought.locks.size).toBe(5);
        // A press on a control vertex finds nothing there; on an end it finds the end.
        expect(pickAt(g, [10, 8], 0.5)).toBeNull();
        expect(pickAt(g, [20, 0], 0.5)).toEqual({ type: 'point', id: points[points.length - 1] });
        // Drawing snaps to its ends, and not to a control vertex.
        const snap = { enabled: true, grid: 0, tolerance: 0.5 };
        expect(snapCursor(g, [20.1, 0.1], snap)).toMatchObject({ p: [20, 0], kind: 'point' });
        expect(snapCursor(g, [10.1, 8.1], snap).kind).not.toBe('point');
    });

    it('keeps a control vertex that something is drawn on', () => {
        const curve = g.curves.find((c) => c.id === ids[0])!;
        const pole = curve.kind === 'styleSpline' ? curve.points[2] : '';
        const drawn = { ...g, points: [...g.points, { id: 'p9', u: 30, v: 30 }], curves: [...g.curves, { id: 'c9', kind: 'line' as const, a: pole, b: 'p9' }] };
        expect(broughtIn(drawn).handles.has(pole)).toBe(false);
        expect(pickAt(drawn, [10, 8], 0.5)).toEqual({ type: 'point', id: pole });
    });
});
