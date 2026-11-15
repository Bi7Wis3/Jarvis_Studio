// App sketches as FreeCAD Sketcher geometry and constraints (Python source for the history macro). Sketch (u, v) are
// the FreeCAD sketch's own (x, y): the sketch's placement carries the plane (see freecadMacro.ts).

import type { Sketch, SketchConstraint, SketchCurve, SketchGeometry, SketchProfile } from '@jarvis/core';
import { clampedKnots, conicWeight, ellipseAxes, ellipseSweep, splineBezier, splineSpans, type EllipseAxes } from '@jarvis/core/curves';

type P2 = [number, number];

/** A Python float literal with full precision (never an int, which Sketcher would read as an index). */
export function num(n: number): string {
    if (!Number.isFinite(n)) {
        throw new Error(`cannot write ${n} into the macro`);
    }
    const v = Object.is(n, -0) || Math.abs(n) < 1e-15 ? 0 : n;
    const text = String(v);
    return /[.e]/.test(text) ? text : `${text}.0`;
}

/** A Python string literal. */
export const str = (s: string): string => JSON.stringify(s);

const dist = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const same = (a: P2, b: P2, tol = 1e-6): boolean => dist(a, b) < tol;
const TAU = 2 * Math.PI;

// ---- Profiles as pieces --------------------------------------------------------------------------------------

/** One curve of a profile, in sketch coordinates, run from `from` to `to` where it has ends. */
export type Piece =
    | { kind: 'line'; from: P2; to: P2 }
    | { kind: 'arc'; from: P2; through: P2; to: P2 }
    | { kind: 'circle'; centre: P2; radius: number }
    | { kind: 'ellipse'; e: EllipseAxes }
    | { kind: 'ellipseArc'; from: P2; to: P2; e: EllipseAxes; ccw: boolean }
    | { kind: 'spline'; from: P2; to: P2; through: P2[]; startHandle?: P2; endHandle?: P2; spacing?: number[] }
    | { kind: 'bspline'; from: P2; to: P2; poles: P2[]; degree: number; knots?: number[] }
    | { kind: 'conic'; from: P2; to: P2; apex: P2; rho: number };

