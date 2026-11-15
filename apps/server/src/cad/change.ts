// What a range of steps does to the body, for a tool preview that highlights only the feature's own material (as
// SolidWorks does) over the model as it is: for a step that adds or cuts (extrude, revolve, loft, sweep, hole, add,
// cut, and the patterns and mirrors of those) the volume it adds or removes, from its tool; for a step that reshapes
// the body (fillet, chamfer, shell, draft, split, mirror of the body, combine) the faces it makes; for a thread shown
// in a preview, its ridges. Built by a ChangeWatch while the preview builds the part (build.ts buildPartial).

import { getOC, makeCompound, type Face, type Shape3D } from 'replicad';
import { mergeMeshes, meshTolerance, meshWithOpenCascade } from './build.js';
import { cosmeticMarks, isCosmetic } from './bodies.js';
import { toolTap, type StepWatch } from './changeTap.js';
import type { MeshData } from './kernel.js';
import { toleranceFor, type MeshQuality } from './meshQuality.js';
import { ghostMesh, type ThreadGhost } from './thread.js';

/** The steps of a part whose effect a preview shows: indices into its features, both included; `steps`: only these. */
export interface ChangeRange {
    from: number;
    to: number;
    steps?: number[];
}

interface Tapped {
    body: Shape3D | null;
    tool: Shape3D;
    mode: 'add' | 'cut';
}

interface SurfaceHandle {
    delete(): void;
    isAliasOf(other: unknown): boolean;
    $$?: { ptr?: number };
}

/** The handle of the surface under a face (several handles of one surface point to the same object). */
const surfaceOf = (face: Face): SurfaceHandle =>
    (getOC() as unknown as { BRep_Tool: { Surface(f: unknown): SurfaceHandle } }).BRep_Tool.Surface(face.wrapped);

/**
 * The faces of `after` that the step made: not a face of `before`, nor a face on one of `before`'s surfaces (a face
 * the step only trimmed, like the sides next to a fillet, keeps its surface).
 */
export function madeFaces(before: Shape3D | null, after: Shape3D): Face[] {
    const faces = after.faces;
    if (!before) {
        return faces;
    }
    const old = before.faces;
    const hashes = new Map<number, Face[]>();
    for (const face of old) {
        const list = hashes.get(face.hashCode);
        if (list) {
            list.push(face);
        } else {
            hashes.set(face.hashCode, [face]);
        }
    }
    const handles = old.map(surfaceOf);
    // embind keeps the object a handle points to in $$.ptr: a set of those finds a shared surface at once.
    const byPointer = handles.every((h) => typeof h.$$?.ptr === 'number');
    const pointers = new Set(handles.map((h) => h.$$?.ptr));
    const made: Face[] = [];
    try {
        for (const face of faces) {
            let kept = !!hashes.get(face.hashCode)?.some((o) => o.isSame(face));
            if (!kept) {
                const surface = surfaceOf(face);
                const ptr = surface.$$?.ptr;
                kept = byPointer && typeof ptr === 'number' ? pointers.has(ptr) : handles.some((h) => h.isAliasOf(surface));
                surface.delete();
            }
            if (kept) {
                face.delete();
            } else {
                made.push(face);
            }
        }
        return made;
    } finally {
        handles.forEach((h) => h.delete());
        old.forEach((f) => f.delete());
    }
}

/** The material a tool adds to or removes from a body (null when it is nothing). */
function toolVolume({ body, tool, mode }: Tapped): Shape3D | null {
    try {
        const made = mode === 'add' ? (body ? tool.cut(body) : tool.clone()) : body ? tool.intersect(body) : null;
        return made && made.faces.length ? made : null;
    } catch {
        // The highlight is a nicety: a boolean the kernel cannot do shows the tool itself for an add, nothing for a cut.
        return mode === 'add' ? tool.clone() : null;
    }
}

interface OcPoint {
    X(): number;
    Y(): number;
    Z(): number;
    delete(): void;
}

/** A face's box from its triangulation (fast; replicad's boundingBox finds the optimal box, which is slow on a torus). */
function quickBounds(face: Face): [number[], number[]] {
    const oc = getOC() as unknown as {
        Bnd_Box: new () => { CornerMin(): OcPoint; CornerMax(): OcPoint; delete(): void };
        BRepBndLib: { Add(shape: unknown, box: unknown, useTriangulation: boolean): void };
    };
    const box = new oc.Bnd_Box();
    try {
        oc.BRepBndLib.Add(face.wrapped, box, true);
        const [min, max] = [box.CornerMin(), box.CornerMax()];
        const out: [number[], number[]] = [[min.X(), min.Y(), min.Z()], [max.X(), max.Y(), max.Z()]];
        min.delete();
        max.delete();
        return out;
    } finally {
        box.delete();
    }
}

