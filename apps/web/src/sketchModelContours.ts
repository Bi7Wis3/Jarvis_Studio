// The model edges a sketch on a face can use as contour boundaries (SolidWorks: Selected Contours may include model
// edges; Close Sketch to Model closes an open profile whose ends lie on the edges of one face). The kernel gives the
// loops of the body's flat faces in the sketch plane (query `planeFaces`); here they are split where sketch points lie
// on them, so a profile ending on an edge and the edge between its ends make a closed area.

import { create } from 'zustand';
import type { SketchGeometry, SketchRegion } from '@jarvis/core';
import { ellipseAt, ellipseAxes, ellipseParam, type EllipseAxes } from '@jarvis/core/curves';
import type { ModelCurve, ModelSketch, P2, TaggedCurve } from '@jarvis/core/projection';
import { ORIGIN, pointOf } from './solver';
import { geometryEntities } from './sketchGeometry';
import { curveEndIds } from './sketchCurves';
import { sketchRegions } from './sketchRegions';
import { addModelCurves, curveEntity, edgesKey, fetchModelSketch, modelTarget, type ModelTarget } from './sketchModel';
import { mergePoints } from './sketchRepair';
import { dist, entityPoints, inside, profilePoints, type Entity, type Pt } from './sketchMath';
import { useStudio } from './state';
import { useSketcher } from './sketcher';
import { regionsOf } from './regionPick';

/** A sketch point this close (mm) to a model edge lies on it. */
export const ON_EDGE = 1e-3;
const SAME = 1e-9;
const TAU = 2 * Math.PI;

// ---- Model curves by parameter ----------------------------------------------------------------------------------

/** How a model curve runs from parameter 0 to 1 (its own direction), and its pieces between two parameters. */
interface Param {
    at: (t: number) => P2;
    /** The parameter of `p` on the curve (0 to 1), or null when it is not on it. */
    find: (p: P2) => number | null;
    /** The piece from t0 to t1 (t0 < t1; past 1 for a closed curve); null when it cannot be cut there. */
    piece: (t0: number, t1: number) => ModelCurve | null;
    closed: boolean;
}

const ccwSweep = (from: number, to: number): number => {
    let d = (to - from) % TAU;
    if (d <= SAME) {
        d += TAU;
    }
    return d;
};
const angleIn = (from: number, a: number): number => ((((a - from) % TAU) + TAU) % TAU);

function conicParam(e: EllipseAxes, start: number, sweep: number, closed: boolean, circle: boolean, src: ModelCurve): Param {
    const at = (t: number): P2 => (circle
        ? [e.center[0] + e.a * Math.cos(start + sweep * t), e.center[1] + e.a * Math.sin(start + sweep * t)]
        : ellipseAt(e, start + sweep * t));
    return {
        at,
        closed,
        find: (p) => {
            const phi = circle ? Math.atan2(p[1] - e.center[1], p[0] - e.center[0]) : ellipseParam(e, p);
            let d = angleIn(start, phi);
            if (closed && d > TAU - 1e-12) {
                d = 0;
            }
            const t = d / sweep;
            if (t > 1 + 1e-9) {
                // Just before the start of a partial curve counts as its start.
                return dist(at(0), p) <= ON_EDGE ? 0 : null;
            }
            return dist(at(Math.min(1, t)), p) <= ON_EDGE ? Math.min(1, t) : null;
        },
        piece: (t0, t1) => {
            if (t1 - t0 >= 1 - 1e-12 && closed) {
                return src;
            }
            const [a, b] = [at(t0), at(t1)];
            if (circle) {
                return { kind: 'arc', center: e.center, start: a, end: b };
            }
            const major: P2 = [e.center[0] + e.a * Math.cos(e.angle), e.center[1] + e.a * Math.sin(e.angle)];
            return { kind: 'ellipseArc', center: e.center, major, minor: e.b, start: a, end: b };
        },
    };
}

