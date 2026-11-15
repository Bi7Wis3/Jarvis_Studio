// Segment (SolidWorks Tools > Sketch Tools > Segment): equally spaced sketch points on a line, arc or circle, or the
// entity cut into equal pieces. SolidWorks ties the points with an Equidistant relation; this sketch has no such
// relation, so the spacing is held by construction chords between neighbouring points, all made Equal (equal
// chords on one circle are equal arcs). The points follow when the entity is dragged or resized.
//
// Each use is kept as a segment group (SketchGeometry.segments): deleting one of its points re-spaces the others
// (SolidWorks: Deleting Sketch Points); deleting one of its chords or their Equal relations ends the group, the
// points staying on the entity where they are (SolidWorks: deleting an Equidistant relation); and the number of
// instances can be changed later.

import type { SketchConstraint, SketchCurve, SketchGeometry, SketchSegmentGroup } from '@jarvis/core';
import { curveOf, pointOf } from './solver';
import { addConstraint, constraintRefs, newId, type NewConstraint } from './sketchGeometry';
import type { Pt } from './sketchMath';

export type SegmentMode = 'points' | 'segments';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface SegmentResult {
    g: SketchGeometry;
    /** The new points (in order along the entity). */
    points: string[];
    /** The pieces (segments mode) or the construction chords (points mode). */
    curves: string[];
    /** Relations and dimensions of the whole entity that no longer hold (a line's length, middle). */
    dropped: number;
    /** The group kept for the result. */
    group: SketchSegmentGroup;
}

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

function addPoint(g: SketchGeometry, at: Pt): { g: SketchGeometry; id: string } {
    const id = newId('p', g);
    return { g: { ...g, points: [...g.points, { id, u: at[0], v: at[1] }] }, id };
}

function addCurve(g: SketchGeometry, c: DistributiveOmit<SketchCurve, 'id'>): { g: SketchGeometry; id: string } {
    const id = newId('c', g);
    return { g: { ...g, curves: [...g.curves, { ...c, id } as SketchCurve] }, id };
}

function withAll(g: SketchGeometry, list: NewConstraint[]): SketchGeometry {
    return list.reduce((out, k) => addConstraint(out, k).g, g);
}

/**
 * Construction lines through the points in order, all equal to the first. Two points round a circle (its `centre`)
 * are opposite each other: their one chord goes through the centre.
 */
function chords(g: SketchGeometry, ids: string[], closed: boolean, centre?: string): { g: SketchGeometry; ids: string[] } {
    let out = g;
    const made: string[] = [];
    const pairs = ids.slice(1).map((id, i): [string, string] => [ids[i], id]);
    if (closed && ids.length > 2) {
        pairs.push([ids[ids.length - 1], ids[0]]);
    }
    for (const [a, b] of pairs) {
        const r = addCurve(out, { kind: 'line', a, b, construction: true });
        out = r.g;
        made.push(r.id);
    }
    out = withAll(out, made.slice(1).map((id): NewConstraint => ({ kind: 'equal', a: made[0], b: id })));
    if (closed && ids.length === 2 && centre) {
        out = withAll(out, [{ kind: 'pointOnCurve', point: centre, curve: made[0] }]);
    }
    return { g: out, ids: made };
}

function groupId(g: SketchGeometry): string {
    const taken = new Set((g.segments ?? []).map((s) => s.id));
    let n = 1;
    while (taken.has(`seg${n}`)) {
        n += 1;
    }
    return `seg${n}`;
}

/** The entity's ends with the points between, in order (a circle: the points alone). */
function chain(c: SketchCurve, points: string[]): string[] {
    return c.kind === 'line' ? [c.a, ...points, c.b] : c.kind === 'arc' ? [c.start, ...points, c.end] : points;
}

/**
 * Divides the line, arc or circle `curveId` equally. Points mode: `count` points inside the entity (a circle: round
 * it). Segments mode: `count` pieces, the first keeping the entity's id (and relations that still hold).
 */
