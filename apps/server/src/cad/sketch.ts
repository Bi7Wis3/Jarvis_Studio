// 2D sketches on a plane of the part frame (Y up), turned into faces and then extruded or revolved.

import {
    addHolesInFace, assembleWire, basicFaceExtrusion, loft, makeCircle, makeCompound, makeFace, makeLine,
    makeThreePointArc, revolution, Vector, type Edge, type Face, type Shape3D, type Wire,
} from 'replicad';
import type { ExtrudeDirection, Sketch, SketchPlaneName, SketchProfile, SketchRegion, Vec3 } from '@jarvis/core';
import { resolvePlane } from '@jarvis/core/reference';

type P2 = [number, number];

/** A sketch plane in the part frame: origin, in-plane axes u and v, and normal (u x v). */
export interface SketchFrame {
    origin: Vec3;
    u: Vec3;
    v: Vec3;
    normal: Vec3;
}

const PLANES: Record<SketchPlaneName, Omit<SketchFrame, 'origin'>> = {
    top: { u: [1, 0, 0], v: [0, 0, -1], normal: [0, 1, 0] },
    front: { u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
    right: { u: [0, 0, -1], v: [0, 1, 0], normal: [1, 0, 0] },
};

/**
 * The plane's frame. Named and custom planes resolve through @jarvis/core/reference (the sketcher uses the same
 * maths); `{ planeRef }` must already have been resolved against the part's history by the caller.
 */
export function sketchFrame(sketch: Sketch): SketchFrame {
    const plane = sketch.plane;
    if (plane && typeof plane === 'object' && 'planeRef' in plane) {
        throw new Error(`plane "${plane.planeRef}" was not resolved`);
    }
    if (typeof plane === 'string' && !PLANES[plane]) {
        throw new Error(`unknown sketch plane "${plane}"`);
    }
    if (!plane || (typeof plane !== 'string' && typeof plane !== 'object')) {
        throw new Error('sketch plane must be top, front, right, { origin, normal, xDir } or { planeRef }');
    }
    if (typeof plane === 'object' && !(Array.isArray(plane.origin) && plane.origin.length === 3
        && plane.origin.every(Number.isFinite))) {
        throw new Error('sketch plane origin must be a point [x, y, z]');
    }
    const resolved = resolvePlane(plane, [], 'sketch plane');
    const normal = resolved.normal;
    const u = resolved.xDir;
    const offset = sketch.offset ?? 0;
    const o = resolved.origin;
    return {
        origin: [o[0] + normal[0] * offset, o[1] + normal[1] * offset, o[2] + normal[2] * offset],
        u,
        v: [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]],
        normal,
    };
}

const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

function to3d(frame: SketchFrame, [a, b]: P2): Vec3 {
    const { origin: o, u, v } = frame;
    return [o[0] + a * u[0] + b * v[0], o[1] + a * u[1] + b * v[1], o[2] + a * u[2] + b * v[2]];
}

// ---- Profiles as 2D outlines (for validation and nesting) and as wires ------------------------------------

const ARC_SAMPLES = 24;

/** Centre and radius of the circle through three points, or null when they are collinear. */
function circleThrough(a: P2, b: P2, c: P2): { centre: P2; radius: number } | null {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    const size = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]), 1e-9);
    if (Math.abs(d) < 1e-9 * size * size) {
        return null;
    }
    const sq = (p: P2): number => p[0] * p[0] + p[1] * p[1];
    const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
    const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
    return { centre: [ux, uy], radius: Math.hypot(a[0] - ux, a[1] - uy) };
}

