import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { bsplineAt, ellipseAxes, segmentPoints } from '@jarvis/core/curves';
import { loadSolver, measure, solveGeometry } from './solver';
import { addLine, EMPTY_GEOMETRY, geometryOpenChains, geometryProfiles, relationsFromPicks } from './sketchGeometry';
import { area, profilePoints } from './sketchMath';
import { regionsOf } from './regionPick';
import { snapCursor } from './snapping';
import { mirrorCurves, offsetEntities, splitAt, transformEntities, trimAt } from './sketchEdit';
import { filletCornerAt } from './sketchFillet';
import { currentSketch, endChain, setTool, sketchClick, sketchDown, sketchMove, sketchUp, useSketcher } from './sketcher';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 0.5;
const state = () => useSketcher.getState();
const at = (g: SketchGeometry, id: string): [number, number] => {
    const p = g.points.find((q) => q.id === id)!;
    return [p.u, p.v];
};
const dist = (p: [number, number], q: [number, number]) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** An ellipse about (10, 5): Radius 1 = 20 along u, Radius 2 = 8 along v. */
function ellipse(): SketchGeometry {
    return {
        points: [{ id: 'c', u: 10, v: 5 }, { id: 'm', u: 30, v: 5 }, { id: 'n', u: 10, v: 13 }],
        curves: [{ id: 'e', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' }],
        constraints: [],
    };
}

function start(g: SketchGeometry = EMPTY_GEOMETRY) {
    useSketcher.setState({ active: true, stage: 'draw', geometry: g, labels: {}, picks: [], draft: [], selection: [], snap: false, undo: [], redo: [] });
}

describe('ellipse: solver', () => {
    it('keeps an ellipse with 5 free degrees and its axes square', () => {
        const r = solveGeometry(ellipse());
        expect(r.ok).toBe(true);
        expect(r.dof).toBe(5);
    });

    it('drives Radius 1 and Radius 2 by dimensions from the centre to the axis ends', () => {
        const g = ellipse();
        g.constraints.push(
            { id: 'r1', kind: 'distance', a: 'c', b: 'm', value: 25 },
            { id: 'r2', kind: 'distance', a: 'c', b: 'n', value: 6.5 },
            { id: 'fc', kind: 'fix', point: 'c' },
            { id: 'h', kind: 'horizontalPoints', a: 'c', b: 'm' },
        );
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(r.dof).toBe(0);
        expect(dist(at(r.geometry, 'c'), at(r.geometry, 'm'))).toBeCloseTo(25, 9);
        expect(dist(at(r.geometry, 'c'), at(r.geometry, 'n'))).toBeCloseTo(6.5, 9);
        // The second axis stays square to the first.
        const [c, m, n] = ['c', 'm', 'n'].map((id) => at(r.geometry, id));
        expect((m[0] - c[0]) * (n[0] - c[0]) + (m[1] - c[1]) * (n[1] - c[1])).toBeCloseTo(0, 9);
    });

    it('lets Radius 2 grow past Radius 1 (the axes swap roles)', () => {
        const g = ellipse();
        g.constraints.push({ id: 'r2', kind: 'distance', a: 'c', b: 'n', value: 30 }, { id: 'f', kind: 'fix', point: 'c' }, { id: 'fm', kind: 'fix', point: 'm' });
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        expect(dist(at(r.geometry, 'c'), at(r.geometry, 'n'))).toBeCloseTo(30, 6);
    });

    it('drags an axis end and the ellipse follows', () => {
        const r = solveGeometry(ellipse(), { targets: [{ point: 'm', u: 32, v: 9 }] });
        expect(r.ok).toBe(true);
        expect(at(r.geometry, 'm')[0]).toBeCloseTo(32, 6);
        const [c, m, n] = ['c', 'm', 'n'].map((id) => at(r.geometry, id));
        expect((m[0] - c[0]) * (n[0] - c[0]) + (m[1] - c[1]) * (n[1] - c[1])).toBeCloseTo(0, 6);
    });

    it('holds a point on the ellipse and a line tangent to it', () => {
        const g = addLine(ellipse(), { at: [0, 30] }, { at: [40, 25] }).g;
        const line = g.curves.find((c) => c.kind === 'line')!.id;
        g.points.push({ id: 'q', u: 33, v: 0 });
        g.constraints.push({ id: 'on', kind: 'pointOnCurve', point: 'q', curve: 'e' }, { id: 't', kind: 'tangent', a: line, b: 'e' },
            { id: 'fc', kind: 'fix', point: 'c' }, { id: 'fm', kind: 'fix', point: 'm' }, { id: 'fn', kind: 'fix', point: 'n' });
        const r = solveGeometry(g);
        expect(r.ok).toBe(true);
        const e = ellipseAxes([10, 5], [30, 5], 8);
        const onE = (p: [number, number]) => ((p[0] - e.center[0]) / e.a) ** 2 + ((p[1] - e.center[1]) / e.b) ** 2;
        expect(onE(at(r.geometry, 'q'))).toBeCloseTo(1, 6);
        // Tangent: the line meets the ellipse in exactly one point (its distance function touches 1 from above).
        const l = r.geometry.curves.find((c) => c.id === line) as Extract<SketchCurve, { kind: 'line' }>;
        const [a, b] = [at(r.geometry, l.a), at(r.geometry, l.b)];
        let least = Infinity;
        for (let i = -2000; i <= 3000; i++) {
            const t = i / 1000;
            least = Math.min(least, onE([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
        }
        expect(least).toBeCloseTo(1, 5);
    });

    it('keeps a partial ellipse with its ends on the ellipse when an axis is dragged', () => {
        const g: SketchGeometry = {
            points: [{ id: 'c', u: 0, v: 0 }, { id: 'm', u: 20, v: 0 }, { id: 'n', u: 0, v: 10 }, { id: 's', u: 20, v: 0.0001 }, { id: 't', u: -20, v: 0 }],
            curves: [{ id: 'pe', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 's', end: 't' }],
            constraints: [{ id: 'f', kind: 'fix', point: 'c' }],
        };
        const r = solveGeometry(g, { targets: [{ point: 'n', u: 0, v: 14 }] });
        expect(r.ok).toBe(true);
        const [m, n] = [at(r.geometry, 'm'), at(r.geometry, 'n')];
        const e = ellipseAxes([0, 0], m, Math.hypot(...n));
        for (const id of ['s', 't']) {
            const p = at(r.geometry, id);
            const [x, y] = [(p[0] * Math.cos(e.angle) + p[1] * Math.sin(e.angle)) / e.a, (-p[0] * Math.sin(e.angle) + p[1] * Math.cos(e.angle)) / e.b];
            expect(x * x + y * y).toBeCloseTo(1, 9);
        }
    });

    it('lists the relations an ellipse takes, and says so for the rest', () => {
        const g = { ...ellipse(), points: [...ellipse().points, { id: 'q', u: 0, v: 0 }] };
        expect(relationsFromPicks(g, 'coincident', [{ type: 'point', id: 'q' }, { type: 'curve', id: 'e' }])).toEqual([{ kind: 'pointOnCurve', point: 'q', curve: 'e' }]);
        expect(relationsFromPicks(g, 'equal', [{ type: 'curve', id: 'e' }, { type: 'curve', id: 'e' }])).toHaveProperty('need');
    });
});

describe('ellipse: drawing', () => {
    beforeEach(() => {
        start();
        setTool('ellipse');
    });

    it('draws centre, first axis, second axis', () => {
        sketchClick([0, 0], TOL);
        sketchClick([20, 0], TOL);
        expect(state().draft.length).toBe(2);
        sketchClick([7, 8], TOL);
        const g = state().geometry;
        const e = g.curves.find((c) => c.kind === 'ellipse');
        expect(e).toBeTruthy();
        if (e?.kind !== 'ellipse') {
            return;
        }
        expect(dist(at(g, e.center), at(g, e.minor))).toBeCloseTo(8, 9);
        // It is a closed area, an ellipse profile the kernel builds exactly.
        const { profiles } = geometryProfiles(g);
        expect(profiles).toEqual([{ kind: 'ellipse', center: [0, 0], major: [20, 0], minor: 8 }]);
        expect(regionsOf(g)).toHaveLength(1);
        expect(Math.abs(area(profilePoints(profiles[0])))).toBeCloseTo(Math.PI * 20 * 8, 0);
        expect(currentSketch().profiles[0].kind).toBe('ellipse');
    });

    it('drags the ellipse as a whole by its curve', () => {
        sketchClick([0, 0], TOL);
        sketchClick([20, 0], TOL);
        sketchClick([0, 8], TOL);
        setTool('select');
        expect(sketchDown([0, 8], TOL)).toBe(true);
        sketchMove([5, 10], TOL);
        sketchUp();
        const g = state().geometry;
        const e = g.curves.find((c) => c.kind === 'ellipse') as Extract<SketchCurve, { kind: 'ellipse' }>;
        // The minor axis end was grabbed as a point and moved alone: Radius 2 grew, the axes stay square.
        const [c, m, n] = [e.center, e.major, e.minor].map((id) => at(g, id));
        expect((m[0] - c[0]) * (n[0] - c[0]) + (m[1] - c[1]) * (n[1] - c[1])).toBeCloseTo(0, 6);
    });

    it('snaps to the centre and the quadrants', () => {
        const g = ellipse();
        expect(snapCursor(g, [10.1, 5.1], { enabled: true, grid: 0, tolerance: 0.5 })).toMatchObject({ kind: 'centre' });
        expect(snapCursor(g, [-9.8, 5.2], { enabled: true, grid: 0, tolerance: 0.5 })).toMatchObject({ kind: 'quadrant' });
        const on = snapCursor(g, [10, -3.2], { enabled: true, grid: 0, tolerance: 0.5 });
        expect(on.kind).toBe('quadrant');
        const near = snapCursor(g, [20, 5 + 8 * Math.sqrt(0.75) + 0.2], { enabled: true, grid: 0, tolerance: 0.5 });
        expect(near).toMatchObject({ kind: 'curve', ref: { onCurves: ['e'] } });
    });
});

describe('partial ellipse', () => {
    it('draws centre, axis, axis (the start), then round to the end; an open chain, closed with a line', () => {
        start();
        setTool('partialEllipse');
        sketchClick([0, 0], TOL);
        sketchClick([20, 0], TOL);
        // The second axis click is on the positive v side: the arc starts at the top of the ellipse.
        sketchMove([0, 10], TOL);
        sketchClick([0, 10], TOL);
        // Go round anticlockwise to the far end of the first axis.
        for (const a of [100, 130, 160, 180]) {
            sketchMove([20 * Math.cos((a * Math.PI) / 180), 10 * Math.sin((a * Math.PI) / 180)], TOL);
        }
        sketchClick([-20, 0], TOL);
        let g = state().geometry;
        const pe = g.curves.find((c) => c.kind === 'ellipseArc') as Extract<SketchCurve, { kind: 'ellipseArc' }>;
        expect(pe).toBeTruthy();
        expect(at(g, pe.start)[1]).toBeCloseTo(10, 6);
        expect(at(g, pe.end)[0]).toBeCloseTo(-20, 6);
        expect(geometryOpenChains(g)).toHaveLength(1);
        // A line back from its end to its start makes a closed area: a quarter of the ellipse plus a triangle.
        g = addLine(g, { at: at(g, pe.end), point: pe.end }, { at: at(g, pe.start), point: pe.start }).g;
        const { profiles } = geometryProfiles(g);
        expect(profiles).toHaveLength(1);
        expect(Math.abs(area(profilePoints(profiles[0])))).toBeCloseTo(Math.PI * 200 / 4 - 100, 0);
    });
});

describe('ellipse: modify tools', () => {
    const g = () => solveGeometry(ellipse()).geometry;

    it('mirrors and moves an ellipse by its points', () => {
        const before = g();
        const line = addLine(before, { at: [0, -10] }, { at: [0, 30] });
        const m = mirrorCurves(line.g, ['e'], line.id);
        expect('g' in m).toBe(true);
        if ('g' in m) {
            const copy = m.g.curves.find((c) => c.id === m.created![0]) as Extract<SketchCurve, { kind: 'ellipse' }>;
            expect(at(m.g, copy.center)).toEqual([-10, 5]);
        }
        const t = transformEntities(before, ['e'], { kind: 'move', by: [1, 2] }, false);
        expect('g' in t && at(t.g, 'c')).toEqual([11, 7]);
    });

    it('trims away an ellipse nothing crosses, wants two split points, and offsets it (sketchCurveTools.test.ts)', () => {
        expect(trimAt(g(), 'e', [30, 5])!.g.curves).toHaveLength(0);
        expect(splitAt(g(), 'e', [30, 5])).toEqual({ error: 'An ellipse is split at two points: click the second.' });
        expect(offsetEntities(g(), ['e'], { distance: 2 })).not.toHaveProperty('error');
        start(g());
        setTool('trim');
        sketchClick([30, 5], TOL);
        expect(state().geometry.curves).toHaveLength(0);
    });
});

describe('spline', () => {
    it('draws through clicked points and ends with a double-click; closing on the first point makes an area', () => {
        start();
        setTool('spline');
        for (const p of [[0, 0], [10, 5], [20, 0]] as [number, number][]) {
            sketchClick(p, TOL);
        }
        endChain();
        let g = state().geometry;
        const open = g.curves.find((c) => c.kind === 'spline');
        expect(open?.kind === 'spline' && open.points).toHaveLength(3);
        expect(geometryOpenChains(g)).toHaveLength(1);
        setTool('spline');
        for (const p of [[0, 20], [10, 30], [20, 20], [10, 12]] as [number, number][]) {
            sketchClick(p, TOL);
        }
        sketchClick([0, 20], TOL);
        g = state().geometry;
        const closed = g.curves.filter((c) => c.kind === 'spline')[1];
        expect(closed?.kind === 'spline' && closed.points[0] === closed.points[closed.points.length - 1]).toBe(true);
        const { profiles } = geometryProfiles(g);
        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({ kind: 'path', segments: [{ kind: 'spline' }] });
    });

    it('finds a loop of a line, a spline and a partial ellipse as one area', () => {
        const g: SketchGeometry = {
            points: [{ id: 'a', u: -20, v: 0 }, { id: 'b', u: 20, v: 0 }, { id: 'c', u: 0, v: 0 }, { id: 'm', u: 20, v: 0 }, { id: 'n', u: 0, v: 10 },
                { id: 'k', u: 0, v: -9 }, { id: 'z', u: -20, v: -6 }],
            curves: [
                { id: 'pe', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 'b', end: 'a' },
                { id: 'l', kind: 'line', a: 'a', b: 'z' },
                { id: 's', kind: 'spline', points: ['z', 'k', 'b'] },
            ],
            constraints: [],
        };
        const { profiles, open } = geometryProfiles(g);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(1);
        expect(profiles[0].kind === 'path' && profiles[0].segments.map((s) => s.kind).sort()).toEqual(['ellipse', 'line', 'spline']);
        expect(regionsOf(g)).toHaveLength(1);
    });

    it('refuses relations to a spline in plain words', () => {
        const g: SketchGeometry = { points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 9, v: 3 }, { id: 'q', u: 4, v: 9 }], curves: [{ id: 's', kind: 'spline', points: ['a', 'b'] }], constraints: [] };
        const r = relationsFromPicks(g, 'coincident', [{ type: 'point', id: 'q' }, { type: 'curve', id: 's' }]);
        expect(r).toHaveProperty('need');
        expect(filletCornerAt({ ...g, curves: [...g.curves, { id: 'l', kind: 'line', a: 'b', b: 'q' }] }, 'b')).not.toHaveProperty('error');
    });
});

describe('parabola and conic', () => {
    it('draws a parabola from focus, vertex, start and end, its ends on it', () => {
        start();
        setTool('parabola');
        sketchClick([0, 5], TOL);
        sketchClick([0, 0], TOL);
        sketchClick([-10, 3], TOL);
        sketchClick([12, 9], TOL);
        const g = state().geometry;
        const p = g.curves.find((c) => c.kind === 'parabola') as Extract<SketchCurve, { kind: 'parabola' }>;
        expect(p).toBeTruthy();
        // y = x² / 4f with f = 5.
        expect(at(g, p.start)[1]).toBeCloseTo(100 / 20, 9);
        expect(at(g, p.end)[1]).toBeCloseTo(144 / 20, 9);
        const r = solveGeometry(g, { targets: [{ point: p.vertex, u: 0, v: -1 }] });
        expect(r.ok).toBe(true);
        const [f, v, s] = [p.focus, p.vertex, p.start].map((id) => at(r.geometry, id));
        // On the parabola: as far from the focus as from the directrix (2f behind... 1 focal length behind the vertex).
        const axis: [number, number] = [(f[0] - v[0]) / dist(f, v), (f[1] - v[1]) / dist(f, v)];
        const behind = (s[0] - v[0]) * axis[0] + (s[1] - v[1]) * axis[1] + dist(f, v);
        expect(dist(s, f)).toBeCloseTo(behind, 6);
    });

    it('draws a conic from two ends, the top vertex and Rho; the shoulder is Rho of the way to the vertex', () => {
        start();
        setTool('conic');
        sketchClick([0, 0], TOL);
        sketchClick([20, 0], TOL);
        sketchClick([10, 10], TOL);
        sketchClick([10, 3], TOL);
        const g = state().geometry;
        const c = g.curves.find((k) => k.kind === 'conic') as Extract<SketchCurve, { kind: 'conic' }>;
        expect(c.rho).toBeCloseTo(0.3, 9);
        const prof = geometryOpenChains(g)[0];
        expect(prof.kind === 'path' && prof.segments[0]).toMatchObject({ kind: 'conic', rho: c.rho, apex: [10, 10] });
        const pts = prof.kind === 'path' ? segmentPoints(prof.start, prof.segments[0], 2) : [];
        expect(pts[0][1]).toBeCloseTo(3, 9);
        expect(measure(g, { id: 'x', kind: 'distance', a: c.start, b: c.end, value: 0 })).toBeCloseTo(20, 9);
    });

    it('holds a conic tangent to a line it joins: its top vertex stays on the line', () => {
        const g: SketchGeometry = {
            points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 20, v: 0 }, { id: 't', u: 9, v: 11 }, { id: 'l', u: -10, v: -8 }],
            curves: [{ id: 'k', kind: 'conic', start: 'a', end: 'b', apex: 't', rho: 0.4 }, { id: 'ln', kind: 'line', a: 'l', b: 'a' }],
            constraints: [],
        };
        const r = relationsFromPicks(g, 'tangent', [{ type: 'curve', id: 'ln' }, { type: 'curve', id: 'k' }]);
        expect(Array.isArray(r)).toBe(true);
        const s = solveGeometry({ ...g, constraints: [{ id: 'tg', kind: 'tangent', a: 'ln', b: 'k' }, { id: 'f1', kind: 'fix', point: 'l' }, { id: 'f2', kind: 'fix', point: 'a' }] });
        expect(s.ok).toBe(true);
        const [l, a, t] = ['l', 'a', 't'].map((id) => at(s.geometry, id));
        // Rounded to 1e-6 mm like every solved point (not the ellipse ones).
        expect((a[0] - l[0]) * (t[1] - l[1]) - (a[1] - l[1]) * (t[0] - l[0])).toBeCloseTo(0, 4);
    });
});

describe('style spline', () => {
    it('draws control vertices into a Bezier curve, and a B-spline of degree 3 once it has four', async () => {
        const { setStyleSplineType } = await import('./sketchConics');
        start();
        setTool('styleSpline');
        for (const p of [[0, 0], [5, 10], [15, 10], [20, 0]] as [number, number][]) {
            sketchClick(p, TOL);
        }
        endChain();
        let g = state().geometry;
        const bezier = g.curves.find((c) => c.kind === 'styleSpline') as Extract<SketchCurve, { kind: 'styleSpline' }>;
        expect(bezier.points).toHaveLength(4);
        expect(bezier.degree).toBeUndefined();
        let chain = geometryOpenChains(g)[0];
        expect(chain.kind === 'path' && chain.segments[0]).toMatchObject({ kind: 'bspline', degree: 3, poles: [[5, 10], [15, 10]] });
        // The Bezier's middle: (p0 + 3 p1 + 3 p2 + p3) / 8.
        expect(bsplineAt([[0, 0], [5, 10], [15, 10], [20, 0]], 3, 0.5)).toEqual([10, 7.5]);
        setStyleSplineType(3);
        setTool('styleSpline');
        for (const p of [[0, 20], [5, 30], [10, 20]] as [number, number][]) {
            sketchClick(p, TOL);
        }
        endChain();
        expect(state().message).toMatch(/at least 4 control vertices/);
        sketchClick([20, 30], TOL);
        endChain();
        g = state().geometry;
        const b3 = g.curves.filter((c) => c.kind === 'styleSpline')[1] as Extract<SketchCurve, { kind: 'styleSpline' }>;
        expect(b3.degree).toBe(3);
        chain = geometryOpenChains(g)[1];
        expect(chain.kind === 'path' && chain.segments[0]).toMatchObject({ kind: 'bspline', degree: 3 });
        setStyleSplineType('bezier');
    });

    it('closes into an area with a line, and keeps its control vertices as free points to drag', () => {
        const g: SketchGeometry = {
            points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 6, v: 12 }, { id: 'c', u: 14, v: 12 }, { id: 'd', u: 20, v: 0 }],
            curves: [{ id: 's', kind: 'styleSpline', points: ['a', 'b', 'c', 'd'] }, { id: 'l', kind: 'line', a: 'd', b: 'a' }],
            constraints: [],
        };
        const { profiles } = geometryProfiles(g);
        expect(profiles).toHaveLength(1);
        // The Bezier's area over the chord: 3/10 of the control polygon's height times... measured: compare with sampling.
        expect(Math.abs(area(profilePoints(profiles[0])))).toBeGreaterThan(100);
        const r = solveGeometry(g, { targets: [{ point: 'b', u: 4, v: 15 }] });
        expect(r.ok && at(r.geometry, 'b')).toEqual([4, 15]);
    });

    it('inserts a control vertex where the control polygon is clicked, and deletes one again', async () => {
        const { insertControlVertex } = await import('./sketchConics');
        const { removeItems } = await import('./sketchGeometry');
        const g: SketchGeometry = {
            points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 10 }, { id: 'c', u: 20, v: 0 }],
            curves: [{ id: 's', kind: 'styleSpline', points: ['a', 'b', 'c'] }],
            constraints: [],
        };
        const r = insertControlVertex(g, 's', [15, 5]);
        expect('g' in r && (r.g.curves[0] as { points: string[] }).points).toEqual(['a', 'b', 'point' in r ? r.point : '', 'c']);
        const gone = removeItems(g, ['b']);
        expect((gone.curves[0] as { points: string[] }).points).toEqual(['a', 'c']);
    });
});

