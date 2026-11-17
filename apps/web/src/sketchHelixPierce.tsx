// Helix and spiral steps seen from an open sketch: their start and end points to snap to (sketchOthers.ts), and the
// Pierce point form's picks of them: where the curve passes through the sketch plane. As SolidWorks' Pierce relation,
// a point moved there by the form stays there when the curve changes if the sketch is on a plane made square to that
// curve at a point of it (its origin is that point, which follows the curve): the point is tied to the sketch's
// origin. On any other plane it is locked where it is now, as the app's other pierce points are.

import type { Feature, SketchConstraint, SketchGeometry, SketchPlane, SketchPoint, Vec3 } from '@jarvis/core';
import { helixDerivatives, helixOfStep, type HelixShape, type HelixStep } from '@jarvis/core/helix';
import { projectPoint, tidy, type P2, type PlaneFrame3 } from '@jarvis/core/projection';
import { useSketchModel } from './sketchModel';
import { newId } from './sketchGeometry';

/** A Pierce form pick of a helix or spiral step: `<id>/curve` (sketchPicks holds `<step>/<curve>` ids). */
export const helixPierceId = (id: string): string => `${id}/curve`;

const helixOf = (features: readonly Feature[], id: string): HelixShape | null => {
    const at = features.findIndex((f) => f.id === id);
    const f = features[at];
    if (!f || f.op !== 'helix') {
        return null;
    }
    try {
        return helixOfStep(f as HelixStep, features.slice(0, at));
    } catch {
        return null;
    }
};

/** While the sketch's Pierce point form is open: picks or drops the helix step; false when the form is not open. */
export function toggleHelixPierce(id: string): boolean {
    if (useSketchModel.getState().picking !== 'pierce') {
        return false;
    }
    const key = helixPierceId(id);
    useSketchModel.setState((m) => ({
        sketchPicks: m.sketchPicks.includes(key) ? m.sketchPicks.filter((x) => x !== key) : [...m.sketchPicks, key],
        version: m.version + 1,
    }));
    return true;
}

/** Where the curve passes through the plane, in its (u, v): every crossing, found on a fine sampling and refined. */
export function helixPierce(s: HelixShape, here: PlaneFrame3): P2[] {
    const n = here.n as Vec3;
    const o = here.origin as Vec3;
    const height = (t: number): number => {
        const p = helixDerivatives(s, t)[0];
        return (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2];
    };
    const count = Math.max(64, Math.min(40000, Math.ceil(s.revolutions * 144)));
    const scale = Math.max(1, s.startDiameter, s.endDiameter, Math.abs(s.height));
    const out: P2[] = [];
    const add = (t: number) => {
        const q = projectPoint(here, helixDerivatives(s, t)[0]);
        const p: P2 = [tidy(q[0]), tidy(q[1])];
        if (!out.some((x) => Math.abs(x[0] - p[0]) < 1e-7 && Math.abs(x[1] - p[1]) < 1e-7)) {
            out.push(p);
        }
    };
    let ta = 0;
    let ha = height(0);
    for (let i = 1; i <= count; i++) {
        const tb = (s.revolutions * i) / count;
        const hb = height(tb);
        if (Math.abs(ha) <= 1e-9 * scale) {
            add(ta);
        } else if (ha * hb < 0) {
            let [lo, hi, hl] = [ta, tb, ha];
            for (let k = 0; k < 80; k++) {
                const mid = (lo + hi) / 2;
                const hm = height(mid);
                if (hm * hl <= 0) {
                    hi = mid;
                } else {
                    [lo, hl] = [mid, hm];
                }
            }
            add((lo + hi) / 2);
        }
        if (i === count && Math.abs(hb) <= 1e-9 * scale) {
            add(tb);
        }
        [ta, ha] = [tb, hb];
    }
    return out;
}

/** The pierce points of the helix step `id` for an open sketch, or null when `id` is not a helix step of `features`. */
export function helixPiercePoints(features: readonly Feature[], id: string, here: PlaneFrame3): P2[] | null {
    const s = helixOf(features, id);
    return s ? helixPierce(s, here) : null;
}

