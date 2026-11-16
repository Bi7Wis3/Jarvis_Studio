// A SolidWorks sketch as a studio sketch: its plane, its points and curves as the sketcher's geometry (ids kept), its
// relations and dimensions as constraints (each checked against the geometry first, so a sketch opened in the
// sketcher solves to what SolidWorks had), and the profiles, regions and open chains the kernel builds from.

import type { CustomSketchPlane, Sketch, SketchConstraint, SketchCurve, SketchGeometry, SketchPlaneName, SketchPoint, SketchProfile, Vec3 } from '@jarvis/core';
import { bsplineAt } from '@jarvis/core/curves';
import type { SwRelation, SwSegment, SwSketch } from './format.js';
import { findLoops, profileOf, loopStart, regionsOf, type P2, type Piece, type SketchLoops } from './loops.js';
import { apply, clean, cross, dot, frameOf, invert, MM, norm, rigidOf, sub, unit, type Convention, type Rigid } from './math.js';

export interface SketchFrame3 {
    origin: Vec3;
    x: Vec3;
    y: Vec3;
    normal: Vec3;
}

export interface MappedSketch {
    sketch: Sketch;
    frame: SketchFrame3;
    /** The sketch's closed loops (for selected contours) and its curves as loop pieces by curve id. */
    loops: SketchLoops;
    /** Sketch (u, v) mm to the part frame and back. */
    to3d: (p: P2) => Vec3;
    to2d: (p: Vec3) => P2;
    /** Point coordinates (u, v) by id, after mapping. */
    points: Map<string, P2>;
    curves: Map<string, SketchCurve>;
    notes: string[];
}

