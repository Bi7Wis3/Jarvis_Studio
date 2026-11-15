import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { segmentPoints } from '@jarvis/core/curves';
import {
    cubicPieces, curvatureSample, innerKnots, minimumRadius, nurbsAt, nurbsPieces, pieceCurvature, pieceDerivatives, splineAsBSpline, splitPiece, type BezierPiece,
} from '@jarvis/core/splines';
import { loadSolver, pointOf, solveGeometry } from './solver';
import { curveSegment, type ExtraCurve } from './sketchCurves';
import {
    activateHandle, curvatureAtPoint, curvePieces, handleEdit, handleInfo, handleValues, movePolygonVertex, resetAllHandles, setCurvature,
    nearestOnSpline, solvedSpline, splinePolygon, splineToStyle, splitSplineAt, styleToSpline, type Spline,
} from './sketchSplines';
import { solveWithTargets, splineDown, splineMove, splineUp, toggleShown, useSplineView } from './sketchSplineTools';
import { splitAt } from './sketchEdit';
import { notForCurve } from './sketchEdit';
import { insertSplinePoint } from './sketchConics';
import { useSketcher } from './sketcher';
import { removeItems } from './sketchGeometry';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

type Pt = [number, number];
const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);

function spline(extra: Partial<Spline> = {}, points: Pt[] = [[0, 0], [10, 8], [20, -2], [32, 6], [40, 0]]): SketchGeometry {
    return {
        points: points.map((p, i) => ({ id: `s${i}`, u: p[0], v: p[1] })),
        curves: [{ id: 'sp', kind: 'spline', points: points.map((_, i) => `s${i}`), ...extra }],
        constraints: [],
    };
}

/** Points along a curve of the sketch, finely. */
function samples(g: SketchGeometry, id: string, n = 40): Pt[] {
    const c = g.curves.find((k) => k.id === id) as ExtraCurve;
    const s = curveSegment(g, c)!;
    return [s.from as Pt, ...(segmentPoints(s.from, s.seg, n) as Pt[])];
}

/** Distance from p to the exact curve given as pieces (nearest sample, then Newton's method). */
function toPieces(p: Pt, pieces: BezierPiece[]): number {
    let best = Infinity;
    for (const piece of pieces) {
        let t0 = 0;
        let d0 = Infinity;
        for (let s = 0; s <= 32; s++) {
            const d = dist(p, pieceDerivatives(piece, s / 32).at as Pt);
            if (d < d0) {
                [d0, t0] = [d, s / 32];
            }
        }
        let t = t0;
        for (let it = 0; it < 40; it++) {
            const { at, d1, d2 } = pieceDerivatives(piece, t);
            const r: Pt = [at[0] - p[0], at[1] - p[1]];
            const h = d1[0] * d1[0] + d1[1] * d1[1] + r[0] * d2[0] + r[1] * d2[1];
            if (!(h > 0)) {
                break;
            }
            t = Math.min(1, Math.max(0, t - (r[0] * d1[0] + r[1] * d1[1]) / h));
        }
        best = Math.min(best, d0, dist(p, pieceDerivatives(piece, t).at as Pt));
    }
    return best;
}

/** Largest distance from the points `a` to the exact curves `b` (pieces of one or more curves). */
function apart(a: Pt[], b: BezierPiece[]): number {
    return Math.max(...a.map((p) => toPieces(p, b)));
}

const exact = (g: SketchGeometry, id: string) => curvePieces(g, id)!;

function start(g: SketchGeometry) {
    useSketcher.setState({ active: true, stage: 'draw', tool: 'select', geometry: g, labels: {}, picks: [], draft: [], selection: [], snap: false, undo: [], redo: [] });
}

beforeEach(() => {
    useSplineView.setState({ combs: [], inflections: [], minRadius: [], polygonFlip: [], picked: null, vertex: null, drag: null, adding: null, symmetric: false });
});