function polygonPieces(points: P2[]): Piece[] {
    const pts: P2[] = [];
    for (const p of points) {
        if (!pts.length || !same(pts[pts.length - 1], p)) pts.push(p);
    }
    if (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
    return pts.map((p, i) => ({ kind: 'line', from: p, to: pts[(i + 1) % pts.length] }));
}

/** A profile as pieces, as the kernel builds it (sketch.ts); `open` leaves a path unclosed. */
export function profilePieces(profile: SketchProfile, open = false): Piece[] {
    switch (profile.kind) {
        case 'circle':
            return [{ kind: 'circle', centre: profile.center, radius: profile.radius }];
        case 'ellipse':
            return [{ kind: 'ellipse', e: ellipseAxes(profile.center, profile.major, profile.minor) }];
        case 'rect': {
            const { center: [cx, cy], width: w, height: h } = profile;
            const r = profile.radius ?? 0;
            const [x0, x1, y0, y1] = [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2];
            if (r <= 1e-9) {
                return polygonPieces([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
            }
            const k = r * (1 - Math.SQRT1_2);
            const out: Piece[] = [];
            const line = (from: P2, to: P2): void => {
                if (!same(from, to)) out.push({ kind: 'line', from, to });
            };
            line([x0 + r, y0], [x1 - r, y0]);
            out.push({ kind: 'arc', from: [x1 - r, y0], through: [x1 - k, y0 + k], to: [x1, y0 + r] });
            line([x1, y0 + r], [x1, y1 - r]);
            out.push({ kind: 'arc', from: [x1, y1 - r], through: [x1 - k, y1 - k], to: [x1 - r, y1] });
            line([x1 - r, y1], [x0 + r, y1]);
            out.push({ kind: 'arc', from: [x0 + r, y1], through: [x0 + k, y1 - k], to: [x0, y1 - r] });
            line([x0, y1 - r], [x0, y0 + r]);
            out.push({ kind: 'arc', from: [x0, y0 + r], through: [x0 + k, y0 + k], to: [x0 + r, y0] });
            return out;
        }
        case 'slot': {
            const { from: a, to: b, radius: r } = profile;
            const length = dist(a, b);
            if (length < 1e-9) {
                return [{ kind: 'circle', centre: a, radius: r }];
            }
            const d: P2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
            const p: P2 = [-d[1], d[0]];
            const at = (c: P2, x: P2, s: number): P2 => [c[0] + x[0] * s, c[1] + x[1] * s];
            return [
                { kind: 'line', from: at(a, p, r), to: at(b, p, r) },
                { kind: 'arc', from: at(b, p, r), through: at(b, d, r), to: at(b, p, -r) },
                { kind: 'line', from: at(b, p, -r), to: at(a, p, -r) },
                { kind: 'arc', from: at(a, p, -r), through: at(a, d, -r), to: at(a, p, r) },
            ];
        }
        case 'polygon':
            return polygonPieces(profile.points);
        case 'path': {
            const out: Piece[] = [];
            let current = profile.start;
            for (const s of profile.segments ?? []) {
                if (same(current, s.to) && s.kind !== 'spline') {
                    continue;
                }
                switch (s.kind) {
                    case 'line':
                        out.push({ kind: 'line', from: current, to: s.to });
                        break;
                    case 'arc':
                        out.push({ kind: 'arc', from: current, through: s.through, to: s.to });
                        break;
                    case 'ellipse':
                        out.push({ kind: 'ellipseArc', from: current, to: s.to, e: ellipseAxes(s.center, s.major, s.minor), ccw: s.ccw !== false });
                        break;
                    case 'spline':
                        out.push({ kind: 'spline', from: current, to: s.to, through: s.through ?? [], startHandle: s.startHandle, endHandle: s.endHandle, spacing: s.spacing });
                        break;
                    case 'bspline':
                        out.push({ kind: 'bspline', from: current, to: s.to, poles: s.poles, degree: s.degree, knots: s.knots });
                        break;
                    case 'conic':
                        out.push({ kind: 'conic', from: current, to: s.to, apex: s.apex, rho: s.rho });
                        break;
                }
                current = s.to;
            }
            if (!open && !same(current, profile.start)) {
                out.push({ kind: 'line', from: current, to: profile.start });
            }
            return out;
        }
    }
}

/** Centre and radius of the circle through three points. */
function circleThrough(a: P2, b: P2, c: P2): { centre: P2; radius: number } {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    const sq = (p: P2): number => p[0] * p[0] + p[1] * p[1];
    const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
    const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
    return { centre: [ux, uy], radius: Math.hypot(a[0] - ux, a[1] - uy) };
}

const angleOf = (c: P2, p: P2): number => Math.atan2(p[1] - c[1], p[0] - c[0]);
const norm = (t: number): number => ((t % TAU) + TAU) % TAU;

/** An arc as centre, radius and the counter-clockwise run from a0 to a1; `reversed` when it runs from `to`. */
export function arcOf(p: Extract<Piece, { kind: 'arc' }>): { centre: P2; radius: number; a0: number; a1: number; reversed: boolean } {
    const { centre, radius } = circleThrough(p.from, p.through, p.to);
    const a = angleOf(centre, p.from);
    const sweep = norm(angleOf(centre, p.to) - a);
    if (norm(angleOf(centre, p.through) - a) <= sweep) {
        return { centre, radius, a0: a, a1: a + sweep, reversed: false };
    }
    const b = angleOf(centre, p.to);
    return { centre, radius, a0: b, a1: b + (TAU - sweep), reversed: true };
}

/**
 * Knots and multiplicities of a clamped B-spline of `count` poles: its inner knots when given and usable, else evenly
 * spaced (a Bezier curve at degree count - 1), as the kernel builds it (sketch.ts bsplineEdge).
 */
function clamped(count: number, degree: number, inner?: number[]): { knots: number[]; mults: number[] } {
    const knots: number[] = [];
    const mults: number[] = [];
    for (const k of clampedKnots(count, degree, degree === count - 1 ? undefined : inner)) {
        if (knots.length && Math.abs(k - knots[knots.length - 1]) < 1e-12) mults[mults.length - 1]++;
        else {
            knots.push(k);
            mults.push(1);
        }
    }
    return { knots, mults };
}

const pts = (list: P2[]): string => `[${list.map(([x, y]) => `(${num(x)}, ${num(y)})`).join(', ')}]`;
const list = (xs: number[], f: (n: number) => string = num): string => `[${xs.map(f).join(', ')}]`;

/** FreeCAD geometry for a piece, and which vertex (1 start, 2 end) is the piece's `from` end. */
export function pieceGeometry(p: Piece): { expr: string; fromPos: 1 | 2; toPos: 1 | 2; centre: boolean } {
    switch (p.kind) {
        case 'line':
            return { expr: `line(${num(p.from[0])}, ${num(p.from[1])}, ${num(p.to[0])}, ${num(p.to[1])})`, fromPos: 1, toPos: 2, centre: false };
        case 'arc': {
            const a = arcOf(p);
            return {
                expr: `arc(${num(a.centre[0])}, ${num(a.centre[1])}, ${num(a.radius)}, ${num(a.a0)}, ${num(a.a1)})`,
                fromPos: a.reversed ? 2 : 1, toPos: a.reversed ? 1 : 2, centre: true,
            };
        }
        case 'circle':
            return { expr: `circle(${num(p.centre[0])}, ${num(p.centre[1])}, ${num(p.radius)})`, fromPos: 1, toPos: 2, centre: true };
        case 'ellipse':
            return { expr: `ellipse(${ellipseArgs(p.e)})`, fromPos: 1, toPos: 2, centre: true };
        case 'ellipseArc': {
            const { start, sweep } = ellipseSweep(p.e, p.from, p.to, p.ccw);
            const [a0, a1] = sweep >= 0 ? [start, start + sweep] : [start + sweep, start];
            return {
                expr: `ellipse_arc(${ellipseArgs(p.e)}, ${num(a0)}, ${num(a1)})`,
                fromPos: sweep >= 0 ? 1 : 2, toPos: sweep >= 0 ? 2 : 1, centre: true,
            };
        }
        case 'spline': {
            const closed = same(p.from, p.to);
            const points = [p.from, ...p.through, closed ? p.from : p.to];
            const poles = splineBezier(points, closed, { start: p.startHandle, end: p.endHandle, spacing: p.spacing });
            const pieces = (poles.length - 1) / 3;
            // Knots as the spline's own parameter: chord lengths, times its spacing when it was cut from a longer one.
            const spans = splineSpans(closed ? points.slice(0, -1) : points, closed, p.spacing);
            const knots: number[] = [];
            let t = 0;
            for (let i = 0; i <= pieces; i++) {
                knots.push(t);
                if (i < pieces) t += spans[i];
            }
            const mults = knots.map((_, i) => (i === 0 || i === pieces ? 4 : 3));
            return {
                expr: `bspline(${pts(poles)}, 3, ${list(knots)}, ${list(mults, String)}, simplify=True)`,
                fromPos: 1, toPos: 2, centre: false,
            };
        }
        case 'bspline': {
            const poles = [p.from, ...p.poles, p.to];
            const { knots, mults } = clamped(poles.length, p.degree, p.knots);
            return { expr: `bspline(${pts(poles)}, ${p.degree}, ${list(knots)}, ${list(mults, String)})`, fromPos: 1, toPos: 2, centre: false };
        }
        case 'conic':
            return {
                expr: `bspline(${pts([p.from, p.apex, p.to])}, 2, [0.0, 1.0], [3, 3], weights=${list([1, conicWeight(p.rho), 1])})`,
                fromPos: 1, toPos: 2, centre: false,
            };
    }
}

function ellipseArgs(e: EllipseAxes): string {
    const [c, s] = [Math.cos(e.angle), Math.sin(e.angle)];
    const major: P2 = [e.center[0] + e.a * c, e.center[1] + e.a * s];
    const minor: P2 = [e.center[0] - e.b * s, e.center[1] + e.b * c];
    return [e.center[0], e.center[1], major[0], major[1], minor[0], minor[1]].map(num).join(', ');
}

// ---- Sketches ------------------------------------------------------------------------------------------------

/** A sketch ready to write: geometry, constraints (Python tuples) and the geometry ids of each piece kind. */
export interface FcSketch {
    geometry: { expr: string; construction: boolean }[];
    constraints: string[];
    /** Geometry whose internal geometry (control points) FreeCAD should show. */
    expose: number[];
    /** The piece each geometry id draws (for picking profile loops), null for points. */
    pieces: (Piece | null)[];
    /** What of the app sketch could not be carried over. */
    notes: string[];
}

/** A sketch of closed profiles only, joined end to end (sketches written as profiles, and copies of picked regions). */
export function sketchOfProfiles(profiles: SketchProfile[], open: SketchProfile[] = []): FcSketch {
    const out: FcSketch = { geometry: [], constraints: [], expose: [], pieces: [], notes: [] };
    const addLoop = (profile: SketchProfile, isOpen: boolean): void => {
        const ps = profilePieces(profile, isOpen);
        const first = out.geometry.length;
        ps.forEach((p, i) => {
            const g = pieceGeometry(p);
            out.geometry.push({ expr: g.expr, construction: false });
            out.pieces.push(p);
            if (i > 0) {
                const prev = pieceGeometry(ps[i - 1]);
                out.constraints.push(`('Coincident', ${first + i - 1}, ${prev.toPos}, ${first + i}, ${g.fromPos})`);
            }
        });
        const closedRun = !isOpen && ps.length > 1 && 'from' in ps[0];
        if (closedRun) {
            const last = pieceGeometry(ps[ps.length - 1]);
            const head = pieceGeometry(ps[0]);
            out.constraints.push(`('Coincident', ${first + ps.length - 1}, ${last.toPos}, ${first}, ${head.fromPos})`);
        }
    };
    profiles.forEach((p) => addLoop(p, false));
    open.forEach((p) => addLoop(p, true));
    return out;
}

interface Ref {
    /** Geometry id, as a Python expression. */
    g: string;
    pos: number;
}

const dimensionKinds = new Set(['distance', 'length', 'angle', 'radius', 'diameter', 'arcLength', 'pointAngle', 'pathLength']);

/**
 * A constrained sketch: the app's curves and points as FreeCAD geometry, shared points joined by coincidences, and
 * the relations and dimensions FreeCAD has (dimensions named D1, D2... in order, as SolidWorks names them).
 */
export function sketchOfGeometry(g: SketchGeometry): FcSketch {
    const out: FcSketch = { geometry: [], constraints: [], expose: [], pieces: [], notes: [] };
    const point = new Map(g.points.map((p) => [p.id, [p.u, p.v] as P2]));
    point.set('origin', [0, 0]);
    const P = (id: string): P2 => {
        const p = point.get(id);
        if (!p) throw new Error(`sketch point "${id}" is missing`);
        return p;
    };
    const curveGeo = new Map<string, number>();
    const curveOf = new Map(g.curves.map((c) => [c.id, c]));
    /** Every place a point appears in FreeCAD: its first entry is the point itself, the others are joined to it. */
    const refs = new Map<string, Ref[]>();
    const addRef = (id: string, ref: Ref): void => {
        if (id === 'origin') {
            refs.set('origin', [{ g: '-1', pos: 1 }, ...(refs.get('origin') ?? []).filter((r) => r.g !== '-1'), ref]);
            return;
        }
        refs.set(id, [...(refs.get(id) ?? []), ref]);
    };
    refs.set('origin', [{ g: '-1', pos: 1 }]);
    /** Points a curve passes through without a vertex there (spline through points): kept on it. */
    const onCurve: [string, number][] = [];
    const push = (c: SketchCurve, piece: Piece | null, expr: string): number => {
        const id = out.geometry.length;
        out.geometry.push({ expr, construction: !!c.construction });
        out.pieces.push(piece);
        curveGeo.set(c.id, id);
        return id;
    };
    for (const c of g.curves) {
        switch (c.kind) {
            case 'line': {
                const piece: Piece = { kind: 'line', from: P(c.a), to: P(c.b) };
                const id = push(c, piece, pieceGeometry(piece).expr);
                addRef(c.a, { g: String(id), pos: 1 });
                addRef(c.b, { g: String(id), pos: 2 });
                break;
            }
            case 'circle': {
                const piece: Piece = { kind: 'circle', centre: P(c.center), radius: c.radius };
                const id = push(c, piece, pieceGeometry(piece).expr);
                addRef(c.center, { g: String(id), pos: 3 });
                break;
            }
            case 'arc': {
                const centre = P(c.center);
                const [s, e] = [P(c.start), P(c.end)];
                const r = dist(centre, s);
                const a0 = angleOf(centre, s);
                let a1 = angleOf(centre, e);
                if (a1 <= a0 + 1e-12) a1 += TAU;
                const mid = (a0 + a1) / 2;
                const piece: Piece = { kind: 'arc', from: s, through: [centre[0] + r * Math.cos(mid), centre[1] + r * Math.sin(mid)], to: e };
                const id = push(c, piece, `arc(${num(centre[0])}, ${num(centre[1])}, ${num(r)}, ${num(a0)}, ${num(a1)})`);
                addRef(c.start, { g: String(id), pos: 1 });
                addRef(c.end, { g: String(id), pos: 2 });
                addRef(c.center, { g: String(id), pos: 3 });
                break;
            }
            case 'ellipse':
            case 'ellipseArc': {
                const centre = P(c.center);
                const e = ellipseAxes(centre, P(c.major), dist(centre, P(c.minor)));
                const piece: Piece = c.kind === 'ellipse' ? { kind: 'ellipse', e }
                    : { kind: 'ellipseArc', from: P(c.start), to: P(c.end), e, ccw: true };
                const fc = pieceGeometry(piece);
                const id = push(c, piece, fc.expr);
                addRef(c.center, { g: String(id), pos: 3 });
                if (c.kind === 'ellipseArc') {
                    addRef(c.start, { g: String(id), pos: fc.fromPos });
                    addRef(c.end, { g: String(id), pos: fc.toPos });
                }
                // The axis ends are FreeCAD internal geometry: relations to them are left out (see notes).
                break;
            }
            case 'spline': {
                const ids = c.points;
                const closed = ids.length > 2 && ids[0] === ids[ids.length - 1];
                const coords = ids.map(P);
                const piece: Piece = {
                    kind: 'spline', from: coords[0], to: coords[coords.length - 1], through: coords.slice(1, -1),
                    startHandle: c.startHandle ? P(c.startHandle) : undefined, endHandle: c.endHandle ? P(c.endHandle) : undefined,
                    spacing: c.spacing,
                };
                const id = push(c, piece, pieceGeometry(piece).expr);
                addRef(ids[0], { g: String(id), pos: 1 });
                addRef(ids[ids.length - 1], { g: String(id), pos: closed ? 1 : 2 });
                if (closed) {
                    out.constraints.push(`('Coincident', ${id}, 1, ${id}, 2)`);
                }
                ids.slice(1, -1).forEach((pid) => onCurve.push([pid, id]));
                break;
            }
            case 'styleSpline': {
                const coords = c.points.map(P);
                const degree = c.degree ?? coords.length - 1;
                const piece: Piece = { kind: 'bspline', from: coords[0], to: coords[coords.length - 1], poles: coords.slice(1, -1), degree, knots: c.knots };
                const id = push(c, piece, pieceGeometry(piece).expr);
                out.expose.push(id);
                c.points.forEach((pid, i) => {
                    if (i === 0) addRef(pid, { g: String(id), pos: 1 });
                    else if (i === c.points.length - 1) addRef(pid, { g: String(id), pos: 2 });
                    else addRef(pid, { g: `pole(sk, ${num(coords[i][0])}, ${num(coords[i][1])})`, pos: 3 });
                });
                break;
            }
            case 'parabola': {
                const [f, v, s, e] = [P(c.focus), P(c.vertex), P(c.start), P(c.end)];
                const focal = dist(f, v);
                const axis: P2 = [(f[0] - v[0]) / focal, (f[1] - v[1]) / focal];
                const across: P2 = [-axis[1], axis[0]];
                const u = (p: P2): number => (p[0] - v[0]) * across[0] + (p[1] - v[1]) * across[1];
                const [us, ue] = [u(s), u(e)];
                const k = (us * ue) / (4 * focal);
                const m = (us + ue) / 2;
                const piece: Piece = { kind: 'conic', from: s, to: e, apex: [v[0] + across[0] * m + axis[0] * k, v[1] + across[1] * m + axis[1] * k], rho: 0.5 };
                const [u0, u1] = us <= ue ? [us, ue] : [ue, us];
                const id = push(c, piece, `parabola_arc(${[v[0], v[1], axis[0], axis[1], focal, u0, u1].map(num).join(', ')})`);
                addRef(c.start, { g: String(id), pos: us <= ue ? 1 : 2 });
                addRef(c.end, { g: String(id), pos: us <= ue ? 2 : 1 });
                addRef(c.vertex, { g: String(id), pos: 3 });
                break;
            }
            case 'conic': {
                const piece: Piece = { kind: 'conic', from: P(c.start), to: P(c.end), apex: P(c.apex), rho: c.rho };
                const id = push(c, piece, pieceGeometry(piece).expr);
                out.expose.push(id);
                addRef(c.start, { g: String(id), pos: 1 });
                addRef(c.end, { g: String(id), pos: 2 });
                addRef(c.apex, { g: `pole(sk, ${num(P(c.apex)[0])}, ${num(P(c.apex)[1])})`, pos: 3 });
                break;
            }
        }
    }
    // Points on no curve are sketch points of their own; through points of splines are held on them.
    for (const p of g.points) {
        if (p.id === 'origin' || refs.has(p.id)) continue;
        const id = out.geometry.length;
        out.geometry.push({ expr: `point(${num(p.u)}, ${num(p.v)})`, construction: false });
        out.pieces.push(null);
        addRef(p.id, { g: String(id), pos: 1 });
    }
    for (const [pid, curve] of onCurve) {
        const own = refs.get(pid)?.[0];
        if (own) out.constraints.push(`('PointOnObject', ${own.g}, ${own.pos}, ${curve})`);
    }

    const ref = (id: string): Ref | null => refs.get(id)?.[0] ?? null;
    const geoOf = (id: string): string | null => (id === 'axis-u' ? '-1' : id === 'axis-v' ? '-2' : curveGeo.has(id) ? String(curveGeo.get(id)) : null);
    const isPoint = (id: string): boolean => refs.has(id);
    const kindOf = (id: string): string | undefined => (id === 'axis-u' || id === 'axis-v' ? 'line' : curveOf.get(id)?.kind);
    const lineEnds = (id: string): [string, string] | null => {
        const c = curveOf.get(id);
        return c?.kind === 'line' ? [c.a, c.b] : null;
    };
    /** Joins already made between two refs of one point (endpoint tangency joins them too). */
    const joined: [Ref, Ref][] = [];
    const sameRef = (a: Ref, b: Ref): boolean => a.g === b.g && a.pos === b.pos;
    const relations: string[] = [];
    let dimension = 0;
    const skipped: string[] = [];
    const skip = (c: SketchConstraint, why: string): void => {
        skipped.push(`${c.kind} ${c.id} (${why})`);
    };
    const endOf = (curve: string, pid: string): Ref | null => {
        const c = curveOf.get(curve);
        const id = curveGeo.get(curve);
        if (!c || id === undefined) return null;
        if (c.kind === 'line') return pid === c.a ? { g: String(id), pos: 1 } : pid === c.b ? { g: String(id), pos: 2 } : null;
        if (c.kind === 'arc') return pid === c.start ? { g: String(id), pos: 1 } : pid === c.end ? { g: String(id), pos: 2 } : null;
        const own = (refs.get(pid) ?? []).find((r) => r.g === String(id) && (r.pos === 1 || r.pos === 2));
        return own ?? null;
    };
    const sharedEnd = (a: string, b: string): string | null => {
        const ends = (id: string): string[] => {
            const c = curveOf.get(id);
            if (!c) return [];
            if (c.kind === 'line') return [c.a, c.b];
            if (c.kind === 'arc' || c.kind === 'ellipseArc' || c.kind === 'parabola' || c.kind === 'conic') return [c.start, c.end];
            if (c.kind === 'spline' || c.kind === 'styleSpline') return [c.points[0], c.points[c.points.length - 1]];
            return [];
        };
        return ends(a).find((p) => ends(b).includes(p)) ?? null;
    };

    for (const c of g.constraints) {
        const opts: string[] = [];
        if ('driven' in c && c.driven) opts.push(`'driving': False`);
        if (c.suppressed) opts.push(`'active': False`);
        if (dimensionKinds.has(c.kind)) {
            dimension += 1;
            opts.push(`'name': 'D${dimension}'`);
        }
        const tail = opts.length ? `, {${opts.join(', ')}}` : '';
        const r = (id: string): string => {
            const x = ref(id);
            if (!x) throw new Error(`point ${id}`);
            return `${x.g}, ${x.pos}`;
        };
        const geo = (id: string): string => {
            const x = geoOf(id);
            if (x === null) throw new Error(`curve ${id}`);
            return x;
        };
        try {
            switch (c.kind) {
                case 'coincident':
                    relations.push(`('Coincident', ${r(c.a)}, ${r(c.b)}${tail})`);
                    break;
                case 'horizontal':
                case 'vertical':
                    relations.push(`('${c.kind === 'horizontal' ? 'Horizontal' : 'Vertical'}', ${geo(c.line)}${tail})`);
                    break;
                case 'horizontalPoints':
                case 'verticalPoints':
                    relations.push(`('${c.kind === 'horizontalPoints' ? 'Horizontal' : 'Vertical'}', ${r(c.a)}, ${r(c.b)}${tail})`);
                    break;
                case 'parallel':
                case 'perpendicular':
                    relations.push(`('${c.kind === 'parallel' ? 'Parallel' : 'Perpendicular'}', ${geo(c.a)}, ${geo(c.b)}${tail})`);
                    break;
                case 'equal':
                    relations.push(`('Equal', ${geo(c.a)}, ${geo(c.b)}${tail})`);
                    break;
                case 'collinear':
                    // FreeCAD calls two lines on one line tangent.
                    relations.push(`('Tangent', ${geo(c.a)}, ${geo(c.b)}${tail})`);
                    break;
                case 'tangent': {
                    const shared = sharedEnd(c.a, c.b);
                    const [ea, eb] = shared ? [endOf(c.a, shared), endOf(c.b, shared)] : [null, null];
                    if (ea && eb) {
                        relations.push(`('Tangent', ${ea.g}, ${ea.pos}, ${eb.g}, ${eb.pos}${tail})`);
                        joined.push([ea, eb]);
                    } else {
                        relations.push(`('Tangent', ${geo(c.a)}, ${geo(c.b)}${tail})`);
                    }
                    break;
                }
                case 'concentric':
                case 'coradial': {
                    const centre = (id: string): string => (isPoint(id) ? r(id) : `${geo(id)}, 3`);
                    relations.push(`('Coincident', ${centre(c.a)}, ${centre(c.b)}${tail})`);
                    if (c.kind === 'coradial') relations.push(`('Equal', ${geo(c.a)}, ${geo(c.b)}${tail})`);
                    break;
                }
                case 'pointOnCurve':
                    relations.push(`('PointOnObject', ${r(c.point)}, ${geo(c.curve)}${tail})`);
                    break;
                case 'midpoint': {
                    const line = geo(c.line);
                    relations.push(`('Symmetric', ${line}, 1, ${line}, 2, ${r(c.point)}${tail})`);
                    break;
                }
                case 'intersection':
                    relations.push(`('PointOnObject', ${r(c.point)}, ${geo(c.a)}${tail})`, `('PointOnObject', ${r(c.point)}, ${geo(c.b)}${tail})`);
                    break;
                case 'symmetric': {
                    if (c.part) {
                        skip(c, 'half of a symmetric relation');
                        break;
                    }
                    if (isPoint(c.a) && isPoint(c.b)) {
                        relations.push(`('Symmetric', ${r(c.a)}, ${r(c.b)}, ${geo(c.about)}${tail})`);
                        break;
                    }
                    const [la, lb, axis] = [lineEnds(c.a), lineEnds(c.b), lineEnds(c.about)];
                    if (la && lb && axis) {
                        // Pair each end of a with the end of b that is its mirror image.
                        const [p, q] = [P(axis[0]), P(axis[1])];
                        const d = dist(p, q);
                        const mirror = (x: P2): P2 => {
                            const t = ((x[0] - p[0]) * (q[0] - p[0]) + (x[1] - p[1]) * (q[1] - p[1])) / (d * d);
                            const f: P2 = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
                            return [2 * f[0] - x[0], 2 * f[1] - x[1]];
                        };
                        const [b0, b1] = [P(lb[0]), P(lb[1])];
                        const m0 = mirror(P(la[0]));
                        const pairs: [string, string][] = dist(m0, b0) <= dist(m0, b1) ? [[la[0], lb[0]], [la[1], lb[1]]] : [[la[0], lb[1]], [la[1], lb[0]]];
                        for (const [x, y] of pairs) relations.push(`('Symmetric', ${r(x)}, ${r(y)}, ${geo(c.about)}${tail})`);
                        break;
                    }
                    skip(c, 'symmetric curves other than lines');
                    break;
                }
                case 'fix': {
                    if (c.point === 'origin') break;
                    const at = P(c.point);
                    if (c.axis !== 'v') relations.push(`('DistanceX', ${r(c.point)}, ${num(at[0])})`);
                    if (c.axis !== 'u') relations.push(`('DistanceY', ${r(c.point)}, ${num(at[1])})`);
                    break;
                }
                case 'fixRadius': {
                    const curve = curveOf.get(c.curve);
                    const radius = curve?.kind === 'circle' ? curve.radius : curve?.kind === 'arc' ? dist(P(curve.center), P(curve.start)) : null;
                    if (radius === null) {
                        skip(c, 'not a circle or arc');
                        break;
                    }
                    relations.push(`('Radius', ${geo(c.curve)}, ${num(radius)})`);
                    break;
                }
                case 'distance': {
                    if (c.aMid || c.bMid || c.aCond || c.bCond) {
                        skip(c, 'measured from a line midpoint or an arc condition');
                        break;
                    }
                    if (!isPoint(c.a)) {
                        skip(c, 'the first end is not a point');
                        break;
                    }
                    const value = c.doubled ? c.value / 2 : c.value;
                    if (c.doubled) {
                        skipped.push(`${c.kind} ${c.id} (a diameter dimension to a centreline: FreeCAD holds half of it, ${num(value)} mm, as the distance)`);
                    }
                    if (!isPoint(c.b)) {
                        if (c.b === 'axis-u' || c.b === 'axis-v') {
                            const at = P(c.a);
                            const kind = c.b === 'axis-u' ? 'DistanceY' : 'DistanceX';
                            const signed = (c.b === 'axis-u' ? at[1] : at[0]) < 0 ? -value : value;
                            relations.push(`('${kind}', ${r(c.a)}, ${num(signed)}${tail})`);
                        } else {
                            relations.push(`('Distance', ${r(c.a)}, ${geo(c.b)}, ${num(value)}${tail})`);
                        }
                        break;
                    }
                    if (c.axis) {
                        const [a, b] = [P(c.a), P(c.b)];
                        const now = c.axis === 'u' ? b[0] - a[0] : b[1] - a[1];
                        const kind = c.axis === 'u' ? 'DistanceX' : 'DistanceY';
                        const [x, y] = now < 0 ? [c.b, c.a] : [c.a, c.b];
                        relations.push(`('${kind}', ${r(x)}, ${r(y)}, ${num(value)}${tail})`);
                        break;
                    }
                    relations.push(`('Distance', ${r(c.a)}, ${r(c.b)}, ${num(value)}${tail})`);
                    break;
                }
                case 'length':
                    relations.push(`('Distance', ${geo(c.line)}, ${num(c.value)}${tail})`);
                    break;
                case 'angle': {
                    const dir = (id: string): number | null => {
                        if (id === 'axis-u') return 0;
                        if (id === 'axis-v') return Math.PI / 2;
                        const ends = lineEnds(id);
                        if (!ends) return null;
                        const [a, b] = [P(ends[0]), P(ends[1])];
                        return Math.atan2(b[1] - a[1], b[0] - a[0]);
                    };
                    const [da, db] = [dir(c.a), dir(c.b)];
                    if (da === null || db === null) {
                        skip(c, 'not between two lines');
                        break;
                    }
                    const wrap = (t: number): number => Math.atan2(Math.sin(t), Math.cos(t));
                    const value = (c.value * Math.PI) / 180;
                    const now = wrap(db - da);
                    let target: number;
                    if (c.reverseA !== undefined || c.reverseB !== undefined) {
                        const shift = (c.reverseA ? Math.PI : 0) - (c.reverseB ? Math.PI : 0);
                        target = wrap((wrap(db - da - shift) < 0 ? -value : value) + shift);
                    } else {
                        const candidates = [value, -value, Math.PI - value, value - Math.PI];
                        target = candidates.reduce((best, t) => (Math.abs(wrap(t - now)) < Math.abs(wrap(best - now)) ? t : best));
                    }
                    const [x, y, t] = target < 0 ? [c.b, c.a, -target] : [c.a, c.b, target];
                    relations.push(`('Angle', ${geo(x)}, ${geo(y)}, ${num(t)}${tail})`);
                    break;
                }
                case 'radius':
                case 'diameter': {
                    const kind = kindOf(c.curve);
                    if (kind !== 'circle' && kind !== 'arc') {
                        skip(c, `a ${c.kind} of a ${kind}`);
                        break;
                    }
                    relations.push(`('${c.kind === 'radius' ? 'Radius' : 'Diameter'}', ${geo(c.curve)}, ${num(c.value)}${tail})`);
                    break;
                }
                case 'arcLength':
                case 'pointAngle':
                case 'pathLength':
                    skip(c, 'FreeCAD has no such dimension');
                    break;
            }
        } catch (e) {
            skip(c, `refers to ${e instanceof Error ? e.message : String(e)} that is not in the sketch`);
        }
    }
    // Shared points: every further place a point appears joins its first one (unless a tangency joins them already).
    const coincidences: string[] = [];
    for (const [, list] of refs) {
        const [own, ...others] = list;
        for (const other of others) {
            if (joined.some(([a, b]) => (sameRef(a, other) && (sameRef(b, own) || others.some((o) => sameRef(b, o))))
                || (sameRef(b, other) && (sameRef(a, own) || others.some((o) => sameRef(a, o)))))) {
                continue;
            }
            coincidences.push(`('Coincident', ${own.g}, ${own.pos}, ${other.g}, ${other.pos})`);
        }
    }
    // Fixed points (generated items: text, blocks, equation curves) block their whole curve.
    const fixed = new Set(g.points.filter((p) => p.fixed && p.id !== 'origin').map((p) => p.id));
    const blocks: string[] = [];
    if (fixed.size) {
        for (const c of g.curves) {
            const ids = curvePoints(c);
            if (ids.length && ids.every((id) => fixed.has(id))) {
                blocks.push(`('Block', ${curveGeo.get(c.id)})`);
            }
        }
    }
    out.constraints.push(...coincidences, ...blocks, ...relations);
    if (skipped.length) {
        out.notes.push(`left out: ${skipped.join('; ')}`);
    }
    if (g.pictures?.length) {
        out.notes.push('its pictures are left out (FreeCAD sketches have none)');
    }
    if (g.curves.some((c) => (c.kind === 'ellipse' || c.kind === 'ellipseArc'))
        && g.constraints.some((k) => g.curves.some((c) => (c.kind === 'ellipse' || c.kind === 'ellipseArc') && JSON.stringify(k).includes(`"${c.major}"`)))) {
        out.notes.push('relations to the ends of ellipse axes are left out');
    }
    return out;
}

function curvePoints(c: SketchCurve): string[] {
    switch (c.kind) {
        case 'line': return [c.a, c.b];
        case 'circle': return [c.center];
        case 'arc': return [c.center, c.start, c.end];
        case 'ellipse': return [c.center, c.major, c.minor];
        case 'ellipseArc': return [c.center, c.major, c.minor, c.start, c.end];
        case 'spline': return c.points;
        case 'styleSpline': return c.points;
        case 'parabola': return [c.focus, c.vertex, c.start, c.end];
        case 'conic': return [c.start, c.end, c.apex];
    }
}

// ---- Which geometry a profile uses -----------------------------------------------------------------------------

function endsOf(p: Piece): [P2, P2] | null {
    return 'from' in p ? [p.from, p.to] : null;
}

/** True when two pieces draw the same curve (in either direction). */
function samePiece(a: Piece, b: Piece): boolean {
    const tol = 1e-6;
    if (a.kind === 'circle' || b.kind === 'circle') {
        return a.kind === 'circle' && b.kind === 'circle' && same(a.centre, b.centre, tol) && Math.abs(a.radius - b.radius) < tol;
    }
    if (a.kind === 'ellipse' || b.kind === 'ellipse') {
        return a.kind === 'ellipse' && b.kind === 'ellipse' && same(a.e.center, b.e.center, tol)
            && Math.abs(a.e.a - b.e.a) < tol && Math.abs(a.e.b - b.e.b) < tol;
    }
    const [ea, eb] = [endsOf(a), endsOf(b)];
    if (!ea || !eb) return false;
    const forward = same(ea[0], eb[0], tol) && same(ea[1], eb[1], tol);
    const backward = same(ea[0], eb[1], tol) && same(ea[1], eb[0], tol);
    if (!forward && !backward) return false;
    if (a.kind === 'line' || b.kind === 'line') return a.kind === b.kind;
    if (a.kind === 'arc' && b.kind === 'arc') {
        return same(arcOf(a).centre, arcOf(b).centre, 1e-5) && sameSide(a, b);
    }
    if (a.kind === 'ellipseArc' && b.kind === 'ellipseArc') {
        return same(a.e.center, b.e.center, tol) && Math.abs(a.e.a - b.e.a) < tol;
    }
    // Splines, style splines and conics: their own kind between the same ends.
    const family = (p: Piece): string => (p.kind === 'conic' ? 'conic' : p.kind);
    return family(a) === family(b);
}

/** Two arcs between the same ends on one circle are the same arc when their middles are on the same side. */
function sameSide(a: Extract<Piece, { kind: 'arc' }>, b: Extract<Piece, { kind: 'arc' }>): boolean {
    const mid = (p: Extract<Piece, { kind: 'arc' }>): P2 => {
        const arc = arcOf(p);
        const t = (arc.a0 + arc.a1) / 2;
        return [arc.centre[0] + arc.radius * Math.cos(t), arc.centre[1] + arc.radius * Math.sin(t)];
    };
    return same(mid(a), mid(b), 1e-4 * Math.max(1, arcOf(a).radius));
}

/**
 * The geometry ids that draw these profiles, or null when a profile uses part of a curve (curves that cross are
 * split into regions by the app, which FreeCAD cannot select).
 */
export function geometryOfProfiles(sketch: FcSketch, profiles: SketchProfile[], open = false): number[] | null {
    const ids: number[] = [];
    for (const profile of profiles) {
        for (const piece of profilePieces(profile, open)) {
            const id = sketch.pieces.findIndex((p, i) => p !== null && !sketch.geometry[i].construction && samePiece(p, piece));
            if (id < 0) {
                return null;
            }
            if (!ids.includes(id)) ids.push(id);
        }
    }
    return ids;
}

/** The FreeCAD sketch of an app sketch: its constrained geometry when it has one, else its profiles. */
export function fcSketch(sketch: Sketch): FcSketch {
    return sketch.geometry ? sketchOfGeometry(sketch.geometry) : sketchOfProfiles(sketch.profiles, sketch.open ?? []);
}

/**
 * The direction OpenCascade starts a circle at when it is given only its normal (gp_Ax2's automatic X direction):
 * the kernel builds sketch circles that way, and lofts join sections at their start points.
 */
export function circleStart(normal: [number, number, number]): [number, number, number] {
    const l = Math.hypot(...normal);
    const [A, B, C] = normal.map((x) => x / l);
    const [a, b, c] = [Math.abs(A), Math.abs(B), Math.abs(C)];
    let d: [number, number, number];
    if (b <= a && b <= c) d = a > c ? [-C, 0, A] : [C, 0, -A];
    else if (a <= b && a <= c) d = b > c ? [0, -C, B] : [0, C, -B];
    else d = a > b ? [-B, A, 0] : [B, -A, 0];
    const k = Math.hypot(...d);
    return [d[0] / k, d[1] / k, d[2] / k];
}

/** The sketch's geometry with every full circle starting where the kernel starts it (u, v: the plane's axes). */
export function seamedGeometry(sketch: FcSketch, u: [number, number, number], v: [number, number, number],
    normal: [number, number, number]): { expr: string; construction: boolean }[] {
    const x = circleStart(normal);
    const seam = Math.atan2(x[0] * v[0] + x[1] * v[1] + x[2] * v[2], x[0] * u[0] + x[1] * u[1] + x[2] * u[2]);
    return sketch.geometry.map((g, i) => {
        const p = sketch.pieces[i];
        return p?.kind === 'circle' ? { ...g, expr: g.expr.replace(/\)$/, `, seam=${num(seam)})`) } : g;
    });
}

/** Geometry ids that are not construction and not points: what a whole-sketch feature uses. */
export function profileGeometry(sketch: FcSketch): number[] {
    return sketch.geometry.flatMap((g, i) => (!g.construction && sketch.pieces[i] ? [i] : []));
}
