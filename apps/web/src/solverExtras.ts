// PlaneGCS primitives for the relations of paths, belts, arc slots and conics (solver.ts calls these): a driving
// sum of lengths, the member of a path in contact with a follower, a belt's offset from its pulleys, equal sweeps,
// a point on a conic (as a rational quadratic B-spline), and a conic's Rho held by its dimension.

import type { SketchPrimitive } from '@salusoft89/planegcs';
import type { SketchConstraint, SketchCurve, SketchGeometry, SketchPath } from '@jarvis/core';
import { conicAt, conicWeight } from '@jarvis/core/curves';

type Pt = [number, number];
type Base = { id: string; temporary?: boolean };
type Param = { o_id: string; prop: 'radius' | 'start_angle' | 'end_angle' } | number;

const pid = (id: string) => `p:${id}`;
const cid = (id: string) => `c:${id}`;
const ORIGIN = 'p:origin';

const curve = (g: SketchGeometry, id: string): SketchCurve | undefined => g.curves.find((c) => c.id === id);
const at = (g: SketchGeometry, id: string): Pt | null => {
    if (id === 'origin') {
        return [0, 0];
    }
    const p = g.points.find((q) => q.id === id);
    return p ? [p.u, p.v] : null;
};
const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);
const TAU = 2 * Math.PI;
const sweepOf = (c: Pt, s: Pt, e: Pt) => {
    const a = Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]);
    return (((a % TAU) + TAU) % TAU) || TAU;
};

/** A hidden solver unknown (the radius of a circle nothing else uses), set to `value`. */
function unknown(id: string, value: number): { prim: SketchPrimitive; ref: Param } {
    return { prim: { id, type: 'circle', c_id: ORIGIN, radius: value }, ref: { o_id: id, prop: 'radius' } };
}

/** The length of a line or arc as it stands; null for other kinds. */
export function pieceLength(g: SketchGeometry, id: string): number | null {
    const c = curve(g, id);
    if (c?.kind === 'line') {
        const [a, b] = [at(g, c.a), at(g, c.b)];
        return a && b ? dist(a, b) : null;
    }
    if (c?.kind === 'arc') {
        const [m, s, e] = [at(g, c.center), at(g, c.start), at(g, c.end)];
        return m && s && e ? dist(m, s) * sweepOf(m, s, e) : null;
    }
    return null;
}

/**
 * The lines and arcs `curves` add up to `value` long: each piece's length is a hidden unknown tied to it, and running
 * sums of them end at the value. Null when a piece is not a line or arc.
 */
export function lengthSumPrimitives(g: SketchGeometry, curves: string[], value: number, base: Base): SketchPrimitive[] | null {
    const out: SketchPrimitive[] = [];
    let sum: Param | null = null;
    let running = 0;
    for (const [i, id] of curves.entries()) {
        const c = curve(g, id);
        const now = pieceLength(g, id);
        if (!c || now === null) {
            return null;
        }
        const len = unknown(`${base.id}:len${i}`, now);
        out.push(len.prim);
        out.push(c.kind === 'line'
            ? { ...base, id: `${base.id}:l${i}`, type: 'p2p_distance', p1_id: pid(c.a), p2_id: pid(c.b), distance: len.ref }
            : { ...base, id: `${base.id}:l${i}`, type: 'arc_length', a_id: cid(id), dist: len.ref });
        running += now;
        if (!sum) {
            sum = len.ref;
            continue;
        }
        const next = unknown(`${base.id}:sum${i}`, running);
        out.push(next.prim, { ...base, id: `${base.id}:s${i}`, type: 'difference', param1: sum, param2: next.ref, difference: len.ref });
        sum = next.ref;
    }
    if (!sum) {
        return null;
    }
    out.push({ ...base, type: 'equal', param1: sum, param2: value });
    return out;
}

/** Arcs a and b sweep the same angle: each one's end angle less its start angle is one hidden unknown. */
export function equalSweepPrimitives(g: SketchGeometry, c: Extract<SketchConstraint, { kind: 'equalSweep' }>, base: Base): SketchPrimitive[] {
    const [a, b] = [curve(g, c.a), curve(g, c.b)];
    if (a?.kind !== 'arc' || b?.kind !== 'arc') {
        return [];
    }
    const [m, s, e] = [at(g, a.center), at(g, a.start), at(g, a.end)];
    const span = unknown(`${base.id}:span`, m && s && e ? sweepOf(m, s, e) : Math.PI);
    const turn = (id: string, tag: string): SketchPrimitive => ({
        ...base, id: `${base.id}:${tag}`, type: 'difference',
        param1: { o_id: cid(id), prop: 'start_angle' }, param2: { o_id: cid(id), prop: 'end_angle' }, difference: span.ref,
    });
    return [span.prim, turn(c.a, 'a'), turn(c.b, 'b')];
}

