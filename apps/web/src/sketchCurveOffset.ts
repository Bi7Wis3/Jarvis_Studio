// Offset Entities of chains with ellipses, splines, parabolas or conics (SolidWorks: the offset of such a curve is a
// spline). The solver cannot hold a curve at a distance from these, so the offset is an item of the sketch that owns
// its curves (fixed lines, arcs and splines fitted within 0.000001 mm of the true offset) and is rebuilt from its
// chain whenever the chain changes: that is the offset relation. Its distance shows as a driven dimension on a
// construction rib, and a value typed into it sets the distance. Chains of only lines and arcs are offset by
// sketchEdit.ts with solver relations as before.

import type { SketchConstraint, SketchCurve, SketchGeometry, SketchOffset, SketchPoint } from '@jarvis/core';
import { closestParam, directionAt, pointAt, type CurveGeom } from '@jarvis/core/curveIntersect';
import {
    curvatureAt, geomEval, offsetCurve, offsetEval, paramCrossings, refineCrossing, reversedEval, tangentAt, type CurveEval, type OffsetPiece,
} from '@jarvis/core/curveOffset';
import { curveOf, pointOf, withDrivenValues } from './solver';
import { constraintRefs, newId, type NewConstraint } from './sketchGeometry';
import { curveEndIds, isExtra } from './sketchCurves';
import { geomOfCurve } from './sketchCut';
import { isModelLock, sketchLockSource } from './sketchModel';

type Pt = [number, number];
type NewCurve = SketchCurve extends infer C ? (C extends SketchCurve ? Omit<C, 'id'> : never) : never;

/** How close the offset keeps to the true offset, mm; while dragging and in the preview, this coarser one. */
export const OFFSET_TOLERANCE = 1e-6;
const QUICK_TOLERANCE = 1e-3;

const dist = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);
const P = (g: SketchGeometry, id: string): Pt | null => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};

/** One curve of a chain, the way the chain runs. */
export interface ChainPart {
    curve: SketchCurve;
    reversed: boolean;
}

/** Whether a curve is closed on its own (a circle, an ellipse, a closed spline). */
function closedCurve(c: SketchCurve): boolean {
    return c.kind === 'circle' || c.kind === 'ellipse' || (c.kind === 'spline' && c.points.length > 2 && c.points[0] === c.points[c.points.length - 1]);
}

/**
 * The chain of curves joined end to end through `curveId` (through points where exactly two meet, construction with
 * construction), and whether it closes; a closed curve is a chain of its own.
 */
export function curveChain(g: SketchGeometry, curveId: string, allowed?: ReadonlySet<string>): { parts: ChainPart[]; closed: boolean } {
    const start = curveOf(g, curveId);
    if (!start) {
        return { parts: [], closed: false };
    }
    if (closedCurve(start)) {
        return { parts: [{ curve: start, reversed: false }], closed: true };
    }
    const pool = g.curves.filter((c) => !closedCurve(c) && !!c.construction === !!start.construction && (!allowed || allowed.has(c.id)));
    const users = (point: string) => pool.filter((c) => curveEndIds(c).includes(point));
    const [a, b] = curveEndIds(start);
    const parts: ChainPart[] = [{ curve: start, reversed: false }];
    const seen = new Set([start.id]);
    const endOf = (p: ChainPart) => curveEndIds(p.curve)[p.reversed ? 0 : 1];
    const startOf = (p: ChainPart) => curveEndIds(p.curve)[p.reversed ? 1 : 0];
    let at = b;
    for (;;) {
        const here = users(at);
        const next = here.length === 2 ? here.find((c) => c.id !== parts[parts.length - 1].curve.id) : undefined;
        if (!next) {
            break;
        }
        if (seen.has(next.id)) {
            return { parts, closed: next.id === start.id };
        }
        parts.push({ curve: next, reversed: curveEndIds(next)[0] !== at });
        seen.add(next.id);
        at = endOf(parts[parts.length - 1]);
    }
    at = a;
    for (;;) {
        const here = users(at);
        const prev = here.length === 2 ? here.find((c) => c.id !== parts[0].curve.id) : undefined;
        if (!prev || seen.has(prev.id)) {
            break;
        }
        parts.unshift({ curve: prev, reversed: curveEndIds(prev)[1] !== at });
        seen.add(prev.id);
        at = startOf(parts[0]);
    }
    return { parts, closed: false };
}

