// The dimension tools and behaviours beyond plain Smart Dimension, on the sketcher state (see sketchDimGroups.ts for
// the geometry): Ordinate (Horizontal, Vertical, or decided by where the row goes) along an axis or an edge, Angular
// Running Dimension, Path Length (driving), locking the dimension type with a right-click, zero and negative values
// with Reverse direction, maintaining proportions with the first dimension, the over-defining dimension options,
// Break alignment, dragging the zero, Add to the same ordinate or running set, and Auto Insert Dimension.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, isDimension, measure, pointOf, solveGeometry, solverReady } from './solver';
import {
    chainOf, commitGeometry, dimensionAnchor, setSketchSettings, setTool, useSketcher,
} from './sketcher';
import { addConstraint, curveAt, dimensionFromPicks, evaluate, pickAt, type NewConstraint, type Pick } from './sketchGeometry';
import { overDefines } from './sketchDimensions';
import {
    drawnDimensions, firstDimensionScale, groupZeros, moveRing, moveRow, onRing, ordinateFrame, ordinateLabel, positionDimension,
    reverseTarget, rezeroed, runningFrame, sideOf, typedValue, type GroupZero,
} from './sketchDimGroups';
import { round, type Pt } from './sketchMath';
import { curvePointIds } from './sketchCurves';
import { solvesAtOnce } from './sketchSettings';
import { pathSelection } from './sketchPathModel';

type State = ReturnType<typeof useSketcher.getState>;
type Special = NonNullable<State['dimSpecial']>;

const get = () => useSketcher.getState();
const set = (patch: Partial<State>) => useSketcher.setState(patch);
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

/** Commits `g` and puts the new dimension's label where it goes; false (with the solver's message) when it does not solve. */
function commitWithLabel(g: SketchGeometry, id: string, label: Pt, patch: Partial<State> = {}): boolean {
    const labels = get().labels;
    if (!commitGeometry(g)) {
        return false;
    }
    set({ ...patch, labels: { ...labels, [id]: label } });
    return true;
}

// ---- Ordinate, angular running and path length tools ---------------------------------------------------------

/** The Ordinate Dimension tool: a zero, then the row (its side decides horizontal or vertical), then each point. */
export function setSmartOrdinateTool(): void {
    setTool('dimension');
    set({ dimLock: null, dimSpecial: { kind: 'ordinate', axis: 'u', auto: true }, message: 'Click the zero: a point, or a line (an edge) the others are measured from.' });
}

/** The Angular Running Dimension tool: a centre, the zero, the ring, then each point. */
export function setRunningTool(): void {
    setTool('dimension');
    set({ dimLock: null, dimSpecial: { kind: 'running' }, message: 'Click the centre the angles are measured about: a point, or an arc or circle.' });
}

/** Whether the next click of an ordinate, running or path length tool places (rather than picks). */
export function specialPlacing(s: State): boolean {
    const special = s.dimSpecial;
    if (!special) {
        return s.picks.length >= 2;
    }
    if (special.kind === 'path') {
        return s.picks.length > 0;
    }
    if (special.kind === 'running') {
        return !!special.zero && special.radius === undefined;
    }
    return !!special.zero && special.row === undefined;
}

/** What a click picks for these tools: a point right under it, else a curve. */
function pickFor(g: SketchGeometry, raw: Pt, tolerance: number): Pick | null {
    const near = pickAt(g, raw, tolerance * 0.7);
    return near?.type === 'point' ? near : curveAt(g, raw, tolerance * 2.4, tolerance * 0.8);
}

/** The point a pick stands for: the point itself, or an arc's or circle's centre. */
function pointFor(g: SketchGeometry, pick: Pick | null): string | null {
    if (pick?.type === 'point') {
        return pick.id;
    }
    const c = pick ? curveOf(g, pick.id) : undefined;
    return c && (c.kind === 'circle' || c.kind === 'arc') ? c.center : null;
}

