import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { closestParam, paramOf, pointAt, type CurveGeom } from '@jarvis/core/curveIntersect';
import { loadSolver, pointOf, solveGeometry } from './solver';
import { addLine, EMPTY_GEOMETRY, geometryEntities } from './sketchGeometry';
import { entityPoints, type Pt } from './sketchMath';
import { extendAt, notForCurve, splitAt, trimAt } from './sketchEdit';
import { powerTrim, trimBetween, trimCorner } from './sketchTrim';
import { cutsAlong, geomOf } from './sketchCut';
import { deleteSelected, setTool, sketchClick, useSketcher } from './sketcher';
import { joinAtPoint } from './sketchJoin';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const at = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);
const curve = <K extends SketchCurve['kind']>(g: SketchGeometry, id: string, kind: K) => {
    const c = g.curves.find((k) => k.id === id)!;
    expect(c.kind).toBe(kind);
    return c as Extract<SketchCurve, { kind: K }>;
};
const solved = (g: SketchGeometry) => {
    const r = solveGeometry(g);
    expect(r.ok).toBe(true);
    return r.geometry;
};
/** Largest distance from the drawn curve to the original's exact shape: zero for an exact piece. */
const offOriginal = (g: SketchGeometry, id: string, original: CurveGeom) => {
    const e = geometryEntities(g).find((k) => k.id === id)!;
    return Math.max(...entityPoints(e).map((p) => dist(p, pointAt(original, closestParam(original, p)))));
};
const ends = (c: SketchCurve) => ('start' in c ? [c.start, c.end] : 'points' in c ? [c.points[0], c.points[c.points.length - 1]] : []);