/** Whether the chain through this curve has a curve this module offsets (beyond lines, arcs and circles). */
export function chainHasCurves(g: SketchGeometry, curveId: string, allowed?: ReadonlySet<string>): boolean {
    return curveChain(g, curveId, allowed).parts.some((p) => isExtra(p.curve));
}

/** A chain curve as the maths takes it: its exact shape, and the way the chain runs it. */
interface ChainCurve {
    geom: CurveGeom;
    ev: CurveEval;
}

/** The chain's curves, each the way the chain runs (a backward one with its parameter turned round). */
function chainCurves(g: SketchGeometry, parts: ChainPart[]): ChainCurve[] | null {
    const out: ChainCurve[] = [];
    for (const p of parts) {
        const geom = geomOfCurve(g, p.curve);
        if (!geom) {
            return null;
        }
        const ev = geomEval(geom);
        out.push({ geom, ev: p.reversed ? reversedEval(ev) : ev });
    }
    return out;
}

/** Signed distance of p from the chain: positive on the left of the way it runs. */
export function curveSideDistance(g: SketchGeometry, curveId: string, p: Pt, allowed?: ReadonlySet<string>): number {
    const { parts } = curveChain(g, curveId, allowed);
    const curves = chainCurves(g, parts) ?? [];
    let best: { d: number; signed: number } | null = null;
    curves.forEach(({ geom }, i) => {
        const t = closestParam(geom, p);
        const q = pointAt(geom, t);
        const u = mulDir(directionAt(geom, t), parts[i].reversed ? -1 : 1);
        const d = dist(p, q);
        const signed = Math.sign(u[0] * (p[1] - q[1]) - u[1] * (p[0] - q[0])) * d;
        if (!best || d < best.d) {
            best = { d, signed };
        }
    });
    return (best as { signed: number } | null)?.signed ?? 0;
}

const mulDir = (v: Pt, k: number): Pt => [v[0] * k, v[1] * k];

// ---- Building an offset ---------------------------------------------------------------------------------------

/** One side of a built offset: its pieces end to end, and the rib (base point, offset point) for its dimension. */
interface BuiltSide {
    pieces: OffsetPiece[];
    rib: [Pt, Pt];
}

interface Built {
    sides: BuiltSide[];
    /** The base chain's ends (open chains), for the caps. */
    ends: [Pt, Pt] | null;
    deviation: number;
}

/** The chain offset by d: each curve's offset, trimmed or extended to meet its neighbours' (or none). */
function buildSide(curves: ChainCurve[], closed: boolean, d: number, tolerance: number, quick: boolean): BuiltSide & { deviation: number } | { error: string } {
    const n = curves.length;
    const offs = curves.map((c) => offsetEval(c.ev, d));
    const range: [number, number][] = curves.map((c) => [c.ev.t0, c.ev.t1]);
    const span = (i: number) => curves[i].ev.t1 - curves[i].ev.t0;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
        const j = (i + 1) % n;
        if (closed && n === 1) {
            break;
        }
        const [a, b] = [offs[i], offs[j]];
        const [ea, eb] = [curves[i].ev.t1, curves[j].ev.t0];
        const [pa, pb] = [a.at(ea), b.at(eb)];
        if (dist(pa, pb) < 1e-9) {
            continue;
        }
        // Where the neighbouring offsets cross near the joint (each run on past its end if need be).
        const near = (h: { s: number; u: number } | null) => !!h && h.s > ea - span(i) && h.s < ea + span(i) && h.u > eb - span(j) && h.u < eb + span(j);
        let hit = refineCrossing(a, b, ea, eb);
        if (!near(hit)) {
            const mid: Pt = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
            const all = paramCrossings(a, [ea - span(i), ea + span(i)], b, [eb - span(j), eb + span(j)], 256);
            hit = all.length ? all.reduce((x, y) => (dist(y.at, mid) < dist(x.at, mid) ? y : x)) : null;
        }
        if (!hit || !near(hit)) {
            return { error: 'The offset does not meet itself at a corner of the chain: try a smaller distance.' };
        }
        range[i][1] = hit.s;
        range[j][0] = hit.u;
    }
    if (range.some(([lo, hi]) => !(hi - lo > 1e-9))) {
        return { error: 'The distance is too big for a curve of the chain.' };
    }
    // As in SolidWorks, no offset that would cross itself: nowhere may it go further in than the curve's radius of curvature.
    for (let i = 0; i < n; i++) {
        for (let k = 0; k <= 400; k++) {
            const t = range[i][0] + ((range[i][1] - range[i][0]) * k) / 400;
            if (d * curvatureAt(curves[i].ev, t) >= 1 - 1e-9) {
                return { error: 'At that distance the offset would cross itself where the curve bends tighter: use a smaller distance.' };
            }
        }
    }
    const pieces: OffsetPiece[] = [];
    let deviation = 0;
    for (let i = 0; i < n; i++) {
        const fit = offsetCurve(curves[i].geom, curves[i].ev, d, range[i][0], range[i][1], { tolerance, measure: !quick, maxPoints: quick ? 120 : 400 });
        if (!fit) {
            return { error: 'That distance is more than the radius of an arc in the chain.' };
        }
        pieces.push(fit.piece);
        deviation = Math.max(deviation, fit.deviation);
    }
    const t = (range[0][0] + range[0][1]) / 2;
    return { pieces, rib: [curves[0].ev.at(t), offs[0].at(t)], deviation };
}

