// References on a curve step (a helix or spiral, helix.ts): a point at its start, its end or part way through it, and
// a plane square to it at a point (SolidWorks' Plane: Perpendicular to a curve with a Coincident point; Point: On
// point at a curve's end, Along curve distance or percentage). Worked out from the curve step every time, by the
// kernel and the view alike, so planes and points made on a helix follow it when it changes.

import type { CustomSketchPlane, Feature, PointRef, Vec3 } from './index';
import { helixDerivatives, helixLength, helixLengthTo, helixOfStep, helixSpeed, type HelixShape } from './helix';

/** A curve step by id (a helix or spiral). */
export interface CurveRef {
    curveRef: string;
}

/** A point on a curve step: its start, its end, or a fraction (0 to 1) of the way through its revolutions. */
export interface CurvePointRef {
    curveRef: string;
    at: 'start' | 'end' | number;
}

/** A plane square to a curve where it passes nearest the point; the origin at the point, or on the curve. */
export interface CurveNormalDefinition {
    kind: 'curveNormal';
    curve: CurveRef;
    point: PointRef;
    originOnCurve?: boolean;
}

/** A point step made on a curve step: at its start or end (On point), or along it by distance or percentage. */
export type CurvePointDefinition =
    | { kind: 'onCurve'; curve: CurvePointRef }
    | { kind: 'alongCurve'; curve: CurveRef; by: 'distance' | 'percent'; amount: number; index: number; reverse?: boolean };

type V3 = Vec3;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1));

/** The curve of the curve step `id` among `features` (the steps before the one asking). */
export function curveOf(id: string, features: readonly Feature[], where = 'curve'): HelixShape {
    const at = features.findIndex((f) => f.id === id);
    const step = at >= 0 ? features[at] : undefined;
    if (!step || step.op !== 'helix') {
        throw new Error(`${where}: curve "${id}" not found (it must be an earlier helix or spiral step of this part)`);
    }
    return helixOfStep(step, features.slice(0, at));
}

/** The revolution a curve point is at. */
export function curveParam(s: HelixShape, at: CurvePointRef['at']): number {
    if (at === 'start') {
        return 0;
    }
    if (at === 'end') {
        return s.revolutions;
    }
    if (!(typeof at === 'number' && at >= 0 && at <= 1)) {
        throw new Error('a point on a curve is at its start, its end, or a fraction from 0 to 1 of the way');
    }
    return at * s.revolutions;
}

/** Where a curve point is (part frame). */
export function curvePoint(ref: CurvePointRef, features: readonly Feature[], where = 'point'): Vec3 {
    const s = curveOf(ref.curveRef, features, where);
    return helixDerivatives(s, curveParam(s, ref.at))[0];
}

/**
 * The curve at revolution t: the point, the unit tangent (the way it runs), and the unit normal towards its axis,
 * square to the tangent. A profile sketched with its X along that normal keeps its angle to the axis as a sweep
 * along the curve carries it (the sweep keeps the profile at its angle to the axis), so it is not twisted.
 */
export function curveFrame(s: HelixShape, t: number): { point: Vec3; tangent: Vec3; inward: Vec3 } {
    const [point, d] = helixDerivatives(s, t, 1);
    const tangent = unit(d);
    const rel = sub(point, s.centre);
    const radial = sub(rel, scale(s.axis, dot(rel, s.axis)));
    const towards = scale(radial, -1);
    return { point, tangent, inward: unit(sub(towards, scale(tangent, dot(towards, tangent)))) };
}

/** The revolution where the curve passes nearest p (sampled, then Newton on (C - p) . C' = 0). */
export function nearestParam(s: HelixShape, p: Vec3): number {
    const count = Math.max(64, Math.min(20000, Math.ceil(s.revolutions * 72)));
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i <= count; i++) {
        const t = (s.revolutions * i) / count;
        const d = Math.hypot(...sub(helixDerivatives(s, t)[0], p));
        if (d < bestD) {
            bestD = d;
            best = t;
        }
    }
    let t = best;
    for (let k = 0; k < 30; k++) {
        const [c, d1, d2] = helixDerivatives(s, t, 2);
        const w = sub(c, p);
        const g = dot(w, d1);
        const dg = dot(d1, d1) + dot(w, d2);
        if (!(dg > 0)) {
            break;
        }
        const next = Math.max(0, Math.min(s.revolutions, t - g / dg));
        if (Math.abs(next - t) < 1e-15 * Math.max(1, s.revolutions)) {
            t = next;
            break;
        }
        t = next;
    }
    return t;
}

/** A plane square to the curve; `resolvePoint` resolves the point reference (reference.ts). */
export function curveNormalPlane(d: CurveNormalDefinition, before: Feature[], where: string,
    resolvePoint: (ref: PointRef, features: Feature[], where: string) => Vec3): CustomSketchPlane {
    const s = curveOf(d.curve.curveRef, before, where);
    const ref = d.point;
    const onSame = !Array.isArray(ref) && 'curveRef' in ref && ref.curveRef === d.curve.curveRef;
    const p = resolvePoint(ref, before, where);
    const t = onSame ? curveParam(s, (ref as CurvePointRef).at) : nearestParam(s, p);
    const f = curveFrame(s, t);
    return { origin: d.originOnCurve || onSame ? f.point : p, normal: f.tangent, xDir: f.inward };
}

/** The revolution at which the curve has run `length` mm from its start. */
export function paramAtLength(s: HelixShape, length: number): number {
    let lo = 0;
    let hi = s.revolutions;
    const total = helixLength(s);
    let t = total > 0 ? (length / total) * s.revolutions : 0;
    for (let k = 0; k < 60; k++) {
        const err = helixLengthTo(s, t) - length;
        if (Math.abs(err) < 1e-10 * Math.max(1, total)) {
            break;
        }
        if (err > 0) {
            hi = t;
        } else {
            lo = t;
        }
        const next = t - err / helixSpeed(s, t);
        t = next > lo && next < hi ? next : (lo + hi) / 2;
    }
    return t;
}

/**
 * `count` points along the curve from its start (`reverse`: from its end), spaced by a distance or a percentage of
 * its length; the first is one spacing from the end, as in SolidWorks.
 */
export function pointsAlongCurve(s: HelixShape, by: 'distance' | 'percent', amount: number, count: number, reverse = false,
    fmt: (mm: number) => string = String): Vec3[] {
    const total = helixLength(s);
    const spacing = by === 'percent' ? (total * amount) / 100 : amount;
    if (!(spacing > 0)) {
        throw new Error(`the ${by === 'percent' ? 'percentage' : 'distance'} must be greater than 0`);
    }
    if (spacing * count > total * (1 + 1e-9)) {
        throw new Error(`The points run past the end of the curve (it is ${fmt(total)} mm long): use a smaller value or fewer points.`);
    }
    return Array.from({ length: count }, (_, i) => {
        const along = Math.min(total, spacing * (i + 1));
        return helixDerivatives(s, paramAtLength(s, reverse ? total - along : along))[0];
    });
}

export const isCurvePointDefinition = (d: { kind: string }): d is CurvePointDefinition => d.kind === 'onCurve' || d.kind === 'alongCurve';

/** Where a point step made on a curve is now. */
export function curvePointOfDefinition(d: CurvePointDefinition, before: readonly Feature[], where = 'point'): Vec3 {
    if (d.kind === 'onCurve') {
        return curvePoint(d.curve, before, where);
    }
    const s = curveOf(d.curve.curveRef, before, where);
    return pointsAlongCurve(s, d.by, d.amount, d.index, d.reverse)[d.index - 1];
}
