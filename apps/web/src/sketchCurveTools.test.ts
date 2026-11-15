import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { closestParam, directionAt, domainOf, pointAt, type CurveGeom } from '@jarvis/core/curveIntersect';
import { curveOf, loadSolver, pointOf, solveGeometry } from './solver';
import { geometryProfiles } from './sketchGeometry';
import { chamferSides, filletCornerAt, filletCornerOf, filletSides, type FilletCorner } from './sketchFillet';
import { offsetEntities, sideDistance } from './sketchEdit';
import { geomOfCurve } from './sketchCut';
import { refreshOffsets } from './sketchCurveOffset';
import { unmetConstraints } from './sketchCheck';
import { removeItems } from './sketchGeometry';
import { expandOwned } from './sketchItems';
import { transformWithItems } from './sketchItemTransform';
import {
    DEFAULT_EDIT_OPTIONS, applyDimension, editDimension, setDimText, setEditOptions, setTool, sketchClick, sketchDown, sketchMove, sketchUp, undoSketch, useSketcher,
} from './sketcher';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

type Pt = [number, number];

beforeAll(async () => {
    await loadSolver();
});

const at = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** Points and curves from short lists. */
function sketch(points: Record<string, Pt>, curves: SketchCurve[], constraints: SketchConstraint[] = []): SketchGeometry {
    return { points: Object.entries(points).map(([id, [u, v]]) => ({ id, u, v })), curves, constraints };
}

/** A sketch curve sampled by s from 0 at its start to 1 at its end (once round a closed one), on its exact shape. */
interface Ev {
    geom: CurveGeom;
    closed: boolean;
    at(s: number): Pt;
}
function evalOf(g: SketchGeometry, c: SketchCurve): Ev | null {
    const geom = geomOfCurve(g, c);
    if (!geom) {
        return null;
    }
    const d = domainOf(geom);
    const span = d.period ?? d.t1 - d.t0;
    return { geom, closed: !!d.period, at: (s) => pointAt(geom, d.t0 + span * s) };
}
/** The point of the curve nearest q. */
const nearestOn = (ev: Ev, q: Pt): Pt => pointAt(ev.geom, closestParam(ev.geom, q));

/** Largest distance from samples of `piece` to the curve `whole` (a piece cut from it must lie on it). */
function offCurve(piece: Ev, whole: Ev, samples = 60): number {
    let worst = 0;
    for (let i = 0; i <= samples; i++) {
        const q = piece.at(i / samples);
        worst = Math.max(worst, dist(q, nearestOn(whole, q)));
    }
    return worst;
}

/** The sketch solves as it is: nothing moves and every relation holds. */
function holds(g: SketchGeometry): void {
    const r = solveGeometry(g);
    expect(r.ok, `conflicts: ${r.conflicting.join(', ')}`).toBe(true);
    expect(unmetConstraints(r.geometry)).toEqual([]);
    for (const p of g.points) {
        const q = pointOf(r.geometry, p.id)!;
        expect(dist([p.u, p.v], [q.u, q.v]), `point ${p.id} moved`).toBeLessThan(1e-6);
    }
}