function build(g: SketchGeometry, item: Pick<SketchOffset, 'base' | 'closed' | 'distances' | 'tolerance'>, quick: boolean): Built | { error: string } {
    const parts: ChainPart[] = [];
    for (const b of item.base) {
        const c = curveOf(g, b.curve);
        if (!c) {
            return { error: 'A curve of the offset chain is gone.' };
        }
        parts.push({ curve: c, reversed: !!b.reversed });
    }
    const curves = chainCurves(g, parts);
    if (!curves) {
        const rational = parts.some((p) => p.curve.kind === 'styleSpline' && p.curve.weights?.some((w) => w !== 1));
        return { error: rational ? 'Offset does not work on rational style splines (with control vertex weights) yet: make it non-rational in its form first.'
            : 'A curve of the offset chain is missing a point.' };
    }
    const tolerance = quick ? Math.max(item.tolerance, QUICK_TOLERANCE) : item.tolerance;
    const sides: BuiltSide[] = [];
    let deviation = 0;
    for (const d of item.distances) {
        const r = buildSide(curves, !!item.closed, d, tolerance, quick);
        if ('error' in r) {
            return r;
        }
        sides.push(r);
        deviation = Math.max(deviation, r.deviation);
    }
    const last = curves[curves.length - 1].ev;
    const ends: [Pt, Pt] | null = item.closed ? null : [curves[0].ev.at(curves[0].ev.t0), last.at(last.t1)];
    return { sides, ends, deviation };
}

/** A short fingerprint of what the offset is built from: the chain's points and the settings. */
function keyOf(g: SketchGeometry, item: SketchOffset): string {
    let h = 2166136261;
    const feed = (s: string) => {
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
    };
    for (const b of item.base) {
        const c = curveOf(g, b.curve);
        feed(JSON.stringify(c ?? b.curve));
        for (const id of c ? curveChainPoints(c) : []) {
            const p = pointOf(g, id);
            feed(p ? `${p.u},${p.v};` : '-');
        }
    }
    feed(JSON.stringify([item.distances, item.cap ?? '', item.tolerance, !!item.construction]));
    return (h >>> 0).toString(36);
}

/** Every point a curve's shape depends on (its own points). */
function curveChainPoints(c: SketchCurve): string[] {
    const ids: string[] = [];
    for (const v of Object.values(c)) {
        if (typeof v === 'string' && v !== c.id && v !== c.kind) {
            ids.push(v);
        } else if (Array.isArray(v)) {
            ids.push(...v.filter((x): x is string => typeof x === 'string'));
        }
    }
    // A spline's handles at inner points (sketchSplines.ts) shape it too.
    if (c.kind === 'spline') {
        ids.push(...(c.handles ?? []).map((h) => h.handle));
    }
    return ids;
}

/** Whether a curve was copied in from the model or another sketch (its points carry those locks). */
function takenFromModel(g: SketchGeometry, c: SketchCurve): boolean {
    const ids = curveChainPoints(c).filter((id) => pointOf(g, id));
    const locked = new Set(g.constraints.flatMap((k) => (k.kind === 'fix' && (isModelLock(k) || sketchLockSource(k)) ? [k.point] : [])));
    return ids.length > 0 && ids.every((id) => locked.has(id));
}

/**
 * Writes a built offset as the item's curves: its old curves go (the ribs stay, moved, so their dimensions stay) and
 * the new ones come in, fixed (a one-sided arc cap's centre is free: it is held halfway along its rib).
 */