const isLine = (g: SketchGeometry, id: string) => id === AXIS_U || id === AXIS_V || curveOf(g, id)?.kind === 'line';

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** The direction an ordinate's leaders run (the row is square to it), for a zero point along `axis` or a zero line. */
function leaderDirection(g: SketchGeometry, zero: string, axis: 'u' | 'v'): Pt {
    if (!isLine(g, zero)) {
        return axis === 'u' ? [0, 1] : [1, 0];
    }
    const probe = ordinateFrame(g, { id: 'probe', kind: 'distance', a: ORIGIN, b: zero, value: 0, ordinate: true });
    return probe?.d ?? [0, 1];
}

/** A click with the Ordinate, Angular Running or Path Length tool. */
export function specialClick(raw: Pt, tolerance: number): void {
    const special = get().dimSpecial!;
    if (special.kind === 'path') {
        pathClick(raw, tolerance);
    } else if (special.kind === 'running') {
        runningClick(special, raw, tolerance);
    } else {
        ordinateClick(special, raw, tolerance);
    }
}

function pathClick(raw: Pt, tolerance: number): void {
    const s = get();
    const g = s.geometry;
    const pick = pickFor(g, raw, tolerance);
    if (pick?.type === 'curve') {
        // A path's own curves (sketchPathModel.ts), else the chain of lines and arcs.
        const chain = pathSelection(g, pick.id) ?? chainOf(g, pick.id);
        if (!chain.length) {
            set({ message: 'A path length runs along lines and arcs.' });
            return;
        }
        set({ picks: chain.map((id) => ({ type: 'curve', id }) as Pick), message: 'Click where the path length goes.' });
        return;
    }
    if (!s.picks.length) {
        set({ message: 'Click a line or arc of the chain to measure.' });
        return;
    }
    const curves = s.picks.map((p) => p.id);
    const base: NewConstraint = { kind: 'pathLength', curves, value: 0 };
    const value = measure(g, { ...base, id: 'm' } as SketchConstraint) ?? 0;
    // Driving, so the chain keeps its length; driven when that would over define the sketch.
    const driven = overDefines(g, { ...base, value });
    const r = addConstraint(g, { ...base, value, at: raw, ...(driven ? { driven: true } : {}) } as NewConstraint);
    if (commitWithLabel(r.g, r.id, raw, { picks: [] }) && driven) {
        set({ message: 'That path length would over define the sketch: added as a driven dimension.' });
    }
}

function ordinateClick(special: Extract<Special, { kind: 'ordinate' }>, raw: Pt, tolerance: number): void {
    const s = get();
    const g = s.geometry;
    const pick = pickFor(g, raw, tolerance);
    const pointId = pointFor(g, pick);
    const lineId = pick?.type === 'curve' && isLine(g, pick.id) ? pick.id : null;
    if (!special.zero) {
        const zero = pointId ?? lineId;
        if (!zero) {
            set({ message: 'Click the zero: a point, or a line (an edge) the others are measured from.' });
            return;
        }
        set({ dimSpecial: { ...special, zero }, picks: [pointId ? { type: 'point', id: zero } : { type: 'curve', id: zero }],
            message: 'Click where the row of dimensions goes, then each point to dimension.' });
        return;
    }
    const zeroIsLine = !pointOf(g, special.zero) && special.zero !== ORIGIN;
    // Ordinate (not Horizontal or Vertical): the side of the zero the row (or the first point) is on decides.
    const decide = (at: Pt, rowClick: boolean): 'u' | 'v' => {
        if (!special.auto || zeroIsLine) {
            return special.axis;
        }
        const z = P(g, special.zero!);
        const [du, dv] = [Math.abs(at[0] - z[0]), Math.abs(at[1] - z[1])];
        // A row above or below measures horizontally; a point off to the side is measured horizontally.
        return rowClick ? (dv >= du ? 'u' : 'v') : (du >= dv ? 'u' : 'v');
    };
    if (!pointId) {
        if (!pick && special.row === undefined) {
            const axis = decide(raw, true);
            const d = leaderDirection(g, special.zero, axis);
            set({ dimSpecial: { ...special, axis, row: dot(raw, d) }, message: 'Click each point to dimension from the zero.' });
            return;
        }
        set({ message: 'Click a point (or an arc or circle, for its centre) to dimension.' });
        return;
    }
    if (pointId === special.zero) {
        return;
    }
    const axis = special.row === undefined ? decide(P(g, pointId), false) : special.axis;
    const d = leaderDirection(g, special.zero, axis);
    const at = P(g, pointId);
    const row = special.row ?? Math.max(...g.points.map((p) => dot([p.u, p.v], d)), 0) + 8;
    const base: NewConstraint = zeroIsLine
        ? { kind: 'distance', a: pointId, b: special.zero, value: 0, ordinate: true }
        : { kind: 'distance', a: special.zero, b: pointId, value: 0, axis, ordinate: true };
    const value = measure(g, { ...base, id: 'm' } as SketchConstraint) ?? 0;
    const label = ordinateLabel(d, at, row);
    const driven = overDefines(g, base);
    const r = addConstraint(g, { ...base, value, at: label, ...(driven ? { driven: true } : {}) } as NewConstraint);
    if (commitWithLabel(r.g, r.id, label, { dimSpecial: { ...special, axis, row } }) && driven) {
        set({ message: 'That ordinate would over define the sketch: added as a driven dimension.' });
    }
}