/** An ellipse about the origin, Radius 1 = 20 along u, Radius 2 = 10, and a vertical line through it at u = 5. */
function ellipseAndLine() {
    const g: SketchGeometry = {
        points: [{ id: 'c', u: 0, v: 0 }, { id: 'm', u: 20, v: 0 }, { id: 'n', u: 0, v: 10 }],
        curves: [{ id: 'e', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' }],
        constraints: [],
    };
    const l = addLine(g, { at: [5, -20] }, { at: [5, 20] });
    return { g: l.g, line: l.id };
}

describe('ellipses and partial ellipses', () => {
    it('trims an ellipse crossed twice into the partial ellipse that is left, on the same axes, its ends held on the line', () => {
        const s = ellipseAndLine();
        const original = geomOf(s.g, 'e')!;
        const plan = trimAt(s.g, 'e', [-20, 0])!;
        expect(plan.removed.kind).toBe('curve');
        const g = solved(plan.g);
        const pe = curve(g, 'e', 'ellipseArc');
        expect([pe.center, pe.major, pe.minor]).toEqual(['c', 'm', 'n']);
        for (const id of [pe.start, pe.end]) {
            expect(at(g, id)[0]).toBeCloseTo(5, 9);
            expect(g.constraints.some((k) => k.kind === 'pointOnCurve' && k.point === id && k.curve === s.line)).toBe(true);
        }
        // The right part stayed (counter-clockwise from below the line to above it).
        expect(at(g, pe.start)[1]).toBeLessThan(0);
        expect(offOriginal(g, 'e', original)).toBeLessThan(1e-9);
    });

    it('splits a partial ellipse at a point and a full ellipse at two, the pieces sharing the axes and the split points', () => {
        const s = ellipseAndLine();
        const arc = trimAt(s.g, 'e', [-20, 0])!.g;
        const r = splitAt(arc, 'e', [19, 3]) as { g: SketchGeometry; point: string };
        const g = solved(r.g);
        const pieces = g.curves.filter((c) => c.kind === 'ellipseArc') as Extract<SketchCurve, { kind: 'ellipseArc' }>[];
        expect(pieces).toHaveLength(2);
        expect(pieces.every((p) => p.center === 'c' && p.major === 'm')).toBe(true);
        expect(pieces.flatMap(ends).filter((id) => id === r.point)).toHaveLength(2);
        const two = splitAt(ellipseAndLine().g, 'e', [20, 0], [-20, 0]) as { g: SketchGeometry };
        expect(two.g.curves.filter((c) => c.kind === 'ellipseArc')).toHaveLength(2);
        expect(solveGeometry(two.g).ok).toBe(true);
    });

    it('extends a partial ellipse round its ellipse to a line, and takes the line as a corner', () => {
        const s = ellipseAndLine();
        // Keep only the top right quarter: from the major axis end round to the top.
        let g: SketchGeometry = {
            points: [...s.g.points, { id: 's', u: 20, v: 0 }, { id: 't', u: 0, v: 10 }],
            curves: [{ id: 'q', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 's', end: 't' }],
            constraints: [],
        };
        const wall = addLine(g, { at: [-12, -20] }, { at: [-12, 20] });
        g = wall.g;
        const plan = extendAt(g, 'q', [1, 10])!;
        expect(plan).not.toBeNull();
        const out = solved(plan.g);
        expect(at(out, 't')[0]).toBeCloseTo(-12, 9);
        expect(at(out, 't')[1]).toBeCloseTo(10 * Math.sqrt(1 - 144 / 400), 9);
        // Corner with the line: the partial ellipse runs on to it and the line is cut there.
        const corner = trimCorner(g, { id: 'q', at: [19, 2] }, { id: wall.id, at: [-12, -15] }) as { g: SketchGeometry };
        expect(corner.g).toBeDefined();
        const c = solved(corner.g);
        const q = curve(c, 'q', 'ellipseArc');
        const l = curve(c, wall.id, 'line');
        expect([l.a, l.b]).toContain(q.end);
        expect(at(c, q.end)[0]).toBeCloseTo(-12, 9);
    });
});

describe('parabolas and conics', () => {
    /** A parabola of focal length 2.5 opening up from the origin, from u = -10 to 10, and a line across at v = 4. */
    function parabola(): SketchGeometry {
        const g: SketchGeometry = {
            points: [{ id: 'f', u: 0, v: 2.5 }, { id: 'v', u: 0, v: 0 }, { id: 's', u: -10, v: 10 }, { id: 'e', u: 10, v: 10 }],
            curves: [{ id: 'p', kind: 'parabola', focus: 'f', vertex: 'v', start: 's', end: 'e' }],
            constraints: [],
        };
        return addLine(g, { at: [-20, 4] }, { at: [20, 4] }).g;
    }

    it('trims a parabola into two pieces on the same focus and vertex, their cut ends on the parabola and the line', () => {
        const g0 = parabola();
        const original = geomOf(g0, 'p')!;
        const plan = trimAt(g0, 'p', [0, 0.2])!;
        const g = solved(plan.g);
        const pieces = g.curves.filter((c) => c.kind === 'parabola') as Extract<SketchCurve, { kind: 'parabola' }>[];
        expect(pieces).toHaveLength(2);
        for (const p of pieces) {
            expect([p.focus, p.vertex]).toEqual(['f', 'v']);
            expect(offOriginal(g, p.id, original)).toBeLessThan(1e-9);
        }
        const cutEnds = pieces.flatMap(ends).filter((id) => Math.abs(at(g, id)[1] - 4) < 1e-9);
        expect(cutEnds).toHaveLength(2);
        cutEnds.forEach((id) => expect(Math.abs(at(g, id)[0])).toBeCloseTo(Math.sqrt(40), 9));
    });

    it('extends a parabola along itself to a line', () => {
        let g = parabola();
        g = { ...g, curves: g.curves.filter((c) => c.kind === 'parabola') };
        g = addLine(g, { at: [14, -5] }, { at: [14, 60] }).g;
        const out = solved(extendAt(g, 'p', [9, 8])!.g);
        expect(at(out, 'e')[0]).toBeCloseTo(14, 9);
        expect(at(out, 'e')[1]).toBeCloseTo(196 / 10, 9);
    });

    /** A conic from (-10, 0) to (10, 0), its tangents meeting at (0, 12), Rho 0.4, and a line across at v = 3. */
    function conic(): SketchGeometry {
        const g: SketchGeometry = {
            points: [{ id: 'a', u: -10, v: 0 }, { id: 'b', u: 10, v: 0 }, { id: 't', u: 0, v: 12 }],
            curves: [{ id: 'k', kind: 'conic', start: 'a', end: 'b', apex: 't', rho: 0.4 }],
            constraints: [],
        };
        return addLine(g, { at: [-20, 3] }, { at: [20, 3] }).g;
    }

    it('cuts a conic into conics that lie on it exactly, each with its own top vertex and Rho', () => {
        const g0 = conic();
        const original = geomOf(g0, 'k')!;
        const plan = trimAt(g0, 'k', [0, 4.6])!;
        const g = solved(plan.g);
        const pieces = g.curves.filter((c) => c.kind === 'conic') as Extract<SketchCurve, { kind: 'conic' }>[];
        expect(pieces).toHaveLength(2);
        for (const p of pieces) {
            expect(p.rho).toBeGreaterThan(0);
            expect(p.rho).toBeLessThan(1);
            expect(offOriginal(g, p.id, original)).toBeLessThan(1e-9);
        }
        const split = splitAt(g0, 'k', [0, 4.6]) as { g: SketchGeometry };
        const halves = split.g.curves.filter((c) => c.kind === 'conic');
        expect(halves).toHaveLength(2);
        halves.forEach((c) => expect(offOriginal(split.g, c.id, original)).toBeLessThan(1e-9));
    });

    it('extends a conic along itself, its top vertex moved so it stays the same conic', () => {
        let g = conic();
        g = { ...g, curves: g.curves.filter((c) => c.kind === 'conic') };
        const original = geomOf(g, 'k')!;
        g = addLine(g, { at: [-20, -2] }, { at: [20, -2] }).g;
        const plan = extendAt(g, 'k', [9, 0.5])!;
        expect(plan).not.toBeNull();
        const out = solved(plan.g);
        expect(at(out, 'b')[1]).toBeCloseTo(-2, 9);
        // Every point of it lies on the original conic's natural path.
        const e = geometryEntities(out).find((k) => k.id === 'k')!;
        expect(Math.max(...entityPoints(e).map((p) => dist(p, pointAt(original, paramOf(original, p)))))).toBeLessThan(1e-9);
        // The end is on the conic's own path beyond its old end.
        expect(at(out, 'b')[0]).toBeGreaterThan(10);
    });
});

describe('splines', () => {
    const through: Pt[] = [[0, 0], [10, 8], [20, -3], [32, 5], [40, 0]];
    function spline(closed = false): SketchGeometry {
        const pts = closed ? [[0, 0], [12, 10], [24, 2], [18, -10], [4, -9]] as Pt[] : through;
        const ids = pts.map((_, i) => `s${i}`);
        return {
            points: pts.map((p, i) => ({ id: ids[i], u: p[0], v: p[1] })),
            curves: [{ id: 'sp', kind: 'spline', points: closed ? [...ids, ids[0]] : ids }],
            constraints: [],
        };
    }

    it('trims a spline into exact pieces: the same points, handles at the cuts, the parent spacing', () => {
        const g0 = addLine(spline(), { at: [15, -20] }, { at: [15, 20] }).g;
        const original = geomOf(g0, 'sp')!;
        const plan = trimAt(g0, 'sp', [32, 5])!;
        const g = solved(plan.g);
        const sp = curve(g, 'sp', 'spline');
        expect(sp.points.slice(0, 2)).toEqual(['s0', 's1']);
        expect(sp.endHandle).toBeDefined();
        expect(sp.startHandle).toBeUndefined();
        expect(offOriginal(g, 'sp', original)).toBeLessThan(1e-9);
        expect(at(g, sp.points[sp.points.length - 1])[0]).toBeCloseTo(15, 9);
        // Cut again from the other side: still the same curve.
        const g1 = addLine(g, { at: [4, -20] }, { at: [4, 20] }).g;
        const again = solved(trimAt(g1, 'sp', [1, 0.5])!.g);
        expect(offOriginal(again, 'sp', original)).toBeLessThan(1e-9);
        expect(curve(again, 'sp', 'spline').spacing).toBeDefined();
    });

    it('splits a spline in two pieces that share the split point and are the same curve', () => {
        const g0 = spline();
        const original = geomOf(g0, 'sp')!;
        const r = splitAt(g0, 'sp', [25, 0]) as { g: SketchGeometry; point: string };
        const g = solved(r.g);
        const pieces = g.curves.filter((c) => c.kind === 'spline');
        expect(pieces).toHaveLength(2);
        pieces.forEach((c) => expect(offOriginal(g, c.id, original)).toBeLessThan(1e-9));
        expect(pieces.flatMap(ends).filter((id) => id === r.point)).toHaveLength(2);
    });

    it('opens a closed spline between two crossings into the exact open piece left', () => {
        let g0 = spline(true);
        const original = geomOf(g0, 'sp')!;
        g0 = addLine(g0, { at: [8, -20] }, { at: [8, 20] }).g;
        expect(trimAt(g0, 'sp', [24, 2])).not.toBeNull();
        const g = solved(trimAt(g0, 'sp', [20, 6])!.g);
        const sp = curve(g, 'sp', 'spline');
        expect(sp.points[0]).not.toBe(sp.points[sp.points.length - 1]);
        expect(sp.startHandle && sp.endHandle).toBeTruthy();
        expect(offOriginal(g, 'sp', original)).toBeLessThan(1e-9);
        // Its two ends are on the line; the part right of it went.
        ends(sp).forEach((id) => expect(at(g, id)[0]).toBeCloseTo(8, 9));
    });

    it('cuts a line exactly where a spline crosses it', () => {
        const g0 = addLine(spline(), { at: [-5, 2] }, { at: [45, 2] }).g;
        const line = g0.curves.find((c) => c.kind === 'line')!;
        const sp = geomOf(g0, 'sp')!;
        const cuts = cutsAlong(g0, line);
        expect(cuts.length).toBeGreaterThanOrEqual(3);
        cuts.forEach((k) => expect(dist(k.at, pointAt(sp, closestParam(sp, k.at)))).toBeLessThan(1e-9));
    });

    it('does not extend a spline (it has no natural path past its ends), but corner-trims it to a line', () => {
        const g0 = addLine(spline(), { at: [36, -10] }, { at: [36, 20] }).g;
        expect(notForCurve('Extend', curve(g0, 'sp', 'spline'))).toMatch(/does not lengthen splines/);
        expect(extendAt(g0, 'sp', [39, 0])).toBeNull();
        const line = g0.curves.find((c) => c.kind === 'line')!;
        const r = trimCorner(g0, { id: 'sp', at: [10, 8] }, { id: line.id, at: [36, -8] }) as { g: SketchGeometry };
        expect(r.g).toBeDefined();
        const g = solved(r.g);
        const sp = curve(g, 'sp', 'spline');
        const l = curve(g, line.id, 'line');
        expect([l.a, l.b]).toContain(sp.points[sp.points.length - 1]);
        expect(offOriginal(g, 'sp', geomOf(g0, 'sp')!)).toBeLessThan(1e-9);
    });

    it('trims a spline away inside and outside two boundaries, and power trims across it', () => {
        let g0 = addLine(spline(), { at: [6, -20] }, { at: [6, 20] }).g;
        g0 = addLine(g0, { at: [30, -20] }, { at: [30, 20] }).g;
        const [b1, b2] = g0.curves.filter((c) => c.kind === 'line').map((c) => c.id) as [string, string];
        const original = geomOf(g0, 'sp')!;
        const inside = solved((trimBetween(g0, 'sp', [b1, b2], 'inside') as { g: SketchGeometry }).g);
        const kept = inside.curves.filter((c) => c.kind === 'spline');
        expect(kept).toHaveLength(2);
        kept.forEach((c) => expect(offOriginal(inside, c.id, original)).toBeLessThan(1e-9));
        const outside = solved((trimBetween(g0, 'sp', [b1, b2], 'outside') as { g: SketchGeometry }).g);
        const mid = curve(outside, 'sp', 'spline');
        ends(mid).forEach((id) => expect([6, 30].some((u) => Math.abs(at(outside, id)[0] - u) < 1e-9)).toBe(true));
        const power = powerTrim(g0, [20, 30], [20, -30]);
        expect(power.trimmed).toBeGreaterThan(0);
        expect(solveGeometry(power.g).ok).toBe(true);
    });
});

describe('style splines', () => {
    const poles: Pt[] = [[0, 0], [8, 14], [16, -6], [24, 12], [32, -4], [40, 6]];
    function style(degree?: 3 | 5): SketchGeometry {
        const ids = poles.map((_, i) => `q${i}`);
        return {
            points: poles.map((p, i) => ({ id: ids[i], u: p[0], v: p[1] })),
            curves: [{ id: 'ss', kind: 'styleSpline', points: ids, ...(degree ? { degree } : {}) }],
            constraints: [],
        };
    }

    it('cuts Bezier and B-spline style splines into exact pieces of the same degree', () => {
        for (const degree of [undefined, 3, 5] as const) {
            const g0 = addLine(style(degree), { at: [21, -20] }, { at: [21, 20] }).g;
            const original = geomOf(g0, 'ss')!;
            const plan = trimAt(g0, 'ss', [39, 5])!;
            const g = solved(plan.g);
            const ss = curve(g, 'ss', 'styleSpline');
            expect(ss.degree).toBe(degree);
            expect(ss.points[0]).toBe('q0');
            expect(offOriginal(g, 'ss', original)).toBeLessThan(1e-9);
            const r = splitAt(g0, 'ss', [10, 4]) as { g: SketchGeometry };
            const pieces = r.g.curves.filter((c) => c.kind === 'styleSpline') as Extract<SketchCurve, { kind: 'styleSpline' }>[];
            expect(pieces).toHaveLength(2);
            pieces.forEach((c) => expect(offOriginal(r.g, c.id, original)).toBeLessThan(1e-9));
            if (degree === 3) {
                expect(pieces.some((c) => c.knots)).toBe(true);
            }
        }
    });
});

describe('relations and options', () => {
    it('keeps the trimmed piece as construction, and moves a tangency at the far end to the piece that has it', () => {
        const s = ellipseAndLine();
        const arcG = trimAt(s.g, 'e', [-20, 0])!.g;
        const kept = trimAt(s.g, 'e', [-20, 0], { construction: true })!.g;
        expect(kept.curves.filter((c) => c.kind === 'ellipseArc' && c.construction)).toHaveLength(1);
        expect(solveGeometry(kept).ok).toBe(true);
        // A conic with a line tangent at its end; cut in the middle, the tangency goes with the second piece.
        let g: SketchGeometry = {
            points: [{ id: 'a', u: -10, v: 0 }, { id: 'b', u: 10, v: 0 }, { id: 't', u: 0, v: 12 }, { id: 'z', u: 15, v: -15 }],
            curves: [{ id: 'k', kind: 'conic', start: 'a', end: 'b', apex: 't', rho: 0.4 }, { id: 'tl', kind: 'line', a: 'b', b: 'z' }],
            constraints: [{ id: 'tg', kind: 'tangent', a: 'k', b: 'tl' }],
        };
        g = addLine(g, { at: [-20, 3] }, { at: [20, 3] }).g;
        const out = trimAt(g, 'k', [0, 4.6])!.g;
        const tg = out.constraints.find((c) => c.id === 'tg')!;
        const second = out.curves.find((c) => c.kind === 'conic' && c.id !== 'k')!;
        expect(tg).toMatchObject({ kind: 'tangent', a: second.id, b: 'tl' });
        expect(arcG.curves).toHaveLength(2);
    });

    it('splits an ellipse with two clicks of the Split tool', () => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: ellipseAndLine().g, labels: {}, picks: [], draft: [], selection: [], snap: false, undo: [], redo: [] });
        setTool('split');
        sketchClick([0, 10], 0.5);
        expect(useSketcher.getState().message).toBe('Click the second split point on the ellipse.');
        sketchClick([0, -10], 0.5);
        expect(useSketcher.getState().geometry.curves.filter((c) => c.kind === 'ellipseArc')).toHaveLength(2);
    });

    it('joins split pieces again when their split point is deleted: the same curve as before the split', () => {
        const cases: { g: SketchGeometry; id: string; at: Pt; at2?: Pt }[] = [
            { g: addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 10] }).g, id: '', at: [15, 5] },
            {
                g: {
                    points: [{ id: 'c', u: 0, v: 0 }, { id: 'm', u: 20, v: 0 }, { id: 'n', u: 0, v: 10 }, { id: 's', u: 20, v: 0 }, { id: 't', u: -20, v: 0 }],
                    curves: [{ id: 'pe', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 's', end: 't' }], constraints: [],
                }, id: 'pe', at: [0, 10],
            },
            {
                g: { points: [{ id: 'a', u: -10, v: 0 }, { id: 'b', u: 10, v: 0 }, { id: 't', u: 0, v: 12 }], curves: [{ id: 'k', kind: 'conic', start: 'a', end: 'b', apex: 't', rho: 0.4 }], constraints: [] },
                id: 'k', at: [3, 5],
            },
            {
                g: { points: [[0, 0], [10, 8], [20, -3], [32, 5]].map(([u, v], i) => ({ id: `s${i}`, u, v })), curves: [{ id: 'sp', kind: 'spline', points: ['s0', 's1', 's2', 's3'] }], constraints: [] },
                id: 'sp', at: [14, 3],
            },
            ...([undefined, 3] as const).map((degree) => ({
                g: {
                    points: [[0, 0], [8, 14], [16, -6], [24, 12], [32, -4], [40, 6]].map(([u, v], i) => ({ id: `q${i}`, u, v })),
                    curves: [{ id: 'ss', kind: 'styleSpline' as const, points: ['q0', 'q1', 'q2', 'q3', 'q4', 'q5'], ...(degree ? { degree } : {}) }], constraints: [],
                }, id: 'ss', at: [18, 2] as Pt,
            })),
            {
                g: { points: [{ id: 'c', u: 1, v: 2 }], curves: [{ id: 'ci', kind: 'circle', center: 'c', radius: 5 }], constraints: [] },
                id: 'ci', at: [6, 2], at2: [-4, 2],
            },
        ];
        for (const k of cases) {
            const id = k.id || k.g.curves[0].id;
            const original = geomOf(k.g, id)!;
            const r = splitAt(k.g, id, k.at, k.at2) as { g: SketchGeometry; point: string };
            expect(r.point).toBeDefined();
            const back = joinAtPoint(r.g, k.at2 ? r.g.points.find((p) => p.id !== r.point && !k.g.points.some((q) => q.id === p.id))!.id : r.point)!;
            expect(back, id).not.toBeNull();
            expect(back.curves, id).toHaveLength(1);
            expect(back.curves[0].id).toBe(id);
            const joinedKind = back.curves[0].kind;
            if (k.at2) {
                // A circle split at two points: deleting one split point makes it a whole circle again.
                expect(joinedKind).toBe('circle');
                expect(back.points.map((p) => p.id)).toEqual(['c']);
            } else {
                expect(joinedKind).toBe(k.g.curves[0].kind);
                expect(offOriginal(back, id, original)).toBeLessThan(1e-7);
                expect(solveGeometry(back).ok).toBe(true);
            }
        }
        // Through the Delete key on the selected split point.
        const g0 = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 10] }).g;
        const r = splitAt(g0, g0.curves[0].id, [15, 5]) as { g: SketchGeometry; point: string };
        useSketcher.setState({ active: true, stage: 'draw', geometry: r.g, labels: {}, picks: [], draft: [], selection: [{ type: 'point', id: r.point }], snap: false, undo: [], redo: [] });
        deleteSelected();
        expect(useSketcher.getState().geometry.curves).toHaveLength(1);
        expect(useSketcher.getState().geometry.points).toHaveLength(2);
    });

    it('extends nothing past a point on its own line, and leaves lone lines to Extend as before', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        expect(extendAt(g, g.curves[0].id, [9, 0])).toBeNull();
    });
});