function write(g: SketchGeometry, item: SketchOffset, built: Built): { g: SketchGeometry; item: SketchOffset } {
    const ribCount = item.dimensions ? item.distances.length : 0;
    const ribCurves = item.curves.slice(0, ribCount);
    const ribPoints = item.points.slice(0, ribCount * 2);
    const keepCurves = new Set(ribCurves);
    const keepPoints = new Set(ribPoints);
    const gone = new Set([...item.curves, ...item.points].filter((id) => !keepCurves.has(id) && !keepPoints.has(id)));
    let out: SketchGeometry = {
        ...g,
        points: g.points.filter((p) => !gone.has(p.id)),
        curves: g.curves.filter((c) => !gone.has(c.id)),
        constraints: g.constraints.filter((k) => !constraintRefs(k).some((r) => gone.has(r))),
    };
    const curves: string[] = [];
    const points: string[] = [];
    const extra: NewConstraint[] = [];
    const point = (at: Pt, fixed = true): string => {
        const id = newId('p', out);
        const p: SketchPoint = { id, u: at[0] + 0, v: at[1] + 0, ...(fixed ? { fixed: true } : {}) };
        out = { ...out, points: [...out.points, p] };
        points.push(id);
        return id;
    };
    const curve = (c: NewCurve): string => {
        const id = newId('c', out);
        out = { ...out, curves: [...out.curves, { ...c, id } as SketchCurve] };
        curves.push(id);
        return id;
    };
    const moveTo = (id: string, at: Pt) => {
        out = { ...out, points: out.points.map((p) => (p.id === id ? { ...p, u: at[0] + 0, v: at[1] + 0 } : p)) };
    };
    // The ribs carry the dimensions: the same ids, moved to where the offset now is.
    const ribs: string[] = [];
    const ribIds: string[] = [];
    if (item.dimensions) {
        built.sides.forEach((side, k) => {
            if (ribCurves[k] && curveOf(out, ribCurves[k]) && pointOf(out, ribPoints[2 * k]) && pointOf(out, ribPoints[2 * k + 1])) {
                moveTo(ribPoints[2 * k], side.rib[0]);
                moveTo(ribPoints[2 * k + 1], side.rib[1]);
                ribs.push(ribCurves[k]);
                ribIds.push(ribPoints[2 * k], ribPoints[2 * k + 1]);
            } else {
                const [a, b] = [point(side.rib[0]), point(side.rib[1])];
                ribs.push(curve({ kind: 'line', a, b, construction: true }));
                ribIds.push(a, b);
                // Kept in their own lists, ahead of the rest.
                points.splice(points.length - 2, 2);
                curves.pop();
            }
        });
    }
    const baseFlags = item.base.map((b) => {
        const c = curveOf(g, b.curve);
        return !!item.construction || (!!c?.construction && !takenFromModel(g, c));
    });
    const sideEnds: [string, string][] = [];
    for (const side of built.sides) {
        let first: string | null = null;
        let prev: string | null = null;
        side.pieces.forEach((piece, i) => {
            const [pa, pb] = piece.kind === 'spline' ? [piece.points[0], piece.points[piece.points.length - 1]] : [piece.a, piece.b];
            const a = prev ?? point(pa);
            first ??= a;
            const closing = !!item.closed && i === side.pieces.length - 1;
            const b = closing ? first : point(pb);
            const construction = baseFlags[i] ? { construction: true } : {};
            if (piece.kind === 'line') {
                curve({ kind: 'line', a, b, ...construction });
            } else if (piece.kind === 'arc') {
                const c = point(piece.c);
                curve(piece.ccw ? { kind: 'arc', center: c, start: a, end: b, ...construction } : { kind: 'arc', center: c, start: b, end: a, ...construction });
            } else {
                const inner = piece.points.slice(1, -1).map((q) => point(q));
                const startHandle = piece.start ? point(piece.start) : undefined;
                const endHandle = piece.end ? point(piece.end) : undefined;
                curve({
                    kind: 'spline', points: [a, ...inner, piece.closed ? a : b], ...construction,
                    ...(startHandle ? { startHandle } : {}), ...(endHandle ? { endHandle } : {}),
                });
            }
            prev = b;
        });
        sideEnds.push([first!, prev!]);
    }
    // Caps join the ends of an open chain's offset: across both sides, or to the chain's own ends.
    if (item.cap && built.ends && !item.closed) {
        const flag = item.construction ? { construction: true } : {};
        const baseEnds = (() => {
            const firstPart = item.base[0];
            const lastPart = item.base[item.base.length - 1];
            const c0 = curveOf(g, firstPart.curve)!;
            const c1 = curveOf(g, lastPart.curve)!;
            return [curveEndIds(c0)[firstPart.reversed ? 1 : 0], curveEndIds(c1)[lastPart.reversed ? 0 : 1]];
        })();
        // Out of the chain at each end.
        const curvesOf = chainCurves(g, item.base.map((b) => ({ curve: curveOf(g, b.curve)!, reversed: !!b.reversed })))!;
        const [ev0, ev1] = [curvesOf[0].ev, curvesOf[curvesOf.length - 1].ev];
        const outward: [Pt, Pt] = [
            (() => {
                const u = tangentAt(ev0, ev0.t0);
                return [-u[0], -u[1]] as Pt;
            })(),
            tangentAt(ev1, ev1.t1),
        ];
        for (const e of [0, 1] as const) {
            const across = built.sides.length === 2;
            const p = across ? sideEnds[0][e] : baseEnds[e];
            const q = across ? sideEnds[1][e] : sideEnds[0][e];
            if (item.cap === 'lines') {
                curve({ kind: 'line', a: p, b: q, ...flag });
                continue;
            }
            const [pp, qq] = [P(out, p)!, P(out, q)!];
            const m: Pt = [(pp[0] + qq[0]) / 2, (pp[1] + qq[1]) / 2];
            // Counter-clockwise from start to end: the middle of the half circle is the start turned a quarter left.
            const turned: Pt = [-(pp[1] - m[1]), pp[0] - m[0]];
            const pFirst = turned[0] * outward[e][0] + turned[1] * outward[e][1] > 0;
            if (across) {
                const c = point(m);
                curve({ kind: 'arc', center: c, start: pFirst ? p : q, end: pFirst ? q : p, ...flag });
            } else {
                // From the chain's own end: the centre is free, held halfway along a rib, so the end can still move.
                const rib = curve({ kind: 'line', a: p, b: q, construction: true });
                const c = point(m, false);
                curve({ kind: 'arc', center: c, start: pFirst ? p : q, end: pFirst ? q : p, ...flag });
                extra.push({ kind: 'pointOnCurve', point: c, curve: rib });
            }
        }
    }
    for (const k of extra) {
        const id = newId('k', out);
        out = { ...out, constraints: [...out.constraints, { ...k, id } as SketchConstraint] };
    }
    const next: SketchOffset = { ...item, curves: [...ribs, ...curves], points: [...ribIds, ...points], deviation: built.deviation };
    next.key = keyOf(out, next);
    return { g: out, item: next };
}

