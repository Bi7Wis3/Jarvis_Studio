// Check Sketch for Feature (SolidWorks Tools > Sketch Tools > Check Sketch for Feature): checks the sketch against
// the contour type a feature needs, and names the first problem with the geometry to highlight. The contour types
// are the ones this app's features take, which for a few features is narrower than SolidWorks (see USAGES).

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { pointOf } from './solver';
import { curvePoints, shapeOf } from './sketchEdit';
import { findProblems } from './sketchRepair';
import { intersections } from './snapping';
import { dist, type Pt } from './sketchMath';

/** general: only the checks common to every contour type (SolidWorks: a sketch no feature uses yet). */
export type ContourType = 'multipleClosed' | 'singleClosed' | 'singleOpenOrClosed' | 'general';

export type FeatureUsage = 'none' | 'extrude' | 'cut' | 'revolve' | 'loftSection' | 'sweepProfile' | 'sweepPath';

export const USAGES: { value: FeatureUsage; label: string; contour: ContourType }[] = [
    { value: 'none', label: '<none>', contour: 'general' },
    { value: 'extrude', label: 'Extrude', contour: 'multipleClosed' },
    // SolidWorks also takes a single open contour for a cut (cut through to one side); this app's cut does not.
    { value: 'cut', label: 'Cut extrude', contour: 'multipleClosed' },
    { value: 'revolve', label: 'Revolve', contour: 'multipleClosed' },
    { value: 'loftSection', label: 'Loft section', contour: 'singleClosed' },
    // SolidWorks also sweeps a single open profile (a thin or surface sweep); this app sweeps closed profiles only.
    { value: 'sweepProfile', label: 'Sweep profile', contour: 'multipleClosed' },
    { value: 'sweepPath', label: 'Sweep path', contour: 'singleOpenOrClosed' },
];

export const CONTOUR_TEXT: Record<ContourType, string> = {
    multipleClosed: 'Closed contours, one or more, not crossing each other',
    singleClosed: 'One closed contour',
    singleOpenOrClosed: 'One open or one closed contour',
    general: 'Any (only the checks common to all features)',
};

export interface CheckResult {
    ok: boolean;
    text: string;
    /** Geometry to highlight. */
    refs: string[];
}

const endsOf = (c: SketchCurve): string[] => (c.kind === 'line' ? [c.a, c.b] : c.kind === 'arc' ? [c.start, c.end] : []);
const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** Connected groups of curves (sharing end points), each with its open ends. */
function contours(curves: SketchCurve[]): { curves: string[]; open: string[]; branch: string[] }[] {
    const parent = new Map<string, string>(curves.map((c) => [c.id, c.id]));
    const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
    const byPoint = new Map<string, string[]>();
    for (const c of curves) {
        for (const p of endsOf(c)) {
            byPoint.set(p, [...(byPoint.get(p) ?? []), c.id]);
        }
    }
    for (const owners of byPoint.values()) {
        owners.slice(1).forEach((id) => parent.set(find(id), find(owners[0])));
    }
    const groups = new Map<string, { curves: string[]; open: string[]; branch: string[] }>();
    for (const c of curves) {
        const key = find(c.id);
        groups.set(key, groups.get(key) ?? { curves: [], open: [], branch: [] });
        groups.get(key)!.curves.push(c.id);
    }
    for (const [p, owners] of byPoint) {
        const group = groups.get(find(owners[0]))!;
        // A curve whose both ends are one point counts twice there (a closed arc).
        if (owners.length === 1) {
            group.open.push(p);
        } else if (owners.length > 2) {
            group.branch.push(p);
        }
    }
    return [...groups.values()];
}

/** Places where two curves cross or touch away from an end point they share. */
function crossings(g: SketchGeometry, curves: SketchCurve[]): { at: Pt; curves: [string, string] }[] {
    const out: { at: Pt; curves: [string, string] }[] = [];
    const plain = curves.filter((c) => c.kind === 'line' || c.kind === 'arc' || c.kind === 'circle');
    for (let i = 0; i < plain.length; i++) {
        for (let j = i + 1; j < plain.length; j++) {
            const [a, b] = [plain[i], plain[j]];
            const shared = endsOf(a).filter((p) => endsOf(b).includes(p)).map((p) => P(g, p));
            for (const at of intersections(shapeOf(g, a), shapeOf(g, b))) {
                if (!shared.some((s) => dist(s, at) < 1e-5)) {
                    out.push({ at, curves: [a.id, b.id] });
                }
            }
        }
    }
    return out;
}

/** Checks the sketch for a feature that needs `contour`; the first problem found, or that there is none. */
export function checkSketchFor(g: SketchGeometry, contour: ContourType): CheckResult {
    const curves = g.curves.filter((c) => !c.construction);
    if (!curves.length) {
        return { ok: false, text: 'The sketch has no curves other than construction geometry.', refs: [] };
    }
    // Checks common to every contour type: zero-length and doubled curves, small gaps.
    const solid: SketchGeometry = { ...g, curves };
    for (const p of findProblems(solid)) {
        if (p.kind === 'zero' || p.kind === 'duplicate' || p.kind === 'overlap') {
            return { ok: false, text: `${p.text}.`, refs: p.refs };
        }
        if (p.kind === 'gap') {
            return { ok: false, text: `Open contour: ${p.text.charAt(0).toLowerCase()}${p.text.slice(1)}.`, refs: p.refs };
        }
    }
    if (contour === 'general') {
        return { ok: true, text: 'No problems found.', refs: [] };
    }
    const groups = contours(curves);
    const branch = groups.find((k) => k.branch.length);
    if (branch) {
        const at = branch.branch[0];
        return { ok: false, text: 'More than two curves meet at one point: a contour may only pass through it once.', refs: [at, ...curves.filter((c) => endsOf(c).includes(at)).map((c) => c.id)] };
    }
    const cross = crossings(g, curves);
    if (cross.length) {
        const [a, b] = cross[0].curves;
        return { ok: false, text: `The contour crosses itself or another one: ${a} and ${b} cross.`, refs: [a, b] };
    }
    const open = groups.filter((k) => k.open.length);
    const closed = groups.filter((k) => !k.open.length);
    if (contour === 'multipleClosed') {
        if (open.length) {
            return { ok: false, text: `Open contour: it has free ends${open.length > 1 ? ` (${open.length} open contours)` : ''}. Close it, or make it construction geometry.`, refs: [...open[0].open, ...open[0].curves] };
        }
        return { ok: true, text: `No problems found: ${closed.length} closed contour${closed.length === 1 ? '' : 's'}.`, refs: [] };
    }
    if (groups.length > 1) {
        return { ok: false, text: `There are ${groups.length} contours where one is needed.`, refs: groups.slice(1).flatMap((k) => k.curves) };
    }
    if (contour === 'singleClosed' && open.length) {
        return { ok: false, text: 'Open contour: it has free ends; this needs one closed contour.', refs: [...open[0].open, ...open[0].curves] };
    }
    return { ok: true, text: `No problems found: one ${open.length ? 'open' : 'closed'} contour.`, refs: [] };
}

/** Every point that some curve of `ids` is built on (for highlighting the curves with their ends). */
export function withPoints(g: SketchGeometry, ids: string[]): string[] {
    return [...new Set([...ids, ...g.curves.filter((c) => ids.includes(c.id)).flatMap(curvePoints)])];
}
