// Graphics bodies (an STL imported as a graphics body): triangles shown with the part and exported with its STL,
// but not part of its solid, so no step works on them and they have no mass. The worker adds them to the part's mesh
// after the solid's faces, one face and one body each, for the Solid Bodies folder to hide or show see-through.

import type { Feature } from '@jarvis/core';
import type { BodyInfo } from '@jarvis/core/visibility';
import type { MeshData } from '../cad/kernel.js';
import { readImportAsset } from './assets.js';
import { parseStl } from './stl.js';

const cache = new Map<string, Float32Array>();

function corners(id: string): Float32Array {
    let positions = cache.get(id);
    if (!positions) {
        positions = parseStl(readImportAsset(id)).positions;
        cache.set(id, positions);
        while (cache.size > 8) {
            cache.delete(cache.keys().next().value as string);
        }
    }
    return positions;
}

/** The import steps whose graphics bodies the build reached: those before the step that failed, unsuppressed. */
function reached(features: Feature[] | undefined, error: string | null): Extract<Feature, { op: 'import' }>[] {
    const list = features ?? [];
    const failed = error ? list.findIndex((f) => error.startsWith(`feature "${f.name ?? f.id}" (${f.op})`)) : -1;
    return (failed >= 0 ? list.slice(0, failed) : list)
        .filter((f): f is Extract<Feature, { op: 'import' }> => f.op === 'import' && !f.suppressed && !!f.mesh);
}

/** The key of a step's graphics body in the Solid Bodies folder. */
export const graphicsKey = (stepId: string): string => `${stepId}:graphics`;

/** The part's mesh with the graphics bodies of its import steps added (the mesh itself when there are none). */
export function withGraphics(mesh: MeshData, part: { features?: Feature[] }, error: string | null): MeshData {
    const steps = reached(part.features, error);
    if (!steps.length) {
        return mesh;
    }
    const pieces = steps.map((step) => ({ step, positions: corners(step.mesh!) }));
    const added = pieces.reduce((n, p) => n + p.positions.length, 0);
    const positions = new Float32Array(mesh.positions.length + added);
    const normals = new Float32Array(mesh.normals.length + added);
    const indices = new Uint32Array(mesh.indices.length + added / 3);
    const triFace = new Uint32Array(mesh.triFace.length + added / 9);
    positions.set(mesh.positions);
    normals.set(mesh.normals);
    indices.set(mesh.indices);
    triFace.set(mesh.triFace);
    let faces = mesh.faceBody?.length ?? 0;
    for (const f of mesh.triFace) {
        faces = Math.max(faces, f + 1);
    }
    const bodies: BodyInfo[] = [...(mesh.bodies ?? [])];
    const faceBody = new Uint32Array(faces + pieces.length);
    faceBody.set(mesh.faceBody ?? []);
    let p = mesh.positions.length;
    let i = mesh.indices.length;
    let t = mesh.triFace.length;
    pieces.forEach(({ step, positions: corner }, k) => {
        positions.set(corner, p);
        for (let c = 0; c < corner.length; c += 9) {
            const ux = corner[c + 3] - corner[c], uy = corner[c + 4] - corner[c + 1], uz = corner[c + 5] - corner[c + 2];
            const vx = corner[c + 6] - corner[c], vy = corner[c + 7] - corner[c + 1], vz = corner[c + 8] - corner[c + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const length = Math.hypot(nx, ny, nz) || 1;
            for (let v = 0; v < 3; v++) {
                normals.set([nx / length, ny / length, nz / length], p + c + v * 3);
                indices[i++] = (p + c) / 3 + v;
            }
            triFace[t++] = faces + k;
        }
        p += corner.length;
        faceBody[faces + k] = bodies.length;
        bodies.push({ key: graphicsKey(step.id), by: step.id });
    });
    return { ...mesh, positions, normals, indices, triFace, faceBody, edgeBody: mesh.edgeBody ?? new Uint32Array(0), bodies };
}