function paramOf(c: ModelCurve): Param {
    switch (c.kind) {
        case 'line': {
            const d: P2 = [c.b[0] - c.a[0], c.b[1] - c.a[1]];
            const l2 = d[0] * d[0] + d[1] * d[1] || 1;
            const at = (t: number): P2 => [c.a[0] + d[0] * t, c.a[1] + d[1] * t];
            return {
                at,
                closed: false,
                find: (p) => {
                    const t = ((p[0] - c.a[0]) * d[0] + (p[1] - c.a[1]) * d[1]) / l2;
                    const k = Math.max(0, Math.min(1, t));
                    return dist(at(k), p) <= ON_EDGE ? k : null;
                },
                piece: (t0, t1) => ({ kind: 'line', a: at(t0), b: at(t1) }),
            };
        }
        case 'circle':
            return conicParam({ center: c.center, a: c.radius, b: c.radius, angle: 0 }, 0, TAU, true, true, c);
        case 'arc': {
            const r = dist(c.center, c.start);
            const s = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
            const e = Math.atan2(c.end[1] - c.center[1], c.end[0] - c.center[0]);
            return conicParam({ center: c.center, a: r, b: r, angle: 0 }, s, ccwSweep(s, e), false, true, c);
        }
        case 'ellipse':
            return conicParam(ellipseAxes(c.center, c.major, c.minor), 0, TAU, true, false, c);
        case 'ellipseArc': {
            const e = ellipseAxes(c.center, c.major, c.minor);
            const s = ellipseParam(e, c.start);
            return conicParam(e, s, ccwSweep(s, ellipseParam(e, c.end)), false, false, c);
        }
        default: {
            // Splines and conics are used whole: they can be met only at their ends.
            const [a, b] = c.kind === 'conic' ? [c.start, c.end] : [c.poles[0], c.poles[c.poles.length - 1]];
            return {
                at: (t) => (t < 0.5 ? a : b),
                closed: false,
                find: (p) => (dist(p, a) <= ON_EDGE ? 0 : dist(p, b) <= ON_EDGE ? 1 : null),
                piece: (t0, t1) => (t0 <= SAME && t1 >= 1 - SAME ? c : null),
            };
        }
    }
}

// ---- Face loops as rings -----------------------------------------------------------------------------------------

interface Piece {
    curve: ModelCurve;
    p: Param;
    /** Run from the curve's end to its start. */
    rev: boolean;
}

export interface Ring {
    face: number;
    loop: number;
    pieces: Piece[];
}

const startOf = (x: Piece): P2 => x.p.at(x.rev ? 1 : 0);
const endOf = (x: Piece): P2 => x.p.at(x.rev ? 0 : 1);