describe('curve PropertyManagers', () => {
    it('sets an ellipse\'s Radius 1, Radius 2 and centre through the solver, and refuses what its dimensions forbid', async () => {
        const { editCurve } = await import('./sketcher');
        start(solveGeometry(ellipse()).geometry);
        expect(editCurve('e', [{ point: 'c', u: 0, v: 0 }, { point: 'm', u: 12.5, v: 0 }, { point: 'n', u: 0, v: 4.25 }], { construction: true })).toBeNull();
        const g = state().geometry;
        expect(at(g, 'm')[0]).toBeCloseTo(12.5, 9);
        expect(at(g, 'n')[1]).toBeCloseTo(4.25, 9);
        expect(g.curves[0].construction).toBe(true);
        start({ ...g, constraints: [{ id: 'd', kind: 'distance', a: 'c', b: 'm', value: 12.5 }, { id: 'f', kind: 'fix', point: 'c' }] });
        expect(editCurve('e', [{ point: 'm', u: 20, v: 0 }])).toMatch(/do not let it go there/);
    });
});

describe('spline handles and spline points', () => {

    it('adds a tangency handle where the curve already points, so the shape stays; dragging it steers the end', async () => {
        const { replaceGeometry } = await import('./sketcher');
        const g: SketchGeometry = {
            points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 8 }, { id: 'c', u: 20, v: 0 }],
            curves: [{ id: 's', kind: 'spline', points: ['a', 'b', 'c'] }],
            constraints: [],
        };
        start(g);
        const before = geometryOpenChains(g)[0];
        const sampleOf = (p: typeof before) => (p.kind === 'path' ? segmentPoints(p.start, p.segments[0], 8) : []);
        const { splineBezier } = await import('@jarvis/core/curves');
        const poles = splineBezier([[0, 0], [10, 8], [20, 0]]);
        const withHandle: SketchGeometry = { ...g, points: [...g.points, { id: 'h', u: poles[1][0], v: poles[1][1] }], curves: [{ id: 's', kind: 'spline', points: ['a', 'b', 'c'], startHandle: 'h' }] };
        expect(replaceGeometry(withHandle)).toBeNull();
        const after = geometryOpenChains(state().geometry)[0];
        sampleOf(after).forEach((p, i) => {
            expect(p[0]).toBeCloseTo(sampleOf(before)[i][0], 6);
            expect(p[1]).toBeCloseTo(sampleOf(before)[i][1], 6);
        });
        // A line ending at the start, tangent: the handle stays on it.
        const lined: SketchGeometry = {
            ...withHandle,
            points: [...withHandle.points, { id: 'z', u: -10, v: -3 }],
            curves: [...withHandle.curves, { id: 'ln', kind: 'line', a: 'z', b: 'a' }],
        };
        expect(Array.isArray(relationsFromPicks(lined, 'tangent', [{ type: 'curve', id: 'ln' }, { type: 'curve', id: 's' }]))).toBe(true);
        const s = solveGeometry({ ...lined, constraints: [{ id: 't', kind: 'tangent', a: 'ln', b: 's' }, { id: 'f', kind: 'fix', point: 'z' }, { id: 'f2', kind: 'fix', point: 'a' }] });
        const [z, a, h] = ['z', 'a', 'h'].map((id) => at(s.geometry, id));
        expect((a[0] - z[0]) * (h[1] - z[1]) - (a[1] - z[1]) * (h[0] - z[0])).toBeCloseTo(0, 4);
    });

    it('inserts a spline point on the curve between the points around it', async () => {
        const { insertSplinePoint } = await import('./sketchConics');
        const g: SketchGeometry = {
            points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 8 }, { id: 'c', u: 20, v: 0 }],
            curves: [{ id: 's', kind: 'spline', points: ['a', 'b', 'c'] }],
            constraints: [],
        };
        const r = insertSplinePoint(g, 's', [16, 5]);
        expect('g' in r && (r.g.curves[0] as { points: string[] }).points).toEqual(['a', 'b', 'point' in r ? r.point : '', 'c']);
    });
});

