// Move, copy, rotate and scale of sketch text, block instances and equation driven curves: each is one unit
// (SolidWorks), so a pick of any of its curves takes the whole item, and the item's own placement (text: start point
// and height; block instance: insertion point, angle and scale; equation curve: its offset) goes along, so the item
// stays what it was and rebuilds where it now is (a block instance keeps its entity ids, so relations can stay).

import type { SketchConstraint, SketchEquationCurve, SketchGeometry, SketchText } from '@jarvis/core';
import { curvePoints, transformEntities, transformPoint, type Transform, type TransformResult } from './sketchEdit';
import { insertBlock, placeInsert } from './sketchBlocks';
import { ownerOf } from './sketchItems';
import { constraintRefs } from './sketchGeometry';
import { curveOf } from './solver';

type Pt = [number, number];

/** Why this transform cannot take a text, or null. */
function textRefusal(text: SketchText, t: Transform): string | null {
    if (text.along?.length) {
        return 'Text along curves goes where its curves go: move or change those curves instead.';
    }
    if (t.kind === 'rotate') {
        return 'Sketch text has no rotation of its own, so it is not turned. Dissolve the text first to turn its curves.';
    }
    return null;
}

/** Why this transform cannot take an equation curve, or null: it has an offset, no angle or scale of its own. */
function equationRefusal(t: Transform): string | null {
    return t.kind === 'move' ? null
        : `An equation driven curve is where its equations put it, so it is not ${t.kind === 'rotate' ? 'turned' : 'scaled'}: change the equations, or dissolve it first.`;
}

/** The item's placement after the transform. */
function placed(at: Pt, t: Transform): Pt {
    const [u, v] = transformPoint(t, at);
    return [u + 0, v + 0];
}

const factorOf = (t: Transform) => (t.kind === 'scale' ? t.factor : 1);
const turnOf = (t: Transform) => (t.kind === 'rotate' ? t.angle : 0);

/** Copies of the item's ids, read off the copied curves (point for point). */
function copiedIds(before: SketchGeometry, after: SketchGeometry, curves: string[], created: string[]): { curves: string[]; points: Map<string, string> } {
    const points = new Map<string, string>();
    curves.forEach((id, i) => {
        const [a, b] = [curveOf(before, id), curveOf(after, created[i])];
        if (a && b) {
            const [pa, pb] = [curvePoints(a), curvePoints(b)];
            pa.forEach((p, k) => points.set(p, pb[k]));
        }
    });
    return { curves: created.slice(0, curves.length), points };
}

function freeId(prefix: string, taken: { id: string }[]): string {
    const used = new Set(taken.map((x) => x.id));
    let n = 1;
    while (used.has(`${prefix}${n}`)) {
        n += 1;
    }
    return `${prefix}${n}`;
}

/**
 * transformEntities, with the curves of text, block instances and equation curves taken as whole items. Null when
 * the ids touch none of them (the plain transform applies). `keep`: a moved block instance keeps its relations to
 * what stays behind (Keep relations).
 */