/**
 * The parameter of the point of the conic nearest p, on the whole conic: as a relation to an arc holds on its circle,
 * a point on a conic may lie past its ends (a corner kept where a fillet or chamfer cut it off). The solver runs the
 * rational curve on past its ends exactly.
 */
function conicParam(s: Pt, t: Pt, e: Pt, rho: number, p: Pt): number {
    // Out from the middle both ways, on the branch the conic is drawn on (a hyperbola's other branch lies past where
    // the curve's weight sum goes through zero).
    const w = conicWeight(rho);
    const on = (u: number) => (1 - u) * (1 - u) + 2 * w * u * (1 - u) + u * u > 1e-6;
    let best = { u: 0.5, d: Infinity };
    for (const way of [1, -1]) {
        for (let i = 0; i <= 160; i++) {
            const u = 0.5 + (way * i) / 64;
            if (!on(u)) {
                break;
            }
            const d = dist(conicAt(s, t, e, rho, u), p);
            if (d < best.d) {
                best = { u, d };
            }
        }
    }
    // Halvings of the step round the best sample.
    let step = 1 / 64;
    for (let k = 0; k < 48; k++) {
        step /= 2;
        for (const u of [best.u - step, best.u + step].filter(on)) {
            const d = dist(conicAt(s, t, e, rho, u), p);
            if (d < best.d) {
                best = { u, d };
            }
        }
    }
    return best.u;
}

/**
 * A point held on a conic: the conic as the rational quadratic B-spline it is (its ends and top vertex the control
 * points, weights 1, w, 1), the point on it at a hidden parameter. Each such B-spline brings 4 unknowns of its own
 * that nothing uses (see PHANTOM_DOF).
 */
export function conicPointPrimitives(g: SketchGeometry, point: string, conicId: string, base: Base): SketchPrimitive[] {
    const c = curve(g, conicId);
    if (c?.kind !== 'conic' || !(c.rho > 0 && c.rho < 1)) {
        return [];
    }
    const [s, t, e, p] = [at(g, c.start), at(g, c.apex), at(g, c.end), at(g, point)];
    if (!s || !t || !e || !p) {
        return [];
    }
    const spline = `${base.id}:conic`;
    const param = unknown(`${base.id}:t`, conicParam(s, t, e, c.rho, p));
    const w = conicWeight(c.rho);
    return [
        { id: spline, type: 'bspline', pole_ids: [pid(c.start), pid(c.apex), pid(c.end)], weights: [1, w, 1], knots: [0, 1], mult: [3, 3], degree: 2, periodic: false },
        param.prim,
        { ...base, type: 'point_on_bspline', p_id: pid(point), b_id: spline, pointparam: param.ref },
    ];
}

/** Unknowns of each hidden B-spline that no relation uses (its own start and end copies): taken off the freedom count. */
export const PHANTOM_DOF = 4;

/**
 * A free point held on a conic starts the solve on the conic, at its nearest point: the solver's curve parameter
 * would otherwise run off the conic's ends trying to reach a point far away. Locked points stay where they are; the
 * same object when nothing moves.
 */
export function withConicPointsPlaced(g: SketchGeometry): SketchGeometry {
    const locked = new Set(g.constraints.flatMap((k) => (k.kind === 'fix' && !k.suppressed ? [k.point] : [])));
    let to: Map<string, Pt> | null = null;
    for (const k of g.constraints) {
        if (k.kind !== 'pointOnCurve' || k.suppressed || locked.has(k.point)) {
            continue;
        }
        const c = curve(g, k.curve);
        const p = g.points.find((q) => q.id === k.point);
        if (c?.kind !== 'conic' || !p || p.fixed || !(c.rho > 0 && c.rho < 1)) {
            continue;
        }
        const [s, t, e] = [at(g, c.start), at(g, c.apex), at(g, c.end)];
        if (!s || !t || !e) {
            continue;
        }
        const q = conicAt(s, t, e, c.rho, conicParam(s, t, e, c.rho, [p.u, p.v]));
        // Only a point clearly off it: one on it already (to the solver's precision) stays exactly where it is.
        if (dist(q, [p.u, p.v]) > 1e-6) {
            (to ??= new Map()).set(p.id, q);
        }
    }
    const moves = to;
    return moves ? { ...g, points: g.points.map((p) => (moves.has(p.id) ? { ...p, u: moves.get(p.id)![0], v: moves.get(p.id)![1] } : p)) } : g;
}

