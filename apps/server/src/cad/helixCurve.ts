// Helix and Spiral curve steps in the kernel: the exact curve of @jarvis/core/helix as B-spline edges (at most about
// a turn each, so sweeps along a long spring stay exact), within 1e-8 mm of it; and sweeps along such a curve with the
// profile kept at its angle to the curve's axis, so a long spring does not twist.

import { cast, getOC, localGC, Wire, type Shape3D } from 'replicad';
import type { Feature, Sketch, Vec3 } from '@jarvis/core';
import { helixCircle, helixDerivatives, helixShape, type HelixPiece, type HelixShape, type HelixStep } from '@jarvis/core/helix';
import { sketchFrameOf } from '@jarvis/core/reference';
import type { SketchFrame } from './sketch.js';

/** Degree of the edges: each span matches the curve's value and first three derivatives at both ends (C3 joins). */
const DEGREE = 7;
/** Largest distance of an edge from the exact curve at the same revolution, mm. */
export const HELIX_TOLERANCE = 1e-8;
/** Edges break at whole turns unless a table row is closer than this (revolutions). */
const MIN_EDGE = 0.05;

const binomial = (n: number, k: number): number => {
    let b = 1;
    for (let i = 1; i <= k; i++) {
        b = (b * (n - k + i)) / i;
    }
    return b;
};

/**
 * Longest span (revolutions) between a and b of a piece whose degree 7 Hermite interpolant stays within the
 * tolerance: the error is at most max|f^(8)| h^8 / (8! 2^8), and f^(8) is bounded by the radius terms (the height
 * is quadratic and drops out).
 */
function spanLimit(s: HelixShape, p: HelixPiece, a: number, b: number): number {
    const t = Math.max(Math.abs(a - p.t0), Math.abs(b - p.t0));
    const [a0, a1, a2, a3] = p.r.map(Math.abs);
    const r = [a0 + t * (a1 + t * (a2 + t * a3)), a1 + t * (2 * a2 + 3 * a3 * t), 2 * a2 + 6 * a3 * t, 6 * a3];
    const w = Math.abs(s.omega);
    const bound = r.reduce((sum, rj, j) => sum + binomial(8, j) * rj * w ** (8 - j), 0);
    return (HELIX_TOLERANCE * 40320 * 256 / bound) ** (1 / 8);
}

const combo = (terms: [number, Vec3][]): Vec3 => [0, 1, 2].map((k) => terms.reduce((sum, [c, v]) => sum + c * v[k], 0)) as Vec3;

/** Bezier poles of one span: value and three derivatives matched at both ends. */
function spanPoles(s: HelixShape, p: HelixPiece, ta: number, tb: number): Vec3[] {
    const h = tb - ta;
    const [d0, d1, d2, d3] = helixDerivatives(s, ta, 3, p);
    const [e0, e1, e2, e3] = helixDerivatives(s, tb, 3, p);
    const p1 = combo([[1, d0], [h / 7, d1]]);
    const p2 = combo([[2, p1], [-1, d0], [(h * h) / 42, d2]]);
    const p3 = combo([[3, p2], [-3, p1], [1, d0], [(h * h * h) / 210, d3]]);
    const p6 = combo([[1, e0], [-h / 7, e1]]);
    const p5 = combo([[2, p6], [-1, e0], [(h * h) / 42, e2]]);
    const p4 = combo([[3, p5], [-3, p6], [1, e0], [(-h * h * h) / 210, e3]]);
    return [d0, p1, p2, p3, p4, p5, p6, e0];
}

/** One edge of the curve from revolution a to b (within one piece). */
function curveEdge(s: HelixShape, p: HelixPiece, a: number, b: number) {
    const oc = getOC();
    const n = Math.max(1, Math.ceil((b - a) / spanLimit(s, p, a, b) - 1e-9));
    const knots = Array.from({ length: n + 1 }, (_, i) => (i === n ? b : a + ((b - a) * i) / n));
    const poles: Vec3[] = [];
    for (let i = 0; i < n; i++) {
        const span = spanPoles(s, p, knots[i], knots[i + 1]);
        poles.push(...(i === 0 ? span : span.slice(1)));
    }
    const [r, gc] = localGC();
    try {
        const pa = r(new oc.NCollection_Array1_gp_Pnt(1, poles.length));
        poles.forEach((q, i) => pa.SetValue(i + 1, r(new oc.gp_Pnt(q[0], q[1], q[2]))));
        const ka = r(new oc.NCollection_Array1_double(1, n + 1));
        const ma = r(new oc.NCollection_Array1_int(1, n + 1));
        knots.forEach((k, i) => {
            ka.SetValue(i + 1, k);
            ma.SetValue(i + 1, i === 0 || i === n ? DEGREE + 1 : DEGREE);
        });
        const curve = new oc.Geom_BSplineCurve(pa, ka, ma, DEGREE, false);
        // The spans join with C3 continuity, so the extra knots go again (the curve is unchanged).
        for (let i = n; i >= 2; i--) {
            curve.RemoveKnot(i, DEGREE - 3, 1e-9);
        }
        return r(new oc.BRepBuilderAPI_MakeEdge(curve)).Edge();
    } finally {
        gc();
    }
}