/**
 * The triangles of `faces`, faces of `shape`, cut out of `mesh`, the mesh meshSolid made of `shape` (which numbers
 * faces in the order of `shape.faces`), with their outlines from its edges. Faces that are not found there, or whose
 * triangles do not fit them (a fastener's modelled thread meshes otherwise), are left in `missing`.
 */
export function cutOutFaces(mesh: MeshData, shape: Shape3D, faces: Face[]): { mesh: MeshData | null; missing: Face[] } {
    const ordinals = new Map<number, number>();
    const all = shape.faces;
    const byHash = new Map<number, Face[]>();
    for (const face of all) {
        if (!ordinals.has(face.hashCode)) {
            ordinals.set(face.hashCode, ordinals.size);
        }
        const list = byHash.get(face.hashCode);
        if (list) {
            list.push(face);
        } else {
            byHash.set(face.hashCode, [face]);
        }
    }
    const found = new Map<number, Face>();
    const missing: Face[] = [];
    for (const face of faces) {
        const ordinal = ordinals.get(face.hashCode);
        if (ordinal !== undefined && byHash.get(face.hashCode)!.some((f) => f.isSame(face))) {
            found.set(ordinal, face);
        } else {
            missing.push(face);
        }
    }
    all.forEach((f) => f.delete());
    // Triangles by face.
    const triangles = new Map<number, number[]>();
    for (let t = 0; t < mesh.triFace.length; t++) {
        const ordinal = mesh.triFace[t];
        if (found.has(ordinal)) {
            const list = triangles.get(ordinal);
            if (list) {
                list.push(t);
            } else {
                triangles.set(ordinal, [t]);
            }
        }
    }
    const { positions: P, normals: N, indices: I } = mesh;
    // A face whose triangles are not within its bounds was numbered otherwise in the mesh: it is meshed on its own.
    const fits = (ordinal: number, face: Face): boolean => {
        const list = triangles.get(ordinal);
        if (!list?.length) {
            return false;
        }
        const [lo, hi] = quickBounds(face);
        const slack = 1e-3 + 0.01 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        for (const t of list) {
            for (let k = 0; k < 3; k++) {
                const v = I[t * 3 + k] * 3;
                for (let c = 0; c < 3; c++) {
                    if (P[v + c] < lo[c] - slack || P[v + c] > hi[c] + slack) {
                        return false;
                    }
                }
            }
        }
        return true;
    };
    for (const [ordinal, face] of [...found]) {
        if (!fits(ordinal, face)) {
            found.delete(ordinal);
            missing.push(face);
        }
    }
    if (found.size === 0) {
        return { mesh: null, missing };
    }
    // The part's edge segments, to keep of each face's outline only its real edges (not the seam of a cylinder).
    const point = (a: Float32Array, i: number): string => `${a[i]},${a[i + 1]},${a[i + 2]}`;
    const segment = (p: string, q: string): string => (p < q ? `${p} ${q}` : `${q} ${p}`);
    const edgeSegments = new Set<string>();
    for (let i = 0; i < mesh.edges.length; i += 6) {
        edgeSegments.add(segment(point(mesh.edges, i), point(mesh.edges, i + 3)));
    }
    let triangleCount = 0;
    for (const ordinal of found.keys()) {
        triangleCount += triangles.get(ordinal)!.length;
    }
    // Vertices are shared only within a face, so a face's vertices are copied once each, in order of use.
    const remap = new Int32Array(P.length / 3).fill(-1);
    const positions: number[] = [];
    const normals: number[] = [];
    const indices = new Uint32Array(triangleCount * 3);
    const triFace = new Uint32Array(triangleCount);
    const edges: number[] = [];
    const segEdge: number[] = [];
    let next = 0;
    let at = 0;
    let face = 0;
    for (const ordinal of found.keys()) {
        // The face's outline: the triangle sides only one of its triangles has (keyed a * count + b, a < b).
        const sides = new Map<number, number>();
        const count = P.length / 3;
        for (const t of triangles.get(ordinal)!) {
            for (let k = 0; k < 3; k++) {
                const v = I[t * 3 + k];
                if (remap[v] < 0) {
                    remap[v] = next++;
                    positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
                    normals.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
                }
                indices[at * 3 + k] = remap[v];
                const w = I[t * 3 + ((k + 1) % 3)];
                const key = v < w ? v * count + w : w * count + v;
                sides.set(key, (sides.get(key) ?? 0) + 1);
            }
            triFace[at++] = face;
        }
        const outline: [number, number][] = [];
        for (const [key, uses] of sides) {
            if (uses === 1) {
                outline.push([Math.floor(key / count), key % count]);
            }
        }
        const real = outline.filter(([a, b]) => edgeSegments.has(segment(point(P, a * 3), point(P, b * 3))));
        for (const [a, b] of real.length ? real : outline) {
            edges.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
            segEdge.push(face);
        }
        face++;
    }
    found.forEach((f) => f.delete());
    return {
        mesh: {
            positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices, triFace,
            edges: Float32Array.from(edges), segEdge: Uint32Array.from(segEdge),
        },
        missing,
    };
}

