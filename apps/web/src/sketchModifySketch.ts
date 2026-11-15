// Modify Sketch (SolidWorks Tools > Sketch Tools > Modify): moves, turns, scales or flips the whole sketch. A move or
// a turn takes the sketch's own origin and axes along (the geometry does not move relative to its origin, so its
// relations to the origin and axes hold): the sketch plane becomes a plane at the new place. A scale and a flip
// change the geometry about the origin.

import type { CustomSketchPlane, Feature, SketchConstraint, SketchGeometry, SketchPlane, Vec3 } from '@jarvis/core';
import { ORIGIN } from './solver';
import { mapCurvePoints } from './sketchCurves';
import { planeFrame, type Pt } from './sketchMath';

/** Why the sketch's plane cannot be moved, or null. */
export function frameLocked(plane: SketchPlane): string | null {
    return typeof plane === 'object' && 'planeRef' in plane
        ? 'This sketch is on a reference plane; moving or turning it would stop it following that plane. Move the plane instead, or scale and flip here.'
        : null;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/**
 * The plane after moving the sketch by `by` and turning it by `angle` degrees about `centre` (both in the sketch's
 * own coordinates as they are now), offset included.
 */
export function movedPlane(plane: SketchPlane, offset: number, features: Feature[], by: Pt, centre: Pt = [0, 0], angle = 0): CustomSketchPlane {
    const f = planeFrame(plane, offset, features);
    const a = (angle * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    // A point p goes to centre + R(p - centre) + by; the origin to centre - R centre + by.
    const o: Pt = [centre[0] - (c * centre[0] - s * centre[1]) + by[0], centre[1] - (s * centre[0] + c * centre[1]) + by[1]];
    const origin = add(f.origin, add(mul(f.u, o[0]), mul(f.v, o[1])));
    const xDir = add(mul(f.u, c), mul(f.v, s));
    return { origin: origin.map(clean) as Vec3, normal: f.n.map(clean) as Vec3, xDir: xDir.map(clean) as Vec3 };
}

const clean = (x: number) => Math.round(x * 1e9) / 1e9 + 0;

/** A dimension's value under a scale. */
function scaled(k: SketchConstraint, factor: number): SketchConstraint {
    if (k.kind === 'length' || k.kind === 'distance' || k.kind === 'radius' || k.kind === 'diameter') {
        return { ...k, value: k.value * factor };
    }
    return k;
}

/** Scales the whole sketch about its origin: positions, radii and length dimensions (angles stay). */
export function scaleSketch(g: SketchGeometry, factor: number): SketchGeometry | { error: string } {
    if (!(factor > 0)) {
        return { error: 'The scale factor must be above zero.' };
    }
    return {
        points: g.points.map((p) => (p.id === ORIGIN ? p : { ...p, u: p.u * factor, v: p.v * factor })),
        curves: g.curves.map((c) => (c.kind === 'circle' ? { ...c, radius: c.radius * factor } : c)),
        constraints: g.constraints.map((k) => {
            const out = scaled(k, factor);
            return 'at' in out && out.at ? { ...out, at: [out.at[0] * factor, out.at[1] * factor] as Pt } : out;
        }),
    };
}

/** Mirrors the whole sketch about its X axis (v turns over), its Y axis (u turns over) or both. */
export function flipSketch(g: SketchGeometry, about: 'x' | 'y' | 'both'): SketchGeometry {
    const [su, sv] = about === 'x' ? [1, -1] : about === 'y' ? [-1, 1] : [-1, -1];
    // One reflection turns arcs round; two (both axes, a half turn) do not.
    const turn = su * sv < 0;
    return {
        points: g.points.map((p) => (p.id === ORIGIN ? p : { ...p, u: p.u * su + 0, v: p.v * sv + 0 })),
        curves: g.curves.map((c) => (turn ? mapCurvePoints(c, (id) => id, true) : c)),
        constraints: g.constraints.map((k) => ('at' in k && k.at ? { ...k, at: [k.at[0] * su, k.at[1] * sv] as Pt } : k)),
    };
}

/** Labels (dimension positions) under the same scale or flip. */
export function mapLabels(labels: Record<string, Pt>, f: (p: Pt) => Pt): Record<string, Pt> {
    return Object.fromEntries(Object.entries(labels).map(([id, p]) => [id, f(p)]));
}
