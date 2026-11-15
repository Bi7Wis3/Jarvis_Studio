// Generated sketch items (sketch text, equation driven curves, block instances) and sketch pictures: the parts of a
// sketch beyond its points, curves and constraints. An item owns ordinary curves and points (fixed) that it rebuilds
// when edited; this module keeps the items in step with the entities as the sketch changes.

import type { SketchCurve, SketchGeometry, SketchOwned, SketchPoint } from '@jarvis/core';
import type { Outline } from '@jarvis/core/text';
import { constraintRefs, newId } from './sketchGeometry';
import { curvePointIds } from './sketchCurves';
import { syncSegments } from './sketchSegment';
import { syncPatterns } from './sketchPatternRecord';
import { syncPaths } from './sketchPathModel';

type Pt = [number, number];

export const ITEM_KEYS = ['texts', 'pictures', 'equations', 'blocks', 'inserts', 'offsets', 'segments', 'patterns', 'paths'] as const;

export type OwnerKind = 'text' | 'equation' | 'insert' | 'offset';

const OWNER_KEYS: Record<OwnerKind, 'texts' | 'equations' | 'inserts' | 'offsets'> = { text: 'texts', equation: 'equations', insert: 'inserts', offset: 'offsets' };

/** The items of `from` that `to` does not mention (geometry rebuilt by a tool that knows only points and curves). */
export function carryItems(from: SketchGeometry, to: SketchGeometry): SketchGeometry {
    let out = to;
    for (const key of ITEM_KEYS) {
        if (from[key] !== undefined && !(key in to)) {
            out = { ...out, [key]: from[key] };
        }
    }
    return out;
}

/**
 * Drops the items whose entities were deleted or changed elsewhere: an item with any of its curves gone no longer
 * describes the sketch, so what is left of it stays as plain entities.
 */
export function syncItems(g: SketchGeometry): SketchGeometry {
    const curves = new Set(g.curves.map((c) => c.id));
    // Paths lose what was deleted from them (sketchPathModel.ts).
    let out = syncPaths(g);
    for (const kind of Object.keys(OWNER_KEYS) as OwnerKind[]) {
        const key = OWNER_KEYS[kind];
        const list = g[key] as (SketchOwned & { id: string })[] | undefined;
        if (!list?.length) {
            continue;
        }
        const kept = list.filter((item) => item.curves.length === 0 ? kind === 'text' : item.curves.every((id) => curves.has(id)));
        if (kept.length !== list.length) {
            const gone = list.filter((item) => !kept.includes(item));
            out = { ...unfix(out, gone.flatMap((item) => item.points)), [key]: kept };
        }
    }
    // Segment groups re-space after a point is deleted; patterns forget what was deleted from them.
    return syncPatterns(syncSegments(out));
}

/** How block instances look: the entities of hidden ones, and the colour of those whose block has one. */
export function blockLook(g: SketchGeometry): { hidden: Set<string>; colour: Map<string, string> } {
    const hidden = new Set<string>();
    const colour = new Map<string, string>();
    for (const insert of g.inserts ?? []) {
        if (insert.hidden) {
            [...insert.curves, ...insert.points].forEach((id) => hidden.add(id));
            continue;
        }
        const c = g.blocks?.find((b) => b.id === insert.block)?.colour;
        if (c) {
            insert.curves.forEach((id) => colour.set(id, c));
        }
    }
    return { hidden, colour };
}

/** Every owned item of the sketch. */
export function ownedItems(g: SketchGeometry): { kind: OwnerKind; id: string; owned: SketchOwned }[] {
    return (Object.keys(OWNER_KEYS) as OwnerKind[]).flatMap((kind) =>
        ((g[OWNER_KEYS[kind]] ?? []) as (SketchOwned & { id: string })[]).map((item) => ({ kind, id: item.id, owned: item })));
}

/** The item a curve or point belongs to, if any. */
export function ownerOf(g: SketchGeometry, id: string): { kind: OwnerKind; id: string; owned: SketchOwned } | null {
    return ownedItems(g).find((item) => item.owned.curves.includes(id) || item.owned.points.includes(id)) ?? null;
}

/**
 * Why a tool that cuts or stretches curves (trim, split, extend) leaves this curve alone: text and block instances are
 * single units, changed by dissolving the text or editing or exploding the block; an equation driven curve ends where
 * its range does, changed in its form. Null for other curves.
 */
export function cutRefusal(g: SketchGeometry, curve: string, tool: string): string | null {
    const owner = ownerOf(g, curve);
    if (owner?.kind === 'text') {
        return `${tool} does not cut sketch text: dissolve the text first (right-click it, Dissolve sketch text).`;
    }
    if (owner?.kind === 'insert') {
        return `${tool} does not cut a block instance: edit the block (Edit block), or explode it first (Explode block).`;
    }
    if (owner?.kind === 'equation') {
        return `${tool} does not change an equation driven curve: change its range (x1 and x2, or t1 and t2) in its form instead.`;
    }
    return null;
}