function runningClick(special: Extract<Special, { kind: 'running' }>, raw: Pt, tolerance: number): void {
    const g = get().geometry;
    const pick = pickFor(g, raw, tolerance);
    const pointId = pointFor(g, pick);
    if (!special.centre) {
        if (!pointId) {
            set({ message: 'Click the centre the angles are measured about: a point, or an arc or circle.' });
            return;
        }
        set({ dimSpecial: { ...special, centre: pointId }, picks: [{ type: 'point', id: pointId }],
            message: 'Click the zero: the point the angles are measured from (0°).' });
        return;
    }
    const centre = P(g, special.centre);
    if (!special.zero) {
        const zero = pick?.type === 'point' ? pick.id : null;
        if (!zero || zero === special.centre) {
            set({ message: 'Click the zero: a point (not the centre) the angles are measured from.' });
            return;
        }
        set({ dimSpecial: { ...special, zero }, picks: [{ type: 'point', id: special.centre }, { type: 'point', id: zero }],
            message: 'Click where the ring of angles goes, then each point to dimension.' });
        return;
    }
    const target = pick?.type === 'point' ? pick.id : null;
    if (!target) {
        if (special.radius === undefined && !pick) {
            set({ dimSpecial: { ...special, radius: Math.max(Math.hypot(raw[0] - centre[0], raw[1] - centre[1]), 1e-3) },
                message: 'Click each point to dimension from the zero.' });
            return;
        }
        set({ message: 'Click a point to dimension its angle from the zero.' });
        return;
    }
    if (target === special.centre || target === special.zero) {
        return;
    }
    const reach = Math.max(...[special.zero, target].map((id) => Math.hypot(P(g, id)[0] - centre[0], P(g, id)[1] - centre[1])));
    const radius = special.radius ?? reach * 1.25 + 4;
    const base: NewConstraint = { kind: 'pointAngle', vertex: special.centre, a: special.zero, b: target, value: 0, running: true };
    const value = measure(g, { ...base, id: 'm' } as SketchConstraint) ?? 0;
    const label = onRing(centre, P(g, target), radius);
    const driven = overDefines(g, { ...base, value });
    const r = addConstraint(g, { ...base, value, at: label, ...(driven ? { driven: true } : {}) } as NewConstraint);
    if (commitWithLabel(r.g, r.id, label, { dimSpecial: { ...special, radius } }) && driven) {
        set({ message: 'That angle would over define the sketch: added as a driven dimension.' });
    }
}

/**
 * Add to the same ordinate or running set (SolidWorks: Adding More Dimensions Along the Same Ordinate, Add To Running
 * Dimension): the tool takes up the set's zero and row again, and each click adds one.
 */
