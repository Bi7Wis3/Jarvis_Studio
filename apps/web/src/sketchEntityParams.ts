// The Parameters of a selected line, circle, arc or point (SolidWorks Line Properties, Circle, Arc and Point
// PropertyManagers): the values they show, and the sketch with typed values put in. The typed values are reached as
// a drag of the entity's points to them, so relations keep holding; when they do not let the values hold, nothing
// changes and the caller says so.

import type { SketchGeometry } from '@jarvis/core';
import { ORIGIN, curveOf, pointOf, solveGeometry } from './solver';
import { arcParams, circleParams, editArc, editCircle } from './sketchDrawVariants';
import type { Pt } from './sketchMath';

export type EntityKind = 'line' | 'circle' | 'arc' | 'point';
export type Numbers = Record<string, number>;

/** A target a point is pulled to, as the solver takes it. */
export type Target = { point: string; u: number; v: number };

/** The edited sketch (before solving), where its points must end up, and what else must hold afterwards. */
export interface EntityEdit {
    g: SketchGeometry;
    targets: Target[];
    check?: (solved: SketchGeometry) => boolean;
}

const TOL = 1e-6;
const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** The id of the entity of this kind the selection is, or null. Points of text, blocks and equation curves are not. */
export function entityOf(g: SketchGeometry, kind: EntityKind, pick: { type: string; id: string } | undefined): string | null {
    if (!pick) {
        return null;
    }
    if (kind === 'point') {
        const p = pick.type === 'point' && pick.id !== ORIGIN ? pointOf(g, pick.id) : undefined;
        return p && !p.fixed ? p.id : null;
    }
    return pick.type === 'curve' && curveOf(g, pick.id)?.kind === kind ? pick.id : null;
}

/**
 * The values the form shows. Line: Length, Angle (counter-clockwise from the horizontal, start to end, -180 to 180
 * degrees), Start, End and Delta (end minus start); circle: Centre and Radius; arc: Centre, Start, End, Radius and
 * the Angle it subtends; point: X and Y. Vector values are keyed as the form's fields are: `start0`, `start1`.
 */
export function entityValues(g: SketchGeometry, kind: EntityKind, id: string): Numbers | null {
    switch (kind) {
        case 'line': {
            const c = curveOf(g, id);
            if (c?.kind !== 'line' || !pointOf(g, c.a) || !pointOf(g, c.b)) {
                return null;
            }
            const [a, b] = [P(g, c.a), P(g, c.b)];
            const d: Pt = [b[0] - a[0], b[1] - a[1]];
            return {
                length: Math.hypot(d[0], d[1]), angle: deg(Math.atan2(d[1], d[0])) + 0,
                start0: a[0], start1: a[1], end0: b[0], end1: b[1], delta0: d[0], delta1: d[1],
            };
        }
        case 'circle': {
            const p = circleParams(g, id);
            return p && { centre0: p.cx, centre1: p.cy, radius: p.r };
        }
        case 'arc': {
            const p = arcParams(g, id);
            return p && { centre0: p.cx, centre1: p.cy, start0: p.sx, start1: p.sy, end0: p.ex, end1: p.ey, radius: p.r, angle: p.angle };
        }
        case 'point': {
            const p = id !== ORIGIN ? pointOf(g, id) : undefined;
            return p ? { x: p.u, y: p.v } : null;
        }
    }
}

const has = (n: Numbers, ...keys: string[]) => keys.some((k) => k in n);

/**
 * The sketch with the changed values `next` (only the keys typed) put in, or the reason it cannot be. A line keeps
 * its start unless Start is typed; End, Delta, or Length and Angle then place its end, in that order.
 */