/** Where the curve's edges break: at its pieces (table rows), and at whole turns not close to those. */
function edgeRanges(s: HelixShape): { piece: HelixPiece; a: number; b: number }[] {
    const out: { piece: HelixPiece; a: number; b: number }[] = [];
    for (const piece of s.pieces) {
        let a = piece.t0;
        for (let k = Math.floor(piece.t0) + 1; k < piece.t1; k++) {
            if (k - a >= MIN_EDGE && piece.t1 - k >= MIN_EDGE) {
                out.push({ piece, a, b: k });
                a = k;
            }
        }
        out.push({ piece, a, b: piece.t1 });
    }
    return out;
}

/** The curve as a wire of B-spline edges whose parameter is the revolutions turned. */
export function helixWire(s: HelixShape): Wire {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const builder = r(new oc.BRepBuilderAPI_MakeWire());
        for (const { piece, a, b } of edgeRanges(s)) {
            builder.Add(r(curveEdge(s, piece, a, b)));
        }
        if (!builder.IsDone()) {
            throw new Error('the curve\'s edges do not join');
        }
        return new Wire(builder.Wire());
    } finally {
        gc();
    }
}

/** The curve of a helix step; `sketches` are the part's resolved sketch steps, `before` the steps before the helix. */
export function helixStepShape(step: HelixStep, before: Feature[], sketches: Map<string, Sketch>): HelixShape {
    let sketch: Sketch | undefined;
    if (step.sketchRef !== undefined) {
        sketch = sketches.get(step.sketchRef);
        if (!sketch) {
            throw new Error(`sketch "${step.sketchRef}" not found (it must be an earlier sketch step of this part)`);
        }
    } else {
        sketch = step.sketch;
        if (!sketch) {
            throw new Error('needs a sketch or a sketchRef');
        }
    }
    return helixShape(step, helixCircle(sketch), sketchFrameOf(sketch, before));
}

export interface CurvePath {
    wire: Wire;
    /** The direction the profile keeps its angle to: the helix axis, a spiral's plane normal. */
    axis: Vec3;
    shape: HelixShape;
}

/** The curve step a sweep path names (`curveRef`), among the steps before the sweep. */
export function curvePath(id: string, earlier: Feature[], sketches: Map<string, Sketch>): CurvePath {
    const at = earlier.findIndex((f) => f.id === id);
    const step = at >= 0 ? earlier[at] : undefined;
    if (!step || step.op !== 'helix') {
        throw new Error(`curve "${id}" not found (it must be an earlier helix or spiral step of this part)`);
    }
    const shape = helixStepShape(step, earlier.slice(0, at), sketches);
    return { wire: helixWire(shape), axis: shape.axis, shape };
}

/**
 * Sweeps one wire along a curve step. The profile keeps its angle to the curve's axis (a constant binormal), as a
 * spring's wire does; keepNormal: it keeps its own plane's orientation instead.
 */
export function sweepAlongCurve(profile: Wire, path: CurvePath, keepNormal: SketchFrame | null): Shape3D {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const builder = r(new oc.BRepOffsetAPI_MakePipeShell(path.wire.wrapped));
        if (keepNormal) {
            const { origin, normal, u } = keepNormal;
            builder.SetMode(r(new oc.gp_Ax2(r(new oc.gp_Pnt(...origin)), r(new oc.gp_Dir(...normal)), r(new oc.gp_Dir(...u)))));
        } else {
            builder.SetMode(r(new oc.gp_Dir(...path.axis)));
        }
        builder.Add(profile.wrapped, false, false);
        builder.Build(r(new oc.Message_ProgressRange()));
        if (!builder.IsDone()) {
            throw new Error('the profile cannot be swept along this curve');
        }
        builder.MakeSolid();
        return cast(builder.Shape()) as Shape3D;
    } finally {
        gc();
    }
}