/**
 * Watches a preview build from step `from` to step `to`, keeping what each step does; `mesh` then gives it as one
 * mesh (null when the steps change nothing). `finish` must follow the build, whether it failed or not.
 */
export class ChangeWatch implements StepWatch {
    readonly from: number;
    private readonly to: number;
    private readonly steps: Set<number> | null;
    /** What the add and cut steps add or remove. */
    private volumes: Shape3D[] = [];
    /** The faces the other steps make. */
    private faces: Face[] = [];
    private ghosts: ThreadGhost[] = [];
    private was: Shape3D | null = null;
    private ghostsBefore = 0;
    private tapped: Tapped[] = [];
    /** Milliseconds spent on the highlight (booleans, face checks, its mesh), beyond the build itself. */
    ms = 0;

    constructor(range: ChangeRange) {
        this.from = range.from;
        this.to = range.to;
        this.steps = range.steps ? new Set(range.steps) : null;
    }

    private watching(index: number): boolean {
        return this.steps ? this.steps.has(index) : index >= this.from && index <= this.to;
    }

    enter(index: number, shape: Shape3D | null, state: { features: { op: string }[]; ghosts: unknown[] }): void {
        if (!this.watching(index)) {
            return;
        }
        this.was = shape ? shape.clone() : null;
        this.ghostsBefore = state.ghosts.length;
        this.tapped = [];
        // A combine step builds the other part, whose own steps must not count.
        if (state.features[index]?.op !== 'combine') {
            toolTap.on = (body, tool, mode) => {
                this.tapped.push({ body: body ? body.clone() : null, tool: tool.clone(), mode });
            };
        }
    }

    leave(index: number, shape: Shape3D | null, state: { ghosts: unknown[] }): void {
        if (!this.watching(index)) {
            return;
        }
        toolTap.on = null;
        const started = performance.now();
        try {
            this.ghosts.push(...(state.ghosts.slice(this.ghostsBefore) as ThreadGhost[]));
            if (this.tapped.length) {
                for (const tapped of this.tapped) {
                    const made = toolVolume(tapped);
                    if (made) {
                        this.volumes.push(made);
                    }
                }
            } else if (shape) {
                this.faces.push(...madeFaces(this.was, shape));
            }
        } catch {
            // Nothing to highlight for this step; the preview itself is not affected.
        } finally {
            for (const tapped of this.tapped) {
                tapped.body?.delete();
                tapped.tool.delete();
            }
            this.tapped = [];
            this.was?.delete();
            this.was = null;
            this.ms += performance.now() - started;
        }
    }

    finish(): void {
        toolTap.on = null;
    }

    /** Drops what was kept (the build failed). */
    discard(): void {
        [...this.volumes, ...this.faces].forEach((s) => s.delete());
        this.volumes = [];
        this.faces = [];
        this.ghosts = [];
    }

    /**
     * One mesh of everything the watched steps did, or null when they did nothing. `part` and `meshed`: the part as
     * built and its mesh at `quality`, made just before; the faces it still has are taken from that mesh rather than
     * meshed again. A cosmetic thread shows its marks as lines.
     */
    mesh(part: Shape3D | null, meshed: MeshData, quality: MeshQuality = 'normal'): MeshData | null {
        const started = performance.now();
        try {
            const meshes: MeshData[] = [];
            let rest = this.faces;
            if (part && rest.length) {
                const cut = cutOutFaces(meshed, part, rest);
                if (cut.mesh) {
                    meshes.push(cut.mesh);
                }
                rest = cut.missing;
            }
            const shapes = [...this.volumes, ...rest];
            if (shapes.length) {
                const whole = makeCompound(shapes.map((p) => p.clone())) as unknown as Shape3D;
                try {
                    meshes.push(meshWithOpenCascade(whole, quality, part ? meshTolerance(part, quality) : undefined));
                } finally {
                    whole.delete();
                }
            }
            rest.forEach((f) => f.delete());
            const angular = toleranceFor(0, quality).angularTolerance;
            meshes.push(...this.ghosts.filter((g) => !isCosmetic(g)).map((g) => ghostMesh(g, angular)));
            const marks = cosmeticMarks(part, this.ghosts);
            if (marks) {
                meshes.push({
                    positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), triFace: new Uint32Array(0),
                    edges: marks.lines, segEdge: new Uint32Array(marks.lines.length / 6),
                });
            }
            return meshes.length === 0 ? null : meshes.length === 1 ? meshes[0] : mergeMeshes(meshes);
        } finally {
            this.volumes.forEach((v) => v.delete());
            this.volumes = [];
            this.faces = [];
            this.ghosts = [];
            this.ms += performance.now() - started;
        }
    }
}