export function transformWithItems(g: SketchGeometry, ids: string[], t: Transform, copy: boolean, keep = false): TransformResult | { error: string } | null {
    const owners = new Map<string, NonNullable<ReturnType<typeof ownerOf>>>();
    for (const id of ids) {
        const owner = ownerOf(g, id);
        if (owner) {
            owners.set(owner.id, owner);
        }
    }
    if (!owners.size) {
        return null;
    }
    if (t.kind === 'scale' && !(t.factor > 0)) {
        return { error: 'The scale factor must be above zero.' };
    }
    const texts = (g.texts ?? []).filter((x) => owners.has(x.id));
    const inserts = (g.inserts ?? []).filter((x) => owners.has(x.id));
    const equations = (g.equations ?? []).filter((x) => owners.has(x.id));
    // An offset of curves goes where its curves go (it is rebuilt from them); a copy of it is plain geometry.
    const offsets = (g.offsets ?? []).filter((x) => owners.has(x.id));
    if (!copy && offsets.some((x) => !x.base.every((b) => ids.includes(b.curve)))) {
        return { error: 'An offset goes where the curves it was offset from go: move those curves with it, or copy it.' };
    }
    if (equations.length && equationRefusal(t)) {
        return { error: equationRefusal(t)! };
    }
    for (const text of texts) {
        const refused = textRefusal(text, t);
        if (refused) {
            return { error: refused };
        }
    }
    const owned = new Set([...owners.values()].flatMap((o) => [...o.owned.curves, ...o.owned.points]));
    const rest = ids.filter((id) => !owned.has(id));
    let out = g;
    const created: string[] = [];
    let dropped = 0;
    if (rest.length) {
        const r = transformEntities(out, rest, t, copy);
        if ('error' in r) {
            return r;
        }
        out = r.g;
        created.push(...r.created);
        dropped += r.dropped;
    }
    const f = factorOf(t);
    const movedIds = new Set([...ids, ...[...owners.values()].flatMap((o) => [...o.owned.curves, ...o.owned.points])]);
    for (const ins of inserts) {
        const moved = { at: placed(ins.at, t), angle: ins.angle + turnOf(t), scale: ins.scale * f };
        if (copy) {
            // A copy of a block instance is another instance of the block, built from it.
            const placedCopy = insertBlock(out, ins.block, moved, { ...(ins.lockAngle ? { lockAngle: true } : {}), ...(ins.construction ? { construction: true } : {}) });
            if (typeof placedCopy === 'string') {
                return { error: placedCopy };
            }
            out = placedCopy.g;
            created.push(...placedCopy.insert.curves);
            continue;
        }
        // Built again where it goes (ids kept); without Keep relations, its relations to what stays behind go.
        const r = placeInsert(out, ins.id, moved);
        if (typeof r === 'string') {
            return { error: r };
        }
        const own = new Set([...ins.curves, ...ins.points]);
        const tied = (k: SketchConstraint) => constraintRefs(k).some((id) => own.has(id)) && constraintRefs(k).some((id) => !movedIds.has(id));
        const before = r.constraints.length;
        out = keep ? r : { ...r, constraints: r.constraints.filter((k) => !tied(k)) };
        dropped += before - out.constraints.length;
        created.push(...ins.curves);
    }
    for (const item of texts) {
        const r = transformEntities(out, item.curves, t, copy);
        if ('error' in r) {
            return r;
        }
        const moved = { at: placed(item.at, t), height: item.height * f };
        if (!copy) {
            out = { ...r.g, texts: (r.g.texts ?? []).map((x) => (x.id === item.id ? { ...x, ...moved } : x)) };
            created.push(...item.curves);
            dropped += r.dropped;
            continue;
        }
        // A copy of a text: the copied outline, owned by a new text item placed where it went.
        const copied = copiedIds(out, r.g, item.curves, r.created);
        const points = item.points.map((p) => copied.points.get(p)).filter((p): p is string => !!p);
        const fixed = new Set(points);
        const text: SketchText = { ...item, ...moved, id: freeId('t', r.g.texts ?? []), curves: copied.curves, points };
        out = {
            ...r.g,
            points: r.g.points.map((p) => (fixed.has(p.id) ? { ...p, fixed: true } : p)),
            texts: [...(r.g.texts ?? []), text],
        };
        created.push(...copied.curves);
    }
    for (const item of offsets) {
        if (!copy) {
            continue;
        }
        const r = transformEntities(out, item.curves.slice(item.dimensions ? item.distances.length : 0), t, true);
        if ('error' in r) {
            return r;
        }
        // The copied points are free: the copy is no longer rebuilt from anything.
        out = r.g;
        created.push(...r.created);
    }
    for (const item of equations) {
        const by = (t as Extract<Transform, { kind: 'move' }>).by;
        const offset: Pt = [(item.offset?.[0] ?? 0) + by[0], (item.offset?.[1] ?? 0) + by[1]];
        const r = transformEntities(out, item.curves, t, copy);
        if ('error' in r) {
            return r;
        }
        if (!copy) {
            out = { ...r.g, equations: (r.g.equations ?? []).map((x) => (x.id === item.id ? { ...x, offset } : x)) };
            created.push(...item.curves);
            dropped += r.dropped;
            continue;
        }
        // A copy: the copied spline, owned by a new equation curve with the same equations, moved.
        const copied = copiedIds(out, r.g, item.curves, r.created);
        const points = item.points.map((p) => copied.points.get(p)).filter((p): p is string => !!p);
        const fixed = new Set(points);
        const equation: SketchEquationCurve = { ...item, offset, id: freeId('eq', r.g.equations ?? []), curves: copied.curves, points };
        out = {
            ...r.g,
            points: r.g.points.map((p) => (fixed.has(p.id) ? { ...p, fixed: true } : p)),
            equations: [...(r.g.equations ?? []), equation],
        };
        created.push(...copied.curves);
    }
    return { g: out, created, dropped };
}