/** The start and end points of the helix steps, seen on the plane, as points to snap to (ids `<step>/start`, `/end`). */
export function helixSnapPoints(features: readonly Feature[], here: PlaneFrame3, skip: (id: string) => boolean): SketchPoint[] {
    return features.flatMap((f) => {
        if (f.op !== 'helix' || f.suppressed || skip(f.id)) {
            return [];
        }
        const s = helixOf(features, f.id);
        if (!s) {
            return [];
        }
        return ([['start', 0], ['end', s.revolutions]] as const).map(([name, t]) => {
            const [u, v] = projectPoint(here, helixDerivatives(s, t)[0]);
            return { id: `${f.id}/${name}`, u: tidy(u), v: tidy(v) };
        });
    });
}

/**
 * Whether the sketch's plane is one made square to helix `id` at a point of it, so the curve pierces the sketch at
 * its origin whatever the curve becomes.
 */
export function piercesAtOrigin(features: readonly Feature[], plane: SketchPlane, offset: number, id: string): boolean {
    if (offset !== 0 || typeof plane !== 'object' || !('planeRef' in plane)) {
        return false;
    }
    const step = features.find((f) => f.id === plane.planeRef);
    if (!step || step.op !== 'plane' || step.definition.kind !== 'curveNormal' || step.definition.curve.curveRef !== id) {
        return false;
    }
    const p = step.definition.point;
    return !!step.definition.originOnCurve || (!Array.isArray(p) && 'curveRef' in p && p.curveRef === id);
}

/**
 * The Pierce form with a helix picked and one sketch point selected: the point goes to the crossing nearest it. On a
 * plane made on that helix, at the origin, it is tied to the origin (it then follows the curve); else it is locked
 * there. Null when no helix is picked or not one point is selected.
 */
export function pierceHelixPoint(g: SketchGeometry, selected: string[], picks: string[], features: readonly Feature[],
    here: PlaneFrame3, plane: SketchPlane, offset: number): SketchGeometry | null {
    if (selected.length !== 1) {
        return null;
    }
    const id = selected[0];
    const point = g.points.find((p) => p.id === id);
    if (!point) {
        return null;
    }
    let best: { at: P2; helix: string } | null = null;
    for (const pick of picks) {
        const helix = pick.endsWith('/curve') ? pick.slice(0, -6) : '';
        for (const at of (helix && helixPiercePoints(features, helix, here)) || []) {
            if (!best || Math.hypot(at[0] - point.u, at[1] - point.v) < Math.hypot(best.at[0] - point.u, best.at[1] - point.v)) {
                best = { at, helix };
            }
        }
    }
    if (!best) {
        return null;
    }
    const used = new Set(g.constraints.map((c) => c.id));
    const fresh = (prefix: string): string => {
        let n = 1;
        while (used.has(`${prefix}${n}`)) {
            n++;
        }
        used.add(`${prefix}${n}`);
        return `${prefix}${n}`;
    };
    const atOrigin = Math.hypot(best.at[0], best.at[1]) < 1e-7 && piercesAtOrigin(features, plane, offset, best.helix);
    const kept = g.constraints.filter((c) => !(c.kind === 'fix' && c.point === id));
    const tie: SketchConstraint = atOrigin ? { id: newId('k', g), kind: 'coincident', a: id, b: 'origin' } : { id: fresh('km'), kind: 'fix', point: id };
    return {
        ...g,
        points: g.points.map((p) => (p.id === id ? { ...p, u: atOrigin ? 0 : best!.at[0], v: atOrigin ? 0 : best!.at[1] } : p)),
        constraints: [...kept, tie],
    };
}

/** The Pierce point form's helix and spiral steps, as chips to pick (a click on the curve in the view does the same). */
export function HelixPierceChips({ features }: { features: readonly Feature[] }) {
    const picks = useSketchModel((s) => s.sketchPicks);
    const helices = features.filter((f) => f.op === 'helix' && !f.suppressed);
    if (!helices.length) {
        return null;
    }
    return (
        <div className="tb-field">
            <span>Curves</span>
            <span className="tb-chips">
                {helices.map((f) => {
                    const on = picks.includes(helixPierceId(f.id));
                    return (
                        <button key={f.id} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => toggleHelixPierce(f.id)}>
                            {f.name ?? f.id}
                        </button>
                    );
                })}
            </span>
        </div>
    );
}
