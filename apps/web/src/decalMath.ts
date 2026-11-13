// Projected decals: the picture is cast along the decal normal onto every part triangle that faces it, clipped to
// the picture's rectangle, so it wraps over kicktails and concave tops but never reaches surfaces facing away.

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { Decal, Vec3 } from '@jarvis/core';

/** Triangles whose normal is closer than this to perpendicular to the decal normal are left out. */
const MIN_FACING = 0.15;
/** Lift off the surface along its normal, mm (plus polygon offset in the material). */
const LIFT = 0.04;

export interface DecalBasis {
    origin: Vector3;
    /** Picture right (width). */
    u: Vector3;
    /** Picture up (height). */
    v: Vector3;
    /** Out of the surface, toward the viewer. */
    n: Vector3;
}

/** Axes of the geometry's bounding box, longest first. */
function boxAxes(geometry: BufferGeometry): Vector3[] {
    geometry.computeBoundingBox();
    const size = new Vector3();
    geometry.boundingBox!.getSize(size);
    const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
    const extent = [size.x, size.y, size.z];
    return [0, 1, 2].sort((a, b) => extent[b] - extent[a]).map((i) => axes[i]);
}

/**
 * The decal's frame. With rotation 0 the picture's width runs along the part's longest axis (projected onto the
 * surface plane), so a deck graphic runs along the board; rotation turns it about the normal (degrees).
 */
export function decalBasis(geometry: BufferGeometry, position: Vec3, normal: Vec3, rotation = 0): DecalBasis {
    const n = new Vector3(...normal);
    if (n.lengthSq() < 1e-12) {
        n.set(0, 1, 0);
    }
    n.normalize();
    let u = new Vector3();
    for (const axis of boxAxes(geometry)) {
        u = axis.clone().addScaledVector(n, -axis.dot(n));
        if (u.lengthSq() > 0.09) {
            break;
        }
    }
    u.normalize();
    const radians = (rotation * Math.PI) / 180;
    const side = new Vector3().crossVectors(n, u);
    u = u.multiplyScalar(Math.cos(radians)).addScaledVector(side, Math.sin(radians)).normalize();
    const v = new Vector3().crossVectors(n, u).normalize();
    return { origin: new Vector3(...position), u, v, n };
}

interface Corner {
    p: Vector3;
    normal: Vector3;
    s: number;
    t: number;
}

function lerp(a: Corner, b: Corner, k: number): Corner {
    return {
        p: a.p.clone().lerp(b.p, k),
        normal: a.normal.clone().lerp(b.normal, k),
        s: a.s + (b.s - a.s) * k,
        t: a.t + (b.t - a.t) * k,
    };
}

/** Sutherland-Hodgman against one edge of the picture: keeps the side where value(c) <= limit. */
function clip(poly: Corner[], value: (c: Corner) => number, limit: number): Corner[] {
    const out: Corner[] = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const va = value(a) - limit;
        const vb = value(b) - limit;
        if (va <= 0) {
            out.push(a);
        }
        if ((va < 0 && vb > 0) || (va > 0 && vb < 0)) {
            out.push(lerp(a, b, va / (va - vb)));
        }
    }
    return out;
}

/** Visits each triangle facing the decal: corner positions and vertex normals in the geometry's frame. */
function facingTriangles(
    geometry: BufferGeometry,
    n: Vector3,
    visit: (p: Vector3[], normals: Vector3[]) => void,
    minFacing = MIN_FACING,
): void {
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    const count = index ? index.count : pos.count;
    const p = [new Vector3(), new Vector3(), new Vector3()];
    const e1 = new Vector3();
    const e2 = new Vector3();
    const face = new Vector3();
    for (let i = 0; i + 2 < count; i += 3) {
        const ids = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
        ids.forEach((id, k) => p[k].fromBufferAttribute(pos, id));
        face.crossVectors(e1.subVectors(p[1], p[0]), e2.subVectors(p[2], p[0]));
        const length = face.length();
        if (length < 1e-12 || face.dot(n) / length <= minFacing) {
            continue;
        }
        face.divideScalar(length);
        const normals = ids.map((id) => (nor ? new Vector3().fromBufferAttribute(nor, id).normalize() : face.clone()));
        visit(p.map((v) => v.clone()), normals);
    }
}