export function editEntity(g: SketchGeometry, kind: EntityKind, id: string, next: Numbers): EntityEdit | string {
    const now = entityValues(g, kind, id);
    if (!now) {
        return 'Select it in the view again: it is not in the sketch any more.';
    }
    if (Object.values(next).some((n) => !Number.isFinite(n))) {
        return 'Each value must be a number.';
    }
    const v = (key: string) => next[key] ?? now[key];
    switch (kind) {
        case 'line': {
            const c = curveOf(g, id);
            if (c?.kind !== 'line') {
                return 'Select the line again.';
            }
            const a: Pt = [v('start0'), v('start1')];
            let b: Pt = [now.end0, now.end1];
            if (has(next, 'end0', 'end1')) {
                b = [v('end0'), v('end1')];
            }
            if (has(next, 'delta0', 'delta1')) {
                b = [a[0] + v('delta0'), a[1] + v('delta1')];
            }
            if (has(next, 'length', 'angle')) {
                const length = 'length' in next ? next.length : Math.hypot(b[0] - a[0], b[1] - a[1]);
                if (!(length > 0)) {
                    return 'The length must be above zero.';
                }
                const t = rad(v('angle'));
                b = [a[0] + length * Math.cos(t), a[1] + length * Math.sin(t)];
            }
            if (Math.hypot(b[0] - a[0], b[1] - a[1]) < TOL) {
                return 'The start and the end would be the same point.';
            }
            const moved = { ...g, points: g.points.map((p) => (p.id === c.a ? { ...p, u: a[0], v: a[1] } : p.id === c.b ? { ...p, u: b[0], v: b[1] } : p)) };
            return { g: moved, targets: [{ point: c.a, u: a[0], v: a[1] }, { point: c.b, u: b[0], v: b[1] }] };
        }
        case 'circle': {
            const c = curveOf(g, id);
            if (c?.kind !== 'circle') {
                return 'Select the circle again.';
            }
            const r = v('radius');
            if (!(r > 0)) {
                return 'The radius must be above zero.';
            }
            const edited = editCircle(g, id, { cx: v('centre0'), cy: v('centre1'), r });
            return {
                g: edited,
                targets: [{ point: c.center, u: v('centre0'), v: v('centre1') }],
                check: (solved) => {
                    const k = curveOf(solved, id);
                    return k?.kind === 'circle' && Math.abs(k.radius - r) <= TOL;
                },
            };
        }
        case 'arc': {
            const c = curveOf(g, id);
            if (c?.kind !== 'arc') {
                return 'Select the arc again.';
            }
            if (!(v('radius') > 0) || !(v('angle') > 0 && v('angle') < 360)) {
                return 'The radius must be above zero and the angle between 0 and 360 degrees.';
            }
            const keys = { centre0: 'cx', centre1: 'cy', start0: 'sx', start1: 'sy', end0: 'ex', end1: 'ey', radius: 'r', angle: 'angle' } as const;
            // Only what was typed: each parameter moves the arc its own way (editArc).
            const patch = Object.fromEntries(Object.entries(keys).filter(([key]) => key in next).map(([key, name]) => [name, next[key]]));
            const edited = editArc(g, id, patch);
            return { g: edited, targets: [c.center, c.start, c.end].map((point) => ({ point, u: P(edited, point)[0], v: P(edited, point)[1] })) };
        }
        case 'point':
            return { g: { ...g, points: g.points.map((p) => (p.id === id ? { ...p, u: v('x'), v: v('y') } : p)) }, targets: [{ point: id, u: v('x'), v: v('y') }] };
    }
}

/** The edit solved as a drag to its targets: the solved sketch, or why its relations and dimensions refuse it. */
export function solveEntityEdit(edit: EntityEdit): SketchGeometry | string {
    const r = solveGeometry(edit.g, { targets: edit.targets });
    const reached = r.ok && edit.targets.every((t) => {
        const p = pointOf(r.geometry, t.point);
        return !!p && Math.hypot(p.u - t.u, p.v - t.v) <= TOL;
    });
    if (!reached || (edit.check && !edit.check(r.geometry))) {
        return 'Its relations and dimensions do not let it go there; change or delete them first.';
    }
    return r.geometry;
}