function putItem(g: SketchGeometry, item: SketchOffset): SketchGeometry {
    const list = g.offsets ?? [];
    return { ...g, offsets: list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item] };
}

function freeItemId(g: SketchGeometry): string {
    const used = new Set((g.offsets ?? []).map((x) => x.id));
    let n = 1;
    while (used.has(`of${n}`)) {
        n += 1;
    }
    return `of${n}`;
}

// ---- The tool ------------------------------------------------------------------------------------------------

export interface CurveOffsetOptions {
    /** Positive to the left of the first picked curve's chain, negative to the right. */
    distance: number;
    chain?: boolean;
    both?: boolean;
    cap?: 'none' | 'arcs' | 'lines';
    dimension?: boolean;
    baseConstruction?: boolean;
    offsetConstruction?: boolean;
    /** A preview: built quickly, to a coarser tolerance. */
    preview?: boolean;
}

/**
 * Offsets the picked chains that hold ellipses, splines, parabolas or conics: each becomes an offset item, built now
 * and rebuilt whenever its chain changes. `ids` are the picked curves of those chains.
 */
export function offsetCurveChains(g: SketchGeometry, ids: string[], o: CurveOffsetOptions): { g: SketchGeometry; created: string[]; deviation: number } | { error: string } {
    const allowed = o.chain === false ? new Set(ids) : undefined;
    const seen = new Set<string>();
    let out = g;
    const created: string[] = [];
    let deviation = 0;
    for (const id of ids) {
        if (seen.has(id) || !curveOf(g, id)) {
            continue;
        }
        const { parts, closed } = curveChain(g, id, allowed);
        parts.forEach((p) => seen.add(p.curve.id));
        if (!parts.length) {
            continue;
        }
        if (parts.some((p) => offsetOf(g, p.curve.id))) {
            return { error: 'An offset of a spline cannot be offset again (as in SolidWorks): offset the original curves.' };
        }
        // The distance is to the left of the picked curve's way; the chain may run the other way past it.
        const picked = parts.find((p) => p.curve.id === id)!;
        const d = picked.reversed ? -o.distance : o.distance;
        const item: SketchOffset = {
            id: freeItemId(out),
            base: parts.map((p) => ({ curve: p.curve.id, ...(p.reversed ? { reversed: true } : {}) })),
            ...(closed ? { closed: true } : {}),
            distances: o.both ? [d, -d] : [d],
            ...(o.cap && o.cap !== 'none' && !closed ? { cap: o.cap } : {}),
            ...(o.offsetConstruction ? { construction: true } : {}),
            tolerance: OFFSET_TOLERANCE,
            curves: [],
            points: [],
            ...(o.dimension !== false ? { dimensions: [] } : {}),
        };
        const built = build(out, item, !!o.preview);
        if ('error' in built) {
            return built;
        }
        const r = write(out, item, built);
        out = r.g;
        let next = r.item;
        if (o.dimension !== false) {
            // One driven dimension per side, on its rib.
            const dims: string[] = [];
            next.distances.forEach((dd, k) => {
                const kid = newId('k', out);
                out = { ...out, constraints: [...out.constraints, { id: kid, kind: 'length', line: next.curves[k], value: Math.abs(dd), driven: true }] };
                dims.push(kid);
            });
            next = { ...next, dimensions: dims };
        }
        out = putItem(out, next);
        created.push(...next.curves.slice(next.dimensions?.length ?? 0));
        deviation = Math.max(deviation, built.deviation);
    }
    if (o.baseConstruction) {
        const base = new Set((out.offsets ?? []).filter((x) => !(g.offsets ?? []).some((y) => y.id === x.id)).flatMap((x) => x.base.map((b) => b.curve)));
        out = { ...out, curves: out.curves.map((c) => (base.has(c.id) ? { ...c, construction: true } : c)) };
    }
    return { g: out, created, deviation };
}

