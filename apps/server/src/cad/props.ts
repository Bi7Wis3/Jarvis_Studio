// Mass properties of a built solid from OpenCascade's global properties (GProp), per unit density. The inertia
// tensor comes from moments about axes through the centre of mass (MatrixOfInertia and PrincipalProperties are not
// bound in the WebAssembly build), then a symmetric eigen solve gives the principal moments.

import { getOC, makeAx1, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';

export type Mat3 = [Vec3, Vec3, Vec3];

export interface MassProps {
    /** mm³ */
    volume: number;
    /** mm² */
    area: number;
    /** Centre of mass in the part frame, mm. */
    centre: Vec3;
    /** Axis-aligned bounds in the part frame, mm. */
    bounds: { min: Vec3; max: Vec3 };
    /**
     * Inertia tensor at the centre of mass, part axes, for unit density: mm⁵. Multiply by the density in g/mm³
     * (g/cm³ / 1000) for g·mm². Off-diagonal entries are the tensor's (minus the products of inertia).
     */
    inertia: Mat3;
    /** Principal moments (ascending, same units as `inertia`) and their axes (unit vectors, part frame). */
    principal: { moments: Vec3; axes: Mat3 };
}

/** Mass properties of a solid; null when it has no volume (no body, only sketches or surfaces). */
export function massProperties(shape: Shape3D): MassProps | null {
    const oc = getOC();
    const volumeProps = new oc.GProp_GProps();
    const surfaceProps = new oc.GProp_GProps();
    try {
        oc.BRepGProp.VolumeProperties(shape.wrapped, volumeProps, false, false, false);
        const volume = volumeProps.Mass();
        if (!(Math.abs(volume) > 1e-9)) {
            return null;
        }
        oc.BRepGProp.SurfaceProperties(shape.wrapped, surfaceProps, false, false);
        const area = surfaceProps.Mass();
        const point = volumeProps.CentreOfMass();
        const centre: Vec3 = [point.X(), point.Y(), point.Z()];
        point.delete();
        const moment = (dir: Vec3): number => {
            const axis = makeAx1(centre, dir);
            const value = volumeProps.MomentOfInertia(axis);
            axis.delete();
            return value;
        };
        const s = Math.SQRT1_2;
        const [ixx, iyy, izz] = [moment([1, 0, 0]), moment([0, 1, 0]), moment([0, 0, 1])];
        // About n = (a + b)/√2 the moment is (Iaa + Ibb)/2 + Iab.
        const ixy = moment([s, s, 0]) - (ixx + iyy) / 2;
        const ixz = moment([s, 0, s]) - (ixx + izz) / 2;
        const iyz = moment([0, s, s]) - (iyy + izz) / 2;
        const inertia: Mat3 = [[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]];
        const box = shape.boundingBox;
        const [lo, hi] = box.bounds;
        box.delete();
        return {
            volume, area, centre,
            bounds: { min: [lo[0], lo[1], lo[2]], max: [hi[0], hi[1], hi[2]] },
            inertia: clean(inertia),
            principal: principalAxes(inertia),
        };
    } finally {
        volumeProps.delete();
        surfaceProps.delete();
    }
}

/** Zeroes products that are rounding noise next to the diagonal. */
function clean(m: Mat3): Mat3 {
    const scale = Math.max(Math.abs(m[0][0]), Math.abs(m[1][1]), Math.abs(m[2][2]));
    return m.map((row) => row.map((v) => (Math.abs(v) < scale * 1e-9 ? 0 : v))) as Mat3;
}

/** Eigenvalues (ascending) and unit eigenvectors of a symmetric 3×3 matrix, by Jacobi rotations. */
export function principalAxes(matrix: Mat3): { moments: Vec3; axes: Mat3 } {
    const a = matrix.map((row) => [...row]);
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
        const diag = a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2;
        if (off <= diag * 1e-30 || off === 0) {
            break;
        }
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (a[p][q] === 0) {
                continue;
            }
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k][p];
                const akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p][k];
                const aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k][p];
                const vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
    return {
        moments: order.map((i) => a[i][i]) as Vec3,
        axes: order.map((i) => {
            const axis = [v[0][i], v[1][i], v[2][i]];
            // Point each axis along its largest component's positive direction, for stable output.
            const big = axis.reduce((m, x, k) => (Math.abs(x) > Math.abs(axis[m]) ? k : m), 0);
            return (axis[big] < 0 ? axis.map((x) => -x || 0) : axis) as Vec3;
        }) as Mat3,
    };
}

/** A rigid placement: world = rotation · local + translation (rotation rows). */
export interface Placement {
    rotation: Mat3;
    translation: Vec3;
}

export interface CombinedProps {
    volume: number;
    area: number;
    /** World frame, mm. */
    centre: Vec3;
    /** World axes, at the combined centre of mass, unit density (mm⁵). */
    inertia: Mat3;
    principal: { moments: Vec3; axes: Mat3 };
}

/**
 * Combines placed copies of solids (same density) into one: volumes and areas add, the centre is volume-weighted,
 * and each tensor is rotated into the world (R I Rᵀ) and moved to the common centre by the parallel axis theorem.
 */
export function combineProps(items: { props: MassProps; placements: Placement[] }[]): CombinedProps | null {
    const copies = items.flatMap(({ props, placements }) => placements.map((p) => ({ props, p })));
    if (copies.length === 0) {
        return null;
    }
    const world = copies.map(({ props, p }) => ({
        props,
        centre: add(apply(p.rotation, props.centre), p.translation),
        inertia: mul(mul(p.rotation, props.inertia), transpose(p.rotation)),
    }));
    const volume = world.reduce((s, w) => s + w.props.volume, 0);
    const area = world.reduce((s, w) => s + w.props.area, 0);
    const centre = [0, 1, 2].map((k) => world.reduce((s, w) => s + w.props.volume * w.centre[k], 0) / volume) as Vec3;
    const inertia: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const w of world) {
        const d = [0, 1, 2].map((k) => w.centre[k] - centre[k]);
        const d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                inertia[i][j] += w.inertia[i][j] + w.props.volume * ((i === j ? d2 : 0) - d[i] * d[j]);
            }
        }
    }
    return { volume, area, centre, inertia: clean(inertia), principal: principalAxes(inertia) };
}

function apply(m: Mat3, v: Vec3): Vec3 {
    return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;
}

function add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function transpose(m: Mat3): Mat3 {
    return [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]) as Mat3;
}

function mul(a: Mat3, b: Mat3): Mat3 {
    return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as Mat3;
}