/** The points of all owned items (drawn without their point markers). */
export function ownedPoints(g: SketchGeometry): Set<string> {
    return new Set(ownedItems(g).flatMap((item) => item.owned.points));
}

export function ownedCurves(g: SketchGeometry): Set<string> {
    return new Set(ownedItems(g).flatMap((item) => item.owned.curves));
}

/** Ids to delete for a selection: picking any curve of an item takes the whole item. */
export function expandOwned(g: SketchGeometry, ids: string[]): string[] {
    const out = new Set(ids);
    for (const id of ids) {
        const owner = ownerOf(g, id);
        if (owner) {
            owner.owned.curves.forEach((c) => out.add(c));
            owner.owned.points.forEach((p) => out.add(p));
        }
    }
    return [...out];
}

/** The points made free again (dissolved or exploded items become plain entities). */
function unfix(g: SketchGeometry, ids: string[]): SketchGeometry {
    const set = new Set(ids);
    return set.size ? { ...g, points: g.points.map((p) => (set.has(p.id) && p.fixed ? (({ fixed: _, ...rest }) => rest)(p) : p)) } : g;
}

/** Removes an item's entities and the relations that use them. */
export function removeOwned(g: SketchGeometry, owned: SketchOwned | null): SketchGeometry {
    if (!owned) {
        return g;
    }
    const gone = new Set([...owned.curves, ...owned.points]);
    return {
        ...g,
        points: g.points.filter((p) => !gone.has(p.id)),
        curves: g.curves.filter((c) => !gone.has(c.id)),
        constraints: g.constraints.filter((c) => !constraintRefs(c).some((r) => gone.has(r))),
    };
}

/** Adds entities to the sketch with fresh ids, and returns what they are. */
export function addOwned(g: SketchGeometry, points: { key: string; at: Pt }[], curves: ((id: (key: string) => string) => Omit<SketchCurve, 'id'>)[]):
    { g: SketchGeometry; owned: SketchOwned } {
    let out: SketchGeometry = { ...g, points: [...g.points], curves: [...g.curves] };
    const ids = new Map<string, string>();
    const newPoints: SketchPoint[] = [];
    for (const p of points) {
        const id = newId('p', out);
        ids.set(p.key, id);
        const point: SketchPoint = { id, u: p.at[0] + 0, v: p.at[1] + 0, fixed: true };
        newPoints.push(point);
        out.points.push(point);
    }
    const newCurves: string[] = [];
    for (const make of curves) {
        const id = newId('c', out);
        const curve = { ...make((key) => ids.get(key)!), id } as SketchCurve;
        out.curves.push(curve);
        newCurves.push(id);
    }
    out = { ...out };
    return { g: out, owned: { curves: newCurves, points: newPoints.map((p) => p.id) } };
}

/** Outlines (text glyphs) as fixed lines and Bezier style splines, sharing the points where pieces meet. */
export function addOutlines(g: SketchGeometry, outlines: Outline[], construction = false): { g: SketchGeometry; owned: SketchOwned } {
    const points: { key: string; at: Pt }[] = [];
    const curves: ((id: (key: string) => string) => Omit<SketchCurve, 'id'>)[] = [];
    const extra = construction ? { construction: true } : {};
    outlines.forEach((o, i) => {
        const vertex = (k: number) => `o${i}v${k % o.segments.length}`;
        // Every segment ends on the next one's start; the last ends on the outline's start.
        o.segments.forEach((s, k) => {
            points.push({ key: vertex(k), at: k === 0 ? o.start : o.segments[k - 1].to });
        });
        o.segments.forEach((s, k) => {
            const [a, b] = [vertex(k), vertex(k + 1)];
            if (s.kind === 'line') {
                curves.push((id) => ({ kind: 'line', a: id(a), b: id(b), ...extra }));
            } else {
                const inner = s.controls.map((c, j) => {
                    const key = `o${i}s${k}c${j}`;
                    points.push({ key, at: c });
                    return key;
                });
                curves.push((id) => ({ kind: 'styleSpline', points: [id(a), ...inner.map(id), id(b)], ...extra }));
            }
        });
    });
    return addOwned(g, points, curves);
}

/** Turns an item into plain entities: the item goes, its points are free. */
export function releaseOwned(g: SketchGeometry, owned: SketchOwned): SketchGeometry {
    return unfix(g, owned.points);
}

/** Whether every point of these curves is one of the item's own (it does not lean on other geometry). */
export function curvesPoints(g: SketchGeometry, ids: string[]): string[] {
    return [...new Set(g.curves.filter((c) => ids.includes(c.id)).flatMap(curvePointIds))];
}
