// The regions of a sketch written as profiles alone, without the sketcher's geometry (e.g. by Jarvis's tools), which
// stores no regions of its own. Such profiles are separate or nested (the kernel refuses crossing ones), so each
// profile with the profiles directly inside it as holes is one region, as the sketcher would find it: three
// concentric circles give a disc and two rings. Shared by the view (picking) and the kernel (building the picks).

import type { SketchProfile } from './index';

type P2 = [number, number];

function area(points: P2[]): number {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        a += x0 * y1 - x1 * y0;
    }
    return Math.abs(a / 2);
}

function inside(p: P2, poly: P2[]): boolean {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
            hit = !hit;
        }
    }
    return hit;
}

/**
 * One region per profile: `outer` is its index in `profiles`, `holes` the indices of the profiles directly inside it.
 * `outline` gives a profile's outline as points.
 */
export function profileRegionLoops(profiles: readonly SketchProfile[], outline: (p: SketchProfile) => P2[]): { outer: number; holes: number[] }[] {
    const loops = profiles.map((p) => {
        const points = outline(p);
        return { points, size: points.length > 2 ? area(points) : 0 };
    });
    // Parent: the smallest profile that contains this one.
    const parent = loops.map((loop, i) => {
        let best = -1;
        loops.forEach((other, j) => {
            if (j !== i && loop.points.length && other.size > loop.size && inside(loop.points[0], other.points)
                && (best < 0 || other.size < loops[best].size)) {
                best = j;
            }
        });
        return best;
    });
    return profiles.map((_, i) => ({ outer: i, holes: parent.flatMap((p, j) => (p === i ? [j] : [])) }));
}