/** Points along the arc from a through m to b (excluding a, including b). */
function sampleArc(a: P2, m: P2, b: P2): P2[] {
    const circle = circleThrough(a, m, b);
    if (!circle) {
        throw new Error('arc points are in a straight line');
    }
    const { centre: [cx, cy], radius } = circle;
    const angle = (p: P2): number => Math.atan2(p[1] - cy, p[0] - cx);
    const a0 = angle(a);
    const norm = (t: number): number => ((t - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    // Go counter-clockwise if the through point comes before the end that way, else clockwise.
    let sweep = norm(angle(b));
    if (norm(angle(m)) > sweep) {
        sweep -= 2 * Math.PI;
    }
    return Array.from({ length: ARC_SAMPLES }, (_, i) => {
        const t = a0 + (sweep * (i + 1)) / ARC_SAMPLES;
        return [cx + radius * Math.cos(t), cy + radius * Math.sin(t)] as P2;
    });
}

type Piece = { kind: 'line'; from: P2; to: P2 } | { kind: 'arc'; from: P2; through: P2; to: P2 } | { kind: 'circle'; centre: P2; radius: number };

const same = (a: P2, b: P2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

/** A profile as line, arc or full-circle pieces in sketch coordinates. */
function pieces(profile: SketchProfile, open = false): Piece[] {
    switch (profile.kind) {
        case 'circle':
            if (!(profile.radius > 0)) throw new Error('radius must be positive');
            return [{ kind: 'circle', centre: profile.center, radius: profile.radius }];
        case 'rect': {
            const { center: [cx, cy], width: w, height: h } = profile;
            if (!(w > 0 && h > 0)) throw new Error('width and height must be positive');
            const r = profile.radius ?? 0;
            if (r < 0 || r > Math.min(w, h) / 2 + 1e-9) throw new Error(`corner radius must be 0 to ${Math.min(w, h) / 2}`);
            const [x0, x1, y0, y1] = [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2];
            if (r <= 1e-9) {
                return polygonPieces([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
            }
            const k = r * (1 - Math.SQRT1_2);
            const out: Piece[] = [];
            const line = (from: P2, to: P2): void => {
                if (!same(from, to)) out.push({ kind: 'line', from, to });
            };
            line([x0 + r, y0], [x1 - r, y0]);
            out.push({ kind: 'arc', from: [x1 - r, y0], through: [x1 - k, y0 + k], to: [x1, y0 + r] });
            line([x1, y0 + r], [x1, y1 - r]);
            out.push({ kind: 'arc', from: [x1, y1 - r], through: [x1 - k, y1 - k], to: [x1 - r, y1] });
            line([x1 - r, y1], [x0 + r, y1]);
            out.push({ kind: 'arc', from: [x0 + r, y1], through: [x0 + k, y1 - k], to: [x0, y1 - r] });
            line([x0, y1 - r], [x0, y0 + r]);
            out.push({ kind: 'arc', from: [x0, y0 + r], through: [x0 + k, y0 + k], to: [x0 + r, y0] });
            return out;
        }
        case 'slot': {
            const { from: a, to: b, radius: r } = profile;
            if (!(r > 0)) throw new Error('radius must be positive');
            const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (length < 1e-9) {
                return [{ kind: 'circle', centre: a, radius: r }];
            }
            const d: P2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
            const p: P2 = [-d[1], d[0]];
            const at = (c: P2, x: P2, s: number): P2 => [c[0] + x[0] * s, c[1] + x[1] * s];
            return [
                { kind: 'line', from: at(a, p, r), to: at(b, p, r) },
                { kind: 'arc', from: at(b, p, r), through: at(b, d, r), to: at(b, p, -r) },
                { kind: 'line', from: at(b, p, -r), to: at(a, p, -r) },
                { kind: 'arc', from: at(a, p, -r), through: at(a, d, -r), to: at(a, p, r) },
            ];
        }
        case 'polygon':
            return polygonPieces(profile.points);
        case 'path': {
            const out: Piece[] = [];
            let current = profile.start;
            for (const segment of profile.segments ?? []) {
                if (same(current, segment.to)) {
                    if (segment.kind === 'arc') throw new Error('an arc starts and ends at the same point');
                    continue;
                }
                if (segment.kind === 'arc') {
                    if (!circleThrough(current, segment.through, segment.to)) {
                        throw new Error('arc points are in a straight line');
                    }
                    out.push({ kind: 'arc', from: current, through: segment.through, to: segment.to });
                } else {
                    out.push({ kind: 'line', from: current, to: segment.to });
                }
                current = segment.to;
            }
            if (open) {
                if (out.length === 0) throw new Error('path has no segments');
                return out;
            }
            if (!same(current, profile.start)) {
                out.push({ kind: 'line', from: current, to: profile.start });
            }
            if (out.length < 2 || (out.length === 2 && out.every((p) => p.kind === 'line'))) {
                throw new Error('path does not enclose an area');
            }
            return out;
        }
    }
}

function polygonPieces(points: P2[]): Piece[] {
    const pts: P2[] = [];
    for (const p of points ?? []) {
        if (!pts.length || !same(pts[pts.length - 1], p)) pts.push(p);
    }
    if (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
    if (pts.length < 3) {
        throw new Error('needs at least 3 distinct points');
    }
    return pts.map((p, i) => ({ kind: 'line', from: p, to: pts[(i + 1) % pts.length] }));
}

function outline(ps: Piece[]): P2[] {
    const out: P2[] = [];
    for (const p of ps) {
        if (p.kind === 'circle') {
            for (let i = 0; i < ARC_SAMPLES * 2; i++) {
                const t = (Math.PI * i) / ARC_SAMPLES;
                out.push([p.centre[0] + p.radius * Math.cos(t), p.centre[1] + p.radius * Math.sin(t)]);
            }
        } else if (p.kind === 'line') {
            out.push(p.to);
        } else {
            out.push(...sampleArc(p.from, p.through, p.to));
        }
    }
    return out;
}

function signedArea(poly: P2[]): number {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        a += x0 * y1 - x1 * y0;
    }
    return a / 2;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
    const orient = (p: P2, q: P2, r: P2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    return o1 * o2 < -1e-12 && o3 * o4 < -1e-12;
}

function selfIntersects(poly: P2[]): boolean {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
        }
    }
    return false;
}

function crosses(a: P2[], b: P2[]): boolean {
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
        }
    }
    return false;
}

/** True when some of `a` (corners and edge midpoints) is inside `b` and some is not: the two overlap. */
function straddles(a: P2[], b: P2[]): boolean {
    let ins = 0;
    let outs = 0;
    a.forEach((p, i) => {
        const q = a[(i + 1) % a.length];
        for (const s of [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as P2]) {
            if (inside(s, b)) ins++;
            else outs++;
        }
    });
    return ins > 0 && outs > 0;
}

function inside(point: P2, poly: P2[]): boolean {
    let result = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
            result = !result;
        }
    }
    return result;
}