export function addToSet(id: string): boolean {
    const s = get();
    const g = s.geometry;
    const c = g.constraints.find((k) => k.id === id);
    const at = c ? s.labels[c.id] ?? dimensionAnchor(g, c) : null;
    const f = c && at ? ordinateFrame(g, c) : null;
    if (c?.kind === 'distance' && f && at) {
        setTool('dimension');
        set({ dimLock: null, dimSpecial: { kind: 'ordinate', axis: f.axis ?? 'u', zero: f.zeroId, row: dot(at, f.d) },
            picks: [pointOf(g, f.zeroId) || f.zeroId === ORIGIN ? { type: 'point', id: f.zeroId } : { type: 'curve', id: f.zeroId }],
            message: 'Click each point to add to this ordinate.' });
        return true;
    }
    const r = c && at ? runningFrame(g, c) : null;
    if (c?.kind === 'pointAngle' && r && at) {
        setTool('dimension');
        set({ dimLock: null, dimSpecial: { kind: 'running', centre: c.vertex, zero: c.a, radius: Math.hypot(at[0] - r.centre[0], at[1] - r.centre[1]) },
            picks: [{ type: 'point', id: c.vertex }, { type: 'point', id: c.a }], message: 'Click each point to add to this running dimension.' });
        return true;
    }
    return false;
}

// ---- Groups: Break alignment, run bidirectionally, the zero dimension ---------------------------------------------

/** Break alignment: the ordinate or running dimension leaves (or rejoins) its row or ring. */
export function setUnaligned(ids: string[], on: boolean): boolean {
    const s = get();
    const set1 = new Set(ids);
    let labels = s.labels;
    const g: SketchGeometry = {
        ...s.geometry,
        constraints: s.geometry.constraints.map((c) => {
            if (!set1.has(c.id) || (c.kind !== 'distance' && c.kind !== 'pointAngle') || !!c.unaligned === on) {
                return c;
            }
            const { unaligned: _u, ...rest } = c;
            return (on ? { ...rest, unaligned: true } : rest) as SketchConstraint;
        }),
    };
    if (!on) {
        // Back in line with the rest of its group.
        for (const id of ids) {
            const zero = groupZeros(g, labels, (k) => dimensionAnchor(g, k)).find((z) => z.members.includes(id) && z.members.length > 1);
            const other = zero?.members.find((m) => m !== id);
            const c = g.constraints.find((k) => k.id === id);
            if (!zero || !other || !c) {
                continue;
            }
            const ref = labels[other] ?? dimensionAnchor(g, g.constraints.find((k) => k.id === other)!);
            const f = ordinateFrame(g, c);
            const r = runningFrame(g, c);
            labels = f ? moveRow(g, labels, (k) => dimensionAnchor(g, k), zero.key, dot(ref, f.d))
                : r ? moveRing(g, labels, (k) => dimensionAnchor(g, k), zero.key, Math.hypot(ref[0] - r.centre[0], ref[1] - r.centre[1])) : labels;
        }
    }
    if (!commitGeometry(g)) {
        return false;
    }
    set({ labels });
    return true;
}

/** Run bidirectionally: the whole running set of `id` measures the nearer way (up to 180°), or anticlockwise again. */
export function setBidirectional(id: string, on: boolean): boolean {
    const g = get().geometry;
    const c = g.constraints.find((k) => k.id === id);
    const key = c ? runningFrame(g, c)?.key : undefined;
    if (!key) {
        return false;
    }
    const next: SketchGeometry = {
        ...g,
        constraints: g.constraints.map((k) => {
            if (k.kind !== 'pointAngle' || runningFrame(g, k)?.key !== key) {
                return k;
            }
            const { bidirectional: _b, ...rest } = k;
            const changed = (on ? { ...rest, bidirectional: true } : rest) as SketchConstraint;
            return { ...changed, value: measure(g, changed) ?? k.value } as SketchConstraint;
        }),
    };
    return commitGeometry(next);
}

/** The zero dimensions of the rows and sets in the sketch. */
export function sketchZeros(): GroupZero[] {
    const s = get();
    return groupZeros(s.geometry, s.labels, (c) => dimensionAnchor(s.geometry, c));
}

