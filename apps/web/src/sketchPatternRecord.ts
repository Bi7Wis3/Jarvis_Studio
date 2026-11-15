// Sketch patterns kept as records (SketchGeometry.patterns), so a pattern can be edited after it is made, as in
// SolidWorks (right-click an instance > Edit Linear Pattern; with Display instance count, a double-click on the
// count in the view changes it). A record names the original (seed) curves, the options and everything the pattern
// added; editing takes those out and makes the pattern again from the seed with the new options.

import type { SketchGeometry, SketchPatternRecord } from '@jarvis/core';
import { constraintRefs } from './sketchGeometry';
import { curvePointIds as curvePoints } from './sketchCurves';
import { curveOf, pointOf } from './solver';
import type { Pt } from './sketchMath';

type Kind = SketchPatternRecord['kind'];

function freeId(g: SketchGeometry): string {
    const taken = new Set((g.patterns ?? []).map((p) => p.id));
    let n = 1;
    while (taken.has(`pat${n}`)) {
        n += 1;
    }
    return `pat${n}`;
}

/** The pattern just made (`after`, from `before`) recorded with its seed and options. */
export function withRecord(before: SketchGeometry, after: SketchGeometry, kind: Kind, seed: string[], options: object): SketchGeometry {
    const had = new Set([...before.points.map((p) => p.id), ...before.curves.map((c) => c.id), ...before.constraints.map((k) => k.id)]);
    const record: SketchPatternRecord = {
        id: freeId(after),
        kind,
        seed: [...seed],
        options: JSON.parse(JSON.stringify(options)) as Record<string, unknown>,
        curves: after.curves.filter((c) => !had.has(c.id)).map((c) => c.id),
        points: after.points.filter((p) => !had.has(p.id)).map((p) => p.id),
        constraints: after.constraints.filter((k) => !had.has(k.id)).map((k) => k.id),
        ...((options as { showCount?: boolean }).showCount ? { showCount: true } : {}),
    };
    return { ...after, patterns: [...(after.patterns ?? []), record] };
}

/** Records after an edit: deleted entities leave their lists; a pattern whose original is gone is forgotten. */
export function syncPatterns(g: SketchGeometry): SketchGeometry {
    if (!g.patterns?.length) {
        return g;
    }
    const curves = new Set(g.curves.map((c) => c.id));
    const points = new Set(g.points.map((p) => p.id));
    const constraints = new Set(g.constraints.map((k) => k.id));
    let changed = false;
    const kept: SketchPatternRecord[] = [];
    for (const r of g.patterns) {
        if (!r.seed.every((id) => curves.has(id))) {
            changed = true;
            continue;
        }
        const next = { ...r, curves: r.curves.filter((id) => curves.has(id)), points: r.points.filter((id) => points.has(id)), constraints: r.constraints.filter((id) => constraints.has(id)) };
        if (next.curves.length !== r.curves.length || next.points.length !== r.points.length || next.constraints.length !== r.constraints.length) {
            changed = true;
        }
        kept.push(next);
    }
    return changed ? { ...g, patterns: kept } : g;
}

/** The pattern a curve belongs to, as an instance or the original. */
export function patternRecordOf(g: SketchGeometry, id: string): SketchPatternRecord | null {
    return g.patterns?.find((r) => r.curves.includes(id) || r.seed.includes(id)) ?? null;
}

/** The sketch without what the pattern added (its instances and skeleton), and without its record. */
export function withoutPattern(g: SketchGeometry, id: string): SketchGeometry {
    const r = g.patterns?.find((x) => x.id === id);
    if (!r) {
        return g;
    }
    const gone = new Set([...r.curves, ...r.points]);
    const relations = new Set(r.constraints);
    // A point the pattern made but something else now uses stays (with what holds it).
    const used = new Set(g.curves.filter((c) => !gone.has(c.id)).flatMap(curvePoints));
    for (const p of r.points) {
        if (used.has(p)) {
            gone.delete(p);
        }
    }
    return {
        ...g,
        points: g.points.filter((p) => !gone.has(p.id)),
        curves: g.curves.filter((c) => !gone.has(c.id)),
        constraints: g.constraints.filter((k) => !relations.has(k.id) && !constraintRefs(k).some((x) => gone.has(x))),
        patterns: g.patterns!.filter((x) => x.id !== id),
    };
}

/**
 * Makes the pattern again from its original with new options (`make` runs the pattern on a sketch). The record
 * keeps its id.
 */
export function editPattern(g: SketchGeometry, id: string, options: object,
    make: (g: SketchGeometry, seed: string[], options: object) => { g: SketchGeometry } | { error: string }): SketchGeometry | string {
    const r = g.patterns?.find((x) => x.id === id);
    if (!r) {
        return 'That pattern is gone.';
    }
    const base = withoutPattern(g, id);
    const made = make(base, r.seed, options);
    if ('error' in made) {
        return made.error;
    }
    const patterns = made.g.patterns ?? [];
    const last = patterns[patterns.length - 1];
    // The new record takes the old one's place and id.
    const order = (g.patterns ?? []).map((x) => x.id);
    const renamed = patterns.map((x) => (x === last ? { ...x, id } : x));
    renamed.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return { ...made.g, patterns: renamed };
}

/** Where a pattern's instance count is shown: past its last instance (linear), or at its centre (circular). */
export function countSpot(g: SketchGeometry, r: SketchPatternRecord): Pt | null {
    const first = curveOf(g, r.seed[0]);
    const anchor = first && pointOf(g, curvePoints(first)[0]);
    if (!anchor) {
        return null;
    }
    const o = r.options as { count?: number; spacing?: number; angle?: number; centre?: string | Pt };
    if (r.kind === 'linear') {
        const n = Math.max(1, Math.round(Number(o.count ?? 1)));
        const a = ((Number(o.angle ?? 0)) * Math.PI) / 180;
        const s = Number(o.spacing ?? 0);
        return [anchor.u + Math.cos(a) * s * (n - 0.5), anchor.v + Math.sin(a) * s * (n - 0.5)];
    }
    if (typeof o.centre === 'string') {
        const c = pointOf(g, o.centre);
        return c ? [c.u, c.v] : null;
    }
    return Array.isArray(o.centre) ? [Number(o.centre[0]), Number(o.centre[1])] : null;
}
