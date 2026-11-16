// STL meshes, binary and ASCII. Import as (Mesh files import options): a graphics body, shown and exported but not
// used by other steps; or solid bodies, one face per facet (coplanar neighbours merged into one face when Group
// facets into faces is on), one solid per closed piece of the mesh. The file's numbers are taken in the chosen unit.

import { cast, getOC, type Shape3D } from 'replicad';
import { IMPORT_UNITS, type ImportOptions } from '@jarvis/core/imported';
import { solidFromFacets } from './facets.js';
import { countOf, explore } from './topology.js';
import { knit, shellSolid } from './solids.js';
import type { ImportedBody, ImportResult } from './types.js';

export interface StlMesh {
    /** Triangle corners, x y z each, three per triangle. */
    positions: Float32Array;
    /** The name after `solid` in an ASCII file. */
    name?: string;
}

const isBinary = (bytes: Uint8Array): boolean => {
    if (bytes.length < 84) {
        return false;
    }
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + count * 50 === bytes.length) {
        return true;
    }
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
    return !(head.startsWith('solid') && /facet|endsolid/.test(new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)))));
};

/** The triangles of an STL file, binary or ASCII. */
export function parseStl(bytes: Uint8Array): StlMesh {
    if (isBinary(bytes)) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const count = view.getUint32(80, true);
        if (84 + count * 50 > bytes.length) {
            throw new Error(`the STL file is cut short: it should hold ${count} triangles but has room for ${Math.floor((bytes.length - 84) / 50)}`);
        }
        const positions = new Float32Array(count * 9);
        for (let t = 0; t < count; t++) {
            const at = 84 + t * 50 + 12;
            for (let k = 0; k < 9; k++) {
                positions[t * 9 + k] = view.getFloat32(at + k * 4, true);
            }
        }
        return { positions };
    }
    const text = new TextDecoder().decode(bytes);
    const name = /^\s*solid[ \t]+([^\r\n]*)/.exec(text)?.[1]?.trim() || undefined;
    const numbers: number[] = [];
    const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m = vertex.exec(text); m; m = vertex.exec(text)) {
        numbers.push(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    if (numbers.some((n) => !Number.isFinite(n))) {
        throw new Error('the ASCII STL file has vertices that are not numbers');
    }
    const whole = numbers.length - (numbers.length % 9);
    return { positions: Float32Array.from(numbers.slice(0, whole)), name };
}

/** Binary STL of triangle corners (normals from the corner order). */
export function stlBytes(positions: Float32Array, header = 'Jarvis Studio'): Uint8Array {
    const count = Math.floor(positions.length / 9);
    const out = new Uint8Array(84 + count * 50);
    const view = new DataView(out.buffer);
    out.set(new TextEncoder().encode(header.slice(0, 80)), 0);
    view.setUint32(80, count, true);
    for (let t = 0; t < count; t++) {
        const p = positions.subarray(t * 9, t * 9 + 9);
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
        const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz) || 1;
        const at = 84 + t * 50;
        view.setFloat32(at, nx / length, true);
        view.setFloat32(at + 4, ny / length, true);
        view.setFloat32(at + 8, nz / length, true);
        for (let k = 0; k < 9; k++) {
            view.setFloat32(at + 12 + k * 4, p[k], true);
        }
    }
    return out;
}

interface Indexed {
    /** Per corner: the welded vertex it is. */
    corners: Uint32Array;
    vertices: number;
}

/** Welds corners at the same point (to 10 nm) and drops triangles with two corners at one point. */
function weld(positions: Float32Array): { kept: Float32Array; mesh: Indexed } {
    const ids = new Map<string, number>();
    const q = (v: number): number => Math.round(v * 1e5);
    const corners: number[] = [];
    const kept: number[] = [];
    for (let t = 0; t + 8 < positions.length; t += 9) {
        const tri: number[] = [];
        for (let c = 0; c < 3; c++) {
            const i = t + c * 3;
            const key = `${q(positions[i])},${q(positions[i + 1])},${q(positions[i + 2])}`;
            let id = ids.get(key);
            if (id === undefined) {
                id = ids.size;
                ids.set(key, id);
            }
            tri.push(id);
        }
        if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) {
            corners.push(...tri);
            for (let k = 0; k < 9; k++) {
                kept.push(positions[t + k]);
            }
        }
    }
    return { kept: Float32Array.from(kept), mesh: { corners: Uint32Array.from(corners), vertices: ids.size } };
}

const TWO_FACETS = new Set([2, 1000001, 2000000]);

/** Faces of a faceted solid past which the form warns that work on it is slow. */
const MANY_FACES = 5000;

export interface MeshPiece {
    triangles: number[];
    /** Every edge between exactly two facets (watertight). */
    closed: boolean;
    /** Every edge is run once each way by its two facets: neighbours are wound alike. */
    wound?: boolean;
}