describe('spline handles', () => {
    it('makes a handle active as the curve is, then sets its direction and the weight of each side', () => {
        const g = spline();
        const c = g.curves[0] as Spline;
        const before = samples(g, 'sp');
        const r = activateHandle(g, c, 2);
        expect(r.c.handles).toHaveLength(1);
        expect(apart(samples(r.g, 'sp'), exact(g, 'sp'))).toBeLessThan(1e-9);
        const e = handleEdit(r.g, r.c, 2, { angle: 0, before: 3, after: 5 });
        expect('error' in e).toBe(false);
        if ('error' in e) {
            return;
        }
        const s = solveWithTargets(e.g, e.targets)!;
        const c2 = s.geometry.curves[0] as Spline;
        const h = handleInfo(s.geometry, c2, 2)!;
        const v = handleValues(h);
        expect(v.angle).toBeCloseTo(0, 9);
        expect(v.before).toBeCloseTo(3, 9);
        expect(v.after).toBeCloseTo(5, 9);
        // The curve leaves the point level, as the handle says.
        expect(apart(samples(s.geometry, 'sp'), exact(g, 'sp'))).toBeGreaterThan(0.01);
        const reset = resetAllHandles(s.geometry, c2);
        expect((reset.curves[0] as Spline).handles ?? []).toHaveLength(0);
        expect(reset.points.some((p) => p.id === h.handlePoint)).toBe(false);
        expect(apart(samples(reset, 'sp'), exact(g, 'sp'))).toBeLessThan(1e-9);
    });

    it('drags a handle\'s arrow head for the weight of one side, and both sides with Alt', () => {
        const g = spline();
        const act = activateHandle(g, g.curves[0] as Spline, 2);
        start(act.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: 'sp' }] });
        const h = handleInfo(act.g, act.c, 2)!;
        const v0 = handleValues(h);
        const grip: Pt = [h.at[0] + (h.next![0] - h.at[0]) * 0.72, h.at[1] + (h.next![1] - h.at[1]) * 0.72];
        const u: Pt = [Math.cos(v0.angle), Math.sin(v0.angle)];
        expect(splineDown(grip, 0.3)).toBe(true);
        splineMove([grip[0] + u[0] * 2, grip[1] + u[1] * 2], 0.3);
        splineUp();
        const g1 = useSketcher.getState().geometry;
        const v1 = handleValues(handleInfo(g1, g1.curves[0] as Spline, 2)!);
        expect(v1.after).toBeCloseTo(v0.after! + 2 / 0.72, 6);
        expect(v1.before).toBeCloseTo(v0.before!, 6);
        expect(v1.angle).toBeCloseTo(v0.angle, 9);
        expect(useSketcher.getState().undo.length).toBe(1);
        // Alt: both sides by the same factor.
        useSplineView.setState({ symmetric: true });
        const h1 = handleInfo(g1, g1.curves[0] as Spline, 2)!;
        const grip1: Pt = [h1.at[0] + (h1.next![0] - h1.at[0]) * 0.72, h1.at[1] + (h1.next![1] - h1.at[1]) * 0.72];
        expect(splineDown(grip1, 0.3)).toBe(true);
        splineMove([h1.at[0] + u[0] * v1.after! * 0.72 * 2, h1.at[1] + u[1] * v1.after! * 0.72 * 2], 0.3);
        splineUp();
        const g2 = useSketcher.getState().geometry;
        const v2 = handleValues(handleInfo(g2, g2.curves[0] as Spline, 2)!);
        expect(v2.after! / v1.after!).toBeCloseTo(2, 6);
        expect(v2.before! / v1.before!).toBeCloseTo(2, 6);
    });

    it('turns a handle with its diamond, both sides together', () => {
        const g = spline();
        const act = activateHandle(g, g.curves[0] as Spline, 1);
        start(act.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: 'sp' }] });
        const h = handleInfo(act.g, act.c, 1)!;
        const v0 = handleValues(h);
        const diamond: Pt = [h.at[0] + (h.next![0] - h.at[0]) * 0.42, h.at[1] + (h.next![1] - h.at[1]) * 0.42];
        expect(splineDown(diamond, 0.2)).toBe(true);
        splineMove([h.at[0], h.at[1] + 3], 0.2);
        splineUp();
        const g1 = useSketcher.getState().geometry;
        const v1 = handleValues(handleInfo(g1, g1.curves[0] as Spline, 1)!);
        expect(v1.angle).toBeCloseTo(Math.PI / 2, 9);
        expect(v1.after).toBeCloseTo(v0.after!, 9);
        expect(v1.before).toBeCloseTo(v0.before!, 9);
    });
});