/** Projects the decal onto the facing surface of `geometry` (part frame); null when nothing is covered. */
export function buildDecalGeometry(geometry: BufferGeometry, decal: Decal): BufferGeometry | null {
    const basis = decalBasis(geometry, decal.position, decal.normal, decal.rotation ?? 0);
    const [w, h] = decal.size;
    const hw = w / 2;
    const hh = h / 2;
    // box: a projector of limited depth (default a tenth of the larger side); planar: unlimited unless depth is set.
    const box = decal.mode === 'box';
    const depth = box ? decal.depth ?? Math.max(w, h) / 10 : decal.depth;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const d = new Vector3();
    facingTriangles(geometry, basis.n, (p, vn) => {
        let poly: Corner[] = p.map((point, k) => {
            d.subVectors(point, basis.origin);
            return { p: point, normal: vn[k], s: d.dot(basis.u), t: d.dot(basis.v) };
        });
        // Quick reject before clipping: the whole triangle on one side of the picture.
        if (poly.every((c) => c.s > hw) || poly.every((c) => c.s < -hw) || poly.every((c) => c.t > hh) || poly.every((c) => c.t < -hh)) {
            return;
        }
        if (depth != null && p.every((point) => Math.abs(d.subVectors(point, basis.origin).dot(basis.n)) > depth)) {
            return;
        }
        poly = clip(poly, (c) => c.s, hw);
        poly = clip(poly, (c) => -c.s, hw);
        poly = clip(poly, (c) => c.t, hh);
        poly = clip(poly, (c) => -c.t, hh);
        for (let k = 1; k + 1 < poly.length; k++) {
            for (const c of [poly[0], poly[k], poly[k + 1]]) {
                const lifted = c.p.clone().addScaledVector(c.normal, LIFT);
                positions.push(lifted.x, lifted.y, lifted.z);
                normals.push(c.normal.x, c.normal.y, c.normal.z);
                uvs.push(c.s / w + 0.5, c.t / h + 0.5);
            }
        }
    }, box ? 0 : MIN_FACING);
    if (positions.length === 0) {
        return null;
    }
    const out = new BufferGeometry();
    out.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    out.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    out.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    out.computeBoundingSphere();
    return out;
}

/** Extent (in the decal's u, v) of all surface facing the decal normal: what "Fill surface" covers. */
export function surfaceExtent(geometry: BufferGeometry, position: Vec3, normal: Vec3, rotation = 0): {
    size: [number, number];
    center: Vec3;
} | null {
    const basis = decalBasis(geometry, position, normal, rotation);
    let minS = Infinity;
    let maxS = -Infinity;
    let minT = Infinity;
    let maxT = -Infinity;
    const d = new Vector3();
    facingTriangles(geometry, basis.n, (p) => {
        for (const point of p) {
            d.subVectors(point, basis.origin);
            const s = d.dot(basis.u);
            const t = d.dot(basis.v);
            minS = Math.min(minS, s);
            maxS = Math.max(maxS, s);
            minT = Math.min(minT, t);
            maxT = Math.max(maxT, t);
        }
    });
    if (!Number.isFinite(minS)) {
        return null;
    }
    const center = basis.origin.clone()
        .addScaledVector(basis.u, (minS + maxS) / 2)
        .addScaledVector(basis.v, (minT + maxT) / 2);
    return { size: [maxS - minS, maxT - minT], center: [center.x, center.y, center.z] };
}

/**
 * Default size for a new picture of aspect `aspect` (width / height): fitted into 70 % of the part's extent across
 * the surface, measured along the decal's own axes.
 */
export function defaultDecalSize(geometry: BufferGeometry, position: Vec3, normal: Vec3, aspect: number): [number, number] {
    const basis = decalBasis(geometry, position, normal);
    const pos = geometry.getAttribute('position');
    let minS = Infinity;
    let maxS = -Infinity;
    let minT = Infinity;
    let maxT = -Infinity;
    const p = new Vector3();
    for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).sub(basis.origin);
        const s = p.dot(basis.u);
        const t = p.dot(basis.v);
        minS = Math.min(minS, s);
        maxS = Math.max(maxS, s);
        minT = Math.min(minT, t);
        maxT = Math.max(maxT, t);
    }
    const boxW = Math.max(1, (maxS - minS) * 0.7);
    const boxH = Math.max(1, (maxT - minT) * 0.7);
    const width = Math.min(boxW, boxH * aspect);
    const round = (x: number) => Math.round(x * 10) / 10;
    return [round(width), round(width / aspect)];
}