// ---- Keeping offsets with their chains -----------------------------------------------------------------------

/** Whether a dimension is the distance of an offset item (driven, but a typed value sets the distance). */
export function isOffsetDimension(g: SketchGeometry, id: string): boolean {
    return (g.offsets ?? []).some((x) => x.dimensions?.includes(id));
}

/** The offset item that owns a curve, if any. */
export function offsetOf(g: SketchGeometry, curve: string): SketchOffset | null {
    return (g.offsets ?? []).find((x) => x.curves.includes(curve)) ?? null;
}

/** Lets an item go: its curves stay as plain geometry, their points free. */
function release(g: SketchGeometry, item: SketchOffset): SketchGeometry {
    const own = new Set(item.points);
    return {
        ...g,
        points: g.points.map((p) => (own.has(p.id) && p.fixed ? (({ fixed: _, ...rest }) => rest)(p) : p)),
        offsets: (g.offsets ?? []).filter((x) => x.id !== item.id),
    };
}

/**
 * Rebuilds every offset whose chain changed (or whose dimension was given a new value) since it was built; an offset
 * whose chain is gone becomes plain geometry. `quick`: while dragging, to the coarser tolerance (the next full
 * rebuild makes it exact again).
 */
export function refreshOffsets(g: SketchGeometry, quick = false): SketchGeometry {
    if (!g.offsets?.length) {
        return g;
    }
    let out = g;
    let changed = false;
    for (const item0 of g.offsets) {
        let item = item0;
        if (item.base.some((b) => !curveOf(out, b.curve)) || item.curves.some((c) => !curveOf(out, c))) {
            out = release(out, item);
            changed = true;
            continue;
        }
        // A value typed into a side's dimension is that side's distance.
        const typed = item.distances.map((d, k) => {
            const k2 = item.dimensions?.[k];
            const c = k2 ? out.constraints.find((x) => x.id === k2) : undefined;
            return c?.kind === 'length' && c.value > 0 && Math.abs(c.value - Math.abs(d)) > 1e-9 ? Math.sign(d || 1) * c.value : d;
        });
        if (typed.some((d, k) => d !== item.distances[k])) {
            item = { ...item, distances: typed };
        }
        // Built from this chain already (while dragging, a quick build will do).
        const key = keyOf(out, item);
        if (item === item0 && (item.key === key || (quick && item.key === `q${key}`))) {
            continue;
        }
        const built = build(out, item, quick);
        if ('error' in built) {
            // It cannot follow (the distance is too big now): it stays as it was.
            continue;
        }
        const r = write(out, item, built);
        out = putItem(r.g, quick ? { ...r.item, key: `q${r.item.key}` } : r.item);
        changed = true;
    }
    return changed ? withDrivenValues(out) : g;
}
