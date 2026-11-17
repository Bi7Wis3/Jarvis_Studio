// The equations of each standard mate, as residuals that are zero when the mate holds: per pair of entities, in the
// world, written so the solver's least squares sees lengths in mm (directions are scaled by a length L). The last
// `dims` rows of a distance or angle mate carry its value (the rows checked for redundant dimensions).

import type { Vec3 } from '../index';
import { add, applyDir, applyPoint, compose, cross, dot, invert, len, logRot, mulMat, rigidOf, scale, sub, transpose, type Rigid } from './math';
import type { DistanceEnd, Mate, MateGeom } from './types';
import { entityClass, validMateTypes, type EntityClass } from './valid';

/** One side of a mate as the solver sees it: its geometry in the world and the world transform of its component. */
export interface Side {
    geom: MateGeom;
    T: Rigid;
}

/** The geometry moved by a rigid transform (part frame to world). */
export function worldGeom(g: MateGeom, T: Rigid): MateGeom {
    switch (g.type) {
        case 'plane':
            return { type: 'plane', origin: applyPoint(T, g.origin), normal: applyDir(T, g.normal) };
        case 'line':
            return { type: 'line', point: applyPoint(T, g.point), direction: applyDir(T, g.direction) };
        case 'point':
            return { type: 'point', point: applyPoint(T, g.point) };
        case 'frame':
            return { type: 'frame', origin: applyPoint(T, g.origin), x: applyDir(T, g.x), y: applyDir(T, g.y), z: applyDir(T, g.z) };
        case 'cylinder':
            return { ...g, point: applyPoint(T, g.point), direction: applyDir(T, g.direction) };
        case 'cone':
            return { ...g, apex: applyPoint(T, g.apex), direction: applyDir(T, g.direction) };
        case 'sphere':
            return { ...g, centre: applyPoint(T, g.centre) };
        case 'circle':
            return { ...g, centre: applyPoint(T, g.centre), normal: applyDir(T, g.normal) };
        default:
            return g;
    }
}

/** Order of the classes in a pair, so each pair is written once (plane first, point last). */
const RANK: Record<EntityClass, number> = { plane: 0, cylinder: 1, cone: 2, sphere: 3, circle: 4, line: 5, point: 6, surface: 7, curve: 8 };

/** The direction of an entity for alignment, parallel, perpendicular and angle: a normal or an axis. */
export function directionOf(g: MateGeom): Vec3 | null {
    switch (g.type) {
        case 'plane':
            return g.normal;
        case 'line':
        case 'cylinder':
        case 'cone':
            return g.direction;
        case 'circle':
            return g.normal;
        default:
            return null;
    }
}

/** An entity's axis (a line through a point), for concentric mates and distances to axes. */
export function axisOf(g: MateGeom): { point: Vec3; direction: Vec3 } | null {
    switch (g.type) {
        case 'line':
        case 'cylinder':
            return { point: g.point, direction: g.direction };
        case 'cone':
            return { point: g.apex, direction: g.direction };
        case 'circle':
            return { point: g.centre, direction: g.normal };
        default:
            return null;
    }
}

/** The point of a point-like entity: a point, an origin, a sphere's centre. */
export function centreOf(g: MateGeom): Vec3 | null {
    return g.type === 'point' ? g.point : g.type === 'frame' ? g.origin : g.type === 'sphere' ? g.centre : null;
}

/** A point that tells where an entity is, for the solver's turning centre and for labels. */
export function anchorOf(g: MateGeom): Vec3 | null {
    switch (g.type) {
        case 'plane':
            return g.origin;
        case 'line':
        case 'cylinder':
            return g.point;
        case 'cone':
            return g.apex;
        case 'circle':
            return g.centre;
        default:
            return centreOf(g);
    }
}

const perp = (w: Vec3, d: Vec3): Vec3 => sub(w, scale(d, dot(w, d)));
const radius = (g: MateGeom): number => (g.type === 'cylinder' || g.type === 'sphere' || g.type === 'circle' ? g.radius : 0);
/** A radius with the sign of the face: negative for a hole (its outward normal points to the axis or centre). */
const signedRadius = (g: MateGeom): number => (g.type === 'cylinder' || g.type === 'sphere' ? (g.inside ? -g.radius : g.radius) : 0);
const endOffset = (g: MateGeom, end: DistanceEnd | undefined): number =>
    (end === 'min' ? radius(g) : end === 'max' ? -radius(g) : 0);