const NAMED: Record<SketchPlaneName, { x: Vec3; y: Vec3; normal: Vec3 }> = {
    front: { x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
    top: { x: [1, 0, 0], y: [0, 0, -1], normal: [0, 1, 0] },
    right: { x: [0, 0, -1], y: [0, 1, 0], normal: [1, 0, 0] },
};

const same = (a: Vec3, b: Vec3, tol = 1e-9): boolean => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol;

/** A named plane (with its offset) when the frame is one, else the plane by value. */
export function planeOfFrame(frame: SketchFrame3): { plane: Sketch['plane']; offset?: number } {
    for (const [name, axes] of Object.entries(NAMED) as [SketchPlaneName, typeof NAMED.front][]) {
        if (same(frame.x, axes.x) && same(frame.y, axes.y) && same(frame.normal, axes.normal)) {
            const along = dot(frame.origin, axes.normal);
            const off: Vec3 = [frame.origin[0] - axes.normal[0] * along, frame.origin[1] - axes.normal[1] * along, frame.origin[2] - axes.normal[2] * along];
            if (norm(off) < 1e-9) {
                return Math.abs(along) < 1e-9 ? { plane: name } : { plane: name, offset: clean(along) };
            }
        }
    }
    const plane: CustomSketchPlane = { origin: frame.origin.map(clean) as Vec3, normal: frame.normal.map(clean) as Vec3, xDir: frame.x.map(clean) as Vec3 };
    return { plane };
}

/** The sketch-to-part frame from ModelToSketchTransform (inverted), in mm. */
export function sketchFrameOf(toSketch: readonly number[] | null | undefined, convention: Convention): { frame: SketchFrame3; toModel: Rigid; toSketch: Rigid } | null {
    const m2s = rigidOf(toSketch, convention);
    if (!m2s) {
        return null;
    }
    const toModel = invert(m2s);
    const f = frameOf(toModel);
    const x = unit(f.x);
    const normal = unit(f.z);
    // A right-handed frame: v = normal x u, as the studio's planes are.
    const y = cross(normal, x);
    return { frame: { origin: f.origin, x, y, normal }, toModel, toSketch: m2s };
}

// ---- Curves ---------------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
const angleOf = (c: P2, p: P2): number => Math.atan2(p[1] - c[1], p[0] - c[0]);
const ccwSweep = (c: P2, s: P2, e: P2): number => {
    let d = angleOf(c, e) - angleOf(c, s);
    while (d <= 1e-12) d += TAU;
    return d;
};
const dist2 = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function arcSamples(c: P2, s: P2, sweep: number): P2[] {
    const r = dist2(c, s);
    const a0 = angleOf(c, s);
    const n = Math.max(8, Math.ceil((sweep / TAU) * 96));
    return Array.from({ length: n + 1 }, (_, i) => [c[0] + r * Math.cos(a0 + (sweep * i) / n), c[1] + r * Math.sin(a0 + (sweep * i) / n)] as P2);
}

interface EllipseShape {
    c: P2;
    a: number;
    b: number;
    /** Angle of the axis through `major`. */
    rot: number;
}

const ellipseOf = (c: P2, major: P2, minor: P2): EllipseShape => ({ c, a: dist2(c, major), b: dist2(c, minor), rot: angleOf(c, major) });
const ellipseParam = (e: EllipseShape, p: P2): number => {
    const dx = p[0] - e.c[0];
    const dy = p[1] - e.c[1];
    const x = dx * Math.cos(e.rot) + dy * Math.sin(e.rot);
    const y = -dx * Math.sin(e.rot) + dy * Math.cos(e.rot);
    return Math.atan2(y / e.b, x / e.a);
};
const ellipseAt = (e: EllipseShape, t: number): P2 => {
    const x = e.a * Math.cos(t);
    const y = e.b * Math.sin(t);
    return [e.c[0] + x * Math.cos(e.rot) - y * Math.sin(e.rot), e.c[1] + x * Math.sin(e.rot) + y * Math.cos(e.rot)];
};
function ellipseSamples(e: EllipseShape, t0: number, sweep: number, n = Math.max(16, Math.ceil((Math.abs(sweep) / TAU) * 128))): P2[] {
    return Array.from({ length: n + 1 }, (_, i) => ellipseAt(e, t0 + (sweep * i) / n));
}
const polyLength = (pts: P2[]): number => pts.reduce((s, p, i) => (i ? s + dist2(p, pts[i - 1]) : 0), 0);

/** A rational clamped B-spline point (weights optional), with the core's de Boor for the homogeneous parts. */
function nurbsAt(poles: P2[], degree: number, t: number, inner: number[], weights?: number[]): P2 {
    if (!weights) {
        return bsplineAt(poles, degree, t, inner);
    }
    const num = bsplineAt(poles.map((p, i) => [p[0] * weights[i], p[1] * weights[i]] as P2), degree, t, inner);
    const den = bsplineAt(weights.map((w) => [w, 0] as P2), degree, t, inner)[0];
    return [num[0] / den, num[1] / den];
}

/** Tangent lines of a parabola at two of its points meet at the control point of the quadratic that is that piece. */
function parabolaApex(focus: P2, vertex: P2, s: P2, e: P2): P2 | null {
    const f = dist2(focus, vertex);
    if (!(f > 1e-12)) return null;
    const ax: P2 = [(focus[0] - vertex[0]) / f, (focus[1] - vertex[1]) / f];
    const px: P2 = [-ax[1], ax[0]];
    const local = (p: P2): number => (p[0] - vertex[0]) * px[0] + (p[1] - vertex[1]) * px[1];
    const xs = local(s);
    const xe = local(e);
    const x = (xs + xe) / 2;
    const y = (xs * xe) / (4 * f);
    return [vertex[0] + px[0] * x + ax[0] * y, vertex[1] + px[1] * x + ax[1] * y];
}

// ---- Mapping ------------------------------------------------------------------------------------------------------

export function mapSketch(sw: SwSketch, convention: Convention): MappedSketch {
    if (sw.is3d) {
        throw new Error('it is a 3D sketch; the studio has 2D sketches only');
    }
    const placed = sketchFrameOf(sw.toSketch, convention);
    if (!placed) {
        throw new Error('the export did not give the sketch plane');
    }
    const { frame } = placed;
    const notes: string[] = [];
    const to3d = (p: P2): Vec3 => [
        frame.origin[0] + p[0] * frame.x[0] + p[1] * frame.y[0],
        frame.origin[1] + p[0] * frame.x[1] + p[1] * frame.y[1],
        frame.origin[2] + p[0] * frame.x[2] + p[1] * frame.y[2],
    ];
    const to2d = (p: Vec3): P2 => {
        const d = sub(p, frame.origin);
        return [dot(d, frame.x), dot(d, frame.y)];
    };

    // Points (u, v in mm). The sketch origin is the sketcher's own 'origin'.
    const coords = new Map<string, P2>();
    const origins = new Set<string>();
    for (const p of sw.points ?? []) {
        // The sketch origin (or the model origin projected onto the sketch, an external point there).
        if (p.type === 8 || (p.type === 10 && Math.abs(p.x) < 1e-12 && Math.abs(p.y) < 1e-12)) {
            origins.add(p.id);
            continue;
        }
        coords.set(p.id, [clean(p.x * MM), clean(p.y * MM)]);
    }
    const pointId = (id: string | null | undefined): string | null => {
        if (!id) return null;
        if (origins.has(id)) return 'origin';
        return coords.has(id) ? id : null;
    };
    const at = (id: string): P2 => (id === 'origin' ? [0, 0] : coords.get(id)!);
    const extraPoints: SketchPoint[] = [];
    const newPoint = (id: string, p: P2): string => {
        coords.set(id, p);
        extraPoints.push({ id, u: p[0], v: p[1] });
        return id;
    };

    // Arc directions: settled from the arc length (a semicircle is the same length both ways, so it takes its
    // direction from GetRotationDir, read as the unambiguous arcs of this sketch read it).
    let agree = 0;
    let disagree = 0;
    const pendingArcs: { seg: SwSegment; ccwKnown: boolean | null }[] = [];
    for (const seg of sw.segments ?? []) {
        if (seg.kind !== 'arc' && seg.kind !== 'ellipse') continue;
        const ccw = arcDirectionByLength(seg, pointId, at);
        if (ccw !== null && (seg.dir === 1 || seg.dir === -1)) {
            if ((seg.dir === 1) === ccw) agree++;
            else disagree++;
        }
        pendingArcs.push({ seg, ccwKnown: ccw });
    }
    const dirMeansCcw = disagree > agree ? -1 : 1;
    const ccwOf = (seg: SwSegment): boolean => {
        const known = pendingArcs.find((a) => a.seg === seg)?.ccwKnown;
        return known ?? (seg.dir === dirMeansCcw || seg.dir == null);
    };

    const curves: SketchCurve[] = [];
    const pieces: Piece[] = [];
    let skipped = 0;
    const kinds: string[] = [];
    for (const seg of sw.segments ?? []) {
        const construction = seg.construction ? { construction: true as const } : {};
        try {
            const made = mapSegment(seg, construction, pointId, at, newPoint, ccwOf);
            if (!made) {
                skipped++;
                kinds.push(seg.kind);
                continue;
            }
            curves.push(made.curve);
            if (!seg.construction && made.piece) {
                pieces.push(made.piece);
            }
            if (made.note) notes.push(made.note);
        } catch (error) {
            skipped++;
            kinds.push(`${seg.kind} (${error instanceof Error ? error.message : String(error)})`);
        }
    }
    if (skipped) {
        notes.push(`${skipped} sketch ${skipped === 1 ? 'entity was' : 'entities were'} left out: ${[...new Set(kinds)].join(', ')}`);
    }

    const points: SketchPoint[] = [...coords.entries()].filter(([id]) => !extraPoints.some((p) => p.id === id))
        .map(([id, [u, v]]) => ({ id, u, v }));
    points.push(...extraPoints);
    const curveMap = new Map(curves.map((c) => [c.id, c]));

    // Ends that meet at the same place are one end for the loops, whatever their ids.
    const canon = new Map<string, string>();
    const byPlace = new Map<string, string>();
    for (const [id, [u, v]] of [...coords.entries(), ['origin', [0, 0]] as [string, P2]]) {
        const key = `${Math.round(u * 1e6)},${Math.round(v * 1e6)}`;
        const first = byPlace.get(key);
        canon.set(id, first ?? id);
        if (!first) byPlace.set(key, id);
    }
    for (const p of pieces) {
        p.from = canon.get(p.from) ?? p.from;
        p.to = canon.get(p.to) ?? p.to;
    }
    const loops = findLoops(pieces);
    const profiles = loops.outlines.map((o) => profileOf(o, loopStart(o)));
    const open: SketchProfile[] = loops.open.map((chain) => profileOf(chain, loopStart(chain), false));

    const constraints = mapRelations(sw.relations ?? [], { pointId, at, curves: curveMap, notes });
    const geometry: SketchGeometry = { points, curves, constraints };
    const { plane, offset } = planeOfFrame(frame);
    const sketch: Sketch = {
        plane, ...(offset !== undefined ? { offset } : {}), profiles, geometry,
        ...(loops.faces.length ? { regions: regionsOf(loops) } : {}),
        ...(open.length ? { open } : {}),
    };
    return { sketch, frame, loops, to3d, to2d, points: coords, curves: curveMap, notes };
}

function arcDirectionByLength(seg: SwSegment, pointId: (id: string | null | undefined) => string | null, at: (id: string) => P2): boolean | null {
    const c = pointId(seg.centre);
    const s = pointId(seg.start);
    const e = pointId(seg.end);
    if (!c || !s || !e || s === e || seg.circle || !(typeof seg.length === 'number')) return null;
    const length = seg.length * MM;
    let ccwLength: number;
    let cwLength: number;
    if (seg.kind === 'arc') {
        const r = dist2(at(c), at(s));
        const sweep = ccwSweep(at(c), at(s), at(e));
        ccwLength = r * sweep;
        cwLength = r * (TAU - sweep);
    } else {
        const mj = pointId(seg.major);
        const mn = pointId(seg.minor);
        if (!mj || !mn) return null;
        const el = ellipseOf(at(c), at(mj), at(mn));
        let sweep = ellipseParam(el, at(e)) - ellipseParam(el, at(s));
        while (sweep <= 1e-12) sweep += TAU;
        ccwLength = polyLength(ellipseSamples(el, ellipseParam(el, at(s)), sweep, 2000));
        cwLength = polyLength(ellipseSamples(el, ellipseParam(el, at(s)), sweep - TAU, 2000));
    }
    const tol = Math.max(1e-6, length * 1e-6);
    if (Math.abs(ccwLength - cwLength) < tol * 10) return null;
    return Math.abs(length - ccwLength) < Math.abs(length - cwLength);
}

interface Made {
    curve: SketchCurve;
    piece?: Piece;
    note?: string;
}

function mapSegment(
    seg: SwSegment, construction: { construction?: true }, pointId: (id: string | null | undefined) => string | null, at: (id: string) => P2,
    newPoint: (id: string, p: P2) => string, ccwOf: (seg: SwSegment) => boolean,
): Made | null {
    const id = seg.id;
    switch (seg.kind) {
        case 'line': {
            const a = pointId(seg.start);
            const b = pointId(seg.end);
            if (!a || !b) return null;
            const curve: SketchCurve = { id, kind: 'line', a, b, ...construction, ...(seg.infinite ? { endless: 'both' as const } : {}) };
            return { curve, piece: seg.infinite ? undefined : { id, from: a, to: b, forward: { kind: 'line', to: at(b) }, backward: { kind: 'line', to: at(a) }, samples: [at(a), at(b)] } };
        }
        case 'arc': {
            const c = pointId(seg.centre);
            if (!c) return null;
            const s = pointId(seg.start);
            const e = pointId(seg.end);
            const full = seg.circle || !s || !e || s === e;
            if (full) {
                const radius = clean((seg.radius ?? (s ? dist2(at(c), at(s)) / MM : 0)) * MM);
                if (!(radius > 0)) return null;
                const centre = at(c);
                const samples = arcSamples(centre, [centre[0] + radius, centre[1]], TAU);
                return {
                    curve: { id, kind: 'circle', center: c, radius, ...construction },
                    piece: { id, from: c, to: c, forward: { kind: 'line', to: centre }, backward: { kind: 'line', to: centre }, samples, closed: { kind: 'circle', center: centre, radius } },
                };
            }
            const [start, end] = ccwOf(seg) ? [s, e] : [e, s];
            const sweep = ccwSweep(at(c), at(start), at(end));
            const samples = arcSamples(at(c), at(start), sweep);
            const mid = samples[Math.floor(samples.length / 2)];
            return {
                curve: { id, kind: 'arc', center: c, start, end, ...construction },
                piece: { id, from: start, to: end, forward: { kind: 'arc', to: at(end), through: mid }, backward: { kind: 'arc', to: at(start), through: mid }, samples },
            };
        }
        case 'ellipse': {
            const c = pointId(seg.centre);
            const mj = pointId(seg.major);
            const mn = pointId(seg.minor);
            if (!c || !mj || !mn) return null;
            const s = pointId(seg.start);
            const e = pointId(seg.end);
            const el = ellipseOf(at(c), at(mj), at(mn));
            const full = !s || !e || s === e;
            if (full) {
                const samples = ellipseSamples(el, 0, TAU);
                return {
                    curve: { id, kind: 'ellipse', center: c, major: mj, minor: mn, ...construction },
                    piece: { id, from: c, to: c, forward: { kind: 'line', to: at(c) }, backward: { kind: 'line', to: at(c) }, samples, closed: { kind: 'ellipse', center: at(c), major: at(mj), minor: el.b } },
                };
            }
            const [start, end] = ccwOf(seg) ? [s, e] : [e, s];
            const t0 = ellipseParam(el, at(start));
            let sweep = ellipseParam(el, at(end)) - t0;
            while (sweep <= 1e-12) sweep += TAU;
            const samples = ellipseSamples(el, t0, sweep);
            return {
                curve: { id, kind: 'ellipseArc', center: c, major: mj, minor: mn, start, end, ...construction },
                piece: {
                    id, from: start, to: end, samples,
                    forward: { kind: 'ellipse', to: at(end), center: at(c), major: at(mj), minor: el.b, ccw: true },
                    backward: { kind: 'ellipse', to: at(start), center: at(c), major: at(mj), minor: el.b, ccw: false },
                },
            };
        }
        case 'spline':
            return mapSpline(seg, construction, pointId, at, newPoint);
        case 'parabola': {
            const f = pointId(seg.focus);
            const v = pointId(seg.apex);
            const s = pointId(seg.start);
            const e = pointId(seg.end);
            if (!f || !v || !s || !e) return null;
            const apex = parabolaApex(at(f), at(v), at(s), at(e));
            if (!apex) return null;
            const samples = Array.from({ length: 33 }, (_, i) => {
                const t = i / 32;
                const [a, b, c] = [at(s), apex, at(e)];
                return [(1 - t) ** 2 * a[0] + 2 * t * (1 - t) * b[0] + t * t * c[0], (1 - t) ** 2 * a[1] + 2 * t * (1 - t) * b[1] + t * t * c[1]] as P2;
            });
            return {
                curve: { id, kind: 'parabola', focus: f, vertex: v, start: s, end: e, ...construction },
                piece: { id, from: s, to: e, samples, forward: { kind: 'conic', to: at(e), apex, rho: 0.5 }, backward: { kind: 'conic', to: at(s), apex, rho: 0.5 } },
            };
        }
        default:
            return null;
    }
}

/**
 * A sketch spline as a style spline with SolidWorks' own control vertices and knots, so it is the same curve; when
 * the export holds no B-spline data, a spline through its points (close, not the same).
 */
function mapSpline(
    seg: SwSegment, construction: { construction?: true }, pointId: (id: string | null | undefined) => string | null, at: (id: string) => P2,
    newPoint: (id: string, p: P2) => string,
): Made | null {
    const ids = (seg.points ?? []).map((p) => pointId(p)).filter((p): p is string => !!p);
    if (ids.length < 2) return null;
    const id = seg.id;
    const first = ids[0];
    const last = ids[ids.length - 1];
    const b = seg.bspline;
    const poles = b ? splinePoles(b, at(first), at(last)) : null;
    if (b && poles && b.knots && b.order >= 2) {
        const degree = b.order - 1;
        const n = poles.points.length;
        const knots = b.knots;
        const clamped = knots.length === n + b.order
            && knots.slice(0, b.order).every((k) => Math.abs(k - knots[0]) < 1e-12)
            && knots.slice(-b.order).every((k) => Math.abs(k - knots[knots.length - 1]) < 1e-12);
        const span = knots[knots.length - 1] - knots[0];
        const inner = clamped && span > 0 ? knots.slice(b.order, n).map((k) => (k - knots[0]) / span) : null;
        const bezier = n === degree + 1;
        if (inner && (bezier || [3, 5, 7].includes(degree))) {
            const vertexIds = poles.points.map((p, i) => (i === 0 ? first : i === n - 1 ? last : newPoint(`${id}-cv${i}`, [clean(p[0]), clean(p[1])])));
            const weights = poles.weights && poles.weights.some((w) => Math.abs(w - 1) > 1e-12) ? poles.weights : undefined;
            const curve: SketchCurve = {
                id, kind: 'styleSpline', points: vertexIds, ...(bezier ? {} : { degree: degree as 3 | 5 | 7, knots: inner }),
                ...(weights ? { weights } : {}), ...construction,
            };
            const pts = vertexIds.map(at);
            const samples = Array.from({ length: 97 }, (_, i) => nurbsAt(pts, degree, i / 96, bezier ? [] : inner, weights));
            const reversedInner = bezier ? undefined : [...inner].reverse().map((k) => 1 - k);
            const piece: Piece = {
                id, from: first, to: last, samples,
                forward: { kind: 'bspline', to: pts[n - 1], poles: pts.slice(1, -1), degree, ...(bezier ? {} : { knots: inner }), ...(weights ? { weights } : {}) },
                backward: { kind: 'bspline', to: pts[0], poles: pts.slice(1, -1).reverse(), degree, ...(reversedInner ? { knots: reversedInner } : {}), ...(weights ? { weights: [...weights].reverse() } : {}) },
            };
            if (first === last) {
                piece.closed = { kind: 'path', start: pts[0], segments: [piece.forward] };
            }
            return { curve, piece };
        }
    }
    const pts = ids.map(at);
    const curve: SketchCurve = { id, kind: 'spline', points: ids, ...construction };
    const piece: Piece = {
        id, from: first, to: last, samples: pts,
        forward: { kind: 'spline', to: pts[pts.length - 1], through: pts.slice(1, -1) },
        backward: { kind: 'spline', to: pts[0], through: pts.slice(1, -1).reverse() },
    };
    if (first === last) {
        piece.closed = { kind: 'path', start: pts[0], segments: [piece.forward] };
    }
    return { curve, piece, note: `spline ${id} came across as a spline through its points, not as SolidWorks' exact curve` };
}

/** The spline's control vertices in sketch (u, v) mm, whichever space and weighting the export gave them in. */
function splinePoles(b: NonNullable<SwSegment['bspline']>, first: P2, last: P2): { points: P2[]; weights?: number[] } | null {
    const cps = b.controlPoints;
    const d = b.dimension;
    if (!cps || !(d >= 2 && d <= 4) || cps.length < d * 2 || cps.length % d) return null;
    const n = cps.length / d;
    const read = (weighted: boolean): { points: P2[]; weights?: number[] } => {
        const points: P2[] = [];
        const weights: number[] = [];
        for (let i = 0; i < n; i++) {
            const w = d === 4 ? cps[i * d + 3] || 1 : 1;
            const k = weighted && d === 4 ? 1 / w : 1;
            points.push([cps[i * d] * k * MM, cps[i * d + 1] * k * MM]);
            weights.push(w);
        }
        return d === 4 ? { points, weights } : { points };
    };
    // The curve is clamped: its first and last control vertices are its ends. Pick the reading that puts them there.
    for (const weighted of d === 4 ? [true, false] : [false]) {
        const r = read(weighted);
        if (dist2(r.points[0], first) < 1e-4 && dist2(r.points[n - 1], last) < 1e-4) {
            return r;
        }
    }
    return null;
}

// ---- Relations and dimensions ---------------------------------------------------------------------------------

interface RelationContext {
    pointId: (id: string | null | undefined) => string | null;
    at: (id: string) => P2;
    curves: Map<string, SketchCurve>;
    notes: string[];
}

const RELATION_NAMES: Record<number, string> = {
    1: 'distance', 2: 'angle', 3: 'radius', 4: 'horizontal', 5: 'vertical', 6: 'tangent', 7: 'parallel', 8: 'perpendicular',
    9: 'coincident', 10: 'concentric', 11: 'symmetric', 12: 'midpoint', 13: 'intersection', 14: 'equal', 15: 'diameter',
    16: 'offset', 17: 'fix', 25: 'horizontal points', 26: 'vertical points', 27: 'collinear', 28: 'coradial', 32: 'convert entities',
    41: 'double distance', 42: 'merge', 44: 'arc length', 47: 'offset', 57: 'pattern',
};

/** A constraint before its id. */
type NewConstraint = SketchConstraint extends infer C ? (C extends SketchConstraint ? Omit<C, 'id'> : never) : never;

const TOL = 1e-5;

function mapRelations(relations: SwRelation[], ctx: RelationContext): SketchConstraint[] {
    const out: SketchConstraint[] = [];
    const dropped = new Map<string, number>();
    const drop = (why: string) => dropped.set(why, (dropped.get(why) ?? 0) + 1);
    let n = 0;
    for (const rel of relations) {
        const name = RELATION_NAMES[rel.type] ?? `type ${rel.type}`;
        const made = mapRelation(rel, ctx);
        if (typeof made === 'string') {
            drop(`${name}: ${made}`);
            continue;
        }
        for (const c of made) {
            out.push({ ...c, id: `k${++n}`, ...(rel.suppressed ? { suppressed: true } : {}) } as SketchConstraint);
        }
    }
    if (dropped.size) {
        const total = [...dropped.values()].reduce((a, b) => a + b, 0);
        ctx.notes.push(`${total} ${total === 1 ? 'relation was' : 'relations were'} not brought across (${[...dropped.entries()].map(([k, v]) => (v > 1 ? `${k} x${v}` : k)).join('; ')})`);
    }
    return out;
}

function mapRelation(rel: SwRelation, ctx: RelationContext): NewConstraint[] | string {
    const { at, curves } = ctx;
    // Each entity as a point id or a curve id of this sketch.
    const ents: { point?: string; curve?: string }[] = [];
    for (const e of rel.entities) {
        if (!e.ref) {
            return 'it refers to model geometry outside the sketch';
        }
        if (e.type === 2) {
            const p = ctx.pointId(e.ref);
            if (!p) return 'a point was not exported';
            ents.push({ point: p });
        } else if (curves.has(e.ref)) {
            ents.push({ curve: e.ref });
        } else {
            return 'a curve was not brought across';
        }
    }
    const kind = (i: number): string => (ents[i]?.point ? 'point' : curves.get(ents[i]?.curve ?? '')?.kind ?? '?');
    const line = (id: string): [P2, P2] | null => {
        const c = curves.get(id);
        return c?.kind === 'line' ? [at(c.a), at(c.b)] : null;
    };
    const centreOf = (i: number): string | null => {
        if (ents[i].point) return ents[i].point!;
        const c = curves.get(ents[i].curve!);
        return c && 'center' in c ? c.center : null;
    };
    const radiusOf = (id: string): number | null => {
        const c = curves.get(id);
        if (c?.kind === 'circle') return c.radius;
        if (c?.kind === 'arc') return dist2(at(c.center), at(c.start));
        return null;
    };
    const ids = ents.map((e) => (e.point ?? e.curve)!);
    const dim = rel.dimension;
    const value = typeof dim?.value === 'number' ? dim.value : null;
    const driven = dim?.driven === 1 ? { driven: true } : {};

    switch (rel.type) {
        case 4:
        case 5: {
            const horizontal = rel.type === 4;
            if (ents.length === 1 && kind(0) === 'line') {
                const l = line(ids[0])!;
                const d = horizontal ? l[1][1] - l[0][1] : l[1][0] - l[0][0];
                return Math.abs(d) < TOL ? [{ kind: horizontal ? 'horizontal' : 'vertical', line: ids[0] }] : 'it does not hold in the geometry';
            }
            if (ents.length === 2 && ents[0].point && ents[1].point) {
                return pointsLevel(ids, horizontal, at);
            }
            return 'unexpected entities';
        }
        case 25:
        case 26:
            if (ents.length === 2 && ents[0].point && ents[1].point) {
                return pointsLevel(ids, rel.type === 25, at);
            }
            return 'unexpected entities';
        case 9:
        case 42: {
            if (ents.length !== 2) return 'unexpected entities';
            if (ents[0].point && ents[1].point) {
                if (ids[0] === ids[1]) return [];
                return dist2(at(ids[0]), at(ids[1])) < TOL ? [{ kind: 'coincident', a: ids[0], b: ids[1] }] : 'it does not hold in the geometry';
            }
            const pi = ents[0].point ? 0 : ents[1].point ? 1 : -1;
            if (pi < 0) return 'unexpected entities';
            const curve = ids[1 - pi];
            return onCurve(at(ids[pi]), curves.get(curve)!, at) ? [{ kind: 'pointOnCurve', point: ids[pi], curve }] : 'it does not hold in the geometry';
        }
        case 7:
        case 8:
        case 27: {
            if (ents.length !== 2 || kind(0) !== 'line' || kind(1) !== 'line') return 'unexpected entities';
            const [a, b] = [line(ids[0])!, line(ids[1])!];
            const da = unit2(a);
            const db = unit2(b);
            const crossAB = da[0] * db[1] - da[1] * db[0];
            const dotAB = da[0] * db[0] + da[1] * db[1];
            if (rel.type === 8) {
                return Math.abs(dotAB) < 1e-7 ? [{ kind: 'perpendicular', a: ids[0], b: ids[1] }] : 'it does not hold in the geometry';
            }
            if (Math.abs(crossAB) > 1e-7) return 'it does not hold in the geometry';
            if (rel.type === 27) {
                const off = (b[0][0] - a[0][0]) * da[1] - (b[0][1] - a[0][1]) * da[0];
                return Math.abs(off) < TOL ? [{ kind: 'collinear', a: ids[0], b: ids[1] }] : 'it does not hold in the geometry';
            }
            return [{ kind: 'parallel', a: ids[0], b: ids[1] }];
        }
        case 6:
            return ents.length === 2 && ents[0].curve && ents[1].curve ? [{ kind: 'tangent', a: ids[0], b: ids[1] }] : 'unexpected entities';
        case 10:
        case 28: {
            if (ents.length !== 2) return 'unexpected entities';
            const [ca, cb] = [centreOf(0), centreOf(1)];
            if (!ca || !cb || dist2(at(ca), at(cb)) > TOL) return 'it does not hold in the geometry';
            if (rel.type === 28) {
                const [ra, rb] = [radiusOf(ids[0]), radiusOf(ids[1])];
                if (ra === null || rb === null || Math.abs(ra - rb) > TOL) return 'it does not hold in the geometry';
                return [{ kind: 'coradial', a: ids[0], b: ids[1] }];
            }
            return [{ kind: 'concentric', a: ids[0], b: ids[1] }];
        }
        case 14: {
            if (ents.length !== 2) return 'unexpected entities';
            const size = (i: number): number | null => {
                const l = kind(i) === 'line' ? line(ids[i]) : null;
                return l ? dist2(l[0], l[1]) : radiusOf(ids[i]);
            };
            const [sa, sb] = [size(0), size(1)];
            if (sa === null || sb === null || Math.abs(sa - sb) > TOL) return 'it does not hold in the geometry';
            return [{ kind: 'equal', a: ids[0], b: ids[1] }];
        }
        case 12: {
            const pi = ents.findIndex((e) => e.point);
            const li = ents.findIndex((e, i) => i !== pi && kind(i) === 'line');
            if (pi < 0 || li < 0) return 'unexpected entities';
            const l = line(ids[li])!;
            const mid: P2 = [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2];
            return dist2(mid, at(ids[pi])) < TOL ? [{ kind: 'midpoint', point: ids[pi], line: ids[li] }] : 'it does not hold in the geometry';
        }
        case 13: {
            const pi = ents.findIndex((e) => e.point);
            const ls = ents.map((_, i) => i).filter((i) => i !== pi && kind(i) === 'line');
            if (pi < 0 || ls.length !== 2) return 'unexpected entities';
            const p = at(ids[pi]);
            return ls.every((i) => onCurve(p, curves.get(ids[i])!, at, true)) ? [{ kind: 'intersection', point: ids[pi], a: ids[ls[0]], b: ids[ls[1]] }] : 'it does not hold in the geometry';
        }
        case 11: {
            if (ents.length !== 3) return 'unexpected entities';
            for (let k = 2; k >= 0; k--) {
                if (kind(k) !== 'line') continue;
                const [i, j] = [0, 1, 2].filter((x) => x !== k);
                const axis = line(ids[k])!;
                if (mirrors(ents[i], ents[j], axis, curves, at)) {
                    return [{ kind: 'symmetric', a: ids[i], b: ids[j], about: ids[k] }];
                }
            }
            return 'it does not hold in the geometry';
        }
        case 17: {
            const out: NewConstraint[] = [];
            for (const e of ents) {
                if (e.point) {
                    if (e.point !== 'origin') out.push({ kind: 'fix', point: e.point });
                    continue;
                }
                const c = curves.get(e.curve!)!;
                for (const p of curveEnds(c)) out.push({ kind: 'fix', point: p });
                if (c.kind === 'circle' || c.kind === 'arc') out.push({ kind: 'fixRadius', curve: c.id });
            }
            return out;
        }
        case 3:
        case 15: {
            if (value === null || ents.length !== 1) return 'unexpected entities';
            const r = radiusOf(ids[0]);
            const v = clean(value * MM);
            const want = rel.type === 15 ? v / 2 : v;
            if (r === null || Math.abs(r - want) > TOL) return 'it does not hold in the geometry';
            return [{ kind: rel.type === 15 ? 'diameter' : 'radius', curve: ids[0], value: v, ...driven }];
        }
        case 44: {
            if (value === null || ents.length !== 1 || kind(0) !== 'arc') return 'unexpected entities';
            return [{ kind: 'arcLength', curve: ids[0], value: clean(value * MM), ...driven }];
        }
        case 1:
        case 41:
            return distanceDimension(rel, ents, ids, kind, ctx, driven);
        case 2: {
            if (value === null || ents.length !== 2 || kind(0) !== 'line' || kind(1) !== 'line') return 'unexpected entities';
            const target = (value * 180) / Math.PI;
            const [a, b] = [line(ids[0])!, line(ids[1])!];
            for (const reverseA of [false, true]) {
                for (const reverseB of [false, true]) {
                    const da = reverseA ? [a[0][0] - a[1][0], a[0][1] - a[1][1]] : [a[1][0] - a[0][0], a[1][1] - a[0][1]];
                    const db = reverseB ? [b[0][0] - b[1][0], b[0][1] - b[1][1]] : [b[1][0] - b[0][0], b[1][1] - b[0][1]];
                    const angle = (Math.acos(Math.max(-1, Math.min(1, (da[0] * db[0] + da[1] * db[1]) / (Math.hypot(da[0], da[1]) * Math.hypot(db[0], db[1]))))) * 180) / Math.PI;
                    if (Math.abs(angle - target) < 1e-6) {
                        return [{ kind: 'angle', a: ids[0], b: ids[1], value: clean(target), ...(reverseA ? { reverseA } : {}), ...(reverseB ? { reverseB } : {}), ...driven }];
                    }
                }
            }
            return 'it does not hold in the geometry';
        }
        default:
            return 'the studio has no such relation';
    }
}

function pointsLevel(ids: string[], horizontal: boolean, at: (id: string) => P2): NewConstraint[] | string {
    const [a, b] = [at(ids[0]), at(ids[1])];
    const d = horizontal ? a[1] - b[1] : a[0] - b[0];
    return Math.abs(d) < TOL ? [{ kind: horizontal ? 'horizontalPoints' : 'verticalPoints', a: ids[0], b: ids[1] }] : 'it does not hold in the geometry';
}

const unit2 = (l: [P2, P2]): P2 => {
    const d = dist2(l[0], l[1]);
    return [(l[1][0] - l[0][0]) / d, (l[1][1] - l[0][1]) / d];
};

function curveEnds(c: SketchCurve): string[] {
    switch (c.kind) {
        case 'line': return [c.a, c.b];
        case 'circle': return [c.center];
        case 'arc': return [c.center, c.start, c.end];
        case 'ellipse': return [c.center, c.major, c.minor];
        case 'ellipseArc': return [c.center, c.major, c.minor, c.start, c.end];
        case 'parabola': return [c.focus, c.vertex, c.start, c.end];
        case 'spline':
        case 'styleSpline': return c.points;
        default: return [];
    }
}

function onCurve(p: P2, c: SketchCurve, at: (id: string) => P2, infinite = true): boolean {
    if (c.kind === 'line') {
        const [a, b] = [at(c.a), at(c.b)];
        const d = dist2(a, b);
        const off = Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / d;
        return off < TOL && (infinite || true);
    }
    if (c.kind === 'circle') return Math.abs(dist2(p, at(c.center)) - c.radius) < TOL;
    if (c.kind === 'arc') return Math.abs(dist2(p, at(c.center)) - dist2(at(c.start), at(c.center))) < TOL;
    // Other curves: kept without a check (the sketcher solves them as they are).
    return true;
}

function mirrors(a: { point?: string; curve?: string }, b: { point?: string; curve?: string }, axis: [P2, P2], curves: Map<string, SketchCurve>, at: (id: string) => P2): boolean {
    const d = unit2(axis);
    const reflect = (p: P2): P2 => {
        const v: P2 = [p[0] - axis[0][0], p[1] - axis[0][1]];
        const t = v[0] * d[0] + v[1] * d[1];
        return [axis[0][0] + 2 * t * d[0] - v[0], axis[0][1] + 2 * t * d[1] - v[1]];
    };
    if (a.point && b.point) return dist2(reflect(at(a.point)), at(b.point)) < TOL;
    if (a.curve && b.curve) {
        const ca = curves.get(a.curve)!;
        const cb = curves.get(b.curve)!;
        const pa = curveEnds(ca).map(at).map(reflect);
        const pb = curveEnds(cb).map(at);
        return pa.length === pb.length && pa.every((p) => pb.some((q) => dist2(p, q) < TOL));
    }
    return false;
}

function distanceDimension(
    rel: SwRelation, ents: { point?: string; curve?: string }[], ids: string[], kind: (i: number) => string, ctx: RelationContext,
    driven: { driven?: boolean },
): NewConstraint[] | string {
    const { at, curves } = ctx;
    const dim = rel.dimension;
    if (!dim || typeof dim.value !== 'number') return 'no value';
    const value = clean(dim.value * MM);
    const axis = dim.type === 11 ? 'u' : dim.type === 12 ? 'v' : undefined;
    const doubled = rel.type === 41;
    // Ends: a point, an arc or circle by its centre, a line as itself.
    const ends: string[] = [];
    for (let i = 0; i < ents.length; i++) {
        if (ents[i].point) {
            ends.push(ents[i].point!);
            continue;
        }
        const c = curves.get(ents[i].curve!)!;
        if (c.kind === 'circle' || c.kind === 'arc' || c.kind === 'ellipse' || c.kind === 'ellipseArc') ends.push(c.center);
        else if (c.kind === 'line') ends.push(c.id);
        else return 'unexpected entities';
    }
    const isLine = (id: string) => curves.get(id)?.kind === 'line';
    const measure = (a: string, b: string, ax?: 'u' | 'v'): number | null => {
        if (isLine(a) && isLine(b)) return null;
        if (isLine(a) || isLine(b)) {
            const [p, l] = isLine(a) ? [b, a] : [a, b];
            const c = curves.get(l) as Extract<SketchCurve, { kind: 'line' }>;
            const [la, lb] = [at(c.a), at(c.b)];
            const q = at(p);
            if (ax) return null;
            return Math.abs((lb[0] - la[0]) * (q[1] - la[1]) - (lb[1] - la[1]) * (q[0] - la[0])) / dist2(la, lb);
        }
        const [pa, pb] = [at(a), at(b)];
        return ax === 'u' ? Math.abs(pa[0] - pb[0]) : ax === 'v' ? Math.abs(pa[1] - pb[1]) : dist2(pa, pb);
    };
    let pair: [string, string] | null = null;
    if (ends.length === 1 && isLine(ends[0])) {
        const c = curves.get(ends[0]) as Extract<SketchCurve, { kind: 'line' }>;
        if (!axis && Math.abs(dist2(at(c.a), at(c.b)) - value) < TOL) {
            return [{ kind: 'length', line: c.id, value, ...driven }];
        }
        pair = [c.a, c.b];
    } else if (ends.length === 2) {
        pair = [ends[0], ends[1]];
        if (isLine(pair[0]) && isLine(pair[1])) {
            // Two parallel lines: from an end of the first to the second.
            pair = [(curves.get(pair[0]) as Extract<SketchCurve, { kind: 'line' }>).a, pair[1]];
        }
    }
    if (!pair) return 'unexpected entities';
    const want = doubled ? value / 2 : value;
    const tries: ('u' | 'v' | undefined)[] = axis ? [axis] : [undefined, 'u', 'v'];
    for (const ax of tries) {
        const m = measure(pair[0], pair[1], ax);
        if (m !== null && Math.abs(m - want) < TOL) {
            return [{ kind: 'distance', a: pair[0], b: pair[1], value, ...(ax ? { axis: ax } : {}), ...(doubled ? { doubled: true } : {}), ...driven }];
        }
    }
    return 'it does not hold in the geometry';
}