describe('points added on the curve', () => {
    it('adds a spline point, a tangency handle or a curvature control without changing the curve', () => {
        const g = spline();
        const c = g.curves[0] as Spline;
        const before = samples(g, 'sp');
        for (const o of [{}, { handle: true }, { curvature: true }]) {
            const r = splitSplineAt(g, c, [15, 4], o);
            expect('error' in r).toBe(false);
            if ('error' in r) {
                continue;
            }
            expect(r.c.points).toHaveLength(6);
            expect(r.index).toBe(2);
            expect(apart(samples(r.g, 'sp'), exact(g, 'sp'))).toBeLessThan(1e-9);
            expect(apart(before, exact(r.g, 'sp'))).toBeLessThan(1e-9);
            if ('curvature' in o) {
                expect(r.c.curvature).toHaveLength(1);
            }
        }
        const ins = insertSplinePoint(g, 'sp', [15, 4]);
        expect('g' in ins && apart(samples(ins.g, 'sp'), exact(g, 'sp'))).toBeLessThan(1e-9);
    });

    it('holds a curvature at a point: the curve takes it on both sides and stays curvature continuous elsewhere', () => {
        const g = spline();
        const r = setCurvature(g, g.curves[0] as Spline, 2, -0.05);
        const solved = solvedSpline(r.g, r.c)!;
        expect(solved.unmet).toEqual([]);
        const k = curvatureAtPoint(solved, 2);
        expect(k.before).toBeCloseTo(-0.05, 9);
        expect(k.after).toBeCloseTo(-0.05, 9);
        for (const i of [1, 3]) {
            const s = curvatureAtPoint(solved, i);
            expect(s.before).toBeCloseTo(s.after!, 8);
        }
    });

    it('drops a deleted point\'s handle and keeps the stored spacing of the joined pieces', () => {
        const g = spline();
        const r = splitSplineAt(g, g.curves[0] as Spline, [15, 4], { handle: true });
        if ('error' in r) {
            throw new Error(r.error);
        }
        const gone = removeItems(r.g, [r.point]);
        const c = gone.curves[0] as Spline;
        expect(c.points).toHaveLength(5);
        expect(c.handles ?? []).toHaveLength(0);
        expect(gone.points.length).toBe(5);
    });
});

describe('control polygon', () => {
    it('moves a polygon vertex: the spline becomes that B-spline exactly, through its new points', () => {
        const g = spline();
        const c = g.curves[0] as Spline;
        const solved = solvedSpline(g, c)!;
        const b = splineAsBSpline(solved.poles, solved.spans);
        const poly = splinePolygon(solved);
        expect(poly.length).toBe(7);
        const to: Pt = [poly[3][0] + 2, poly[3][1] - 3];
        const r = movePolygonVertex(g, c, 3, to);
        if ('error' in r) {
            throw new Error(r.error);
        }
        const s = solveWithTargets(r.g, r.targets)!;
        expect(s.miss).toBeLessThan(1e-9);
        const moved = b.poles.map((p, i) => (i === 3 ? to : p));
        const inner = innerKnots(b.knots, b.mults, 3);
        const want = Array.from({ length: 101 }, (_, i) => nurbsAt(moved as Pt[], 3, i / 100, inner) as Pt);
        const wanted = nurbsPieces(moved as Pt[], 3, inner).pieces;
        expect(apart(samples(s.geometry, 'sp', 60), wanted)).toBeLessThan(1e-9);
        expect(apart(want, exact(s.geometry, 'sp'))).toBeLessThan(1e-9);
        const after = splinePolygon(solvedSpline(s.geometry, s.geometry.curves[0] as Spline)!);
        expect(dist(after[3], to)).toBeLessThan(1e-6);
    });
});

