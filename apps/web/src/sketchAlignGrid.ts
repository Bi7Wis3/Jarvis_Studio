// Align Grid/Origin (SolidWorks Tools > Sketch Tools > Align > Align Grid/Origin): the sketch's origin goes to a
// point, its X or Y axis along a line (flipped half a turn if asked). Relocate all sketch entities: the sketch comes
// along (its entities keep their coordinates, the plane moves, as Modify Sketch moves it). Relocate origin: the
// entities stay where they are and get coordinates in the new frame; whatever was tied to the old origin and axes
// is tied to a locked point and locked construction lines left in their place, so nothing moves.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, pointOf } from './solver';
import { curvePointIds, mapCurvePoints } from './sketchCurves';
import { addConstraint, constraintRefs, newId } from './sketchGeometry';
import type { Pt } from './sketchMath';

export interface AlignOptions {
    /** The point the origin goes to; absent: the origin stays (or goes square onto the axis line). */
    origin?: string;
    /** The line the chosen axis runs along. */
    axis?: string;
    axisIs: 'x' | 'y';
    /** Turns the new axes half a turn. */
    flip: boolean;
    mode: 'origin' | 'all';
}

/** The new frame in the sketch's coordinates as they are now: where the origin goes and the X axis's angle (radians). */
export function alignFrame(g: SketchGeometry, o: AlignOptions): { at: Pt; angle: number } | { error: string } {
    const xy = (id: string): Pt | null => {
        const p = pointOf(g, id);
        return p ? [p.u, p.v] : null;
    };
    let angle = 0;
    let line: [Pt, Pt] | null = null;
    if (o.axis) {
        const c = curveOf(g, o.axis);
        const [a, b] = c?.kind === 'line' ? [xy(c.a), xy(c.b)] : [null, null];
        if (!a || !b || Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) {
            return { error: 'The axis must be a line of the sketch.' };
        }
        line = [a, b];
        const along = Math.atan2(b[1] - a[1], b[0] - a[0]);
        // The line is the Y axis: X runs a quarter turn clockwise of it.
        angle = o.axisIs === 'y' ? along - Math.PI / 2 : along;
    }
    if (o.flip) {
        angle += Math.PI;
    }
    let at: Pt = [0, 0];
    if (o.origin) {
        const p = o.origin === ORIGIN ? [0, 0] as Pt : xy(o.origin);
        if (!p) {
            return { error: 'The origin location must be a point of the sketch.' };
        }
        at = p;
    } else if (line) {
        // Only an axis: it runs along the line, so the origin goes square onto it.
        const [a, b] = line;
        const d: Pt = [b[0] - a[0], b[1] - a[1]];
        const t = -(a[0] * d[0] + a[1] * d[1]) / (d[0] * d[0] + d[1] * d[1]);
        at = [a[0] + d[0] * t, a[1] + d[1] * t];
    }
    if (!o.origin && !o.axis) {
        return { error: 'Pick the new origin location, or a line for the X or Y axis.' };
    }
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    return { at: [at[0] + 0, at[1] + 0], angle };
}

/** Coordinates in the frame with its origin at `at` and its X axis at `angle` (radians). */
export function toFrame(at: Pt, angle: number): (p: Pt) => Pt {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const clean = (x: number) => (Math.abs(x - Math.round(x * 1e9) / 1e9) < 1e-12 ? Math.round(x * 1e9) / 1e9 : x) + 0;
    return (p) => {
        const [x, y] = [p[0] - at[0], p[1] - at[1]];
        return [clean(c * x + s * y), clean(-s * x + c * y)];
    };
}

/** A constraint with every reference to `from` (a point, curve or axis id) made a reference to `to`. */
function renamed(k: SketchConstraint, from: string, to: string): SketchConstraint {
    const out: Record<string, unknown> = { ...k };
    for (const [key, value] of Object.entries(k)) {
        if (key === 'id' || key === 'kind') {
            continue;
        }
        if (value === from) {
            out[key] = to;
        } else if (Array.isArray(value)) {
            out[key] = value.map((x) => (x === from ? to : x));
        }
    }
    return out as SketchConstraint;
}

