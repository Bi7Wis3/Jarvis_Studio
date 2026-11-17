// Display quality (Options > Display): how finely solids are meshed for the view. Normal is what the kernel has always
// used; coarse meshes faster with fewer triangles; fine is used for every export, whatever the view uses.

import { createHash } from 'node:crypto';
import type { MeshQuality } from '@jarvis/core/settings';

export type { MeshQuality } from '@jarvis/core/settings';

/** Linear deflection: `relative` of the solid's diagonal, kept between `min` and `max` mm; angular deflection in radians. */
export const MESH_TOLERANCES: Record<MeshQuality, { relative: number; min: number; max: number; angular: number }> = {
    // 0.3 rad, not 0.5: at 29 degrees a triangle on a lofted face bent so far that each showed its own shading patch.
    coarse: { relative: 0.001, min: 0.05, max: 1, angular: 0.3 },
    normal: { relative: 0.0002, min: 0.01, max: 0.2, angular: 0.2 },
    fine: { relative: 0.00005, min: 0.0025, max: 0.05, angular: 0.1 },
};

/** Mesh tolerances for a solid with this bounding-box diagonal. */
export function toleranceFor(diagonal: number, quality: MeshQuality = 'normal'): { tolerance: number; angularTolerance: number } {
    const t = MESH_TOLERANCES[quality];
    return { tolerance: Math.min(t.max, Math.max(t.min, diagonal * t.relative)), angularTolerance: t.angular };
}

/** The key of a mesh at a quality: the solid's own key at normal (as before), a hash of both otherwise. */
export function qualityKey(key: string, quality: MeshQuality = 'normal'): string {
    return quality === 'normal' ? key : createHash('sha256').update(`${key}:${quality}`).digest('hex').slice(0, 24);
}