function wireOf(frame: SketchFrame, ps: Piece[]): Wire {
    const edges: Edge[] = ps.map((p) => {
        if (p.kind === 'circle') return makeCircle(p.radius, to3d(frame, p.centre), frame.normal);
        if (p.kind === 'line') return makeLine(to3d(frame, p.from), to3d(frame, p.to));
        return makeThreePointArc(to3d(frame, p.from), to3d(frame, p.through), to3d(frame, p.to));
    });
    return assembleWire(edges);
}

interface Profile {
    index: number;
    kind: string;
    pieces: Piece[];
    outline: P2[];
    area: number;
}

/**
 * Faces of a sketch: each profile at even containment depth is a region, with the profiles directly inside it
 * as holes (and those inside the holes as islands again). Also returns the 2D outlines for checks.
 */
export function sketchFaces(sketch: Sketch): { faces: Face[]; frame: SketchFrame; outlines: P2[][] } {
    if (!sketch || !Array.isArray(sketch.profiles) || sketch.profiles.length === 0) {
        throw new Error('sketch has no profiles');
    }
    const frame = sketchFrame(sketch);
    const profiles: Profile[] = sketch.profiles.map((profile, index) => {
        const name = `profile ${index} (${profile?.kind})`;
        try {
            const ps = pieces(profile);
            const poly = outline(ps);
            if (selfIntersects(poly)) throw new Error('is self-intersecting');
            const area = Math.abs(signedArea(poly));
            if (area < 1e-6) throw new Error('has no area');
            return { index, kind: profile.kind, pieces: ps, outline: poly, area };
        } catch (e) {
            throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
    for (let i = 0; i < profiles.length; i++) {
        for (let j = i + 1; j < profiles.length; j++) {
            const [pa, pb] = [profiles[i].outline, profiles[j].outline];
            if (crosses(pa, pb) || straddles(pa, pb) || straddles(pb, pa)) {
                const [a, b] = [profiles[i], profiles[j]];
                throw new Error(`profile ${a.index} (${a.kind}) and profile ${b.index} (${b.kind}) overlap; `
                    + 'profiles must be separate or nested');
            }
        }
    }
    // Parent = the smallest profile that contains this one.
    const parent = profiles.map((p) => {
        let best: Profile | null = null;
        for (const q of profiles) {
            if (q !== p && q.area > p.area && inside(p.outline[0], q.outline) && (!best || q.area < best.area)) {
                best = q;
            }
        }
        return best;
    });
    const depth = (i: number): number => {
        let d = 0;
        for (let p = parent[i]; p; p = parent[p.index]) d++;
        return d;
    };
    const faces: Face[] = [];
    profiles.forEach((p, i) => {
        if (depth(i) % 2 !== 0) return;
        const holes = profiles.filter((_, j) => parent[j] === p).map((h) => wireOf(frame, h.pieces));
        const face = makeFace(wireOf(frame, p.pieces));
        faces.push(holes.length ? addHolesInFace(face, holes) : face);
    });
    return { faces, frame, outlines: profiles.map((p) => p.outline) };
}

function asShape(solids: Shape3D[]): Shape3D {
    return solids.length === 1 ? solids[0] : (makeCompound(solids) as Shape3D);
}

// ---- Selected regions --------------------------------------------------------------------------------------

/** True when `point` is inside the region's outline and outside its holes. */
function inRegion(region: SketchRegion, point: P2, index: number): boolean {
    const loops = region?.loops ?? [];
    if (!loops.length) {
        throw new Error(`sketch region ${index} has no loops`);
    }
    try {
        const [outer, ...holes] = loops.map((loop) => outline(pieces(loop)));
        return inside(point, outer) && !holes.some((hole) => inside(point, hole));
    } catch (e) {
        throw new Error(`sketch region ${index}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * The sketches to build for a feature that uses some regions of its sketch: one sketch per region containing a
 * pick point (its outline and holes as profiles). No picks, or a sketch without regions: the whole sketch.
 */
export function selectedRegions(sketch: Sketch, picks?: P2[]): Sketch[] {
    if (!picks?.length || !sketch?.regions?.length) {
        return [sketch];
    }
    const chosen = sketch.regions.filter((region, i) => picks.some((p) => inRegion(region, p, i)));
    if (!chosen.length) {
        throw new Error('its selected sketch regions no longer exist; pick them again');
    }
    return chosen.map((region) => ({ plane: sketch.plane, offset: sketch.offset, profiles: region.loops }));
}

/**
 * One solid from the solids of several regions. Regions sharing an edge fuse into one body; the fuse merges
 * same-domain faces (OpenCascade's ShapeUpgrade_UnifySameDomain), so no seam faces stay between them.
 */
function fuseRegions(solids: Shape3D[]): Shape3D {
    let result = solids[0];
    for (const solid of solids.slice(1)) {
        result = result.fuse(solid);
    }
    return result;
}

/** Start and end of an extrusion along the plane normal, measured from the sketch plane. */
export function extrudeRange(distance: number, direction: ExtrudeDirection = 'normal'): [number, number] {
    if (!Number.isFinite(distance) || Math.abs(distance) < 1e-9) {
        throw new Error('extrude distance must be non-zero');
    }
    const d = Math.abs(distance);
    const reverse = (direction === 'reverse') !== (distance < 0);
    if (direction === 'symmetric') return [-d / 2, d / 2];
    return reverse ? [-d, 0] : [0, d];
}

/** Prism of the sketch's faces (or of the regions picked by `regions`) between two distances along its normal. */
export function extrudeSketch(sketch: Sketch, range: [number, number], regions?: P2[]): Shape3D {
    const parts = selectedRegions(sketch, regions);
    if (parts.length > 1 || parts[0] !== sketch) {
        return fuseRegions(parts.map((part) => extrudeSketch(part, range)));
    }
    const [start, end] = range;
    const { faces, frame } = sketchFaces(sketch);
    const solids = faces.map((face) => {
        let solid = basicFaceExtrusion(face, new Vector(scale(frame.normal, end - start))) as Shape3D;
        if (Math.abs(start) > 1e-12) solid = solid.translate(scale(frame.normal, start));
        return solid;
    });
    return asShape(solids);
}

/** Revolves the sketch (or the regions picked by `regions`) about its u or v axis through the sketch origin. */
export function revolveSketch(sketch: Sketch, axis: 'u' | 'v', angle = 360, regions?: P2[]): Shape3D {
    const parts = selectedRegions(sketch, regions);
    if (parts.length > 1 || parts[0] !== sketch) {
        return fuseRegions(parts.map((part) => revolveSketch(part, axis, angle)));
    }
    if (axis !== 'u' && axis !== 'v') {
        throw new Error('revolve axis must be "u" or "v"');
    }
    if (!(Math.abs(angle) > 1e-6 && Math.abs(angle) <= 360)) {
        throw new Error('revolve angle must be between 0 and 360 degrees');
    }
    const { faces, frame, outlines } = sketchFaces(sketch);
    // Profiles must stay on one side of the axis (touching it is fine).
    const across = axis === 'u' ? 1 : 0;
    const values = outlines.flat().map((p) => p[across]);
    if (Math.min(...values) < -1e-6 && Math.max(...values) > 1e-6) {
        throw new Error(`the sketch crosses the ${axis} axis; keep it on one side to revolve`);
    }
    const direction = axis === 'u' ? frame.u : frame.v;
    return asShape(faces.map((face) => revolution(face, frame.origin, direction, angle)));
}

/** Range along the sketch normal that passes the whole of `shape` for a through extrusion. */
export function throughRange(sketch: Sketch, bounds: [Vec3, Vec3], direction: ExtrudeDirection = 'normal'): [number, number] {
    const frame = sketchFrame(sketch);
    const [lo, hi] = bounds;
    let min = Infinity;
    let max = -Infinity;
    for (const x of [lo[0], hi[0]]) {
        for (const y of [lo[1], hi[1]]) {
            for (const z of [lo[2], hi[2]]) {
                const s = (x - frame.origin[0]) * frame.normal[0] + (y - frame.origin[1]) * frame.normal[1]
                    + (z - frame.origin[2]) * frame.normal[2];
                min = Math.min(min, s);
                max = Math.max(max, s);
            }
        }
    }
    const margin = 1;
    if (direction === 'symmetric') return [min - margin, max + margin];
    if (direction === 'reverse') return [Math.min(min, 0) - margin, 0];
    return [0, Math.max(max, 0) + margin];
}

/** Solid blended through the sections in order; each section is one closed profile without holes. */
export function loftSketches(sections: Sketch[], ruled: boolean): Shape3D {
    if (sections.length < 2) {
        throw new Error('a loft needs at least 2 sections');
    }
    const wires = sections.map((sketch, i) => {
        if (!sketch?.profiles || sketch.profiles.length !== 1) {
            throw new Error(`section ${i}: needs exactly one closed profile (got ${sketch?.profiles?.length ?? 0})`);
        }
        try {
            sketchFaces(sketch); // validates the profile
            return wireOf(sketchFrame(sketch), pieces(sketch.profiles[0]));
        } catch (e) {
            throw new Error(`section ${i}: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
    return loft(wires, { ruled });
}

function singleProfile(sketch: Sketch, what: string): SketchProfile {
    if (!sketch?.profiles || sketch.profiles.length !== 1) {
        throw new Error(`${what} needs exactly one profile (got ${sketch?.profiles?.length ?? 0})`);
    }
    return sketch.profiles[0];
}

/** The closed wire of a sketch with a single profile, and the profile's centre in the part frame. */
export function profileWire(sketch: Sketch, what = 'profile'): { wire: Wire; centre: Vec3; frame: SketchFrame } {
    singleProfile(sketch, what);
    const { frame, outlines } = sketchFaces(sketch); // validates the profile
    const pts = outlines[0];
    const c: P2 = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    return { wire: wireOf(frame, pieces(sketch.profiles[0])), centre: to3d(frame, c), frame };
}

/**
 * A sweep path: a single profile, where a `path` may stay open (it is not closed back to its start).
 * Returns the wire and whether it is one straight line (for twisting).
 */
export function pathWire(sketch: Sketch): { wire: Wire; line: [Vec3, Vec3] | null } {
    const profile = singleProfile(sketch, 'path sketch');
    const frame = sketchFrame(sketch);
    let ps: Piece[];
    try {
        ps = pieces(profile, profile.kind === 'path');
    } catch (e) {
        throw new Error(`path: ${e instanceof Error ? e.message : String(e)}`);
    }
    const only = ps.length === 1 && ps[0].kind === 'line' ? ps[0] : null;
    return { wire: wireOf(frame, ps), line: only ? [to3d(frame, only.from), to3d(frame, only.to)] : null };
}
