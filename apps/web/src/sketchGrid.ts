// Grid/Snap helpers (Document Properties > Grid/Snap): how far automatic scaling thins the grid, and the lines of a
// dashed grid over a window of the view.

/** Minor lines closer than this many pixels are thinned out by automatic scaling (ten at a time). */
const MIN_PX = 7;
/** The factor (1, 10, 100, ...) the grid spacing is scaled by so the minor lines are at least MIN_PX apart. */
export function gridScale(minor: number, mmPerPx: number): number {
    let f = 1;
    while (minor * f < MIN_PX * mmPerPx && f < 1e9) {
        f *= 10;
    }
    return f;
}

/** Lines of a square grid of `step` over the window [u0, u1] x [v0, v1], as segment pairs. */
export function gridSegments(step: number, u0: number, u1: number, v0: number, v1: number): [number, number, number][] {
    const out: [number, number, number][] = [];
    if (!(step > 0)) {
        return out;
    }
    for (let i = Math.ceil(u0 / step); i * step <= u1; i++) {
        out.push([i * step, v0, 0], [i * step, v1, 0]);
    }
    for (let j = Math.ceil(v0 / step); j * step <= v1; j++) {
        out.push([u0, j * step, 0], [u1, j * step, 0]);
    }
    return out;
}