/** Driving Rho dimensions give their conic its Rho (a value between 0 and 1); the same object when there are none. */
export function withDimensionedRho(g: SketchGeometry): SketchGeometry {
    const rho = new Map<string, number>();
    for (const k of g.constraints) {
        if (k.kind === 'rho' && !k.driven && !k.suppressed && k.value > 0 && k.value < 1) {
            rho.set(k.curve, k.value);
        }
    }
    if (!rho.size || g.curves.every((c) => c.kind !== 'conic' || !rho.has(c.id) || c.rho === rho.get(c.id))) {
        return g;
    }
    return { ...g, curves: g.curves.map((c) => (c.kind === 'conic' && rho.has(c.id) ? { ...c, rho: rho.get(c.id)! } : c)) };
}

// ---- Paths -------------------------------------------------------------------------------------------------

interface Contact {
    member: string;
    /** How far the follower is from touching the member's carrier (its line or circle). */
    gap: number;
    /** How far the carrier's contact point lies beyond the member's ends (0: on the member). */
    outside: number;
    /** A round follower: how far its centre is from the member itself (within its ends); the nearest member bears it. */
    near?: number;
}

/** Where a round (centre, radius) or a line follower would touch a path member, and how well. */
function contact(g: SketchGeometry, member: string, follower: string): Contact | null {
    const m = curve(g, member);
    const f = curve(g, follower);
    if (!m || !f) {
        return null;
    }
    const round = (c: SketchCurve): { c: Pt; r: number } | null => {
        if (c.kind === 'circle') {
            const centre = at(g, c.center);
            return centre ? { c: centre, r: c.radius } : null;
        }
        if (c.kind === 'arc') {
            const [centre, s] = [at(g, c.center), at(g, c.start)];
            return centre && s ? { c: centre, r: dist(centre, s) } : null;
        }
        return null;
    };
    const line = (c: SketchCurve): [Pt, Pt] | null => (c.kind === 'line' ? ([at(g, c.a), at(g, c.b)].every(Boolean) ? [at(g, c.a)!, at(g, c.b)!] : null) : null);
    const foot = (p: Pt, [a, b]: [Pt, Pt]) => {
        const d: Pt = [b[0] - a[0], b[1] - a[1]];
        const l2 = d[0] * d[0] + d[1] * d[1] || 1;
        const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2;
        return { t, p: [a[0] + d[0] * t, a[1] + d[1] * t] as Pt, len: Math.sqrt(l2) };
    };
    // Beyond an arc's ends: the angle outside its sweep, as a length along it.
    const arcOutside = (c: Extract<SketchCurve, { kind: 'arc' }>, q: Pt): number => {
        const [centre, s, e] = [at(g, c.center)!, at(g, c.start)!, at(g, c.end)!];
        const sweep = sweepOf(centre, s, e);
        const a = sweepOf(centre, s, q) % TAU;
        if (a <= sweep + 1e-9) {
            return 0;
        }
        return Math.min(a - sweep, TAU - a) * dist(centre, s);
    };
    const ml = line(m);
    const mr = m.kind === 'arc' ? round(m) : null;
    const fl = line(f);
    const fr = round(f);
    if (ml && fr) {
        const k = foot(fr.c, ml);
        const outside = k.t < 0 ? -k.t * k.len : k.t > 1 ? (k.t - 1) * k.len : 0;
        const t = Math.max(0, Math.min(1, k.t));
        const near = dist(fr.c, [ml[0][0] + (ml[1][0] - ml[0][0]) * t, ml[0][1] + (ml[1][1] - ml[0][1]) * t]);
        return { member, gap: Math.abs(dist(fr.c, k.p) - fr.r), outside, near };
    }
    if (mr && m.kind === 'arc' && fr) {
        const d = dist(mr.c, fr.c);
        const gap = Math.min(Math.abs(d - (mr.r + fr.r)), Math.abs(d - Math.abs(mr.r - fr.r)));
        const u: Pt = d > 1e-12 ? [(fr.c[0] - mr.c[0]) / d, (fr.c[1] - mr.c[1]) / d] : [1, 0];
        // Touching outside, or the follower round the member from inside: the contact is on the line of centres.
        const q: Pt = d > Math.abs(mr.r - fr.r) + 1e-9 || fr.r < mr.r ? [mr.c[0] + u[0] * mr.r, mr.c[1] + u[1] * mr.r] : [mr.c[0] - u[0] * mr.r, mr.c[1] - u[1] * mr.r];
        const [s, e] = [at(g, m.start)!, at(g, m.end)!];
        const towards: Pt = [mr.c[0] + u[0] * mr.r, mr.c[1] + u[1] * mr.r];
        const near = arcOutside(m, towards) === 0 ? Math.abs(d - mr.r) : Math.min(dist(fr.c, s), dist(fr.c, e));
        return { member, gap, outside: arcOutside(m, q), near };
    }
    if (mr && m.kind === 'arc' && fl) {
        const k = foot(mr.c, fl);
        const d = dist(mr.c, k.p);
        const q: Pt = d > 1e-12 ? [mr.c[0] + ((k.p[0] - mr.c[0]) / d) * mr.r, mr.c[1] + ((k.p[1] - mr.c[1]) / d) * mr.r] : k.p;
        return { member, gap: Math.abs(d - mr.r), outside: arcOutside(m, q) };
    }
    if (ml && fl) {
        // Flat on flat: the follower's ends on the member's line, where they overlap.
        const [p, q] = [foot(fl[0], ml), foot(fl[1], ml)];
        const gap = Math.max(dist(fl[0], p.p), dist(fl[1], q.p));
        const lo = Math.min(p.t, q.t);
        const hi = Math.max(p.t, q.t);
        const outside = hi < 0 ? -hi * p.len : lo > 1 ? (lo - 1) * p.len : 0;
        return { member, gap, outside };
    }
    return null;
}

