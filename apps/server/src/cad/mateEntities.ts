// The exact geometry of entities picked for mates (@jarvis/core/mates): for each pick on a part's body, what it is
// and where (a plane, a cylinder's axis and radius, a cone's apex and half angle, a sphere, a straight or circular
// edge, a vertex), found again on the body as feature picks are (followRefs.ts), so a mate follows the part's edits.
// Kernel only; the server keeps the answers by mesh key (CadKernel.entities).

import { getOC, iterTopo, localGC, Vertex, type Edge, type Face, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';
import type { MateGeom, MatePick } from '@jarvis/core/mates';
import { Body, findEdge, findFace, findVertex } from './followRefs.js';
import { distanceToShape } from './refs.js';

/** A pick's geometry, or why it was not found. */
export type MateEntityAnswer = MateGeom | { error: string };

/** The picks the kernel answers (the rest resolve from the part's history, see @jarvis/core/mates resolve.ts). */
export type ModelMatePick = Extract<MatePick, { kind: 'face' | 'edge' | 'vertex' }>;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
/** Float noise off near-zero direction components, so a face facing +Y says exactly [0, 1, 0]. */
const clean = (d: Vec3): Vec3 => unit(d.map((c) => (Math.abs(c) < 1e-12 ? 0 : c)) as Vec3);

type Pnt = { X(): number; Y(): number; Z(): number };
const xyz = (p: Pnt): Vec3 => [p.X(), p.Y(), p.Z()];

const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** A circular edge's centre and radius. */
function circleOf(edge: Edge): { centre: Vec3; radius: number } {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const circle = r(r(new oc.BRepAdaptor_Curve(edge.wrapped)).Circle());
        return { centre: xyz(r(circle.Location())), radius: circle.Radius() };
    } finally {
        gc();
    }
}

/**
 * A cone's apex, opening direction and half angle, from its circular edges (the kernel build has no gp_Cone): two
 * circles of different sizes give the slope; one circle and the face's pointed end give it too.
 */
function coneOf(face: Face): { apex: Vec3; direction: Vec3; halfAngle: number } | null {
    const circles = face.edges.filter((e) => e.geomType === 'CIRCLE').map(circleOf);
    if (circles.length === 0) {
        return null;
    }
    const a = circles[0];
    const b = circles.find((c) => len(sub(c.centre, a.centre)) > 1e-9 && Math.abs(c.radius - a.radius) > 1e-9);
    if (b) {
        const d = unit(sub(b.centre, a.centre));
        const slope = (b.radius - a.radius) / len(sub(b.centre, a.centre));
        const apex = sub(a.centre, scale(d, a.radius / slope));
        return { apex, direction: slope > 0 ? d : scale(d, -1), halfAngle: (Math.atan(Math.abs(slope)) * 180) / Math.PI };
    }
    // A pointed cone: its apex is the face's vertex farthest from the circle.
    let apex: Vec3 | null = null;
    for (const v of iterTopo(face.wrapped as never, 'vertex')) {
        const vertex = new Vertex(v);
        const p = vertex.asTuple() as Vec3;
        vertex.delete();
        if (!apex || len(sub(p, a.centre)) > len(sub(apex, a.centre))) {
            apex = p;
        }
    }
    if (!apex || len(sub(a.centre, apex)) < 1e-9) {
        return null;
    }
    const h = len(sub(a.centre, apex));
    return { apex, direction: unit(sub(a.centre, apex)), halfAngle: (Math.atan(a.radius / h) * 180) / Math.PI };
}

function normalAt(face: Face, at: Vec3): Vec3 | null {
    try {
        const v = face.normalAt(at);
        const out: Vec3 = [v.x, v.y, v.z];
        v.delete();
        return unit(out);
    } catch {
        return null;
    }
}

