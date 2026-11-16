// The import job the CAD worker runs: read the file with its importer, turn it to the studio's Y up, and store the
// bodies as assets (a BREP of the solids, an STL of a graphics body), one set per part to be made.

import { makeCompound, measureVolume, type Shape3D } from 'replicad';
import type { Vec3 } from '@jarvis/core';
import type { ImportedBodyInfo, ImportOptions } from '@jarvis/core/imported';
import { saveImportAsset } from './assets.js';
import { saveBrep } from './brep.js';
import { readFile } from './registry.js';
import { stlBytes } from './stl.js';
import type { ImportedBody } from './types.js';

export interface ImportJob {
    filename: string;
    bytes: Uint8Array;
    options: ImportOptions;
}

/** What one part gets: the assets of its Imported step and what they hold. */
export interface ImportedPart {
    brep?: string;
    mesh?: string;
    /** Per solid of the BREP in order, then the graphics body. */
    bodies: ImportedBodyInfo[];
    solids: number;
    /** Facets of the graphics body. */
    facets: number;
    /** mm³, of the solids. */
    volume: number;
    /** Bounding box in the part frame (solids and graphics), or null. */
    box: [Vec3, Vec3] | null;
}

export interface ImportJobResult {
    format: string;
    parts: ImportedPart[];
    warnings: string[];
    thumbnail?: Uint8Array;
    up: 'y' | 'z';
}

/** Z up to the studio's Y up: (x, y, z) -> (x, z, -y). */
function turnMesh(positions: Float32Array): Float32Array {
    const out = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        out[i] = positions[i];
        out[i + 1] = positions[i + 2];
        out[i + 2] = -positions[i + 1];
    }
    return out;
}

function grow(box: [Vec3, Vec3] | null, min: number[], max: number[]): [Vec3, Vec3] {
    if (!box) {
        return [[min[0], min[1], min[2]], [max[0], max[1], max[2]]];
    }
    return [box[0].map((v, k) => Math.min(v, min[k])) as Vec3, box[1].map((v, k) => Math.max(v, max[k])) as Vec3];
}

function meshBox(positions: Float32Array): [number[], number[]] {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], positions[i + k]);
            max[k] = Math.max(max[k], positions[i + k]);
        }
    }
    return [min, max];
}

function concat(meshes: Float32Array[]): Float32Array {
    const out = new Float32Array(meshes.reduce((n, m) => n + m.length, 0));
    let at = 0;
    for (const m of meshes) {
        out.set(m, at);
        at += m.length;
    }
    return out;
}

/** Stores one part's bodies (and frees their shapes). */
function store(bodies: ImportedBody[]): ImportedPart {
    const solids: Shape3D[] = [];
    const info: ImportedBodyInfo[] = [];
    const meshes: Float32Array[] = [];
    const meshInfo: ImportedBodyInfo[] = [];
    for (const body of bodies) {
        const named = { ...(body.name ? { name: body.name } : {}), ...(body.color ? { color: body.color } : {}) };
        if (body.shape) {
            for (const solid of body.shape.solids) {
                solids.push(solid);
                info.push(named);
            }
            body.shape.delete();
        }
        if (body.mesh?.length) {
            meshes.push(body.mesh);
            meshInfo.push(named);
        }
    }
    const part: ImportedPart = { bodies: [...info, ...meshInfo.slice(0, 1)], solids: solids.length, facets: 0, volume: 0, box: null };
    if (solids.length) {
        const shape = solids.length === 1 ? solids[0] : (makeCompound(solids) as Shape3D);
        part.brep = saveBrep(shape);
        part.volume = measureVolume(shape);
        const box = shape.boundingBox;
        part.box = grow(part.box, box.bounds[0], box.bounds[1]);
        box.delete();
        shape.delete();
    }
    if (meshes.length) {
        const positions = concat(meshes);
        part.mesh = saveImportAsset(stlBytes(positions), 'stl');
        part.facets = positions.length / 9;
        const [min, max] = meshBox(positions);
        part.box = grow(part.box, min, max);
    }
    return part;
}

export async function runImport(job: ImportJob): Promise<ImportJobResult> {
    const result = await readFile(job.filename, job.bytes, job.options);
    const up = result.up ?? job.options.up ?? 'z';
    const bodies = result.bodies.map((body): ImportedBody => (up === 'z'
        ? { ...body, shape: body.shape?.rotate(-90, [0, 0, 0], [1, 0, 0]), mesh: body.mesh && turnMesh(body.mesh) }
        : body));
    // Import multiple bodies as parts: each solid (and the graphics body) a part of its own.
    const groups: ImportedBody[][] = job.options.bodiesAsParts
        ? bodies.flatMap((body) => [
            ...(body.shape ? body.shape.solids.map((solid): ImportedBody[] => [{ ...body, shape: solid, mesh: undefined }]) : []),
            ...(body.mesh?.length ? [[{ ...body, shape: undefined }]] : []),
        ])
        : [bodies];
    if (job.options.bodiesAsParts) {
        bodies.forEach((b) => b.shape?.delete());
    }
    const parts = groups.map(store).filter((p) => p.solids || p.facets);
    if (!parts.length) {
        throw new Error(`nothing in ${job.filename} could be imported${result.warnings.length ? `: ${result.warnings.join('. ')}` : ''}`);
    }
    return { format: result.importer.format, parts, warnings: result.warnings, ...(result.thumbnail ? { thumbnail: result.thumbnail } : {}), up };
}
