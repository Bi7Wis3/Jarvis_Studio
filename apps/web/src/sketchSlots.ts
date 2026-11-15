// Slots found in a sketch's curves, as the slot tools draw them: straight slots (two lines and two arcs of one radius
// in a closed loop) and arc slots (outer and inner arcs about a construction arc, closed by end arcs on its ends), for
// the Equal Slots and Fix Slot relations and the slot's Parameters.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import type { NewConstraint } from './sketchGeometry';
import { ORIGIN, curveOf, curveRadius } from './solver';
import { curvePointIds } from './sketchCurves';

type Line = Extract<SketchCurve, { kind: 'line' }>;
type Arc = Extract<SketchCurve, { kind: 'arc' }>;

export interface Slot {
    lines: [string, string];
    arcs: [string, string];
}

/** An arc slot: the construction arc it is drawn about, its outer and inner arcs and the end arcs on that arc's ends. */
export interface ArcSlot {
    centre: string;
    outer: string;
    inner: string;
    /** The end arcs about the construction arc's start and end. */
    caps: [string, string];
}

/** The straight slot a curve belongs to, if it is one: each line joins an end of one arc to an end of the other. */
export function slotOf(g: SketchGeometry, curveId: string): Slot | null {
    const lines = g.curves.filter((c): c is Line => c.kind === 'line' && !c.construction);
    const arcs = g.curves.filter((c): c is Arc => c.kind === 'arc' && !c.construction);
    const ends = (a: Arc) => [a.start, a.end];
    for (let i = 0; i < arcs.length; i++) {
        for (let j = i + 1; j < arcs.length; j++) {
            const [a, b] = [arcs[i], arcs[j]];
            if (a.center === b.center) {
                continue;
            }
            const ra = curveRadius(g, a.id);
            const rb = curveRadius(g, b.id);
            if (ra === null || rb === null || Math.abs(ra - rb) > 1e-6) {
                continue;
            }
            const joins = lines.filter((l) => (ends(a).includes(l.a) && ends(b).includes(l.b)) || (ends(a).includes(l.b) && ends(b).includes(l.a)));
            const used = new Set(joins.flatMap((l) => [l.a, l.b]));
            if (joins.length === 2 && used.size === 4) {
                const slot: Slot = { lines: [joins[0].id, joins[1].id], arcs: [a.id, b.id] };
                if ([...slot.lines, ...slot.arcs].includes(curveId)) {
                    return slot;
                }
            }
        }
    }
    return null;
}

/** The arc slot a curve belongs to (its construction arc included), if it is one. */
export function arcSlotOf(g: SketchGeometry, curveId: string): ArcSlot | null {
    const arcs = g.curves.filter((c): c is Arc => c.kind === 'arc');
    for (const centre of arcs.filter((c) => c.construction)) {
        const about = arcs.filter((c) => !c.construction && c.center === centre.center);
        const capS = arcs.find((c) => !c.construction && c.center === centre.start);
        const capE = arcs.find((c) => !c.construction && c.center === centre.end);
        if (about.length !== 2 || !capS || !capE) {
            continue;
        }
        const [r0, r1] = about.map((c) => curveRadius(g, c.id) ?? 0);
        const [outer, inner] = r0 >= r1 ? about : [about[1], about[0]];
        // Closed: each end arc joins the outer and the inner arc.
        const joins = (cap: Arc) => [outer, inner].every((k) => [k.start, k.end].some((p) => p === cap.start || p === cap.end));
        if (!joins(capS) || !joins(capE)) {
            continue;
        }
        const slot: ArcSlot = { centre: centre.id, outer: outer.id, inner: inner.id, caps: [capS.id, capE.id] };
        if ([slot.centre, slot.outer, slot.inner, ...slot.caps].includes(curveId)) {
            return slot;
        }
    }
    return null;
}

/** The distinct straight slots the picked curves belong to, in pick order; null when a pick is in no slot. */
export function slotsOf(g: SketchGeometry, curveIds: string[]): Slot[] | null {
    const out: Slot[] = [];
    for (const id of curveIds) {
        const s = slotOf(g, id);
        if (!s) {
            return null;
        }
        if (!out.some((x) => x.arcs[0] === s.arcs[0])) {
            out.push(s);
        }
    }
    return out;
}

type AnySlot = { kind: 'straight'; slot: Slot } | { kind: 'arc'; slot: ArcSlot };

/** The distinct slots (straight or arc) of the picks, in pick order; null when a pick is in no slot. */
function anySlotsOf(g: SketchGeometry, curveIds: string[]): AnySlot[] | null {
    const out: AnySlot[] = [];
    for (const id of curveIds) {
        const straight = slotOf(g, id);
        const arc = straight ? null : arcSlotOf(g, id);
        const s: AnySlot | null = straight ? { kind: 'straight', slot: straight } : arc ? { kind: 'arc', slot: arc } : null;
        if (!s) {
            return null;
        }
        const key = (x: AnySlot) => (x.kind === 'straight' ? x.slot.arcs[0] : x.slot.centre);
        if (!out.some((x) => key(x) === key(s))) {
            out.push(s);
        }
    }
    return out;
}

/** The curves of a slot (an arc slot's construction arc too). */
function slotCurves(s: AnySlot): string[] {
    return s.kind === 'straight' ? [...s.slot.lines, ...s.slot.arcs] : [s.slot.centre, s.slot.outer, s.slot.inner, ...s.slot.caps];
}

/**
 * Equal Slots: the same sizes, each slot related to the first. Straight slots: equal lengths and radii; arc slots:
 * the same arc radius, width and angle.
 */
export function equalSlotRelations(g: SketchGeometry, curveIds: string[]): NewConstraint[] | { need: string } {
    const slots = anySlotsOf(g, curveIds);
    if (!slots || slots.length < 2) {
        return { need: 'Pick a curve of each of two or more slots' };
    }
    if (slots.some((s) => s.kind !== slots[0].kind)) {
        return { need: 'Pick slots of one kind: straight slots, or arc slots' };
    }
    const [first, ...rest] = slots;
    return rest.flatMap((s): NewConstraint[] => {
        if (first.kind === 'straight' && s.kind === 'straight') {
            return [
                { kind: 'equal', a: first.slot.lines[0], b: s.slot.lines[0] },
                { kind: 'equal', a: first.slot.arcs[0], b: s.slot.arcs[0] },
            ];
        }
        const [a, b] = [first.slot as ArcSlot, s.slot as ArcSlot];
        return [
            { kind: 'equal', a: a.centre, b: b.centre },
            { kind: 'equal', a: a.caps[0], b: b.caps[0] },
            { kind: 'equalSweep', a: a.centre, b: b.centre },
        ];
    });
}

/** Fix Slot: every point of the slot locked (those locked already left out). */
export function fixSlotRelations(g: SketchGeometry, curveIds: string[]): NewConstraint[] | { need: string } {
    const slots = anySlotsOf(g, curveIds);
    if (!slots?.length) {
        return { need: 'Pick a curve of a slot' };
    }
    const locked = new Set(g.constraints.flatMap((c) => (c.kind === 'fix' ? [c.point] : [])));
    const own = [...new Set(slots.flatMap(slotCurves).flatMap((id) => {
        const c = curveOf(g, id);
        return c ? curvePointIds(c) : [];
    }))].filter((p) => p !== ORIGIN && !locked.has(p));
    return own.length ? own.map((point) => ({ kind: 'fix', point })) : { need: 'That slot is fixed already' };
}