/** The zero dimension dragged: its row (or ring) follows it. */
export function moveZero(zero: GroupZero, at: Pt): void {
    const s = get();
    const g = s.geometry;
    const anchor = (c: SketchConstraint) => dimensionAnchor(g, c);
    const c = g.constraints.find((k) => k.id === zero.members[0]);
    const f = c ? ordinateFrame(g, c) : null;
    const r = c ? runningFrame(g, c) : null;
    const labels = f ? moveRow(g, s.labels, anchor, zero.key, dot(at, f.d))
        : r ? moveRing(g, s.labels, anchor, zero.key, Math.hypot(at[0] - r.centre[0], at[1] - r.centre[1])) : s.labels;
    set({ labels });
}

/**
 * The zero dimension dropped: on another point or line of the sketch, the row is measured from that instead
 * (SolidWorks: drag the zero dimension to a new position and the ordinates update to it); elsewhere it just moved.
 */
export function dropZero(zero: GroupZero, at: Pt, tolerance: number): void {
    if (zero.kind !== 'ordinate') {
        return;
    }
    const s = get();
    const pick = pickAt(s.geometry, at, tolerance);
    const target = pick?.type === 'point' ? pick.id : pick && isLine(s.geometry, pick.id) ? pick.id : null;
    if (!target || target === zero.zeroId) {
        return;
    }
    const next = rezeroed(s.geometry, zero.key, target);
    if (!next) {
        set({ message: 'The zero of this row can go on a point (for a row along the sketch axes) or on a line parallel to its leaders.' });
        return;
    }
    if (commitGeometry(next)) {
        set({ message: 'The ordinates are measured from the new zero.' });
    }
}

// ---- Smart Dimension: locking the type ----------------------------------------------------------------------

let locked: { key: string; constraint: NewConstraint } | null = null;

const picksKey = (picks: Pick[]) => picks.map((p) => `${p.type}:${p.id}:${p.type === 'curve' && p.edge ? 'e' : ''}`).join(' ');

/** The dimension these picks make with the label at `place`, unless its type was locked (right-click) for them. */
export function smartDimension(g: SketchGeometry, picks: Pick[], place: Pt, lock: 'u' | 'v' | null): NewConstraint | null {
    if (locked && locked.key === picksKey(picks)) {
        return locked.constraint;
    }
    return dimensionFromPicks(g, picks, place, lock);
}

/** Whether the type of the dimension being placed is locked. */
export const dimensionTypeLocked = (picks: Pick[]): boolean => !!locked && locked.key === picksKey(picks);

export function clearDimensionLock(): void {
    locked = null;
}

/**
 * Right-click while a dimension follows the pointer (SolidWorks: locking dimensions): the type it shows now (aligned,
 * horizontal or vertical, which angle) stays while the pointer only places it; again unlocks. True when it acted.
 */
export function toggleDimensionLock(): boolean {
    const s = get();
    const picks = s.dimDrag?.picks ?? s.picks;
    if (s.tool !== 'dimension' || s.dimDraft || s.dimSpecial || !s.cursor || !picks.length) {
        return false;
    }
    const key = picksKey(picks);
    if (locked?.key === key) {
        locked = null;
        set({ message: 'Dimension type unlocked: the pointer chooses it again.' });
        return true;
    }
    const c = dimensionFromPicks(s.geometry, picks, s.cursor, s.dimLock);
    if (!c) {
        return false;
    }
    locked = { key, constraint: c };
    set({ message: 'Dimension type locked: move the pointer to place it, click to put it there (right-click unlocks).' });
    return true;
}

// ---- Values: zero, negative, reverse direction, the first dimension ------------------------------------------

/** The points joined to `id` through curves (its own entity and what it is drawn on to). */
function joined(g: SketchGeometry, id: string): Set<string> {
    const out = new Set([id]);
    for (let grew = true; grew;) {
        grew = false;
        for (const c of g.curves) {
            const ids = curvePointIds(c);
            if (ids.some((p) => out.has(p)) && ids.some((p) => !out.has(p))) {
                ids.forEach((p) => out.add(p));
                grew = true;
            }
        }
    }
    return out;
}

