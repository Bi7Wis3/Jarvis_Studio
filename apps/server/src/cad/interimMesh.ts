// A coarse mesh to show first while the real one is made, when that takes a while: after a full rebuild, or with a
// modelled thread built again, whose walls take OpenCascade seconds at normal quality. It is made on a copy of the
// solid (meshApart), so the faces keep the triangles the next mesh of the view reuses (incrementalMesh.ts).

import type { Shape3D } from 'replicad';
import { meshSolid, meshTolerance } from './build.js';
import { meshApart, meshWork } from './incrementalMesh.js';
import type { MeshData } from './kernel.js';
import type { MeshQuality } from './meshQuality.js';

/** CPU ms of meshing (meshWork) from which a coarse mesh first pays off. */
export const LONG_MESH_MS = 2000;
/** A coarse mesh of a whole solid takes about this part of the time of a normal one. */
const COARSE_SHARE = 0.3;

/**
 * A coarse mesh of `shape` when meshing it at `quality` will take a while, else null. Only when it comes at least
 * twice as soon: a coarse mesh is of the whole solid, while the real one may keep most of its faces.
 */
export function interimMesh(shape: Shape3D, quality: MeshQuality = 'normal'): MeshData | null {
    if (quality === 'coarse') {
        return null;
    }
    try {
        const work = meshWork(shape, meshTolerance(shape, quality), LONG_MESH_MS);
        if (work.now < LONG_MESH_MS || COARSE_SHARE * work.whole > work.now / 2) {
            return null;
        }
        return meshApart(() => meshSolid(shape, 'coarse'));
    } catch {
        return null; // only a nicety: the real mesh follows anyway
    }
}