/** Relations that hold a direction or a coordinate of the sketch's axes, and cannot be kept when the axes turn. */
const AXIS_BOUND = (k: SketchConstraint) => k.kind === 'horizontalPoints' || k.kind === 'verticalPoints'
    || (k.kind === 'distance' && (!!k.axis || !!k.ordinate)) || (k.kind === 'fix' && !!k.axis);

/**
 * Relocate origin: the sketch's points in the new frame, nothing moved. References to the old origin go to a locked
 * point where it was; to the old axes, to locked construction lines along them; horizontal and vertical lines (when
 * the axes turn) become parallel to those lines.
 */
export function relocatedGeometry(g: SketchGeometry, at: Pt, angle: number): SketchGeometry | { error: string } {
    const turned = Math.abs(angle) > 1e-12;
    if (turned) {
        if (g.constraints.some((k) => !k.suppressed && AXIS_BOUND(k))) {
            return { error: 'Horizontal and vertical dimensions and point relations hold directions of the axes, so they cannot stay as they are when the axes turn alone: use Relocate all sketch entities, or delete them first.' };
        }
        if (g.texts?.some((t) => !t.along?.length) || g.equations?.length) {
            return { error: 'Sketch text and equation driven curves cannot turn with new axes: use Relocate all sketch entities, or turn the axes by moving the origin only.' };
        }
    }
    const f = toFrame(at, angle);
    const map = (p: Pt) => f(p);
    let out: SketchGeometry = {
        ...g,
        points: g.points.map((p) => {
            if (p.id === ORIGIN) {
                return p;
            }
            const [u, v] = map([p.u, p.v]);
            return { ...p, u, v };
        }),
        constraints: g.constraints.map((k) => ('at' in k && k.at ? { ...k, at: map(k.at) } as SketchConstraint : k)),
        ...(g.texts ? { texts: g.texts.map((t) => ({ ...t, at: map(t.at) })) } : {}),
        ...(g.pictures ? { pictures: g.pictures.map((p) => ({ ...p, at: map(p.at), angle: p.angle - (angle * 180) / Math.PI })) } : {}),
        ...(g.inserts ? { inserts: g.inserts.map((i) => ({ ...i, at: map(i.at), angle: i.angle - (angle * 180) / Math.PI })) } : {}),
        ...(g.equations ? { equations: g.equations.map((e) => ({ ...e, offset: map(e.offset ?? [0, 0]) })) } : {}),
    };
    const refs = new Set(g.constraints.flatMap((k) => constraintRefs(k)));
    const lock = (p: Pt) => {
        const id = newId('p', out);
        out = addConstraint({ ...out, points: [...out.points, { id, u: p[0], v: p[1] }] }, { kind: 'fix', point: id }).g;
        return id;
    };
    // The old origin, as a locked point (one for everything that needs it).
    let oldOrigin: string | null = null;
    const originPoint = () => (oldOrigin ??= lock(map([0, 0])));
    if (refs.has(ORIGIN) || g.curves.some((c) => curvePointIds(c).includes(ORIGIN))) {
        const id = originPoint();
        out = {
            ...out,
            curves: out.curves.map((c) => mapCurvePoints(c, (p) => (p === ORIGIN ? id : p))),
            constraints: out.constraints.map((k) => renamed(k, ORIGIN, id)),
        };
    }
    const needs = (axis: string, kind: 'horizontal' | 'vertical') => refs.has(axis) || (turned && g.constraints.some((k) => k.kind === kind));
    for (const [axis, kind, dir] of [[AXIS_U, 'horizontal', [10, 0]], [AXIS_V, 'vertical', [0, 10]]] as const) {
        if (!needs(axis, kind)) {
            continue;
        }
        // The old axis, as a locked construction line from the old origin along it.
        const a = originPoint();
        const b = lock(map([dir[0], dir[1]]));
        const line = newId('c', out);
        out = { ...out, curves: [...out.curves, { id: line, kind: 'line', a, b, construction: true }] };
        out = { ...out, constraints: out.constraints.map((k) => renamed(k, axis, line)) };
        if (turned) {
            out = {
                ...out,
                constraints: out.constraints.map((k) => ((k.kind === 'horizontal' || k.kind === 'vertical') && k.kind === kind
                    ? { id: k.id, kind: 'parallel', a: line, b: k.line, ...(k.suppressed ? { suppressed: true } : {}) } : k)),
            };
        }
    }
    return out;
}