/**
 * The sketch with the dimensioned point on the other side (Reverse direction), or null when it cannot be: its entity
 * (what is joined to it) moves over whole when it is apart from the reference, else the point is pulled across.
 */
function reversedStart(g: SketchGeometry, c: NewConstraint | SketchConstraint, editing: string | null): SketchGeometry | null {
    const target = reverseTarget(g, c);
    const p = target ? pointOf(g, target.point) : undefined;
    if (!target || !p || !solverReady() || c.kind !== 'distance') {
        return null;
    }
    const group = joined(g, target.point);
    const line = curveOf(g, c.b);
    const reference = c.axis ? [c.a] : line?.kind === 'line' ? [line.a, line.b] : [];
    const free = ![...group].some((id) => id === ORIGIN || reference.includes(id) || pointOf(g, id)?.fixed)
        && !g.constraints.some((k) => k.kind === 'fix' && group.has(k.point));
    if (free) {
        const by: Pt = [target.u - p.u, target.v - p.v];
        return { ...g, points: g.points.map((q) => (group.has(q.id) ? { ...q, u: q.u + by[0], v: q.v + by[1] } : q)) };
    }
    const without = { ...g, constraints: g.constraints.filter((k) => k.id !== editing) };
    const r = solveGeometry(without, { targets: [target] });
    return r.ok ? { ...r.geometry, constraints: g.constraints } : null;
}

/**
 * The sketch a typed dimension value applies to and the value: a negative value of a position dimension reverses
 * it (the point goes to the other side), and the first dimension of a sketch scales the sketch to it.
 */
export function typedDimension(g: SketchGeometry, c: NewConstraint, editing: string | null, text: string):
    { g: SketchGeometry; value: number; reverse: boolean } | { error: string } {
    const typed = typedValue(g, c, evaluate(text));
    if ('error' in typed) {
        return typed;
    }
    let base = g;
    if (typed.reverse) {
        base = reversedStart(g, c, editing) ?? g;
    }
    if (!editing) {
        base = firstDimensionScale(base, c, typed.value) ?? base;
    }
    return { g: base, value: typed.value, reverse: typed.reverse };
}

/** After a reversing value: says so when the point could not go to the other side. */
export function reportReverse(before: SketchGeometry, id: string): void {
    const after = get().geometry;
    const c = after.constraints.find((k) => k.id === id);
    if (c && positionDimension(after, c) && sideOf(before, c) !== 0 && sideOf(after, c) === sideOf(before, c)) {
        set({ message: 'Its relations hold it on this side: it could not be reversed.' });
    }
}

/** Reverse direction (Dimension PropertyManager): the dimensioned point goes to the other side at the same value. */
export function reverseDimension(id: string): string | null {
    const g = get().geometry;
    const c = g.constraints.find((k) => k.id === id);
    if (!c || !positionDimension(g, c)) {
        return 'Only a position dimension (horizontal or vertical between points, or from a line) can be reversed.';
    }
    const start = reversedStart(g, c, id);
    if (!start || sideOf(start, c) === sideOf(g, c)) {
        return 'Its relations hold it on this side: it cannot be reversed.';
    }
    return commitGeometry(start) ? null : get().message ?? 'Not applied.';
}

// ---- Over defining dimensions ---------------------------------------------------------------------------------

/**
 * What a new dimension that over defines the sketch does (System Options > Sketch > Over defining dimensions): the
 * Make Dimension Driven? choice comes first (with driven or driving as its default), or it is driven, or driving.
 */
export function overDefiningAction(): 'ask' | 'driven' | 'driving' {
    const { overDefPrompt, overDefDriven } = get().settings;
    return overDefPrompt ? 'ask' : overDefDriven ? 'driven' : 'driving';
}

/** Don't ask again: the choice made stays the default and the question no longer comes. */
export function rememberDrivenChoice(driven: boolean): void {
    setSketchSettings({ overDefPrompt: false, overDefDriven: driven });
}