export interface MateRows {
    rows: number[];
    /** How many of the last rows carry the mate's value. */
    dims: number;
}

/**
 * The residuals of a mate between two sides, or null when the pair cannot take it. `L` is the length that scales
 * direction errors into mm (the size of the assembly).
 */
export function mateRows(mate: Mate, a0: Side, b0: Side, L: number, checked = false): MateRows | null {
    const ga0 = a0.geom;
    const gb0 = b0.geom;
    if (!checked && mate.type !== 'lock' && !validMateTypes(ga0, gb0).includes(mate.type)) {
        return null;
    }
    // Plane first, point last: each pair is written once.
    const swap = mate.type !== 'lock' && RANK[entityClass(gb0)] < RANK[entityClass(ga0)];
    const [A, B] = swap ? [b0, a0] : [a0, b0];
    const a = A.geom;
    const b = B.geom;
    const ends: [DistanceEnd | undefined, DistanceEnd | undefined] = swap ? [mate.ends?.[1], mate.ends?.[0]] : [mate.ends?.[0], mate.ends?.[1]];
    const s = mate.alignment === 'aligned' ? 1 : mate.alignment === 'antiAligned' ? -1 : 0;
    const rows: number[] = [];
    const push = (...v: number[]) => rows.push(...v);
    const vec = (v: Vec3, k = 1) => push(v[0] * k, v[1] * k, v[2] * k);
    /** Two directions parallel: the same way, opposite, or either (no alignment set). */
    const parallel = (u: Vec3, v: Vec3) => (s ? vec(sub(u, scale(v, s)), L) : vec(cross(u, v), L));
    const ca = entityClass(a);
    const cb = entityClass(b);
    const pair = `${ca}|${cb}`;

    switch (mate.type) {
        case 'coincident': {
            if (a.type === 'frame' && b.type === 'frame' && mate.alignAxes) {
                vec(sub(b.origin, a.origin));
                vec(sub(a.x, b.x), L);
                vec(sub(a.y, b.y), L);
                return { rows, dims: 0 };
            }
            switch (pair) {
                case 'plane|plane': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const pb = b as Extract<MateGeom, { type: 'plane' }>;
                    parallel(pa.normal, pb.normal);
                    push(dot(sub(pb.origin, pa.origin), pa.normal));
                    break;
                }
                case 'plane|line': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const lb = b as Extract<MateGeom, { type: 'line' }>;
                    push(L * dot(lb.direction, pa.normal), dot(sub(lb.point, pa.origin), pa.normal));
                    break;
                }
                case 'plane|point': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    push(dot(sub(centreOf(b)!, pa.origin), pa.normal));
                    break;
                }
                case 'plane|circle': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const cb2 = b as Extract<MateGeom, { type: 'circle' }>;
                    parallel(pa.normal, cb2.normal);
                    push(dot(sub(cb2.centre, pa.origin), pa.normal));
                    break;
                }
                case 'cylinder|circle': {
                    const ya = a as Extract<MateGeom, { type: 'cylinder' }>;
                    const cb2 = b as Extract<MateGeom, { type: 'circle' }>;
                    parallel(ya.direction, cb2.normal);
                    vec(perp(sub(cb2.centre, ya.point), ya.direction));
                    push(cb2.radius - ya.radius);
                    break;
                }
                case 'cylinder|line': {
                    const ya = a as Extract<MateGeom, { type: 'cylinder' }>;
                    const lb = b as Extract<MateGeom, { type: 'line' }>;
                    parallel(ya.direction, lb.direction);
                    push(len(perp(sub(lb.point, ya.point), ya.direction)) - ya.radius);
                    break;
                }
                case 'cylinder|point': {
                    const ya = a as Extract<MateGeom, { type: 'cylinder' }>;
                    push(len(perp(sub(centreOf(b)!, ya.point), ya.direction)) - ya.radius);
                    break;
                }
                case 'cone|cone': {
                    const na = a as Extract<MateGeom, { type: 'cone' }>;
                    const nb = b as Extract<MateGeom, { type: 'cone' }>;
                    parallel(na.direction, nb.direction);
                    vec(sub(nb.apex, na.apex));
                    break;
                }
                case 'cone|circle': {
                    const na = a as Extract<MateGeom, { type: 'cone' }>;
                    const cb2 = b as Extract<MateGeom, { type: 'circle' }>;
                    parallel(na.direction, cb2.normal);
                    const rel = sub(cb2.centre, na.apex);
                    vec(perp(rel, na.direction));
                    push(dot(rel, na.direction) - cb2.radius / Math.tan((na.halfAngle * Math.PI) / 180));
                    break;
                }
                case 'cone|point': {
                    const na = a as Extract<MateGeom, { type: 'cone' }>;
                    const rel = sub(centreOf(b)!, na.apex);
                    const h = dot(rel, na.direction);
                    const t = (na.halfAngle * Math.PI) / 180;
                    push(len(perp(rel, na.direction)) * Math.cos(t) - h * Math.sin(t));
                    break;
                }
                case 'sphere|point': {
                    const sa = a as Extract<MateGeom, { type: 'sphere' }>;
                    push(len(sub(centreOf(b)!, sa.centre)) - sa.radius);
                    break;
                }
                case 'circle|point': {
                    const ca2 = a as Extract<MateGeom, { type: 'circle' }>;
                    const rel = sub(centreOf(b)!, ca2.centre);
                    push(dot(rel, ca2.normal), len(perp(rel, ca2.normal)) - ca2.radius);
                    break;
                }
                case 'line|line': {
                    const la = a as Extract<MateGeom, { type: 'line' }>;
                    const lb = b as Extract<MateGeom, { type: 'line' }>;
                    parallel(la.direction, lb.direction);
                    vec(perp(sub(lb.point, la.point), la.direction));
                    break;
                }
                case 'line|point': {
                    const la = a as Extract<MateGeom, { type: 'line' }>;
                    vec(perp(sub(centreOf(b)!, la.point), la.direction));
                    break;
                }
                case 'point|point':
                    vec(sub(centreOf(b)!, centreOf(a)!));
                    break;
                default:
                    return null;
            }
            return { rows, dims: 0 };
        }
        case 'concentric': {
            const xa = axisOf(a);
            const xb = axisOf(b);
            if (xa && xb) {
                parallel(xa.direction, xb.direction);
                vec(perp(sub(xb.point, xa.point), xa.direction));
                if (mate.lockRotation && mate.hold?.across) {
                    // The two marks across the axis keep their angle: no turning about it.
                    const [ua, ub] = swap ? [mate.hold.across[1], mate.hold.across[0]] : mate.hold.across;
                    push(L * dot(cross(applyDir(A.T, ua), applyDir(B.T, ub)), xa.direction));
                }
                return { rows, dims: 0 };
            }
            const axis = xa ?? xb;
            const centre = centreOf(xa ? b : a);
            if (axis && centre) {
                vec(perp(sub(centre, axis.point), axis.direction));
                return { rows, dims: 0 };
            }
            const c1 = centreOf(a);
            const c2 = centreOf(b);
            if (c1 && c2) {
                vec(sub(c2, c1));
                return { rows, dims: 0 };
            }
            return null;
        }
        case 'parallel':
        case 'perpendicular': {
            const da = directionOf(a);
            const db = directionOf(b);
            if (!da || !db) {
                return null;
            }
            const mixed = (ca === 'plane') !== (cb === 'plane');
            if (mate.type === 'parallel') {
                if (mixed) {
                    push(L * dot(da, db));
                } else {
                    parallel(da, db);
                }
            } else if (mixed) {
                parallel(da, db);
            } else {
                push(L * dot(da, db));
            }
            return { rows, dims: 0 };
        }
        case 'tangent': {
            // Anti-aligned (the default): the faces' normals at the contact point opposite, so they touch from outside.
            const side = s === 1 ? -1 : 1;
            switch (pair) {
                case 'plane|cylinder': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const yb = b as Extract<MateGeom, { type: 'cylinder' }>;
                    push(L * dot(yb.direction, pa.normal), dot(sub(yb.point, pa.origin), pa.normal) - side * signedRadius(yb));
                    break;
                }
                case 'plane|sphere': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const sb = b as Extract<MateGeom, { type: 'sphere' }>;
                    push(dot(sub(sb.centre, pa.origin), pa.normal) - side * signedRadius(sb));
                    break;
                }
                case 'plane|cone': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const nb = b as Extract<MateGeom, { type: 'cone' }>;
                    const sin = Math.sin((nb.halfAngle * Math.PI) / 180) * side * (nb.inside ? -1 : 1);
                    push(L * (dot(nb.direction, pa.normal) - sin), dot(sub(nb.apex, pa.origin), pa.normal));
                    break;
                }
                case 'cylinder|cylinder': {
                    const ya = a as Extract<MateGeom, { type: 'cylinder' }>;
                    const yb = b as Extract<MateGeom, { type: 'cylinder' }>;
                    vec(cross(ya.direction, yb.direction), L);
                    push(len(perp(sub(yb.point, ya.point), ya.direction)) - Math.abs(signedRadius(ya) + side * signedRadius(yb)));
                    break;
                }
                case 'cylinder|line': {
                    const ya = a as Extract<MateGeom, { type: 'cylinder' }>;
                    const lb = b as Extract<MateGeom, { type: 'line' }>;
                    vec(cross(ya.direction, lb.direction), L);
                    push(len(perp(sub(lb.point, ya.point), ya.direction)) - ya.radius);
                    break;
                }
                case 'cylinder|sphere': {
                    const ya = a as Extract<MateGeom, { type: 'cylinder' }>;
                    const sb = b as Extract<MateGeom, { type: 'sphere' }>;
                    push(len(perp(sub(sb.centre, ya.point), ya.direction)) - Math.abs(signedRadius(ya) + side * signedRadius(sb)));
                    break;
                }
                case 'cone|sphere': {
                    const na = a as Extract<MateGeom, { type: 'cone' }>;
                    const sb = b as Extract<MateGeom, { type: 'sphere' }>;
                    const rel = sub(sb.centre, na.apex);
                    const t = (na.halfAngle * Math.PI) / 180;
                    const off = len(perp(rel, na.direction)) * Math.cos(t) - dot(rel, na.direction) * Math.sin(t);
                    push(off - side * (na.inside ? -1 : 1) * signedRadius(sb));
                    break;
                }
                case 'sphere|sphere': {
                    const sa = a as Extract<MateGeom, { type: 'sphere' }>;
                    const sb = b as Extract<MateGeom, { type: 'sphere' }>;
                    push(len(sub(sb.centre, sa.centre)) - Math.abs(signedRadius(sa) + side * signedRadius(sb)));
                    break;
                }
                case 'sphere|line': {
                    const sa = a as Extract<MateGeom, { type: 'sphere' }>;
                    const lb = b as Extract<MateGeom, { type: 'line' }>;
                    push(len(perp(sub(sa.centre, lb.point), lb.direction)) - sa.radius);
                    break;
                }
                default:
                    return null;
            }
            return { rows, dims: 0 };
        }
        case 'distance': {
            const D = Math.max(0, mate.value ?? 0);
            const f = mate.flip ? -1 : 1;
            const ea = endOffset(a, ends[0]);
            const eb = endOffset(b, ends[1]);
            /** A distance between point-like or line-like things: |w| = d, or w = 0 when d is 0 (|w| has no slope there). */
            const apart = (w: Vec3, d: number) => {
                if (Math.abs(d) < 1e-12) {
                    vec(w);
                    return 3;
                }
                push(len(w) - d);
                return 1;
            };
            switch (pair) {
                case 'plane|plane': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const pb = b as Extract<MateGeom, { type: 'plane' }>;
                    parallel(pa.normal, pb.normal);
                    push(dot(sub(pb.origin, pa.origin), pa.normal) - f * D);
                    return { rows, dims: 1 };
                }
                case 'plane|line':
                case 'plane|cylinder': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    const x = axisOf(b)!;
                    push(L * dot(x.direction, pa.normal), dot(sub(x.point, pa.origin), pa.normal) - f * (D + eb));
                    return { rows, dims: 1 };
                }
                case 'plane|point':
                case 'plane|sphere': {
                    const pa = a as Extract<MateGeom, { type: 'plane' }>;
                    push(dot(sub(centreOf(b)!, pa.origin), pa.normal) - f * (D + eb));
                    return { rows, dims: 1 };
                }
                case 'cylinder|cylinder':
                case 'cylinder|line':
                case 'line|line': {
                    const xa = axisOf(a)!;
                    const xb = axisOf(b)!;
                    vec(cross(xa.direction, xb.direction), L);
                    return { rows, dims: apart(perp(sub(xb.point, xa.point), xa.direction), D + ea + eb) };
                }
                case 'cylinder|point':
                case 'line|point': {
                    const xa = axisOf(a)!;
                    return { rows, dims: apart(perp(sub(centreOf(b)!, xa.point), xa.direction), D + ea) };
                }
                case 'sphere|line': {
                    const sa = a as Extract<MateGeom, { type: 'sphere' }>;
                    const xb = axisOf(b)!;
                    return { rows, dims: apart(perp(sub(sa.centre, xb.point), xb.direction), D + ea) };
                }
                case 'sphere|sphere':
                case 'sphere|point':
                case 'point|point':
                    return { rows, dims: apart(sub(centreOf(b)!, centreOf(a)!), D + ea + eb) };
                case 'cone|cone': {
                    const na = a as Extract<MateGeom, { type: 'cone' }>;
                    const nb = b as Extract<MateGeom, { type: 'cone' }>;
                    parallel(na.direction, nb.direction);
                    const rel = sub(nb.apex, na.apex);
                    vec(perp(rel, na.direction));
                    push(dot(rel, na.direction) - f * D);
                    return { rows, dims: 1 };
                }
                case 'circle|point': {
                    const ca2 = a as Extract<MateGeom, { type: 'circle' }>;
                    const rel = sub(centreOf(b)!, ca2.centre);
                    const h = dot(rel, ca2.normal);
                    const rho = len(perp(rel, ca2.normal));
                    if (D < 1e-12) {
                        push(h, rho - ca2.radius);
                        return { rows, dims: 2 };
                    }
                    push(Math.hypot(h, rho - ca2.radius) - D);
                    return { rows, dims: 1 };
                }
                default:
                    return null;
            }
        }
        case 'angle': {
            const da = directionOf(a);
            const db0 = directionOf(b);
            if (!da || !db0) {
                return null;
            }
            const db = s === -1 ? scale(db0, -1) : db0;
            const theta = (Math.min(180, Math.max(0, mate.value ?? 0)) * Math.PI) / 180;
            if (theta < 1e-9) {
                vec(sub(da, db), L);
                return { rows, dims: 3 };
            }
            if (Math.PI - theta < 1e-9) {
                vec(add(da, db), L);
                return { rows, dims: 3 };
            }
            push(L * (Math.atan2(len(cross(da, db)), dot(da, db)) - theta));
            return { rows, dims: 1 };
        }
        case 'lock': {
            const target = mate.hold?.relative;
            if (!target) {
                return null;
            }
            const rel = compose(invert(A.T), B.T);
            const want = rigidOf(target);
            vec(sub(rel.t, want.t));
            vec(logRot(mulMat(transpose(want.R), rel.R)), L);
            return { rows, dims: 0 };
        }
    }
}

/**
 * Which way an angle mate opens about its reference axis: +1 or -1 (0 when the directions are parallel). The mate is
 * on its asked side when this equals `flip ? -1 : 1`.
 */
export function angleSense(mate: Mate, a: Side, b: Side): number {
    const about = mate.hold?.about;
    const da = directionOf(a.geom);
    const db0 = directionOf(b.geom);
    if (!about || !da || !db0) {
        return 0;
    }
    const db = mate.alignment === 'antiAligned' ? scale(db0, -1) : db0;
    const k = applyDir(a.T, about);
    const v = dot(cross(da, db), k);
    return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
}