// A line from the origin and each curve kind ending on its start, about the same corner.
const kinds: Record<string, () => SketchGeometry> = {
    spline: () => sketch({ o: [0, 0], f: [30, 0], s1: [8, 14], s2: [18, 18], s3: [28, 26] }, [
        { id: 'l', kind: 'line', a: 'o', b: 'f' },
        { id: 'k', kind: 'spline', points: ['o', 's1', 's2', 's3'] },
    ]),
    'spline with handles': () => sketch({ o: [0, 0], f: [30, 0], s1: [10, 12], s2: [22, 20], h0: [1, 5], h1: [26, 26] }, [
        { id: 'l', kind: 'line', a: 'o', b: 'f' },
        { id: 'k', kind: 'spline', points: ['o', 's1', 's2'], startHandle: 'h0', endHandle: 'h1' },
    ]),
    'partial ellipse': () => sketch({ o: [0, 0], f: [30, 0], c: [-20, 0], m: [-20, 30], n: [0, 0] }, [
        { id: 'l', kind: 'line', a: 'o', b: 'f' },
        // Centre (-20, 0), radius 20 across, 30 up: from (0, 0) counter-clockwise up to (-20, 30).
        { id: 'k', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 'o', end: 'm' },
    ]),
    // Vertex (6, -3), focal length 3, axis up: x = 6 across is the origin, x = 12 is (-6, 9).
    parabola: () => sketch({ o: [0, 0], f: [30, 0], fo: [6, 0], v: [6, -3], e: [-6, 9] }, [
        { id: 'l', kind: 'line', a: 'o', b: 'f' },
        { id: 'k', kind: 'parabola', focus: 'fo', vertex: 'v', start: 'o', end: 'e' },
    ]),
    conic: () => sketch({ o: [0, 0], f: [30, 0], ap: [0, 20], e: [20, 28] }, [
        { id: 'l', kind: 'line', a: 'o', b: 'f' },
        { id: 'k', kind: 'conic', start: 'o', end: 'e', apex: 'ap', rho: 0.4 },
    ]),
    'Bezier style spline': () => sketch({ o: [0, 0], f: [30, 0], c1: [4, 12], c2: [12, 22], c3: [26, 24] }, [
        { id: 'l', kind: 'line', a: 'o', b: 'f' },
        { id: 'k', kind: 'styleSpline', points: ['o', 'c1', 'c2', 'c3'] },
    ]),
    'B-spline of degree 3': () => sketch({ o: [0, 0], f: [30, 0], c1: [3, 10], c2: [9, 20], c3: [18, 22], c4: [26, 30], c5: [34, 30] }, [
        { id: 'l', kind: 'line', a: 'o', b: 'f' },
        { id: 'k', kind: 'styleSpline', points: ['o', 'c1', 'c2', 'c3', 'c4', 'c5'], degree: 3 },
    ]),
};