/** The dimensions an entity was drawn with, driven where the settings or the solver say (see drawnDimensions). */
export function withDrawnDimensions(before: SketchGeometry, next: SketchGeometry): SketchGeometry {
    const s = get();
    return drawnDimensions(before, next, s.settings.drivenOnCreate, solverReady() && solvesAtOnce(s.settings, next.curves.length) ? solveGeometry : null);
}

// ---- Auto Insert Dimension and the preview of a selected entity's size ----------------------------------------

/** Opens the value input of a new dimension `c` with its label at `at` (as the Modify box of SolidWorks). */
export function startDimension(c: NewConstraint, at: Pt): void {
    const g = get().geometry;
    const value = measure(g, { ...c, id: 'measuring' } as SketchConstraint) ?? 0;
    const action = overDefiningAction();
    const overDefining = action !== 'driving' && overDefines(g, c);
    if (overDefining && action === 'driven') {
        const r = addConstraint(g, { ...c, value, driven: true } as NewConstraint);
        commitWithLabel(r.g, r.id, at);
        return;
    }
    set({ dimDraft: { constraint: c, at, text: String(round(value)), editing: null, error: null, overDefining }, hover: null });
}

/** Where a dimension of these picks goes by default: beside the middle of what they are. */
function besidePicks(g: SketchGeometry, picks: Pick[]): Pt {
    const spots = picks.map((p): Pt => {
        const c = curveOf(g, p.id);
        if (c?.kind === 'line') {
            const [a, b] = [P(g, c.a), P(g, c.b)];
            return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        }
        return c && 'center' in c ? P(g, c.center) : pointOf(g, p.id) ? P(g, p.id) : [0, 0];
    });
    const m: Pt = [spots.reduce((t, q) => t + q[0], 0) / spots.length, spots.reduce((t, q) => t + q[1], 0) / spots.length];
    return [m[0] + 6, m[1] + 6];
}

/** The dimension the selected entities make together, for the context toolbar; null when they make none. */
export function selectionDimension(): { c: NewConstraint; at: Pt } | null {
    const s = get();
    const picks = s.selection.filter((x): x is Pick & { type: 'point' | 'curve' } => x.type !== 'constraint');
    if (!picks.length || picks.length > 3) {
        return null;
    }
    const at = besidePicks(s.geometry, picks);
    const c = dimensionFromPicks(s.geometry, picks, at, null);
    return c ? { c, at } : null;
}

/** Auto Insert Dimension (context toolbar): a dimension between the selected entities, its value asked for. */
export function autoInsertDimension(): boolean {
    const found = selectionDimension();
    if (!found) {
        set({ message: 'These cannot be dimensioned together.' });
        return false;
    }
    startDimension(found.c, found.at);
    return true;
}

/**
 * Preview sketch dimension when selected (System Options > Sketch): the sizes a selected line, circle or arc has no
 * dimension for yet, shown as previews to click (not path lengths).
 */
export function previewDimensions(g: SketchGeometry, selection: State['selection']): { c: NewConstraint; at: Pt; key: string }[] {
    const out: { c: NewConstraint; at: Pt; key: string }[] = [];
    for (const item of selection) {
        const curve = item.type === 'curve' ? curveOf(g, item.id) : undefined;
        if (!curve || (curve.kind !== 'line' && curve.kind !== 'circle' && curve.kind !== 'arc')) {
            continue;
        }
        const sized = g.constraints.some((c) => isDimension(c) && !c.driven && (('line' in c && c.line === curve.id) || ('curve' in c && c.curve === curve.id)));
        if (sized) {
            continue;
        }
        const c: NewConstraint = curve.kind === 'line' ? { kind: 'length', line: curve.id, value: 0 }
            : { kind: curve.kind === 'circle' ? 'diameter' : 'radius', curve: curve.id, value: 0 };
        const value = measure(g, { ...c, id: 'preview' } as SketchConstraint);
        if (value !== null) {
            out.push({ c: { ...c, value } as NewConstraint, at: dimensionAnchor(g, { ...c, id: 'preview', value } as SketchConstraint), key: curve.id });
        }
    }
    return out;
}