describe('convert spline types', () => {
    it('turns a spline into the style spline of the same curve and back', () => {
        const g = spline();
        const before = samples(g, 'sp');
        const style = splineToStyle(g, 'sp');
        if (typeof style === 'string') {
            throw new Error(style);
        }
        const st = style.curves.find((k) => k.id === 'sp')!;
        expect(st.kind).toBe('styleSpline');
        expect(st.kind === 'styleSpline' && st.degree).toBe(3);
        expect(apart(samples(style, 'sp'), exact(g, 'sp'))).toBeLessThan(1e-9);
        expect(apart(before, exact(style, 'sp'))).toBeLessThan(1e-9);
        // The end points stay the same points (and their relations with them).
        expect(st.kind === 'styleSpline' && [st.points[0], st.points[st.points.length - 1]]).toEqual(['s0', 's4']);
        const back = styleToSpline(solveGeometry(style).geometry, 'sp');
        if (typeof back === 'string') {
            throw new Error(back);
        }
        expect(back.curves[0].kind).toBe('spline');
        expect(apart(samples(back, 'sp'), exact(g, 'sp'))).toBeLessThan(1e-8);
        expect(apart(before, exact(back, 'sp'))).toBeLessThan(1e-8);
    });

    it('says when a style spline is not a cubic, or is rational', () => {
        const g: SketchGeometry = {
            points: Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, u: i * 5, v: (i % 2) * 6 })),
            curves: [{ id: 'st', kind: 'styleSpline', points: Array.from({ length: 6 }, (_, i) => `v${i}`) }],
            constraints: [],
        };
        expect(styleToSpline(g, 'st')).toMatch(/degree 5/);
        const rational = { ...g, curves: [{ ...g.curves[0], degree: 3, weights: [1, 2, 1, 1, 1, 1] } as SketchCurve] };
        expect(styleToSpline(rational, 'st')).toMatch(/rational/);
        expect(notForCurve('Trim', rational.curves[0])).toMatch(/rational/);
    });
});

describe('cutting a spline with handles', () => {
    it('splits a spline with an inner handle and a held curvature into two pieces that are the same curve', () => {
        let g = spline();
        const natural = curvatureAtPoint(solvedSpline(g, g.curves[0] as Spline)!, 2).after!;
        const r = setCurvature(g, g.curves[0] as Spline, 2, natural * 1.1);
        expect(solvedSpline(r.g, r.c)!.unmet).toEqual([]);
        g = r.g;
        const before = samples(g, 'sp', 60);
        const s = splitAt(g, 'sp', [25, 2]);
        if ('error' in s) {
            throw new Error(s.error);
        }
        const pieces = s.g.curves.filter((k): k is Spline => k.kind === 'spline');
        expect(pieces).toHaveLength(2);
        // The two pieces' Bezier control points are the parent's, its piece at the cut split there.
        const parent = solvedSpline(g, g.curves[0] as Spline)!;
        const [a, b] = pieces.map((k) => solvedSpline(s.g, k)!.poles);
        const cut = a[a.length - 1];
        const near = nearestOnSpline(parent, cut);
        expect(near.d).toBeLessThan(1e-9);
        const [left, right] = splitPiece({ poles: parent.poles.slice(3 * near.piece, 3 * near.piece + 4) }, near.t);
        const want = [...parent.poles.slice(0, 3 * near.piece), ...left.poles, ...right.poles.slice(1), ...parent.poles.slice(3 * near.piece + 4)];
        const got = [...a, ...b.slice(1)];
        expect(got).toHaveLength(want.length);
        got.forEach((q, i) => expect(dist(q as Pt, want[i] as Pt)).toBeLessThan(1e-7));
        expect(before.length).toBeGreaterThan(0);
    });
});