/** The loops of the answer, each as its curves joined end to end round the loop; loops that do not close are left out. */
export function ringsOf(model: ModelSketch): Ring[] {
    const groups = new Map<string, TaggedCurve[]>();
    for (const c of model.curves) {
        const key = `${c.face ?? 0} ${c.loop ?? 0}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const rings: Ring[] = [];
    for (const [key, curves] of groups) {
        const [face, loop] = key.split(' ').map(Number);
        const left = curves.map((c): Piece => ({ curve: c, p: paramOf(c), rev: false }));
        const ring: Piece[] = [left.shift()!];
        while (left.length) {
            const end = endOf(ring[ring.length - 1]);
            const i = left.findIndex((x) => dist(startOf(x), end) <= ON_EDGE || dist(endOf(x), end) <= ON_EDGE);
            if (i < 0) {
                break;
            }
            const [next] = left.splice(i, 1);
            ring.push({ ...next, rev: dist(startOf(next), end) > ON_EDGE });
        }
        if (!left.length && dist(startOf(ring[0]), endOf(ring[ring.length - 1])) <= ON_EDGE) {
            rings.push({ face, loop, pieces: ring });
        }
    }
    return rings;
}

/** Where `p` lies on the ring: piece index plus the way along it (0 to 1, in the ring's direction); null when off it. */
export function ringPosition(ring: Ring, p: P2): number | null {
    for (let i = 0; i < ring.pieces.length; i++) {
        const x = ring.pieces[i];
        const t = x.p.find(p);
        if (t !== null) {
            return i + (x.rev ? 1 - t : t);
        }
    }
    return null;
}

/** The point of the ring at a position. */
export function ringPoint(ring: Ring, pos: number): P2 {
    const n = ring.pieces.length;
    const i = Math.min(n - 1, Math.floor(pos));
    const x = ring.pieces[i];
    const s = pos - i;
    return x.p.at(x.rev ? 1 - s : s);
}

/** The ring from position a forward to position b (round past its start if need be), as model curves. */
export function ringPath(ring: Ring, a: number, b: number): ModelCurve[] | { error: string } {
    const n = ring.pieces.length;
    if (n === 1 && ring.pieces[0].p.closed) {
        const x = ring.pieces[0];
        const [s0, s1] = [a, b > a ? b : b + 1];
        // A closed curve's parameter runs on past a turn.
        const piece = x.rev ? x.p.piece(1 - s1, 1 - s0) : x.p.piece(s0, s1);
        return piece ? [piece] : { error: 'that model edge cannot be split there' };
    }
    const span = b > a ? b - a : n - a + b;
    const out: ModelCurve[] = [];
    for (let k = 0; k <= n; k++) {
        const i = (Math.floor(a) + k) % n;
        const base = Math.floor(a) + k;
        const s0 = Math.max(0, a - base);
        const s1 = Math.min(1, a + span - base);
        if (s1 - s0 <= 1e-12) {
            if (a + span - base <= 0) {
                break;
            }
            continue;
        }
        const x = ring.pieces[i];
        const piece = x.rev ? x.p.piece(1 - s1, 1 - s0) : x.p.piece(s0, s1);
        if (!piece) {
            return { error: 'a spline or conic model edge can only be used whole: end the profile at its ends' };
        }
        out.push(piece);
    }
    return out;
}

// ---- The faces of the open sketch --------------------------------------------------------------------------------

interface PlaneFacesState {
    known: Record<string, ModelSketch | 'loading' | { error: string }>;
}

export const usePlaneFaces = create<PlaneFacesState>(() => ({ known: {} }));

/** The targets already asked for (the answer may not be in the store yet). */
const asked = new Set<string>();

function targetNow(): { target: ModelTarget; key: string } | null {
    const s = useSketcher.getState();
    const target = s.active && s.stage === 'draw' ? modelTarget(s) : null;
    return target ? { target, key: edgesKey(target, useStudio.getState().meshes.keys[target.partId] ?? null) } : null;
}

/** The loops of the faces the open sketch lies on; null while they load or when there is no model. Loads on first use. */
export function planeFacesNow(): ModelSketch | null {
    const t = targetNow();
    if (!t) {
        return null;
    }
    const known = usePlaneFaces.getState().known[t.key];
    if (known === undefined && !asked.has(t.key)) {
        asked.add(t.key);
        // Often asked while a component renders: the store changes after it.
        queueMicrotask(() => usePlaneFaces.setState((s) => ({ known: { ...s.known, [t.key]: s.known[t.key] ?? 'loading' } })));
        fetchModelSketch(t.target, { kind: 'planeFaces' }).then(
            (model) => usePlaneFaces.setState((s) => ({ known: { ...s.known, [t.key]: model } })),
            (e: unknown) => usePlaneFaces.setState((s) => ({ known: { ...s.known, [t.key]: { error: e instanceof Error ? e.message : String(e) } } })),
        );
        return null;
    }
    return typeof known === 'object' && 'curves' in known ? known : null;
}

/** Whether the faces of the open sketch are still loading, and why they could not be read. */
export function planeFacesStatus(): { loading: boolean; error: string | null } {
    const t = targetNow();
    const known = t ? usePlaneFaces.getState().known[t.key] : undefined;
    return { loading: known === 'loading', error: known && typeof known === 'object' && 'error' in known ? known.error : null };
}

// ---- Regions bounded by model edges ------------------------------------------------------------------------------

/** The face loops cut where sketch end points lie on them, as entities for the region finder. */
export function boundaryEntities(model: ModelSketch, cuts: P2[]): Entity[] {
    const out: Entity[] = [];
    ringsOf(model).forEach((ring, r) => {
        const at = [...new Set(cuts.map((p) => ringPosition(ring, p)).filter((x): x is number => x !== null)
            .map((x) => Math.round(x * 1e9) / 1e9))].sort((a, b) => a - b);
        // Each whole piece's ends cut it too, so the pieces stay as the kernel gave them.
        const marks = [...new Set([...ring.pieces.map((_, i) => i), ...at])].sort((a, b) => a - b);
        const n = ring.pieces.length;
        const closedAlone = n === 1 && ring.pieces[0].p.closed;
        if (closedAlone && at.length < 2) {
            out.push({ ...curveEntity(ring.pieces[0].curve), id: `model:${r}:0` } as Entity);
            return;
        }
        const stops = closedAlone ? at : marks;
        stops.forEach((a, k) => {
            const b = stops[(k + 1) % stops.length];
            const path = ringPath(ring, a, b);
            if ('error' in path) {
                return;
            }
            path.forEach((c, j) => out.push({ ...curveEntity(c), id: `model:${r}:${k}:${j}` } as Entity));
        });
    });
    return out;
}

const SKETCH_END = (g: SketchGeometry): P2[] => [...new Set(g.curves.filter((c) => !c.construction).flatMap(curveEndIds))].flatMap((id) => {
    const p = id === ORIGIN ? { u: 0, v: 0 } : pointOf(g, id);
    return p ? [[p.u, p.v] as P2] : [];
});

const sameRegion = (a: SketchRegion, b: SketchRegion): boolean => {
    const [pa, pb] = [profilePoints(a.loops[0]), profilePoints(b.loops[0])];
    return inside(a.at, pb) && inside(b.at, pa) && a.loops.length === b.loops.length;
};

/**
 * The sketch's own regions, then the areas that sketch curves and the model edges of the face close together (each
 * bounded by at least one model edge, and not already a region of the sketch alone).
 */
export function regionsWithModel(g: SketchGeometry, own: SketchRegion[], model: ModelSketch | null): SketchRegion[] {
    if (!model?.curves.length) {
        return own;
    }
    const sketch = geometryEntities(g, false);
    const ends = new Map<string, [string, string]>();
    for (const c of g.curves) {
        const e = curveEndIds(c);
        if (e.length === 2) {
            ends.set(c.id, [e[0], e[1]]);
        }
    }
    // Edges that sketch curves cross (not at a sketch point) would make no sound areas: those loops are left out.
    const boundary = boundaryEntities(model, SKETCH_END(g)).filter((e) => !crossesSketch(e, sketch, SKETCH_END(g)));
    if (!boundary.length) {
        return own;
    }
    const all = sketchRegions([...sketch, ...boundary], ends);
    // Only those with a model edge in their outline are new.
    const extra = all.filter((r) => !own.some((o) => sameRegion(o, r)) && touchesModel(r, boundary));
    return [...own, ...extra];
}

/** Regions of the open sketch for its features: its own, and with a model, those its face's edges help close. */
export function openSketchRegions(g: SketchGeometry): SketchRegion[] {
    return regionsWithModel(g, regionsOf(g), planeFacesNow());
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
    const r: Pt = [b[0] - a[0], b[1] - a[1]];
    const s: Pt = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) {
        return null;
    }
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + r[0] * t, a[1] + r[1] * t] : null;
}

/** Whether a sketch curve crosses the edge piece somewhere other than at a sketch end point. */
function crossesSketch(edge: Entity, sketch: Entity[], ends: P2[]): boolean {
    const e = entityPoints(edge);
    return sketch.some((k) => {
        const p = entityPoints(k);
        for (let i = 0; i + 1 < e.length; i++) {
            for (let j = 0; j + 1 < p.length; j++) {
                const x = segmentsCross(e[i], e[i + 1], p[j], p[j + 1]);
                if (x && !ends.some((q) => dist(q, x) < ON_EDGE * 20)) {
                    return true;
                }
            }
        }
        return false;
    });
}

/** Whether the region's outline runs along a model edge somewhere (a point of an edge piece lies on its outline). */
function touchesModel(r: SketchRegion, boundary: Entity[]): boolean {
    const outline = profilePoints(r.loops[0]);
    const near = (p: Pt) => outline.some((q, i) => {
        const n = outline[(i + 1) % outline.length];
        const d: Pt = [n[0] - q[0], n[1] - q[1]];
        const l2 = d[0] * d[0] + d[1] * d[1];
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - q[0]) * d[0] + (p[1] - q[1]) * d[1]) / l2)) : 0;
        return dist(p, [q[0] + d[0] * t, q[1] + d[1] * t]) < ON_EDGE * 10;
    });
    return boundary.some((e) => {
        const m = e.kind === 'line' ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] as Pt : e.kind === 'arc' || e.kind === 'curve' ? e.m : null;
        return !!m && near(m);
    });
}

// ---- Close sketch to model ---------------------------------------------------------------------------------------

export interface Closing {
    /** The open profile's curves and its two free end points. */
    chain: string[];
    ends: [string, string];
    /** The two ways round the face loop from one end to the other, as model curves; the first is the shorter. */
    paths: [ModelCurve[], ModelCurve[]];
    /** Where the ends go on the edge (they lie on it already, to within ON_EDGE). */
    at: [P2, P2];
}

function lengthOf(curves: ModelCurve[]): number {
    return curves.reduce((sum, c) => {
        const e = curveEntity(c);
        const pts = e.kind === 'line' ? [e.a, e.b] : e.kind === 'arc' ? [e.a, e.m, e.b] : e.kind === 'curve' ? [e.a, e.m, e.b] : [];
        return sum + pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
    }, 0);
}

/** The open profiles of the sketch: chains of curves from one free end to another, with no branch. */
export function openProfiles(g: SketchGeometry): { chain: string[]; ends: [string, string] }[] {
    const curves = g.curves.filter((c) => !c.construction && curveEndIds(c).length === 2);
    const root = new Map<string, string>();
    const find = (x: string): string => {
        while (root.has(x) && root.get(x) !== x) {
            x = root.get(x)!;
        }
        return x;
    };
    for (const k of g.constraints) {
        if (k.kind === 'coincident' && !k.suppressed && find(k.a) !== find(k.b)) {
            root.set(find(k.b), find(k.a));
        }
    }
    const at = new Map<string, { curve: string; end: string }[]>();
    for (const c of curves) {
        for (const end of curveEndIds(c)) {
            const key = find(end);
            at.set(key, [...(at.get(key) ?? []), { curve: c.id, end }]);
        }
    }
    const used = new Set<string>();
    const out: { chain: string[]; ends: [string, string] }[] = [];
    for (const [key, list] of at) {
        if (list.length !== 1 || used.has(list[0].curve)) {
            continue;
        }
        const chain: string[] = [];
        let v = key;
        let entry = list[0];
        let last = entry.end;
        for (;;) {
            chain.push(entry.curve);
            used.add(entry.curve);
            const c = curves.find((x) => x.id === entry.curve)!;
            const other = curveEndIds(c).find((e) => find(e) !== v) ?? curveEndIds(c)[1];
            v = find(other);
            last = other;
            const next = (at.get(v) ?? []).filter((x) => x.curve !== entry.curve);
            if (next.length !== 1 || used.has(next[0].curve)) {
                break;
            }
            entry = next[0];
        }
        if ((at.get(v) ?? []).length === 1) {
            out.push({ chain, ends: [list[0].end, last] });
        }
    }
    return out;
}

/** The open profile whose ends lie on one loop of a face in the sketch plane, and the two ways to close it. */
export function findClosing(g: SketchGeometry, model: ModelSketch): Closing | { error: string } {
    const profiles = openProfiles(g);
    if (!profiles.length) {
        return { error: 'The sketch has no open profile: Close sketch to model closes a profile whose two ends lie on model edges.' };
    }
    const rings = ringsOf(model);
    if (!rings.length) {
        return { error: 'No face of the model lies in the sketch plane: sketch on a face of the part to close a profile to its edges.' };
    }
    let reason = 'The ends of the open profile do not lie on the edges of one face: put both on the boundary of the face it is sketched on.';
    for (const { chain, ends } of profiles) {
        const [p, q] = ends.map((id) => {
            const x = pointOf(g, id);
            return x ? [x.u, x.v] as P2 : [0, 0] as P2;
        });
        for (const ring of rings) {
            const [a, b] = [ringPosition(ring, p), ringPosition(ring, q)];
            if (a === null || b === null || Math.abs(a - b) < 1e-9) {
                continue;
            }
            const one = ringPath(ring, a, b);
            const two = ringPath(ring, b, a);
            if ('error' in one || 'error' in two) {
                reason = `The profile cannot be closed: ${'error' in one ? one.error : (two as { error: string }).error}.`;
                continue;
            }
            const paths: [ModelCurve[], ModelCurve[]] = lengthOf(one) <= lengthOf(two) ? [one, two] : [two, one];
            return { chain, ends, paths, at: [ringPoint(ring, a), ringPoint(ring, b)] };
        }
    }
    return { error: reason };
}

/**
 * The sketch closed along the face's edges, the shorter way round (`reverse`: the other way). The pieces of edge come
 * in locked where they are, like converted entities, joined to the profile's ends.
 */
export function closeSketchWith(g: SketchGeometry, closing: Closing, reverse = false): SketchGeometry {
    // The ends go exactly onto the edge first.
    const moved: SketchGeometry = {
        ...g,
        points: g.points.map((p) => {
            const i = closing.ends.indexOf(p.id);
            return i >= 0 ? { ...p, u: closing.at[i][0], v: closing.at[i][1] } : p;
        }),
    };
    const before = new Set(moved.points.map((p) => p.id));
    let { g: out } = addModelCurves(moved, closing.paths[reverse ? 1 : 0], { lock: true });
    for (const [i, end] of closing.ends.entries()) {
        const fresh = out.points.find((p) => !before.has(p.id) && dist([p.u, p.v], closing.at[i]) <= SAME * 1e3);
        if (fresh) {
            out = mergePoints(out, end, fresh.id);
        }
    }
    return out;
}
