// Solving a drag on a big sketch. When a drag lets the whole sketch move (the last of the sketcher's tries), only the
// part of the sketch joined to the dragged points (through free points, curves and relations) is handed to the solver:
// nothing else shares a value with them, so nothing else can move, and the result is the same for much less work (the
// solver checks all it is given for redundancy on every solve, which grows fast with the size of the sketch). The
// tries that hold points are solved whole, as before, but one the solver refused is not tried again in the same drag.

import type { SketchGeometry } from '@jarvis/core';
import { ORIGIN, solveGeometry, type Drag, type SolveResult } from './solver';
import { constraintRefs } from './sketchGeometry';
import { curvePointIds } from './sketchCurves';
import { solvesWhole } from './solverHooks';

export interface JoinedPart {
    points: Set<string>;
    curves: Set<string>;
    constraints: Set<string>;
    /** Points in `points` the solve cannot move (fixed or held): they bound the part. */
    edge: Set<string>;
}

const add = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
};

/** The points, curves and relations a solve that moves `start` can change or needs, stopping at fixed and held points. */
export function joinedPart(g: SketchGeometry, start: string[], hold?: ReadonlySet<string>): JoinedPart {
    const fixed = new Set(g.points.filter((p) => p.fixed).map((p) => p.id));
    const pointIds = new Set(g.points.map((p) => p.id));
    const curveById = new Map(g.curves.map((c) => [c.id, c]));
    const curvesOn = new Map<string, string[]>();
    for (const c of g.curves) {
        for (const id of curvePointIds(c)) {
            add(curvesOn, id, c.id);
        }
    }
    const constraintById = new Map(g.constraints.map((k) => [k.id, k]));
    const constraintsOn = new Map<string, string[]>();
    for (const k of g.constraints) {
        for (const id of constraintRefs(k)) {
            add(constraintsOn, id, k.id);
        }
    }
    const part: JoinedPart = { points: new Set(), curves: new Set(), constraints: new Set(), edge: new Set() };
    const queue: string[] = [];
    const point = (id: string) => {
        if (part.points.has(id) || (!pointIds.has(id) && id !== ORIGIN)) {
            return;
        }
        part.points.add(id);
        if (id === ORIGIN || fixed.has(id) || hold?.has(id)) {
            part.edge.add(id);
        } else {
            queue.push(id);
        }
    };
    const curve = (id: string) => {
        const c = curveById.get(id);
        if (!c || part.curves.has(id)) {
            return;
        }
        part.curves.add(id);
        curvePointIds(c).forEach(point);
        (constraintsOn.get(id) ?? []).forEach(constraint);
    };
    const constraint = (id: string) => {
        const k = constraintById.get(id);
        if (!k || part.constraints.has(id)) {
            return;
        }
        part.constraints.add(id);
        for (const ref of constraintRefs(k)) {
            if (curveById.has(ref)) {
                curve(ref);
            } else {
                point(ref);
            }
        }
    };
    start.forEach(point);
    while (queue.length) {
        const id = queue.pop()!;
        (curvesOn.get(id) ?? []).forEach(curve);
        (constraintsOn.get(id) ?? []).forEach(constraint);
    }
    return part;
}

/** The rest of the sketch solved on its own, once per drag: keyed by an object the drag keeps (its grab point). */
const rests = new WeakMap<object, Map<string, SolveResult>>();
/** The same rest with all its points held, for the held tries, once per drag. */
const heldRests = new WeakMap<object, Map<string, SolveResult>>();
/** The held tries the solver refused, per drag. */
const refusals = new WeakMap<object, Set<string>>();

function keptFor(store: WeakMap<object, Map<string, SolveResult>>, key: object, part: JoinedPart, make: () => SolveResult): SolveResult {
    let known = store.get(key);
    if (!known) {
        known = new Map();
        store.set(key, known);
    }
    const id = [...part.points].filter((p) => !part.edge.has(p)).sort().join(' ');
    let rest = known.get(id);
    if (!rest) {
        rest = make();
        known.set(id, rest);
    }
    return rest;
}

