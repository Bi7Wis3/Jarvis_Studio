import {
    BoxGeometry, BufferGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, ExtrudeGeometry, LatheGeometry, MathUtils, Matrix4,
    Path, Shape as Shape2D, SphereGeometry, SplineCurve, TorusGeometry, Vector2,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shapeHalfExtents, type Part, type Shape } from './index';

const CREASE_ANGLE = Math.PI / 5;
const FILLET_STEPS = 4;

/** Edge softening used when a shape does not say: real products have no razor-sharp edges. */
function defaultEdge(smallestSide: number): number {
    return Math.min(0.6, smallestSide * 0.06);
}

/** Rounds the interior corners of a lathe profile. */
function fillet(points: Vector2[], radius: number): Vector2[] {
    if (radius <= 0) {
        return points;
    }
    const out: Vector2[] = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const corner = points[i];
        const toPrev = points[i - 1].clone().sub(corner);
        const toNext = points[i + 1].clone().sub(corner);
        const d = Math.min(radius, toPrev.length() / 2, toNext.length() / 2);
        const start = corner.clone().addScaledVector(toPrev.normalize(), d);
        const end = corner.clone().addScaledVector(toNext.normalize(), d);
        for (let step = 0; step <= FILLET_STEPS; step++) {
            const t = step / FILLET_STEPS;
            out.push(new Vector2(
                (1 - t) * (1 - t) * start.x + 2 * t * (1 - t) * corner.x + t * t * end.x,
                (1 - t) * (1 - t) * start.y + 2 * t * (1 - t) * corner.y + t * t * end.y,
            ));
        }
    }
    out.push(points[points.length - 1]);
    return out;
}

function extrude(outline: [number, number][], height: number, bevelWanted: number | undefined): BufferGeometry {
    // The outline is [x, z]; z is negated because the extrusion is rotated from Z onto Y below.
    const face = new Shape2D(outline.map(([x, z]) => new Vector2(x, -z)));
    const bevel = Math.min(bevelWanted ?? defaultEdge(height), height / 2 - 0.01);
    const depth = height - bevel * 2;
    const geometry = new ExtrudeGeometry(face, {
        depth,
        bevelEnabled: bevel > 0,
        bevelSize: bevel,
        bevelThickness: bevel,
        bevelOffset: -bevel,
        bevelSegments: 2,
    });
    geometry.translate(0, 0, -depth / 2);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

function tube(outerRadius: number, innerRadius: number, height: number, bevelWanted?: number): BufferGeometry {
    const ring = new Shape2D().absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
    ring.holes.push(new Path().absarc(0, 0, Math.min(innerRadius, outerRadius - 0.01), 0, Math.PI * 2, true));
    const bevel = Math.min(bevelWanted ?? 0.5, (outerRadius - innerRadius) / 4, height / 4);
    const geometry = new ExtrudeGeometry(ring, {
        depth: height - bevel * 2,
        curveSegments: 64,
        bevelEnabled: bevel > 0,
        bevelSize: bevel,
        bevelThickness: bevel,
        bevelSegments: 2,
    });
    geometry.translate(0, 0, -(height - bevel * 2) / 2);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

/** Builds render geometry for a part shape, centred on the part position with its axis along Y. */
export function buildGeometry(shape: Shape): BufferGeometry {
    switch (shape.kind) {
        case 'box': {
            const [w, h, d] = shape.size;
            const smallest = Math.min(w, h, d);
            const radius = Math.min(shape.radius ?? defaultEdge(smallest), smallest / 2);
            return radius > 0 ? new RoundedBoxGeometry(w, h, d, 4, radius) : new BoxGeometry(w, h, d);
        }
        case 'cylinder': {
            const top = shape.radiusTop ?? shape.radius;
            const half = shape.height / 2;
            const bevel = shape.bevel ?? defaultEdge(Math.min(shape.height, Math.max(shape.radius, top) * 2));
            const profile = [new Vector2(0, -half), new Vector2(shape.radius, -half), new Vector2(top, half),
                new Vector2(0, half)];
            return toCreasedNormals(new LatheGeometry(fillet(profile, bevel), 72), CREASE_ANGLE);
        }
        case 'extrude':
            return extrude(shape.outline, shape.height, shape.bevel);
        case 'tube':
            return tube(shape.outerRadius, shape.innerRadius, shape.height, shape.bevel);
        case 'sphere':
            return new SphereGeometry(shape.radius, 48, 32);
        case 'torus':
            return new TorusGeometry(shape.radius, shape.tube, 24, 96).rotateX(Math.PI / 2);
        case 'cone':
            return new ConeGeometry(shape.radius, shape.height, 72);
        case 'capsule':
            return new CapsuleGeometry(shape.radius, shape.length, 8, 32);
        case 'wedge': {
            const [w, h, d] = shape.size;
            const side = new Shape2D([new Vector2(-w / 2, -h / 2), new Vector2(w / 2, -h / 2), new Vector2(-w / 2, h / 2)]);
            return new ExtrudeGeometry(side, { depth: d, bevelEnabled: false }).translate(0, 0, -d / 2);
        }
        case 'lathe': {
            const points = shape.profile.map(([r, y]) => new Vector2(Math.max(0, r), y));
            if (shape.smooth && points.length > 2) {
                const curve = new SplineCurve(points).getPoints(points.length * 8);
                return new LatheGeometry(curve.map((p) => p.setX(Math.max(0, p.x))), 96);
            }
            return toCreasedNormals(new LatheGeometry(points, 96), CREASE_ANGLE);
        }
        case 'script':
            // Placeholder until the CAD kernel has run the script.
            return new BoxGeometry(...shape.size);
        case 'empty':
            return new BufferGeometry();
        case 'sketch': {
            // Placeholder until the CAD kernel has built the sketch body.
            const [x, y, z] = shapeHalfExtents(shape);
            return new BoxGeometry(Math.max(x * 2, 0.1), Math.max(y * 2, 0.1), Math.max(z * 2, 0.1));
        }
        case 'fastener': {
            // Placeholder until the CAD kernel's real mesh arrives.
            const [r, half] = shapeHalfExtents(shape);
            return new CylinderGeometry(r * 0.55, r * 0.55, half * 2, 24).translate(0, -half, 0);
        }
    }
}

/** World transform of each copy of a part, to apply on top of its own position and rotation. */
export function instanceTransforms(part: Pick<Part, 'repeat'>): Matrix4[] {
    const repeat = part.repeat;
    if (!repeat || repeat.count < 2) {
        return [new Matrix4()];
    }
    const out: Matrix4[] = [];
    for (let i = 0; i < repeat.count; i++) {
        if (repeat.kind === 'linear') {
            out.push(new Matrix4().makeTranslation(repeat.step[0] * i, repeat.step[1] * i, repeat.step[2] * i));
        } else {
            const [cx, cz] = repeat.centre ?? [0, 0];
            const sweep = repeat.angle ?? 360;
            const divisions = sweep >= 360 ? repeat.count : repeat.count - 1;
            const angle = MathUtils.degToRad((sweep / divisions) * i);
            out.push(new Matrix4().makeTranslation(cx, 0, cz)
                .multiply(new Matrix4().makeRotationY(angle))
                .multiply(new Matrix4().makeTranslation(-cx, 0, -cz)));
        }
    }
    return out;
}
