// Paths in a sketch (SolidWorks Make Path, and the belt of Belt/Chain): which path a curve is in, the order of a
// chain of curves end to end, the Tangent relation between a path and another entity, and keeping paths in step
// when their curves go.

import type { SketchConstraint, SketchGeometry, SketchPath } from '@jarvis/core';
import type { NewConstraint, Pick } from './sketchGeometry';
import { curveOf } from './solver';
import { curveEndIds } from './sketchCurves';

/** The path a curve belongs to, if any. */
export function pathOf(g: SketchGeometry, curveId: string): SketchPath | null {
    return g.paths?.find((p) => p.curves.includes(curveId)) ?? null;
}

/** The kinds a path takes: lines and arcs (what its relations and length are solved for). */
export const PATH_KINDS: readonly string[] = ['line', 'arc'];

/**
 * The curves in order along one chain, end to end, or why they are not one: each joins the next at an end, none
 * branches, and each is a line or an arc. A chain may close on itself.
 */
export function orderChain(g: SketchGeometry, ids: string[]): string[] | { error: string } {
    const list = [...new Set(ids)];
    if (!list.length) {
        return { error: 'Pick the lines and arcs of the path.' };
    }
    const ends = new Map<string, [string, string]>();
    for (const id of list) {
        const c = curveOf(g, id);
        if (!c || !PATH_KINDS.includes(c.kind)) {
            return { error: 'A path is made of lines and arcs.' };
        }
        if (c.kind === 'line' && c.endless) {
            return { error: 'An infinite line cannot be part of a path: trim it first.' };
        }
        const e = curveEndIds(c);
        ends.set(id, [e[0], e[1]]);
    }
    const count = new Map<string, number>();
    for (const [a, b] of ends.values()) {
        count.set(a, (count.get(a) ?? 0) + 1);
        count.set(b, (count.get(b) ?? 0) + 1);
    }
    if ([...count.values()].some((n) => n > 2)) {
        return { error: 'The curves branch: a path is one chain, each curve joined end to end to the next.' };
    }
    // Start from a free end (an open chain), else anywhere (a closed one).
    const free = list.find((id) => ends.get(id)!.some((p) => count.get(p) === 1)) ?? list[0];
    const order = [free];
    // Go on from the end that is not free.
    const [e0, e1] = ends.get(free)!;
    let at = count.get(e0) === 1 ? e1 : e0;
    while (order.length < list.length) {
        const next = list.find((id) => !order.includes(id) && ends.get(id)!.includes(at));
        if (!next) {
            return { error: 'The curves are not joined end to end in one chain.' };
        }
        order.push(next);
        const [a, b] = ends.get(next)!;
        at = a === at ? b : a;
    }
    return order;
}

/**
 * The Tangent relation when one pick is a curve of a path and the other is not in it: tangent to the path, held by
 * whichever member touches. Null when the picks are not that (the usual relations apply).
 */
export function pathRelationFor(g: SketchGeometry, tool: string, picks: Pick[]): NewConstraint[] | { need: string } | null {
    if (tool !== 'tangent' || picks.length < 2 || picks.some((p) => p.type !== 'curve')) {
        return null;
    }
    // A path picked whole (its members selected together) or by one member, and one other entity.
    const paths = picks.map((p) => pathOf(g, p.id));
    const first = paths.find(Boolean);
    if (!first) {
        return null;
    }
    const outside = picks.filter((_, i) => paths[i]?.id !== first.id);
    if (outside.length !== 1) {
        return { need: 'Pick the path and one entity that is not in it' };
    }
    const [path, other] = [first, outside[0].id];
    const kind = curveOf(g, other)?.kind;
    if (kind !== 'line' && kind !== 'arc' && kind !== 'circle') {
        return { need: 'A path is tangent to a line, arc or circle' };
    }
    return [{ kind: 'pathTangent', path: path.id, curves: [...path.curves], curve: other }];
}

/** The curves a selection of one path member stands for: the whole path (null when the curve is in none). */
export function pathSelection(g: SketchGeometry, curveId: string): string[] | null {
    return pathOf(g, curveId)?.curves ?? null;
}

/**
 * Paths whose curves are gone (a member deleted breaks the chain: the path has to be made again) are dropped, with
 * their path tangent relations; relations on a path that changed take its new members.
 */
export function syncPaths(g: SketchGeometry): SketchGeometry {
    if (!g.paths?.length) {
        return g;
    }
    const curves = new Set(g.curves.map((c) => c.id));
    const kept = g.paths.filter((p) => p.curves.length && p.curves.every((id) => curves.has(id)));
    const members = new Map(kept.map((p) => [p.id, p.curves]));
    const fixed = (k: SketchConstraint): SketchConstraint | null => {
        if (k.kind !== 'pathTangent') {
            return k;
        }
        const now = members.get(k.path);
        if (!now) {
            return null;
        }
        return now.join() === k.curves.join() ? k : { ...k, curves: [...now] };
    };
    const constraints = g.constraints.map(fixed).filter((k): k is SketchConstraint => !!k);
    if (kept.length === g.paths.length && constraints.length === g.constraints.length && constraints.every((k, i) => k === g.constraints[i])) {
        return g;
    }
    return { ...g, paths: kept, constraints };
}
