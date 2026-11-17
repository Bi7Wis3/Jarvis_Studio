// Pierce points of the part's other sketches: where their lines, arcs and circles pass through the open sketch's plane.

import type { Feature, SketchGeometry, SketchPlane } from '@jarvis/core';
import { projectPoint, tidy, type P2, type PlaneFrame3, type Skipped } from '@jarvis/core/projection';
import { profilesToGeometry } from './sketchGeometry';
import { planeFrame } from './sketchMath';
import { CURVE_NOUN } from './sketchCurves';
import { helixPiercePoints } from './sketchHelixPierce';

type V3 = [number, number, number];

/** The pierce points of the curves `ids` (`<step>/<curve>`) of other sketches, in the plane's (u, v). */
export function pierceCurves(features: Feature[], here: PlaneFrame3, ids: string[]): { points: P2[]; skipped: Skipped[] } {
    const points: P2[] = [];
    const skipped: Skipped[] = [];
    const height = (p: V3) => [0, 1, 2].reduce((h, i) => h + (p[i] - here.origin[i]) * here.n[i], 0);
    const add = (p: V3) => {
        const [u, v] = projectPoint(here, p);
        const q: P2 = [tidy(u), tidy(v)];
        if (!points.some((x) => Math.abs(x[0] - q[0]) < 1e-9 && Math.abs(x[1] - q[1]) < 1e-9)) {
            points.push(q);
        }
    };
    for (const ref of ids) {
        const [stepId, curveId] = ref.split('/');
        const index = features.findIndex((f) => f.id === stepId);
        const f = features[index];
        // A helix or spiral step: every place it passes through the plane.
        const onHelix = f?.op === 'helix' ? helixPiercePoints(features, stepId, here) : null;
        if (onHelix) {
            onHelix.forEach((p) => add(here.origin.map((o, i) => o + here.u[i] * p[0] + here.v[i] * p[1]) as V3));
            if (!onHelix.length) {
                skipped.push({ what: f.name ?? stepId, why: 'it does not pass through the sketch plane' });
            }
            continue;
        }
        const sketch = f && 'sketch' in f ? (f as { sketch?: { plane: SketchPlane; offset?: number; geometry?: SketchGeometry; profiles: never[] } }).sketch : undefined;
        if (!sketch) {
            continue;
        }
        const there = planeFrame(sketch.plane, sketch.offset ?? 0, features.slice(0, index));
        const g = sketch.geometry ?? profilesToGeometry(sketch.profiles);
        const P = (id: string): P2 | null => {
            const p = id === 'origin' ? { u: 0, v: 0 } : g.points.find((x) => x.id === id);
            return p ? [p.u, p.v] : null;
        };
        const to3 = (p: P2): V3 => [0, 1, 2].map((i) => there.origin[i] + there.u[i] * p[0] + there.v[i] * p[1]) as V3;
        const c = g.curves.find((x) => x.id === curveId);
        const before = points.length;
        if (c?.kind === 'line') {
            const [a, b] = [P(c.a), P(c.b)].map((p) => p && to3(p));
            if (a && b) {
                const [ha, hb] = [height(a), height(b)];
                if (Math.abs(ha - hb) > 1e-12 && ha * hb <= 0) {
                    const t = ha / (ha - hb);
                    add([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as V3);
                }
            }
        } else if (c?.kind === 'circle' || c?.kind === 'arc') {
            const centre = P(c.center);
            const start = c.kind === 'arc' ? P(c.start) : null;
            const end = c.kind === 'arc' ? P(c.end) : null;
            if (centre && (c.kind === 'circle' || (start && end))) {
                const r = c.kind === 'circle' ? c.radius : Math.hypot(start![0] - centre[0], start![1] - centre[1]);
                const a0 = c.kind === 'arc' ? Math.atan2(start![1] - centre[1], start![0] - centre[0]) : 0;
                let sweep = c.kind === 'arc' ? Math.atan2(end![1] - centre[1], end![0] - centre[0]) - a0 : 2 * Math.PI;
                while (sweep <= 0) {
                    sweep += 2 * Math.PI;
                }
                // Height of the point at angle t: h0 + p cos t + q sin t; zero where cos(t - phi) = -h0 / R.
                const at = (t: number): V3 => to3([centre[0] + r * Math.cos(t), centre[1] + r * Math.sin(t)]);
                const h0 = height(to3(centre));
                const p = height(at(0)) - h0;
                const q = height(at(Math.PI / 2)) - h0;
                const R = Math.hypot(p, q);
                if (R > 1e-12 && Math.abs(h0) <= R) {
                    const phi = Math.atan2(q, p);
                    const d = Math.acos(Math.max(-1, Math.min(1, -h0 / R)));
                    for (const t of [phi + d, phi - d]) {
                        const rel = ((((t - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
                        if (rel <= sweep + 1e-12) {
                            add(at(t));
                        }
                    }
                } else if (R <= 1e-12) {
                    skipped.push({ what: `${CURVE_NOUN[c.kind]} ${curveId}`, why: 'it is parallel to the sketch plane, so it does not pierce it' });
                    continue;
                }
            }
        } else if (c) {
            skipped.push({ what: `${CURVE_NOUN[c.kind]} ${curveId}`, why: 'only lines, arcs and circles of other sketches are pierced yet' });
            continue;
        }
        if (points.length === before) {
            skipped.push({ what: `${c ? CURVE_NOUN[c.kind] : 'curve'} ${curveId}`, why: 'it does not pass through the sketch plane' });
        }
    }
    return { points, skipped };
}
