// Other parts a part's `combine` steps use, with their placement, so the kernel can build them in its frame.

import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { effectivePart, type Feature, type Part, type Shape, type Vec3 } from '@jarvis/core';

export interface Placement {
    position: Vec3;
    /** Degrees, XYZ Euler, like Part.rotation. */
    rotation: Vec3;
}

export interface CombinePart extends Placement {
    shape: Shape;
    features?: Feature[];
}

/** The part being built (`self`) and every part its combine steps reach, by id, with assembly placements. */
export interface CombineContext {
    self: string;
    parts: Record<string, CombinePart>;
}

/** Ids of the parts a history combines with (unsuppressed combine steps). */
export function combineTargets(features: Feature[] | undefined): string[] {
    return (features ?? []).filter((f) => !f.suppressed && f.op === 'combine').map((f) => (f as { part: string }).part);
}

/**
 * Context for building `part` (its effective design) when it has combine steps, collecting referenced parts
 * transitively; undefined when it has none. Unknown ids are left out (the build then reports them).
 */
export function combineContext(part: Part, parts: Part[]): CombineContext | undefined {
    const self = effectivePart(part, parts);
    if (combineTargets(self.features).length === 0) {
        return undefined;
    }
    const out: Record<string, CombinePart> = {};
    const visit = (p: Part): void => {
        if (out[p.id]) {
            return;
        }
        const e = effectivePart(p, parts);
        out[p.id] = { shape: e.shape, features: e.features, position: p.position, rotation: p.rotation };
        for (const id of combineTargets(e.features)) {
            const other = parts.find((q) => q.id === id);
            if (other) {
                visit(other);
            }
        }
    };
    visit(part);
    return { self: part.id, parts: out };
}

function matrix(p: Placement): Matrix4 {
    const [rx, ry, rz] = p.rotation.map((d) => MathUtils.degToRad(d));
    return new Matrix4().compose(new Vector3(...p.position), new Quaternion().setFromEuler(new Euler(rx, ry, rz, 'XYZ')),
        new Vector3(1, 1, 1));
}

/** Rotation (axis, degrees) and translation taking `other`'s local frame into `self`'s local frame. */
export function relativePlacement(self: Placement, other: Placement): { axis: Vec3; angle: number; translation: Vec3 } {
    const rel = matrix(self).invert().multiply(matrix(other));
    const t = new Vector3();
    const q = new Quaternion();
    rel.decompose(t, q, new Vector3());
    q.normalize();
    const w = Math.min(1, Math.max(-1, q.w));
    const angle = 2 * Math.acos(w);
    const s = Math.sqrt(1 - w * w);
    const axis: Vec3 = s < 1e-9 ? [0, 1, 0] : [q.x / s, q.y / s, q.z / s];
    return { axis, angle: (angle * 180) / Math.PI, translation: [t.x, t.y, t.z] };
}

/** Relative transform as rounded matrix entries, for cache keys. */
export function relativeKey(self: Placement, other: Placement): number[] {
    return matrix(self).invert().multiply(matrix(other)).elements.map((v) => Math.round(v * 1e6) / 1e6 + 0);
}