export function segmentEntity(g: SketchGeometry, curveId: string, count: number, mode: SegmentMode): SegmentResult | { error: string } {
    const c = curveOf(g, curveId);
    const n = Math.round(count);
    if (!c || (c.kind !== 'line' && c.kind !== 'arc' && c.kind !== 'circle')) {
        return { error: 'Pick a line, arc or circle to segment.' };
    }
    if (!(n >= 1) || (mode === 'segments' && n < 2)) {
        return { error: mode === 'segments' ? 'Number of instances must be 2 or more for segments.' : 'Number of instances must be 1 or more.' };
    }
    if (n > 500) {
        return { error: 'Number of instances must be 500 or fewer.' };
    }
    // Positions along the entity.
    let at: (t: number) => Pt;
    if (c.kind === 'line') {
        const [a, b] = [P(g, c.a), P(g, c.b)];
        at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    } else {
        const centre = P(g, c.center);
        const r = c.kind === 'circle' ? c.radius : Math.hypot(P(g, c.start)[0] - centre[0], P(g, c.start)[1] - centre[1]);
        const from = c.kind === 'circle' ? 0 : Math.atan2(P(g, c.start)[1] - centre[1], P(g, c.start)[0] - centre[0]);
        let sweep = 2 * Math.PI;
        if (c.kind === 'arc') {
            const to = Math.atan2(P(g, c.end)[1] - centre[1], P(g, c.end)[0] - centre[0]);
            sweep = ((to - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        }
        at = (t) => [centre[0] + r * Math.cos(from + sweep * t), centre[1] + r * Math.sin(from + sweep * t)];
    }
    const closed = c.kind === 'circle';
    const pieces = mode === 'points' ? (closed ? n : n + 1) : n;
    // Parameters of the new points: closed entities start at 0, open ones skip their ends.
    const ts = closed ? Array.from({ length: pieces }, (_, k) => k / pieces) : Array.from({ length: pieces - 1 }, (_, k) => (k + 1) / pieces);
    let out = g;
    const points: string[] = [];
    for (const t of ts) {
        const r = addPoint(out, at(t));
        out = r.g;
        points.push(r.id);
    }
    const id = groupId(g);
    const record = (geometry: SketchGeometry, group: SketchSegmentGroup): SketchGeometry => ({ ...geometry, segments: [...(geometry.segments ?? []), group] });
    if (mode === 'points') {
        out = withAll(out, points.map((p): NewConstraint => ({ kind: 'pointOnCurve', point: p, curve: c.id })));
        const r = n === 1 && closed ? { g: out, ids: [] } : chords(out, chain(c, points), closed, c.kind === 'circle' ? c.center : undefined);
        const group: SketchSegmentGroup = { id, curve: c.id, mode, points, chords: r.ids };
        return { g: record(r.g, group), points, curves: r.ids, dropped: 0, group };
    }
    if (c.kind === 'line') {
        // The line keeps its id as the first piece; the far end and every split point stay on its line.
        const ends = [c.a, ...points, c.b];
        const before = out.constraints.length;
        out = { ...out, constraints: out.constraints.filter((k) => !lineOnly(k, c.id)) };
        const dropped = before - out.constraints.length;
        out = { ...out, curves: out.curves.map((x) => (x.id === c.id ? { ...c, b: ends[1] } : x)) };
        const ids = [c.id];
        for (let k = 1; k < ends.length - 1; k++) {
            const r = addCurve(out, { kind: 'line', a: ends[k], b: ends[k + 1], ...(c.construction ? { construction: true } : {}) });
            out = r.g;
            ids.push(r.id);
        }
        out = withAll(out, [
            ...ends.slice(2).map((p): NewConstraint => ({ kind: 'pointOnCurve', point: p, curve: c.id })),
            ...ids.slice(1).map((p): NewConstraint => ({ kind: 'equal', a: ids[0], b: p })),
        ]);
        const group: SketchSegmentGroup = { id, curve: c.id, mode, points, chords: [], pieces: ids };
        return { g: record(out, group), points, curves: ids, dropped, group };
    }
    // Arcs and circles: pieces round the same centre, equal chords keep them equal in length.
    const ends = c.kind === 'arc' ? [c.start, ...points, c.end] : [...points, points[0]];
    const construction = c.construction ? { construction: true } : {};
    out = { ...out, curves: out.curves.map((x) => (x.id === c.id ? { id: c.id, kind: 'arc', center: c.center, start: ends[0], end: ends[1], ...construction } : x)) };
    const ids = [c.id];
    for (let k = 1; k < ends.length - 1; k++) {
        const r = addCurve(out, { kind: 'arc', center: c.center, start: ends[k], end: ends[k + 1], ...construction });
        out = r.g;
        ids.push(r.id);
    }
    const r = chords(out, ends.slice(0, c.kind === 'arc' ? ends.length : ends.length - 1), closed, c.center);
    const group: SketchSegmentGroup = { id, curve: c.id, mode, points, chords: r.ids, pieces: ids };
    return { g: record(r.g, group), points, curves: ids, dropped: 0, group };
}

/** Relations of a whole line that a piece of it does not keep. */
function lineOnly(k: SketchConstraint, line: string): boolean {
    return (k.kind === 'length' && k.line === line) || (k.kind === 'midpoint' && k.line === line) || (k.kind === 'equal' && (k.a === line || k.b === line));
}

/** The points moved to equal spacing along the line, arc or circle (round a circle from the first of them). */
function spread(g: SketchGeometry, c: SketchCurve, ids: string[]): SketchGeometry {
    const n = ids.length;
    let at: (k: number) => Pt;
    if (c.kind === 'line') {
        const [a, b] = [P(g, c.a), P(g, c.b)];
        at = (k) => [a[0] + ((b[0] - a[0]) * (k + 1)) / (n + 1), a[1] + ((b[1] - a[1]) * (k + 1)) / (n + 1)];
    } else if (c.kind === 'arc' || c.kind === 'circle') {
        const m = P(g, c.center);
        const first = P(g, c.kind === 'arc' ? c.start : ids[0]);
        const r = c.kind === 'circle' ? c.radius : Math.hypot(first[0] - m[0], first[1] - m[1]);
        const from = Math.atan2(first[1] - m[1], first[0] - m[0]);
        let sweep = 2 * Math.PI;
        if (c.kind === 'arc') {
            const e = P(g, c.end);
            sweep = ((Math.atan2(e[1] - m[1], e[0] - m[0]) - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        }
        const t = (k: number) => (c.kind === 'arc' ? (sweep * (k + 1)) / (n + 1) : (sweep * k) / n);
        at = (k) => [m[0] + r * Math.cos(from + t(k)), m[1] + r * Math.sin(from + t(k))];
    } else {
        return g;
    }
    const place = new Map(ids.map((id, k) => [id, at(k)]));
    return { ...g, points: g.points.map((p) => (place.has(p.id) ? { ...p, u: place.get(p.id)![0] + 0, v: place.get(p.id)![1] + 0 } : p)) };
}

/** The group's chords and their Equal relations taken out (the points and their place on the entity stay). */
function withoutChords(g: SketchGeometry, group: SketchSegmentGroup): SketchGeometry {
    const gone = new Set(group.chords);
    return {
        ...g,
        curves: g.curves.filter((c) => !gone.has(c.id)),
        constraints: g.constraints.filter((k) => !constraintRefs(k).some((r) => gone.has(r))),
    };
}

/** Whether the group's chords and their Equal relations are all still there. */
function chordsWhole(g: SketchGeometry, group: SketchSegmentGroup): boolean {
    const set = new Set(group.chords);
    if (!group.chords.every((id) => curveOf(g, id))) {
        return false;
    }
    const equal = g.constraints.filter((k) => k.kind === 'equal' && set.has(k.a) && set.has(k.b)).length;
    return equal >= group.chords.length - 1;
}

/**
 * The segment groups after an edit: a deleted point re-spaces the rest; a deleted chord or Equal relation ends the
 * group (its points stay on the entity); a group whose entity, points or pieces went ends too.
 */
export function syncSegments(g: SketchGeometry): SketchGeometry {
    if (!g.segments?.length) {
        return g;
    }
    let out = g;
    const kept: SketchSegmentGroup[] = [];
    let changed = false;
    for (const group of g.segments) {
        const entity = curveOf(out, group.curve);
        const alive = group.points.filter((id) => !!pointOf(out, id));
        if (group.mode === 'segments') {
            const whole = !!entity && alive.length === group.points.length && (group.pieces ?? []).every((id) => curveOf(out, id))
                && (group.chords.length === 0 || chordsWhole(out, group));
            if (whole) {
                kept.push(group);
            } else {
                changed = true;
            }
            continue;
        }
        if (!entity || (entity.kind !== 'line' && entity.kind !== 'arc' && entity.kind !== 'circle') || !alive.length) {
            out = withoutChords(out, group);
            changed = true;
            continue;
        }
        if (alive.length === group.points.length) {
            if (chordsWhole(out, group)) {
                kept.push(group);
            } else {
                // A chord or one of their relations deleted: the spacing is no longer held.
                out = withoutChords(out, group);
                changed = true;
            }
            continue;
        }
        // A point deleted: the others are spaced equally again (placed there, so the solve moves nothing else).
        const r = chords(spread(withoutChords(out, group), entity, alive), chain(entity, alive), entity.kind === 'circle', entity.kind === 'circle' ? entity.center : undefined);
        out = r.g;
        kept.push({ ...group, points: alive, chords: r.ids });
        changed = true;
    }
    return changed ? { ...out, segments: kept } : g;
}

/** The group a selected point, chord or piece belongs to. */
export function segmentGroupOf(g: SketchGeometry, id: string): SketchSegmentGroup | null {
    return g.segments?.find((s) => s.points.includes(id) || s.chords.includes(id) || (s.pieces ?? []).includes(id) || (s.mode === 'points' && s.curve === id)) ?? null;
}

/**
 * Changes a group's number of instances (or its mode): the group is taken back (points removed, pieces joined into
 * the entity again) and the entity segmented anew.
 */
export function resegment(g: SketchGeometry, groupId: string, count: number, mode: SegmentMode): SegmentResult | { error: string } {
    const group = g.segments?.find((s) => s.id === groupId);
    const entity = group && curveOf(g, group.curve);
    if (!group || !entity) {
        return { error: 'That segment group is gone.' };
    }
    let out = withoutChords({ ...g, segments: g.segments!.filter((s) => s.id !== groupId) }, group);
    if (group.mode === 'segments') {
        const pieces = (group.pieces ?? []).map((id) => curveOf(out, id));
        if (pieces.some((c) => !c)) {
            return { error: 'A piece of that segment group is gone.' };
        }
        const first = pieces[0]!;
        const last = pieces[pieces.length - 1]!;
        let whole: SketchCurve;
        if (first.kind === 'line' && last.kind === 'line') {
            whole = { ...first, b: last.b };
        } else if (first.kind === 'arc' && last.kind === 'arc') {
            const closed = last.end === first.start;
            whole = closed
                ? { id: first.id, kind: 'circle', center: first.center, radius: Math.hypot(P(out, first.start)[0] - P(out, first.center)[0], P(out, first.start)[1] - P(out, first.center)[1]),
                    ...(first.construction ? { construction: true } : {}) }
                : { ...first, end: last.end };
        } else {
            return { error: 'That segment group cannot be changed.' };
        }
        const others = new Set(pieces.slice(1).map((c) => c!.id));
        const inner = new Set(group.points);
        out = {
            ...out,
            curves: out.curves.filter((c) => !others.has(c.id)).map((c) => (c.id === first.id ? whole : c)),
            points: out.points.filter((p) => !inner.has(p.id)),
        };
        out = { ...out, constraints: out.constraints.filter((k) => !constraintRefs(k).some((r) => others.has(r) || inner.has(r))) };
    } else {
        const gone = new Set(group.points);
        out = { ...out, points: out.points.filter((p) => !gone.has(p.id)), constraints: out.constraints.filter((k) => !constraintRefs(k).some((r) => gone.has(r))) };
    }
    return segmentEntity(out, group.curve, count, mode);
}
