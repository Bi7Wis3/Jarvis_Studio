import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Part, Project } from '@jarvis/core';
import { buildGeometry, instanceTransforms } from '@jarvis/core/geometry';
import type { MeshData } from './cad/kernel.js';

/** The kernel's mesh for a part, or null to fall back to the preview geometry. */
export type MeshFor = (part: Part) => MeshData | null;

const HEADER_BYTES = 80;
const FACET_BYTES = 50;
const MIN_AREA = 1e-12;

const Y_UP_TO_Z_UP = new Matrix4().makeRotationX(Math.PI / 2);

interface Triangles {
    positions: ArrayLike<number>;
    indices: ArrayLike<number> | null;
    count: number;
}

function trianglesFor(part: Part, meshFor: MeshFor): { triangles: Triangles; dispose(): void } {
    const mesh = meshFor(part);
    if (mesh) {
        return { triangles: { positions: mesh.positions, indices: mesh.indices, count: mesh.indices.length }, dispose() {} };
    }
    const geometry = buildGeometry(part.shape);
    const positions = geometry.getAttribute('position');
    const index = geometry.getIndex();
    return {
        triangles: {
            positions: positions.array,
            indices: index ? index.array : null,
            count: index ? index.count : positions.count,
        },
        dispose: () => geometry.dispose(),
    };
}

/**
 * Exports the assembled project (without explode offsets) as a binary STL in millimetres, Z-up, using the CAD
 * kernel's mesh where `meshFor` has one. When partIds is given, only those parts are included.
 */
export function exportStl(project: Project, meshFor: MeshFor = () => null, partIds?: string[]): Buffer {
    const wanted = partIds ? new Set(partIds) : null;
    const parts = project.parts.filter((p) => !wanted || wanted.has(p.id));
    if (parts.length === 0) {
        const reason = partIds ? 'none of the requested parts exist in the project' : 'the project has no parts';
        throw new Error(`Nothing to export: ${reason}`);
    }

    const facets: number[] = [];
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const ab = new Vector3();
    const ac = new Vector3();
    for (const part of parts) {
        const [rx, ry, rz] = part.rotation.map((d) => MathUtils.degToRad(d));
        const rotation = new Euler(rx, ry, rz, 'XYZ');
        const local = new Matrix4().compose(
            new Vector3(...part.position),
            new Quaternion().setFromEuler(rotation),
            new Vector3(1, 1, 1),
        );
        const { triangles, dispose } = trianglesFor(part, meshFor);
        const { positions, indices, count } = triangles;
        for (const instance of instanceTransforms(part)) {
            const matrix = Y_UP_TO_Z_UP.clone().multiply(instance).multiply(local);
            for (let i = 0; i + 2 < count; i += 3) {
                const ia = indices ? indices[i] : i;
                const ib = indices ? indices[i + 1] : i + 1;
                const ic = indices ? indices[i + 2] : i + 2;
                a.fromArray(positions, ia * 3).applyMatrix4(matrix);
                b.fromArray(positions, ib * 3).applyMatrix4(matrix);
                c.fromArray(positions, ic * 3).applyMatrix4(matrix);
                const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a));
                const length = normal.length();
                if (length / 2 < MIN_AREA) {
                    continue;
                }
                normal.divideScalar(length);
                facets.push(normal.x, normal.y, normal.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            }
        }
        dispose();
    }

    const triangles = facets.length / 12;
    const buffer = Buffer.alloc(HEADER_BYTES + 4 + triangles * FACET_BYTES);
    buffer.write(`Jarvis Studio: ${project.name}`.slice(0, HEADER_BYTES), 0, 'ascii');
    buffer.writeUInt32LE(triangles, HEADER_BYTES);
    let offset = HEADER_BYTES + 4;
    for (let t = 0; t < triangles; t++) {
        for (let k = 0; k < 12; k++) {
            buffer.writeFloatLE(facets[t * 12 + k], offset);
            offset += 4;
        }
        buffer.writeUInt16LE(0, offset);
        offset += 2;
    }
    return buffer;
}
