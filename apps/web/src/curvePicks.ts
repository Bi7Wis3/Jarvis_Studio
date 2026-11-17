// Picks on helix and spiral steps for the reference forms (referenceDefs.ts): the curve itself as `curve:<id>`, and
// a point on it as `curvept:<id>:start`, `curvept:<id>:end` or `curvept:<id>:<fraction>`. They are stored by the
// step's id (CurvePointRef, CurveRef), so planes and points made from them follow the curve when it changes.

import type { Feature } from '@jarvis/core';
import type { CurvePointRef } from '@jarvis/core/curveRefs';
import type { PickItem } from './pickField';

export const curveRefValue = (id: string): string => `curve:${id}`;
export const curvePointValue = (p: CurvePointRef): string => `curvept:${p.curveRef}:${p.at}`;

/** The curve step id of a `curve:<id>` value. */
export function curveIdOf(ref: string): string | null {
    return ref.startsWith('curve:') ? ref.slice(6) : null;
}

/** The point of a `curvept:<id>:<at>` value. */
export function curvePointOf(ref: string): CurvePointRef | null {
    if (!ref.startsWith('curvept:')) {
        return null;
    }
    const rest = ref.slice(8);
    const cut = rest.lastIndexOf(':');
    if (cut <= 0) {
        return null;
    }
    const at = rest.slice(cut + 1);
    const n = Number(at);
    if (at !== 'start' && at !== 'end' && !(at.trim() !== '' && Number.isFinite(n))) {
        return null;
    }
    return { curveRef: rest.slice(0, cut), at: at === 'start' || at === 'end' ? at : n };
}

const nameOf = (steps: readonly Feature[], id: string): string => steps.find((f) => f.id === id)?.name ?? id;

/** "Helix/Spiral1", "Helix/Spiral1 start", "Helix/Spiral1 at 25%"; null for other values. */
export function curveLabel(ref: string, steps: readonly Feature[]): string | null {
    const id = curveIdOf(ref);
    if (id) {
        return nameOf(steps, id);
    }
    const p = curvePointOf(ref);
    if (!p) {
        return null;
    }
    const name = nameOf(steps, p.curveRef);
    return typeof p.at === 'number' ? `${name} at ${Math.round(p.at * 1e6) / 1e4}%` : `${name} ${p.at}`;
}

export const curveItem = (id: string, steps: readonly Feature[]): PickItem => ({ kind: 'ref', ref: curveRefValue(id), label: nameOf(steps, id) });

export const curvePointItem = (p: CurvePointRef, steps: readonly Feature[]): PickItem =>
    ({ kind: 'ref', ref: curvePointValue(p), label: curveLabel(curvePointValue(p), steps)! });

/** Whether a box item is a helix or spiral, or a point on one. */
export const isCurveItem = (item: PickItem): boolean => item.kind === 'ref' && curveIdOf(item.ref) !== null;
export const isCurvePointItem = (item: PickItem): boolean => item.kind === 'ref' && curvePointOf(item.ref) !== null;

/** List choices for the curves before the step being made: the curves, or their start and end points. */
export function curveOptions(steps: readonly Feature[], points: boolean): { value: string; label: string }[] {
    return steps.filter((f) => f.op === 'helix' && !f.suppressed).flatMap((f) => (points
        ? (['start', 'end'] as const).map((at) => ({ value: curvePointValue({ curveRef: f.id, at }), label: `${f.name ?? f.id} ${at}` }))
        : [{ value: curveRefValue(f.id), label: f.name ?? f.id }]));
}
