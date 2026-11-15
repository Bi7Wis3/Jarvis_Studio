// Tangent arc intent zones (SolidWorks: the pointer's motion off the end point picks the arc). Leaving the end
// along the curve's direction, forwards or backwards, gives a tangent arc; leaving it across the curve gives a normal
// arc (perpendicular to it). Each zone bends either way: eight results. Back on the end point the choice starts
// over.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, pointOf } from './solver';
import { addConstraint, newId, placePoint, tangentArcThrough, tangentAt, type NewConstraint, type PointRef } from './sketchGeometry';
import type { NewEntity, Pt } from './sketchMath';

export interface ArcIntent {
    kind: 'tangent' | 'normal';
    /** tangent: 1 forwards along the curve, -1 backwards; normal: 1 to the curve's left, -1 to its right. */
    sign: 1 | -1;
}

export interface ZoneState {
    /** near: the pointer is on the end point (or has not left it yet); the intent is chosen on leaving it. */
    near: boolean;
    intent: ArcIntent | null;
}

export const ZONE_IDLE: ZoneState = { near: true, intent: null };

/** The zone after a pointer move to `cursor`, for an arc from `start` leaving the curve along `dir` (unit). */
export function zoneMove(state: ZoneState, start: Pt, dir: Pt, cursor: Pt, tolerance: number): ZoneState {
    const d: Pt = [cursor[0] - start[0], cursor[1] - start[1]];
    const r = Math.hypot(d[0], d[1]);
    if (r <= tolerance) {
        return state.near && !state.intent ? state : ZONE_IDLE;
    }
    if (!state.near && state.intent) {
        return state;
    }
    const along = d[0] * dir[0] + d[1] * dir[1];
    const across = -d[0] * dir[1] + d[1] * dir[0];
    const intent: ArcIntent = Math.abs(along) >= Math.abs(across)
        ? { kind: 'tangent', sign: along >= 0 ? 1 : -1 }
        : { kind: 'normal', sign: across >= 0 ? 1 : -1 };
    return { near: false, intent };
}

/** The direction the arc leaves its start in. */
export function leavingDir(dir: Pt, intent: ArcIntent | null): Pt {
    const i = intent ?? { kind: 'tangent', sign: 1 };
    return i.kind === 'tangent' ? [dir[0] * i.sign, dir[1] * i.sign] : [-dir[1] * i.sign, dir[0] * i.sign];
}

/** The arc drawn from the end point `start` to `cursor` for the intent, or a line when it would be straight. */
export function zonedPreview(g: SketchGeometry, start: string | undefined, from: Pt, cursor: Pt, intent: ArcIntent | null): NewEntity | null {
    const t = start ? tangentAt(g, start) : null;
    const arc = t && tangentArcThrough(from, leavingDir(t.dir, intent), cursor);
    if (!arc) {
        return { kind: 'line', a: from, b: cursor };
    }
    return arc.ccw ? { kind: 'arc', a: from, b: cursor, m: arc.m } : { kind: 'arc', a: cursor, b: from, m: arc.m };
}

/**
 * Arc from the end point `start` of a line or arc to `end`, leaving as the intent says: tangent (forwards or back),
 * held by a tangent relation; or normal, held by its centre on the line (from an arc: tangent to a construction
 * line along the arc's radius there).
 */
export function addZonedArc(g: SketchGeometry, start: string, end: PointRef, intent: ArcIntent | null): { g: SketchGeometry; id: string; end: string } | { error: string } {
    const from = tangentAt(g, start);
    const s = pointOf(g, start);
    if (!from || !s) {
        return { error: 'Start a tangent arc on the end of a line or arc.' };
    }
    const arc = tangentArcThrough([s.u, s.v], leavingDir(from.dir, intent), end.at);
    if (!arc) {
        return { error: 'That end is straight ahead: draw a line there instead.' };
    }
    const r = placePoint(g, end);
    const eid = r.id;
    if (eid === start) {
        return { error: 'Pick an end away from the start.' };
    }
    const centre = newId('p', r.g);
    let out: SketchGeometry = { ...r.g, points: [...r.g.points, { id: centre, u: arc.c[0], v: arc.c[1] }] };
    const id = newId('c', out);
    out = { ...out, curves: [...out.curves, { id, kind: 'arc', center: centre, start: arc.ccw ? start : eid, end: arc.ccw ? eid : start }] };
    const base = curveOf(out, from.curve) as SketchCurve;
    let relation: NewConstraint;
    if (intent?.kind !== 'normal') {
        relation = { kind: 'tangent', a: from.curve, b: id };
    } else if (base.kind === 'line') {
        relation = { kind: 'pointOnCurve', point: centre, curve: from.curve };
    } else if (base.kind === 'arc') {
        const radius = newId('c', out);
        out = { ...out, curves: [...out.curves, { id: radius, kind: 'line', a: base.center, b: start, construction: true }] };
        relation = { kind: 'tangent', a: radius, b: id };
    } else {
        return { error: 'Start a tangent arc on the end of a line or arc.' };
    }
    out = addConstraint(out, relation).g;
    return { g: out, id, end: eid };
}