describe('curvature tools', () => {
    it('measures the curvature of circles, ellipses and conics exactly', () => {
        const g: SketchGeometry = {
            points: [{ id: 'c', u: 1, v: 2 }, { id: 'm', u: 21, v: 2 }, { id: 'n', u: 1, v: 10 }, { id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 0 }, { id: 't', u: 5, v: 6 }],
            curves: [
                { id: 'ci', kind: 'circle', center: 'c', radius: 7 },
                { id: 'el', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' },
                { id: 'co', kind: 'conic', start: 'a', end: 'b', apex: 't', rho: 0.4 },
            ],
            constraints: [],
        };
        const circle = curvePieces(g, 'ci')!;
        circle.forEach((p) => [0, 0.3, 1].forEach((t) => expect(pieceCurvature(p, t)).toBeCloseTo(1 / 7, 9)));
        // The tightest radius of an ellipse is b² / a, at the ends of its major axis.
        const m = minimumRadius(curvePieces(g, 'el')!)!;
        expect(m.radius).toBeCloseTo(64 / 20, 8);
        const conic = curvePieces(g, 'co')!;
        expect(curvatureSample(conic, 0, 0.5).at[0]).toBeCloseTo(5, 9);
        expect(cubicPieces).toBeDefined();
    });

    it('switches combs, inflection points and minimum radius per curve', () => {
        toggleShown('combs', ['a', 'b']);
        toggleShown('inflections', ['a']);
        expect(useSplineView.getState().combs).toEqual(['a', 'b']);
        toggleShown('combs', ['a', 'b']);
        expect(useSplineView.getState().combs).toEqual([]);
        expect(useSplineView.getState().inflections).toEqual(['a']);
    });
});

describe('proportional and local edit drags', () => {
    it('drags an end of a proportional spline: the whole spline scales and turns, its shape kept', () => {
        const g = spline({ proportional: true });
        start(g);
        const before = samples(g, 'sp');
        expect(splineDown([40, 0], 0.3)).toBe(true);
        splineMove([0, 40], 0.3);
        splineUp();
        const after = samples(useSketcher.getState().geometry, 'sp');
        // A quarter turn about the start: (x, y) -> (-y, x).
        const turned = exact(g, 'sp').map((piece) => ({ poles: piece.poles.map((p) => [-p[1], p[0]] as Pt) }));
        expect(apart(after, turned)).toBeLessThan(1e-6);
        expect(before.length).toBeGreaterThan(0);
    });

    it('drags a control vertex with Local edit: the style spline joined to it stays', () => {
        const g: SketchGeometry = {
            points: [
                { id: 'a0', u: 0, v: 0 }, { id: 'a1', u: 5, v: 5 }, { id: 'a2', u: 10, v: 5 }, { id: 'j', u: 15, v: 0 },
                { id: 'b1', u: 20, v: -5 }, { id: 'b2', u: 25, v: -5 }, { id: 'b3', u: 30, v: 0 },
            ],
            curves: [
                { id: 'A', kind: 'styleSpline', points: ['a0', 'a1', 'a2', 'j'], localEdit: true },
                { id: 'B', kind: 'styleSpline', points: ['j', 'b1', 'b2', 'b3'] },
            ],
            constraints: [],
        };
        start(g);
        expect(splineDown([10, 5], 0.3)).toBe(true);
        splineMove([10, 9], 0.3);
        splineUp();
        const out = useSketcher.getState().geometry;
        expect(pointOf(out, 'a2')!.v).toBeCloseTo(9, 6);
        for (const id of ['j', 'b1', 'b2', 'b3']) {
            const [p, q] = [pointOf(out, id)!, pointOf(g, id)!];
            expect(Math.hypot(p.u - q.u, p.v - q.v)).toBeLessThan(1e-9);
        }
    });
});

describe('equation driven curve: ends', () => {
    const half = { id: 'e1', type: 'parametric' as const, x: '10*cos(t)', y: '10*sin(t)', from: '0', to: 'pi', tolerance: 0.0001, curves: [], points: [] };

    it('is rigid: relations on its free ends move and turn it, and it stays the curve of its equations', async () => {
        const { buildEquation, equationEnds, equationCurve } = await import('./sketchEquation');
        const b = buildEquation({ points: [], curves: [], constraints: [] }, half);
        if (typeof b === 'string') {
            throw new Error(b);
        }
        const [s, e] = equationEnds(b.g, b.item)!;
        expect(b.item.points.includes(s) || b.item.points.includes(e)).toBe(false);
        // The start on (5, 5), the end straight above it: the half circle turns a quarter and moves.
        // Added one after the other, as the sketcher adds relations.
        const first = solveGeometry({ ...b.g, points: [...b.g.points, { id: 'q', u: 5, v: 5, fixed: true }], constraints: [{ id: 'k1', kind: 'coincident', a: s, b: 'q' }] });
        expect(first.ok).toBe(true);
        const r = solveGeometry({ ...first.geometry, constraints: [...first.geometry.constraints, { id: 'k2', kind: 'verticalPoints', a: s, b: e }] });
        expect(r.ok).toBe(true);
        expect(r.dof).toBe(0);
        const [ps, pe] = [pointOf(r.geometry, s)!, pointOf(r.geometry, e)!];
        expect(ps.u).toBeCloseTo(5, 8);
        expect(ps.v).toBeCloseTo(5, 8);
        expect(pe.u).toBeCloseTo(5, 8);
        expect(Math.abs(pe.v - 5)).toBeCloseTo(20, 8);
        // Every spline point is on the moved and turned equation curve: radius 10 about the middle of its ends.
        const item = r.geometry.equations![0];
        const centre: Pt = [(ps.u + pe.u) / 2, (ps.v + pe.v) / 2];
        for (const id of item.points.filter((p) => (r.geometry.curves[0] as Spline).points.includes(p))) {
            const p = pointOf(r.geometry, id)!;
            expect(Math.hypot(p.u - centre[0], p.v - centre[1])).toBeCloseTo(10, 6);
        }
        const c = equationCurve(item);
        expect(typeof c !== 'string' && dist(c.f(c.from) as Pt, [ps.u, ps.v])).toBeLessThan(1e-6);
        // Built again (a new range), it keeps its end points and their relations, and is moved to meet them.
        const again = buildEquation(r.geometry, { ...item, to: '2' });
        if (typeof again === 'string') {
            throw new Error(again);
        }
        expect(equationEnds(again.g, again.item)).toEqual([s, e]);
        expect(again.g.constraints.map((k) => k.id)).toEqual(['k1', 'k2']);
        const solved2 = solveGeometry(again.g);
        expect(solved2.ok).toBe(true);
        expect(pointOf(solved2.geometry, s)!.u).toBeCloseTo(5, 8);
        expect(pointOf(solved2.geometry, e)!.u).toBeCloseTo(5, 8);
    });

    it('slides an unlocked end along the curve, which changes the range', async () => {
        const { buildEquation, equationEnds } = await import('./sketchEquation');
        const b = buildEquation({ points: [], curves: [], constraints: [] }, { ...half, lockTo: false });
        if (typeof b === 'string') {
            throw new Error(b);
        }
        start(b.g);
        const [, e] = equationEnds(b.g, b.item)!;
        const at = pointOf(b.g, e)!;
        expect(splineDown([at.u, at.v], 0.3)).toBe(true);
        // A point on the circle a little further round (t = pi + 0.5).
        splineMove([10 * Math.cos(Math.PI + 0.5), 10 * Math.sin(Math.PI + 0.5)], 0.3);
        splineUp();
        const out = useSketcher.getState().geometry;
        expect(Number(out.equations![0].to)).toBeCloseTo(Math.PI + 0.5, 6);
        const end = pointOf(out, equationEnds(out, out.equations![0])![1])!;
        expect(end.u).toBeCloseTo(10 * Math.cos(Math.PI + 0.5), 6);
    });
});

describe('offset of a spline with handles', () => {
    it('offsets the spline as its handles shape it, and rebuilds the offset when a handle moves', async () => {
        const { offsetEntities } = await import('./sketchEdit');
        const { refreshOffsets } = await import('./sketchCurveOffset');
        const g0 = spline();
        const act = activateHandle(g0, g0.curves[0] as Spline, 2);
        const v0 = handleValues(handleInfo(act.g, act.c, 2)!);
        const e = handleEdit(act.g, act.c, 2, { angle: v0.angle + 0.1, before: v0.before! * 1.3, after: v0.after! * 0.8 });
        if ('error' in e) {
            throw new Error(e.error);
        }
        const g = solveWithTargets(e.g, e.targets)!.geometry;
        const r = offsetEntities(g, ['sp'], { distance: 0.5 }) as { g: SketchGeometry; created: string[] };
        expect(r).not.toHaveProperty('error');
        // The offset's spline (an offset item owns it; a rebuild makes it again).
        const off = (geometry: SketchGeometry) => {
            const side = geometry.offsets![0].curves.find((id) => geometry.curves.find((k) => k.id === id)?.kind === 'spline')!;
            return Math.max(...samples(geometry, side, 2).filter((_, i) => i % 7 === 0).map((p) => Math.abs(toPieces(p, exact(geometry, 'sp')) - 0.5)));
        };
        expect(off(r.g)).toBeLessThan(2e-6);
        // The handle turns: the offset is built again for the new shape.
        const c = r.g.curves.find((k) => k.id === 'sp') as Spline;
        const e2 = handleEdit(r.g, c, 2, { angle: v0.angle - 0.1 });
        if ('error' in e2) {
            throw new Error(e2.error);
        }
        const moved = refreshOffsets(solveWithTargets(e2.g, e2.targets)!.geometry);
        expect(off(moved)).toBeLessThan(2e-6);
    }, 60000);
});

describe('fit spline', () => {
    it('fits a chain of any curves, and a Constrained fit follows them when they change', async () => {
        const { applyFit, fitChain } = await import('./sketchSplineFit');
        // A line, then a partial ellipse on from its end.
        const g: SketchGeometry = {
            points: [{ id: 'a', u: -20, v: 0 }, { id: 'c', u: 0, v: 0 }, { id: 'm', u: 10, v: 0 }, { id: 'n', u: 0, v: 5 }, { id: 'b', u: 10, v: 0 }, { id: 'e', u: -10, v: 0 }],
            curves: [
                { id: 'ln', kind: 'line', a: 'e', b: 'a' },
                { id: 'el', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 'b', end: 'e' },
            ],
            constraints: [],
        };
        const fit = fitChain(g, ['ln', 'el'], 0.001);
        if (typeof fit === 'string') {
            throw new Error(fit);
        }
        expect(fit.deviation).toBeLessThanOrEqual(0.001);
        const r = applyFit(g, ['ln', 'el'], fit, 'constrained', 0.001);
        const sp = r.g.curves.find((k) => k.id === r.id) as Spline;
        expect(sp.fit).toEqual({ curves: ['ln', 'el'], tolerance: 0.001 });
        expect(r.g.curves.filter((k) => k.id !== r.id).every((k) => k.construction)).toBe(true);
        // The line's far end moves: the spline is fitted again and runs to it.
        const moved = solveGeometry(r.g, { targets: [{ point: 'a', u: -30, v: 4 }] });
        expect(moved.ok).toBe(true);
        const sp2 = moved.geometry.curves.find((k) => k.id === r.id) as Spline;
        const ends = [sp2.points[0], sp2.points[sp2.points.length - 1]].map((id) => pointOf(moved.geometry, id)!);
        expect(ends.some((p) => Math.hypot(p.u + 30, p.v - 4) < 1e-6)).toBe(true);
    });
});

describe('drags in the sketcher (solveDrag)', () => {
    /** A line far from everything else, so a drag elsewhere is solved as a part of the sketch. */
    const apartLine = (g: SketchGeometry): SketchGeometry => ({
        ...g,
        points: [...g.points, { id: 'far1', u: 200, v: 200 }, { id: 'far2', u: 230, v: 210 }],
        curves: [...g.curves, { id: 'farLine', kind: 'line', a: 'far1', b: 'far2' }],
    });
    const drag = async (from: Pt, to: Pt) => {
        const { sketchDown, sketchMove, sketchUp } = await import('./sketcher');
        expect(sketchDown(from, 0.3)).toBe(true);
        sketchMove([from[0] + (to[0] - from[0]) / 2, from[1] + (to[1] - from[1]) / 2], 0.3);
        sketchMove(to, 0.3);
        sketchUp();
    };

    it('keeps a fixed spline length while an end of it is dragged', async () => {
        const { splineLength } = await import('./sketchSplineLength');
        const g0 = spline();
        const want = splineLength(g0, g0.curves[0] as Spline)! * 1.05;
        const g = solveGeometry(apartLine({ ...g0, constraints: [{ id: 'L', kind: 'arcLength', curve: 'sp', value: want }, { id: 'f', kind: 'fix', point: 's0' }] })).geometry;
        start(g);
        await drag([40, 0], [37, 2]);
        const out = useSketcher.getState().geometry;
        expect(pointOf(out, 's4')!.u).toBeCloseTo(37, 6);
        expect(splineLength(out, out.curves.find((k) => k.id === 'sp') as Spline)).toBeCloseTo(want, 8);
        // The line away from it did not move.
        expect(pointOf(out, 'far1')!.u).toBe(200);
    });

    it('drags an end of an equation curve: the whole curve follows, rigid', async () => {
        const { buildEquation, equationEnds } = await import('./sketchEquation');
        const b = buildEquation({ points: [], curves: [], constraints: [] }, { id: 'e1', type: 'parametric', x: '10*cos(t)', y: '10*sin(t)', from: '0', to: 'pi', tolerance: 0.0001, curves: [], points: [] });
        if (typeof b === 'string') {
            throw new Error(b);
        }
        const g = apartLine(b.g);
        start(g);
        const [s, e] = equationEnds(g, b.item)!;
        await drag([10, 0], [12, 3]);
        const out = useSketcher.getState().geometry;
        const [ps, pe] = [pointOf(out, s)!, pointOf(out, e)!];
        expect(Math.hypot(ps.u - pe.u, ps.v - pe.v)).toBeCloseTo(20, 6);
        // Every point of its spline is still 10 from the middle of its ends: a half circle, moved and turned.
        const centre: Pt = [(ps.u + pe.u) / 2, (ps.v + pe.v) / 2];
        const spline = out.curves.find((k) => k.id === b.item.curves[0]) as Spline;
        for (const id of spline.points) {
            const p = pointOf(out, id)!;
            expect(Math.hypot(p.u - centre[0], p.v - centre[1])).toBeCloseTo(10, 5);
        }
        expect(Math.hypot(ps.u - 10, ps.v)).toBeGreaterThan(0.5);
    });
});

describe('fixed spline length', () => {
    it('holds a spline\'s length while an end is dragged, and refuses a length shorter than its ends allow', async () => {
        const { splineLength } = await import('./sketchSplineLength');
        const { dimensionFromPicks } = await import('./sketchGeometry');
        const { measure } = await import('./solver');
        const g = spline();
        const c = g.curves[0] as Spline;
        const length = splineLength(g, c)!;
        expect(dimensionFromPicks(g, [{ type: 'curve', id: 'sp' }], [20, 10])).toEqual({ kind: 'arcLength', curve: 'sp', value: 0 });
        const want = length * 1.1;
        const dimmed: SketchGeometry = { ...g, constraints: [{ id: 'L', kind: 'arcLength', curve: 'sp', value: want }, { id: 'f', kind: 'fix', point: 's0' }] };
        const r = solveGeometry(dimmed);
        expect(r.ok).toBe(true);
        expect(splineLength(r.geometry, r.geometry.curves[0] as Spline)).toBeCloseTo(want, 8);
        expect(measure(r.geometry, r.geometry.constraints[0])).toBeCloseTo(want, 8);
        // Drag the end in: the length stays.
        const d = solveGeometry(r.geometry, { targets: [{ point: 's4', u: 35, v: 3 }] });
        expect(d.ok).toBe(true);
        expect(pointOf(d.geometry, 's4')!.u).toBeCloseTo(35, 6);
        expect(splineLength(d.geometry, d.geometry.curves[0] as Spline)).toBeCloseTo(want, 8);
        const short: SketchGeometry = { ...dimmed, constraints: [{ id: 'L', kind: 'arcLength', curve: 'sp', value: 30 }] };
        const s = solveGeometry(short);
        expect(s.ok).toBe(false);
        expect(s.conflicting).toEqual(['L']);
    });
});