/** Triangles grouped by the pieces of the mesh that share edges, and whether each piece is closed (watertight). */
export function meshPieces(positions: Float32Array): MeshPiece[] {
    const { mesh } = weld(positions);
    const n = mesh.corners.length / 3;
    const parent = Array.from({ length: mesh.vertices }, (_, i) => i);
    const root = (i: number): number => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const uses = new Map<number, number>();
    for (let t = 0; t < n; t++) {
        for (let e = 0; e < 3; e++) {
            const a = mesh.corners[t * 3 + e];
            const b = mesh.corners[t * 3 + ((e + 1) % 3)];
            parent[root(a)] = root(b);
            // +1 one way, +1e6 the other: an edge between exactly two facets sums to 2, 1000001 or 2000000.
            const key = Math.min(a, b) * mesh.vertices + Math.max(a, b);
            uses.set(key, (uses.get(key) ?? 0) + (a < b ? 1 : 1e6));
        }
    }
    const pieces = new Map<number, Required<MeshPiece>>();
    for (let t = 0; t < n; t++) {
        const r = root(mesh.corners[t * 3]);
        let piece = pieces.get(r);
        if (!piece) {
            piece = { triangles: [], closed: true, wound: true };
            pieces.set(r, piece);
        }
        piece.triangles.push(t);
        for (let e = 0; e < 3 && piece.closed; e++) {
            const a = mesh.corners[t * 3 + e];
            const b = mesh.corners[t * 3 + ((e + 1) % 3)];
            // Facets wound against their neighbours still close the piece: making the solid orients them.
            const use = uses.get(Math.min(a, b) * mesh.vertices + Math.max(a, b)) ?? 0;
            if (!TWO_FACETS.has(use)) {
                piece.closed = false;
            }
            if (use !== 1000001) {
                piece.wound = false;
            }
        }
    }
    return [...pieces.values()].map(({ triangles, closed, wound }) => (closed ? { triangles, closed, wound } : { triangles, closed }));
}

/** A closed piece as a solid: built directly when its facets are wound alike, else read, knitted and fixed. */
function pieceSolid(positions: Float32Array, wound: boolean, group: boolean): Shape3D | null {
    if (!wound) {
        return facetedSolid(positions, group);
    }
    const { kept, mesh } = weld(positions);
    const solid = solidFromFacets(kept, mesh.corners, mesh.vertices);
    if (!solid || !group) {
        return solid;
    }
    const oc = getOC();
    const unify = new oc.ShapeUpgrade_UnifySameDomain(solid.wrapped, true, true, false);
    try {
        unify.Build();
        const merged = cast(unify.Shape()) as Shape3D;
        if (merged.solids.length === 1) {
            solid.delete();
            return merged;
        }
        merged.delete();
        return solid;
    } finally {
        unify.delete();
    }
}

const pick = (positions: Float32Array, triangles: number[]): Float32Array => {
    const out = new Float32Array(triangles.length * 9);
    triangles.forEach((t, i) => out.set(positions.subarray(t * 9, t * 9 + 9), i * 9));
    return out;
};

let files = 0;

/** A closed piece of mesh as a solid with one face per facet (coplanar facets merged when `group`). */
export function facetedSolid(positions: Float32Array, group: boolean): Shape3D | null {
    const oc = getOC();
    const fs = (oc as unknown as { FS: { writeFile(p: string, d: Uint8Array): void; unlink(p: string): void } }).FS;
    const file = `/import-${process.pid}-${++files}.stl`;
    fs.writeFile(file, stlBytes(positions));
    const reader = new oc.StlAPI_Reader();
    let read = new oc.TopoDS_Shape();
    try {
        if (!reader.Read(read, file)) {
            return null;
        }
        if (group) {
            const unify = new oc.ShapeUpgrade_UnifySameDomain(read, true, true, false);
            try {
                unify.Build();
                const merged = unify.Shape();
                read.delete();
                read = merged;
            } finally {
                unify.delete();
            }
        }
        let shells = explore(oc, read, 'TopAbs_SHELL');
        if (!shells.length) {
            shells = explore(oc, knit(explore(oc, read, 'TopAbs_FACE'), 1e-6), 'TopAbs_SHELL');
        }
        return shells.length === 1 ? shellSolid(shells[0]) : null;
    } finally {
        reader.delete();
        read.delete();
        try {
            fs.unlink(file);
        } catch {
            // never written
        }
    }
}

export function readStl(bytes: Uint8Array, options: ImportOptions): ImportResult {
    const parsed = parseStl(bytes);
    const scale = IMPORT_UNITS[options.unit ?? 'mm'] ?? 1;
    const positions = scale === 1 ? parsed.positions : parsed.positions.map((v) => v * scale);
    const { kept } = weld(positions);
    if (kept.length === 0) {
        throw new Error('the STL file holds no triangles');
    }
    const warnings: string[] = [];
    if (kept.length < positions.length) {
        warnings.push(`${(positions.length - kept.length) / 9} degenerate facets (two corners at one point) left out`);
    }
    if ((options.meshAs ?? 'graphics') === 'graphics') {
        return { bodies: [{ mesh: kept, name: parsed.name }], warnings };
    }
    const bodies: ImportedBody[] = [];
    const open: number[] = [];
    const pieces = meshPieces(kept);
    let failed = 0;
    for (const piece of pieces) {
        if (!piece.closed) {
            open.push(...piece.triangles);
            continue;
        }
        const solid = pieceSolid(pick(kept, piece.triangles), !!piece.wound, options.groupFacets ?? true);
        if (solid) {
            bodies.push({ shape: solid, name: parsed.name });
        } else {
            failed++;
            open.push(...piece.triangles);
        }
    }
    const faces = bodies.reduce((n, b) => n + (b.shape ? countOf(getOC(), b.shape.wrapped, 'TopAbs_FACE') : 0), 0);
    if (faces > MANY_FACES) {
        warnings.push(`The solid has ${faces} faces: at this size rebuilding the part and picking its edges and faces is slow `
            + '(a graphics body is much quicker to show)');
    }
    const left = pieces.filter((p) => !p.closed).length + failed;
    if (left) {
        // The studio has no surface bodies: what is not closed stays a mesh, shown as a graphics body.
        bodies.push({ mesh: pick(kept, open), name: parsed.name });
        warnings.push(`${left} of ${pieces.length} piece${pieces.length === 1 ? '' : 's'} of the mesh ${left === 1 ? 'is' : 'are'} not closed`
            + `${failed ? ' or could not be made solid' : ''}, so ${left === 1 ? 'it' : 'they'} came in as a graphics body instead of a solid`);
    }
    return { bodies, warnings };
}