describe('sketch fillet on every curve kind', () => {
    for (const [name, make] of Object.entries(kinds)) {
        it(`rounds a line and a ${name} with a tangent arc, the ${name} cut exactly where it touches`, () => {
            const g = make();
            const before = evalOf(g, curveOf(g, 'k')!)!;
            const corner = filletCornerAt(g, 'o');
            expect(corner).not.toHaveProperty('error');
            const r = filletSides(g, corner as FilletCorner, 3) as { g: SketchGeometry; arc: string };
            expect(r).not.toHaveProperty('error');
            const out = r.g;
            const arc = curveOf(out, r.arc) as Extract<SketchCurve, { kind: 'arc' }>;
            const c = at(out, arc.center);
            // Both ends of the arc are on its circle of radius 3, and it is tangent to the curves there.
            for (const id of [arc.start, arc.end]) {
                expect(dist(at(out, id), c)).toBeCloseTo(3, 9);
            }
            const side = curveOf(out, 'k')!;
            expect(side.kind).toBe(curveOf(g, 'k')!.kind);
            const ev = evalOf(out, side)!;
            expect(offCurve(ev, before)).toBeLessThan(1e-9);
            const touch = [arc.start, arc.end].find((id) => Object.values(side).flat().includes(id))!;
            const d = directionAt(ev.geom, closestParam(ev.geom, at(out, touch)));
            const radius: Pt = [at(out, touch)[0] - c[0], at(out, touch)[1] - c[1]];
            expect(Math.abs(d[0] * radius[0] + d[1] * radius[1]) / Math.hypot(...d) / 3).toBeLessThan(1e-9);
            // The line now starts at the other end of the arc, 3 above the centre's foot.
            const line = curveOf(out, 'l') as Extract<SketchCurve, { kind: 'line' }>;
            expect(Math.abs(at(out, line.a)[1])).toBeLessThan(1e-9);
            expect(Math.abs(c[1] - 3)).toBeLessThan(1e-9);
            // The tangency, the radius and the kept corner hold in the solver without moving anything.
            expect(out.constraints.some((k) => k.kind === 'tangent' || k.kind === 'perpendicular')).toBe(true);
            holds(out);
        });
    }

    it('rounds a line and a full ellipse picked as two curves: the ellipse becomes a partial ellipse', () => {
        const g = sketch({ a: [-40, 5], b: [40, 5], c: [0, 0], m: [30, 0], n: [0, 15] }, [
            { id: 'l', kind: 'line', a: 'a', b: 'b' },
            { id: 'e', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' },
        ]);
        // Picked on the line left of the ellipse, and on the ellipse below the line.
        const corner = filletCornerOf(g, 'l', 'e', [[-35, 5], [-29, -2]]);
        expect(corner).not.toHaveProperty('error');
        const r = filletSides(g, corner as FilletCorner, 2) as { g: SketchGeometry; arc: string };
        expect(r).not.toHaveProperty('error');
        const e = curveOf(r.g, 'e')!;
        expect(e.kind).toBe('ellipseArc');
        const ev = evalOf(r.g, e)!;
        expect(offCurve(ev, evalOf(g, curveOf(g, 'e')!)!)).toBeLessThan(1e-9);
        holds(r.g);
    });

    it('rounds a line and a circle picked as two curves: the circle becomes an arc', () => {
        const g = sketch({ a: [-40, 0], b: [40, 0], c: [0, 0] }, [
            { id: 'l', kind: 'line', a: 'a', b: 'b' },
            { id: 'o', kind: 'circle', center: 'c', radius: 10 },
        ]);
        const r = filletSides(g, filletCornerOf(g, 'l', 'o', [[-30, 0], [-9, 4]]) as FilletCorner, 2) as { g: SketchGeometry; arc: string };
        expect(r).not.toHaveProperty('error');
        expect(curveOf(r.g, 'o')!.kind).toBe('arc');
        holds(r.g);
    });

    it('rounds two splines that cross, and a closed spline and a line', () => {
        const g = sketch({ a: [0, 0], b: [10, 6], c: [20, 2], d: [0, 8], e: [10, 1], f: [20, 9] }, [
            { id: 's', kind: 'spline', points: ['a', 'b', 'c'] },
            { id: 't', kind: 'spline', points: ['d', 'e', 'f'] },
        ]);
        const r = filletSides(g, filletCornerOf(g, 's', 't', [[2, 2], [2, 6.5]]) as FilletCorner, 1) as { g: SketchGeometry; arc: string };
        expect(r).not.toHaveProperty('error');
        holds(r.g);
        const loop = sketch({ p: [10, 0], q: [4, 7], r: [-6, 5], s: [-9, -3], t: [0, -8], a: [-20, 2], b: [20, 2] }, [
            { id: 'k', kind: 'spline', points: ['p', 'q', 'r', 's', 't', 'p'] },
            { id: 'l', kind: 'line', a: 'a', b: 'b' },
        ]);
        const r2 = filletSides(loop, filletCornerOf(loop, 'l', 'k', [[18, 2], [8, -1]]) as FilletCorner, 1) as { g: SketchGeometry; arc: string };
        expect(r2).not.toHaveProperty('error');
        const k = curveOf(r2.g, 'k') as Extract<SketchCurve, { kind: 'spline' }>;
        expect(k.points[0]).not.toBe(k.points[k.points.length - 1]);
        expect(offCurve(evalOf(r2.g, k)!, evalOf(loop, curveOf(loop, 'k')!)!)).toBeLessThan(1e-9);
        holds(r2.g);
    });

    it('fillets a loop of a spline and lines into a closed area that the kernel gets as one profile', () => {
        const g = sketch({ o: [0, 0], f: [30, 0], s1: [12, 10], top: [20, 25] }, [
            { id: 'l', kind: 'line', a: 'o', b: 'f' },
            { id: 'k', kind: 'spline', points: ['o', 's1', 'top'] },
            { id: 'r', kind: 'line', a: 'f', b: 'top' },
        ]);
        const r = filletSides(g, filletCornerAt(g, 'o') as FilletCorner, 2) as { g: SketchGeometry };
        const { profiles } = geometryProfiles(r.g);
        expect(profiles).toHaveLength(1);
        expect(profiles[0].kind === 'path' && profiles[0].segments.map((s) => s.kind).sort()).toEqual(['arc', 'line', 'line', 'spline']);
        holds(r.g);
    });

    it('says when the radius is too big', () => {
        const tight = sketch({ a: [0, 0], b: [5, 4], c: [10, 0] }, [{ id: 'k', kind: 'spline', points: ['a', 'b', 'c'] }]);
        // Under the hump the curve bends tighter than 4: the offset would cross itself.
        expect(offsetEntities(tight, ['k'], { distance: -4 })).toHaveProperty('error');
        const g = kinds.conic();
        expect(filletSides(g, filletCornerAt(g, 'o') as FilletCorner, 500)).toHaveProperty('error');
    });
});

describe('sketch chamfer on every curve kind', () => {
    for (const [name, make] of Object.entries(kinds)) {
        it(`cuts the corner of a line and a ${name}, Distance 1 and 2 straight from the corner`, () => {
            const g = make();
            const before = evalOf(g, curveOf(g, 'k')!)!;
            const corner = filletCornerAt(g, 'o') as FilletCorner;
            const r = chamferSides(g, corner, { type: 'distance', distance: 3, distance2: 4 }) as { g: SketchGeometry };
            expect(r).not.toHaveProperty('error');
            const out = r.g;
            const line = curveOf(out, 'l') as Extract<SketchCurve, { kind: 'line' }>;
            const side = curveOf(out, 'k')!;
            expect(dist(at(out, line.a), [0, 0])).toBeCloseTo(3, 9);
            const ev = evalOf(out, side)!;
            expect(dist(ev.at(0), [0, 0])).toBeCloseTo(4, 9);
            expect(offCurve(ev, before)).toBeLessThan(1e-9);
            // The chamfer line joins the two cut ends; the corner stays as a point.
            expect(out.curves.some((c) => c.kind === 'line' && !c.construction && [c.a, c.b].includes(line.a))).toBe(true);
            holds(out);
        });
    }

    it('cuts at a distance and an angle from the first curve, and with equal distances', () => {
        const g = kinds.spline();
        const corner = filletCornerAt(g, 'o') as FilletCorner;
        const r = chamferSides(g, corner, { type: 'angle', distance: 3, angle: 50 }) as { g: SketchGeometry };
        expect(r).not.toHaveProperty('error');
        const line = curveOf(r.g, 'l') as Extract<SketchCurve, { kind: 'line' }>;
        const cut = r.g.curves.find((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line' && !c.construction && c.id !== 'l')!;
        const [p, q] = [at(r.g, cut.a), at(r.g, cut.b)];
        const p1 = at(r.g, line.a);
        const other = dist(p, p1) < 1e-9 ? q : p;
        // From the cut end on the line, the chamfer leaves at 50 degrees to the leg back to the corner.
        const leg: Pt = [0 - p1[0], 0 - p1[1]];
        const ch: Pt = [other[0] - p1[0], other[1] - p1[1]];
        const angle = (Math.acos((leg[0] * ch[0] + leg[1] * ch[1]) / Math.hypot(...leg) / Math.hypot(...ch)) * 180) / Math.PI;
        expect(angle).toBeCloseTo(50, 7);
        holds(r.g);
        const e = chamferSides(g, corner, { type: 'distance', distance: 2.5 }) as { g: SketchGeometry };
        expect(dist(evalOf(e.g, curveOf(e.g, 'k')!)!.at(0), [0, 0])).toBeCloseTo(2.5, 9);
        holds(e.g);
    });

    it('chamfers a line and an arc meeting at an end', () => {
        const g = sketch({ o: [0, 0], f: [30, 0], c: [-10, 10], e: [-10, 10 + Math.hypot(10, 10)] }, [
            { id: 'l', kind: 'line', a: 'o', b: 'f' },
            { id: 'k', kind: 'arc', center: 'c', start: 'o', end: 'e' },
        ]);
        const r = chamferSides(g, filletCornerAt(g, 'o') as FilletCorner, { type: 'distance', distance: 2 }) as { g: SketchGeometry };
        expect(r).not.toHaveProperty('error');
        const arc = curveOf(r.g, 'k') as Extract<SketchCurve, { kind: 'arc' }>;
        expect(dist(at(r.g, arc.start), [0, 0])).toBeCloseTo(2, 9);
        holds(r.g);
    });

    it('chamfers a line crossing a closed curve (ellipse, circle, closed spline) without a repeated relation', () => {
        const closed: [SketchGeometry, string, [Pt, Pt]][] = [
            [sketch({ a: [8, -15], b: [8, 15], c: [0, 0], m: [16, 0], n: [0, 8] }, [
                { id: 'l', kind: 'line', a: 'a', b: 'b' },
                { id: 'k', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' },
            ]), 'ellipseArc', [[8, -12], [-12.69365, 4.87009]]],
            [sketch({ a: [8, -15], b: [8, 15], c: [0, 0] }, [
                { id: 'l', kind: 'line', a: 'a', b: 'b' },
                { id: 'k', kind: 'circle', center: 'c', radius: 10 },
            ]), 'arc', [[8, -12], [-10, 0]]],
            [sketch({ p: [10, 0], q: [4, 7], r: [-6, 5], s: [-9, -3], t: [0, -8], a: [-20, 2], b: [20, 2] }, [
                { id: 'k', kind: 'spline', points: ['p', 'q', 'r', 's', 't', 'p'] },
                { id: 'l', kind: 'line', a: 'a', b: 'b' },
            ]), 'spline', [[18, 2], [8, -1]]],
        ];
        for (const [g, kind, picks] of closed) {
            const r = chamferSides(g, filletCornerOf(g, 'l', 'k', picks) as FilletCorner, { type: 'distance', distance: 2 }) as { g: SketchGeometry };
            expect(r).not.toHaveProperty('error');
            expect(curveOf(r.g, 'k')!.kind).toBe(kind);
            const s = solveGeometry(r.g);
            expect([s.conflicting, s.redundant]).toEqual([[], []]);
            holds(r.g);
        }
    });
});

/** Largest difference between the distance of the offset's points from the base and d. */
function offsetError(g: SketchGeometry, base: string, ids: string[], d: number): number {
    const whole = evalOf(g, curveOf(g, base)!)!;
    let worst = 0;
    for (const id of ids) {
        const c = curveOf(g, id)!;
        if (c.construction) {
            continue;
        }
        const ev = evalOf(g, c)!;
        for (let i = 0; i <= 80; i++) {
            const q = ev.at(i / 80);
            worst = Math.max(worst, Math.abs(dist(q, nearestOn(whole, q)) - Math.abs(d)));
        }
    }
    return worst;
}

describe('offset entities on every curve kind', () => {
    const ellipse = () => sketch({ c: [0, 0], m: [30, 0], n: [0, 15] }, [{ id: 'e', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' }]);

    it('offsets an ellipse as a closed spline within 0.000001 mm, with a driven distance dimension, outside or inside', () => {
        for (const d of [2, -3]) {
            const g = ellipse();
            const r = offsetEntities(g, ['e'], { distance: d }) as { g: SketchGeometry; created: string[] };
            expect(r).not.toHaveProperty('error');
            const item = r.g.offsets![0];
            expect(item.deviation).toBeLessThanOrEqual(1e-6);
            const spline = r.created.map((id) => curveOf(r.g, id)!).find((c) => c.kind === 'spline') as Extract<SketchCurve, { kind: 'spline' }>;
            expect(spline.points[0]).toBe(spline.points[spline.points.length - 1]);
            // Inside a counter-clockwise curve is its left: a positive distance goes in.
            expect(offsetError(r.g, 'e', r.created, d)).toBeLessThan(2e-6);
            const inside = evalOf(r.g, spline)!.at(0);
            expect(Math.hypot(inside[0] / 30, inside[1] / 15) < 1).toBe(d > 0);
            const dim = r.g.constraints.find((k) => k.id === item.dimensions![0]) as Extract<SketchConstraint, { kind: 'length' }>;
            expect(dim).toMatchObject({ kind: 'length', driven: true });
            expect(dim.value).toBeCloseTo(Math.abs(d), 9);
            holds(r.g);
            // Its points are the item's, fixed, so it cannot be pulled off its ellipse.
            expect(spline.points.every((id) => pointOf(r.g, id)!.fixed)).toBe(true);
        }
    });

    it('follows its ellipse when the ellipse changes, and takes a typed distance', () => {
        const g = ellipse();
        const r = offsetEntities(g, ['e'], { distance: 2 }) as { g: SketchGeometry };
        const moved = { ...r.g, points: r.g.points.map((p) => (p.id === 'm' ? { ...p, u: 40 } : p)) };
        const after = refreshOffsets(moved);
        const item = after.offsets![0];
        expect(offsetError(after, 'e', item.curves, 2)).toBeLessThan(2e-6);
        const dim = item.dimensions![0];
        const typed = { ...after, constraints: after.constraints.map((k) => (k.id === dim ? { ...k, value: 5 } as SketchConstraint : k)) };
        const again = refreshOffsets(typed);
        expect(again.offsets![0].distances[0]).toBeCloseTo(5, 12);
        expect(offsetError(again, 'e', again.offsets![0].curves, 5)).toBeLessThan(2e-6);
        expect((again.constraints.find((k) => k.id === dim) as { value: number }).value).toBeCloseTo(5, 9);
        // Deleting the ellipse leaves the offset as plain geometry; deleting the offset takes all of it.
        const loose = refreshOffsets(removeItems(again, ['e']));
        expect(loose.offsets ?? []).toHaveLength(0);
        const gone = removeItems(again, expandOwned(again, [again.offsets![0].curves[1]]));
        expect(gone.curves.map((c) => c.id)).toEqual(['e']);
    });

    it('goes where its ellipse goes when both are moved; alone it is not moved, and a copy of it is plain geometry', () => {
        const r = offsetEntities(ellipse(), ['e'], { distance: 2 }) as { g: SketchGeometry; created: string[] };
        const spline = r.created.find((id) => curveOf(r.g, id)!.kind === 'spline')!;
        expect(transformWithItems(r.g, [spline], { kind: 'move', by: [5, 0] }, false)).toHaveProperty('error');
        const both = transformWithItems(r.g, ['e', spline], { kind: 'move', by: [5, 0] }, false) as { g: SketchGeometry };
        const moved = refreshOffsets(both.g);
        expect(pointOf(moved, 'c')!.u).toBeCloseTo(5, 12);
        expect(offsetError(moved, 'e', moved.offsets![0].curves, 2)).toBeLessThan(2e-6);
        const copy = transformWithItems(r.g, [spline], { kind: 'move', by: [0, 50] }, true) as { g: SketchGeometry; created: string[] };
        const k = curveOf(copy.g, copy.created[0]) as Extract<SketchCurve, { kind: 'spline' }>;
        expect(k.kind).toBe('spline');
        expect(k.points.some((id) => pointOf(copy.g, id)!.fixed)).toBe(false);
        expect(copy.g.offsets).toHaveLength(1);
        // As in SolidWorks, an offset spline is not offset again.
        expect(offsetEntities(r.g, [spline], { distance: 1 })).toHaveProperty('error');
    });

    const curves: Record<string, () => SketchGeometry> = {
        spline: () => sketch({ a: [0, 0], b: [10, 6], c: [20, 2], d: [30, 8] }, [{ id: 'k', kind: 'spline', points: ['a', 'b', 'c', 'd'] }]),
        parabola: () => sketch({ fo: [0, 4], v: [0, 0], s: [-12, 9], e: [10, 6.25] }, [{ id: 'k', kind: 'parabola', focus: 'fo', vertex: 'v', start: 's', end: 'e' }]),
        conic: () => sketch({ s: [0, 0], ap: [10, 15], e: [25, 2] }, [{ id: 'k', kind: 'conic', start: 's', end: 'e', apex: 'ap', rho: 0.6 }]),
        'partial ellipse': () => sketch({ c: [0, 0], m: [30, 0], n: [0, 15], s: [30, 0], e: [0, 15] }, [
            { id: 'k', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 's', end: 'e' }]),
        'style spline': () => sketch({ a: [0, 0], b: [6, 12], c: [14, -4], d: [22, 10], e: [30, 2] }, [{ id: 'k', kind: 'styleSpline', points: ['a', 'b', 'c', 'd', 'e'], degree: 3 }]),
    };
    for (const [name, make] of Object.entries(curves)) {
        it(`offsets a ${name} one way, both ways, and both ways with capped ends that close an area`, () => {
            const g = make();
            const one = offsetEntities(g, ['k'], { distance: 1.5 }) as { g: SketchGeometry; created: string[] };
            expect(one).not.toHaveProperty('error');
            expect(offsetError(one.g, 'k', one.created, 1.5)).toBeLessThan(2e-6);
            holds(one.g);
            for (const cap of ['arcs', 'lines'] as const) {
                const both = offsetEntities(g, ['k'], { distance: 1.5, both: true, cap }) as { g: SketchGeometry; created: string[] };
                expect(both).not.toHaveProperty('error');
                const sides = both.created.filter((id) => curveOf(both.g, id)!.kind === 'spline');
                expect(sides).toHaveLength(2);
                expect(offsetError(both.g, 'k', sides, 1.5)).toBeLessThan(2e-6);
                expect(both.g.offsets![0].dimensions).toHaveLength(2);
                const { profiles } = geometryProfiles(both.g);
                expect(profiles).toHaveLength(1);
                holds(both.g);
                // One way with caps: the caps join the curve's own ends to the offset's.
                const capped = offsetEntities(g, ['k'], { distance: 1.5, cap }) as { g: SketchGeometry; created: string[] };
                expect(geometryProfiles(capped.g).profiles).toHaveLength(1);
                holds(capped.g);
            }
        });
    }

    it('offsets a chain of a line, a spline and a line: the pieces meet at the corners, construction options apply', () => {
        const g = sketch({ a: [-10, 0], b: [0, 0], s1: [8, 6], c: [16, 0], d: [16, -10] }, [
            { id: 'l1', kind: 'line', a: 'a', b: 'b' },
            { id: 'k', kind: 'spline', points: ['b', 's1', 'c'] },
            { id: 'l2', kind: 'line', a: 'c', b: 'd' },
        ]);
        const r = offsetEntities(g, ['k'], { distance: 1, baseConstruction: true }) as { g: SketchGeometry; created: string[] };
        expect(r).not.toHaveProperty('error');
        const kinds = r.created.map((id) => curveOf(r.g, id)!.kind);
        expect(kinds).toEqual(['line', 'spline', 'line']);
        // Joined end to end.
        const made = r.created.map((id) => curveOf(r.g, id)!);
        for (let i = 0; i + 1 < made.length; i++) {
            const end = evalOf(r.g, made[i])!.at(1);
            const start = evalOf(r.g, made[i + 1])!.at(0);
            expect(dist(end, start)).toBeLessThan(1e-9);
        }
        expect(['l1', 'k', 'l2'].every((id) => curveOf(r.g, id)!.construction)).toBe(true);
        holds(r.g);
        // With Select chain off only the spline is offset.
        const alone = offsetEntities(g, ['k'], { distance: 1, chain: false, offsetConstruction: true }) as { g: SketchGeometry; created: string[] };
        expect(alone.created.map((id) => curveOf(alone.g, id)!.kind)).toEqual(['spline']);
        expect(curveOf(alone.g, alone.created[0])!.construction).toBe(true);
    });

    it('offsets a closed loop of a spline and a line, and the cursor side picks the way', () => {
        const g = sketch({ a: [0, 0], b: [20, 0], s1: [10, 10] }, [
            { id: 'l', kind: 'line', a: 'a', b: 'b' },
            { id: 'k', kind: 'spline', points: ['b', 's1', 'a'] },
        ]);
        // The loop runs a -> b along the line, then back over the spline: inside is left.
        expect(sideDistance(g, 'l', [10, 3])).toBeGreaterThan(0);
        expect(sideDistance(g, 'k', [10, 12])).toBeLessThan(0);
        const r = offsetEntities(g, ['l'], { distance: 1 }) as { g: SketchGeometry; created: string[] };
        expect(r).not.toHaveProperty('error');
        const { profiles } = geometryProfiles(r.g);
        expect(profiles).toHaveLength(2);
        holds(r.g);
    });
});

describe('the tools in the sketcher', () => {
    const state = () => useSketcher.getState();
    const start = (g: SketchGeometry) => useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], editOptions: DEFAULT_EDIT_OPTIONS, message: null, typed: '',
    });

    it('offsets a spline by clicks, keeps it with the spline while a point is dragged, and takes a typed distance', () => {
        start(sketch({ a: [0, 0], b: [10, 6], c: [20, 2], d: [30, 8] }, [{ id: 'k', kind: 'spline', points: ['a', 'b', 'c', 'd'] }]));
        setTool('offset');
        setEditOptions({ offsetDistance: 2 });
        sketchClick([20, 2], 0.5);
        expect(state().offsetCurve).toBe('k');
        // Typed distance, on the side of the pointer (below the spline).
        useSketcher.setState({ typed: '2' });
        sketchMove([20, -3], 0.5);
        sketchClick([20, -3], 0.5);
        let g = state().geometry;
        expect(g.offsets).toHaveLength(1);
        expect(g.offsets![0].distances[0]).toBeCloseTo(-2, 12);
        expect(offsetError(g, 'k', g.offsets![0].curves, 2)).toBeLessThan(2e-6);
        // Drag a spline point: the offset follows, exact again when the drag ends.
        setTool('select');
        expect(sketchDown([10, 6], 0.5)).toBe(true);
        sketchMove([11, 9], 0.5);
        sketchMove([12, 10], 0.5);
        sketchUp();
        g = state().geometry;
        expect(pointOf(g, 'b')!.v).toBeCloseTo(10, 6);
        expect(offsetError(g, 'k', g.offsets![0].curves, 2)).toBeLessThan(2e-6);
        // A value typed into the driven distance dimension sets the distance.
        const dim = g.offsets![0].dimensions![0];
        editDimension(dim);
        expect(state().dimDraft?.editing).toBe(dim);
        setDimText('1.25');
        applyDimension();
        g = state().geometry;
        expect(g.offsets![0].distances[0]).toBeCloseTo(-1.25, 12);
        expect(offsetError(g, 'k', g.offsets![0].curves, 1.25)).toBeLessThan(2e-6);
        undoSketch();
        expect(state().geometry.offsets![0].distances[0]).toBeCloseTo(-2, 12);
    });

    it('fillets a line and an ellipse picked one after the other, keeping the picked parts', () => {
        start(sketch({ a: [-40, 5], b: [40, 5], c: [0, 0], m: [30, 0], n: [0, 15] }, [
            { id: 'l', kind: 'line', a: 'a', b: 'b' },
            { id: 'e', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' },
        ]));
        setTool('fillet');
        useSketcher.setState({ filletRadius: 2 });
        sketchClick([-35, 5], 0.5);
        sketchClick([-29.6, -2.4], 0.6);
        const g = state().geometry;
        expect(state().message ?? '').not.toMatch(/not|cannot|too/i);
        expect(curveOf(g, 'e')!.kind).toBe('ellipseArc');
        const line = curveOf(g, 'l') as Extract<SketchCurve, { kind: 'line' }>;
        // The line keeps its left end, the part that was picked.
        expect([line.a, line.b]).toContain('a');
    });
});