/** The rest keeps the fixed points it shares with the part: its relations may refer to them. */
function restGeometry(g: SketchGeometry, part: JoinedPart): SketchGeometry {
    return {
        points: g.points.filter((p) => !part.points.has(p.id) || part.edge.has(p.id)),
        curves: g.curves.filter((c) => !part.curves.has(c.id)),
        constraints: g.constraints.filter((k) => !part.constraints.has(k.id)),
    };
}

function restOf(g: SketchGeometry, part: JoinedPart, key: object): SolveResult {
    return keptFor(rests, key, part, () => solveGeometry(restGeometry(g, part)));
}

// Stand-ins of the held tries (see solveHeld). Ids no sketch uses.
const SPARE = 'drag~spare';
const STAND_A = 'drag~a';
const STAND_B = 'drag~b';
const STAND = 'drag~held';

/**
 * The rest with every point held, as a held try holds it. A free point no relation uses is added: in the whole sketch
 * the dragged points are free, and the solver judges relations among held points only in a system with something free.
 */
function heldRestOf(g: SketchGeometry, part: JoinedPart, key: object): SolveResult {
    return keptFor(heldRests, key, part, () => {
        const rest = restGeometry(g, part);
        const r = solveGeometry({ ...rest, points: [...rest.points, { id: SPARE, u: 0, v: 0 }] }, { targets: [], hold: new Set(rest.points.map((p) => p.id)) });
        return { ...r, dof: r.dof - 2, geometry: { ...r.geometry, points: r.geometry.points.filter((p) => p.id !== SPARE) } };
    });
}

/** The part joined to the dragged points, once per drag (a drag changes no relation). */
const joined = new WeakMap<object, Map<string, JoinedPart>>();

function joinedOnce(g: SketchGeometry, start: string[], key: object): JoinedPart {
    let known = joined.get(key);
    if (!known) {
        known = new Map();
        joined.set(key, known);
    }
    const id = [...start].sort().join(' ');
    let part = known.get(id);
    if (!part) {
        part = joinedPart(g, start);
        known.set(id, part);
    }
    return part;
}

const solvedWhole = (g: SketchGeometry) => (g.inserts?.length && g.blocks?.length) || g.paths?.length || solvesWhole(g);

const covers = (g: SketchGeometry, part: JoinedPart) => part.curves.size === g.curves.length && part.constraints.size === g.constraints.length
    && g.points.every((p) => part.points.has(p.id));

/**
 * A held try, solved on the part the drag joins (all a held try can move lies in it) with the rest solved once per drag
 * with its points held, where the whole sketch solved together gives the same: the part and the rest share no unknown.
 * One judgement of the solver joins them: when it finds relations redundant (relations among held points always are),
 * it checks them with the pull held exactly, and where that fails it calls them conflicting, so the whole try fails
 * when the pull cannot be met exactly and the rest has such a relation. A stand-in relation between two held points of
 * the part's own brings that check into the part's solve.
 */