/**
 * The member of the path that holds the follower. A roller (circle or arc) rests on the member nearest its centre,
 * which is the one it bears on where two meet. A flat follower: the one it touches within its ends (the nearest
 * such), else the one whose ends it is nearest. Recomputed on every solve, so the contact moves on as they move.
 */
export function pathTangentMember(g: SketchGeometry, c: Extract<SketchConstraint, { kind: 'pathTangent' }>): string | null {
    const found = c.curves.map((m) => contact(g, m, c.curve)).filter((x): x is Contact => !!x);
    if (!found.length) {
        return null;
    }
    if (found.every((x) => x.near !== undefined)) {
        return found.reduce((best, x) => (x.near! < best.near! - 1e-12 ? x : best)).member;
    }
    const inside = found.filter((x) => x.outside < 1e-6);
    const pool = inside.length ? inside : found;
    return pool.reduce((best, x) => ((inside.length ? x.gap < best.gap : x.outside + x.gap < best.outside + best.gap) ? x : best)).member;
}

/** The relation the chosen member holds: tangent, or collinear for a flat follower on a straight member. */
export function pathTangentHold(g: SketchGeometry, c: Extract<SketchConstraint, { kind: 'pathTangent' }>): SketchConstraint | null {
    const member = pathTangentMember(g, c);
    if (!member) {
        return null;
    }
    const both = curve(g, member)?.kind === 'line' && curve(g, c.curve)?.kind === 'line';
    return both ? { id: c.id, kind: 'collinear', a: member, b: c.curve } : { id: c.id, kind: 'tangent', a: member, b: c.curve };
}

/** Whether every path tangent picks the same member on `after` as on `before` (else the solve goes again). */
export function pathContactsSettled(before: SketchGeometry, after: SketchGeometry): boolean {
    return before.constraints.every((k) => k.kind !== 'pathTangent' || k.suppressed || pathTangentMember(before, k) === pathTangentMember(after, k));
}

/** A belt's own solver ties: each belt arc as far off its pulley as the belt is thick, and a driving belt length. */
export function pathPrimitives(g: SketchGeometry, path: SketchPath): SketchPrimitive[] {
    const belt = path.belt;
    if (!belt) {
        return [];
    }
    const base = { id: `k:${path.id}` };
    const out: SketchPrimitive[] = [];
    for (const [i, pulley] of belt.pulleys.entries()) {
        const p = curve(g, pulley);
        if (p?.kind !== 'circle' && p?.kind !== 'arc') {
            continue;
        }
        const arc = path.curves.map((id) => curve(g, id)).find((c) => c?.kind === 'arc' && c.center === p.center);
        if (!arc) {
            continue;
        }
        out.push({
            ...base, id: `${base.id}:off${i}`, type: 'difference',
            param1: { o_id: cid(pulley), prop: 'radius' }, param2: { o_id: cid(arc.id), prop: 'radius' }, difference: belt.thickness ?? 0,
        });
    }
    if (belt.length !== undefined) {
        out.push(...(lengthSumPrimitives(g, path.curves, belt.length, { id: `${base.id}:length` }) ?? []));
    }
    return out;
}