/** A face's analytic geometry: plane, cylinder, cone or sphere, else a surface no standard mate takes. */
function faceGeometry(face: Face, at: Vec3): MateGeom {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const type = face.geomType;
        const normal = normalAt(face, at);
        const surface = r(new oc.BRepAdaptor_Surface(face.wrapped, true));
        if (type === 'PLANE' && normal) {
            const plane = r(surface.Plane());
            const location = xyz(r(plane.Location()));
            return { type: 'plane', origin: sub(at, scale(normal, dot(sub(at, location), normal))), normal: clean(normal) };
        }
        /** Whether the face's outward normal at the pick points towards the axis or centre (a hole). */
        const inward = (towards: Vec3): boolean => !!normal && dot(normal, towards) > 0;
        if (type === 'CYLINDRE') {
            const cylinder = r(surface.Cylinder());
            const axis = r(cylinder.Axis());
            const point = xyz(r(axis.Location()));
            const direction = clean(xyz(r(axis.Direction())));
            const rel = sub(at, point);
            const radial = sub(rel, scale(direction, dot(rel, direction)));
            return { type: 'cylinder', point, direction, radius: cylinder.Radius(), inside: inward(scale(radial, -1)) };
        }
        if (type === 'CONE') {
            const cone = coneOf(face);
            if (!cone) {
                return { type: 'surface' };
            }
            const rel = sub(at, cone.apex);
            const radial = sub(rel, scale(cone.direction, dot(rel, cone.direction)));
            return { type: 'cone', apex: cone.apex, direction: clean(cone.direction), halfAngle: cone.halfAngle, inside: inward(scale(radial, -1)) };
        }
        if (type === 'SPHERE') {
            const sphere = r(surface.Sphere());
            const centre = xyz(r(sphere.Location()));
            return { type: 'sphere', centre, radius: sphere.Radius(), inside: inward(sub(centre, at)) };
        }
        return { type: 'surface' };
    } catch {
        return { type: 'surface' };
    } finally {
        gc();
    }
}

/**
 * A cylindrical face the point lies on, extended round its axis (a point given with a mate from another program, on
 * the cylinder but maybe where a partial one has no face): the nearest of those.
 */
function onCylinder(body: Body, at: Vec3): { face: Face } | null {
    const on = body.faces.flatMap((g) => {
        if (g.type !== 'cylinder') {
            return [];
        }
        const rel = sub(at, g.point);
        const off = len(sub(rel, scale(g.direction, dot(rel, g.direction))));
        return Math.abs(off - g.radius) <= body.tolerance ? [{ face: g.face, d: distanceToShape(at, g.face) }] : [];
    });
    on.sort((a, b) => a.d - b.d);
    return on[0] ?? null;
}

/** The geometry of each pick on the body (part frame), or why it is not there. */
export function mateEntities(shape: Shape3D | null, picks: readonly ModelMatePick[]): MateEntityAnswer[] {
    if (!shape) {
        return picks.map(() => ({ error: 'the part has no body to pick on' }));
    }
    const body = new Body(shape);
    return picks.map((pick): MateEntityAnswer => {
        try {
            if (pick.kind === 'face') {
                const found = findFace(body, { at: pick.at, ...(pick.normal ? { normal: pick.normal } : {}) }, null) ?? onCylinder(body, pick.at);
                return found ? faceGeometry(found.face, pick.at) : { error: 'the face picked is no longer on the part' };
            }
            if (pick.kind === 'edge') {
                const edge = findEdge(body, { edge: pick.at, ...(pick.faces ? { faces: pick.faces } : {}) }, null);
                if (edge?.type === 'line') {
                    return { type: 'line', point: edge.a, direction: clean(sub(edge.b, edge.a)) };
                }
                if (edge?.type === 'circle') {
                    return { type: 'circle', centre: edge.centre, normal: clean(edge.normal), radius: edge.radius };
                }
                // Another kind of curve (a spline, an ellipse): there, but no standard mate takes it.
                const near = body.edges.some((e) => body.near(e, pick.at) && distanceToShape(pick.at, e) <= body.tolerance);
                return near ? { type: 'curve' } : { error: 'the edge picked is no longer on the part' };
            }
            const vertex = findVertex(body, { vertex: pick.at, ...(pick.faces ? { faces: pick.faces } : {}) });
            return vertex ? { type: 'point', point: vertex } : { error: 'the vertex picked is no longer on the part' };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    });
}