function solveHeld(g: SketchGeometry, drag: Drag, key: object): SolveResult {
    if (solvedWhole(g)) {
        return solveGeometry(g, drag);
    }
    const part = joinedOnce(g, drag.targets.map((t) => t.point), key);
    if (covers(g, part)) {
        return solveGeometry(g, drag);
    }
    const rest = heldRestOf(g, part, key);
    if (!rest.ok) {
        return { ...rest, geometry: g };
    }
    // (The solver's own relations of curves, an arc's, can be redundant too, but are never ours to call conflicting.)
    const stand = rest.redundant.length > 0;
    const r = solveGeometry({
        points: [...g.points.filter((p) => part.points.has(p.id)), ...(stand ? [{ id: STAND_A, u: 0, v: 0, fixed: true }, { id: STAND_B, u: 0, v: 0, fixed: true }] : [])],
        curves: g.curves.filter((c) => part.curves.has(c.id)),
        constraints: [...g.constraints.filter((k) => part.constraints.has(k.id)), ...(stand ? [{ id: STAND, kind: 'coincident' as const, a: STAND_A, b: STAND_B }] : [])],
    }, drag);
    const conflicting = r.conflicting.filter((id) => id !== STAND);
    const redundant = r.redundant.filter((id) => id !== STAND);
    if (!r.ok) {
        return { ...r, geometry: g, dof: r.dof + rest.dof, conflicting, redundant };
    }
    const points = new Map(r.geometry.points.map((p) => [p.id, p]));
    const curves = new Map([...rest.geometry.curves, ...r.geometry.curves].map((c) => [c.id, c]));
    const constraints = new Map([...rest.geometry.constraints, ...r.geometry.constraints].map((k) => [k.id, k]));
    const changed = g.constraints.some((k) => (constraints.get(k.id) ?? k) !== k);
    return {
        ...r,
        dof: r.dof + rest.dof,
        conflicting: [...conflicting, ...rest.conflicting],
        redundant: [...redundant, ...rest.redundant],
        geometry: {
            ...g,
            points: g.points.map((p) => points.get(p.id) ?? p),
            curves: g.curves.map((c) => curves.get(c.id) ?? c),
            constraints: changed ? g.constraints.map((k) => constraints.get(k.id) ?? k) : g.constraints,
        },
    };
}

/**
 * solveGeometry(g, drag) for a drag. A drag that lets the whole sketch move solves only the part joined to the dragged
 * points; it fails where the whole solve would and gives the whole solve's degrees of freedom (the rest, which cannot
 * move, is solved once per drag: `key`). A drag that holds points is solved on the same part, with the solver's
 * judgement of the relations among the held points kept as the whole solve makes it (see solveHeld).
 */
export function solveDrag(g: SketchGeometry, drag: Drag, key: object): SolveResult {
    if (drag.hold) {
        // A held try the solver refused once in a drag is not tried again: what it refuses (relations that cannot all
        // hold with the pull) follows from the relations and what is held; only the exact spot of the pull could
        // change it, a coincidence a drag does not meet.
        const id = `held ${g.points.filter((p) => !drag.hold!.has(p.id)).map((p) => p.id).sort().join(' ')}`;
        const refused = refusals.get(key);
        if (refused?.has(id)) {
            return { geometry: g, dof: -1, ok: false, conflicting: [], redundant: [] };
        }
        const r = solveHeld(g, drag, key);
        if (!r.ok) {
            refusals.set(key, new Set([...(refused ?? []), id]));
        }
        return r;
    }
    // Block instances (rigid bodies), paths, equation curves and linked fit splines are held through the sketch's
    // items, not by its relations: a part cut out by relations alone would leave them out, so such a sketch is solved
    // whole.
    if (solvedWhole(g)) {
        return solveGeometry(g, drag);
    }
    const part = joinedOnce(g, drag.targets.map((t) => t.point), key);
    if (covers(g, part)) {
        return solveGeometry(g, drag);
    }
    const rest = restOf(g, part, key);
    if (!rest.ok) {
        return { ...rest, geometry: g };
    }
    const r = solveGeometry({
        points: g.points.filter((p) => part.points.has(p.id)),
        curves: g.curves.filter((c) => part.curves.has(c.id)),
        constraints: g.constraints.filter((k) => part.constraints.has(k.id)),
    }, drag);
    if (!r.ok) {
        return { ...r, geometry: g };
    }
    const points = new Map(r.geometry.points.map((p) => [p.id, p]));
    const curves = new Map(r.geometry.curves.map((c) => [c.id, c]));
    // Driven dimensions take new values; the list stays the same object when none did, as after a full solve.
    const constraints = new Map(r.geometry.constraints.map((k) => [k.id, k]));
    const driven = g.constraints.some((k) => (constraints.get(k.id) ?? k) !== k);
    return {
        ...r,
        dof: r.dof + rest.dof,
        geometry: {
            ...g,
            points: g.points.map((p) => points.get(p.id) ?? p),
            curves: g.curves.map((c) => curves.get(c.id) ?? c),
            constraints: driven ? g.constraints.map((k) => constraints.get(k.id) ?? k) : g.constraints,
        },
    };
}
