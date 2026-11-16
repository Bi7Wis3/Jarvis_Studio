// Meshing only the faces an edit changed.
//
// A step leaves the faces it does not touch as they were (the same TShape), and those still carry the triangles the
// last mesh gave them: they are kept, and OpenCascade meshes only the new faces, taking the points along an edge from
// the kept face on its other side, so both meet without a crack. The clean-up after a boolean (replicad's
// SimplifyResult) also rebuilds faces it leaves as they were, the walls of a modelled thread among them (seconds to mesh):
// a new face on the same surface within the very same edges is meshed as its twin, the face it was rebuilt from.
//
// replicad's mesh extractor meshes every face again, so here BRepMesh_IncrementalMesh meshes the new faces (given with
// the kept faces beside them), and the triangles and outlines of each face are kept as the view gets them, so only the
// new faces are read out. OpenCascade keeps a face's triangles only at the very tolerance they were made at, so a part
// keeps the tolerance of its kept faces while the one its size asks for stays within 10% of it.
//
// A solid with a face whose triangles cannot be vouched for (made at another tolerance or by other code, or missing an
// edge's points) is cleaned and meshed afresh as a whole, as is one with fewer kept faces than new ones (the extractor
// is quicker then): cleaning one face (BRepTools.Clean) also strips the points of its edges from the neighbouring faces,
// which would then no longer meet it.

import { cast, getOC, type Shape3D } from 'replicad';

interface Handle {
    delete(): void;
    isAliasOf(other: unknown): boolean;
}

interface OcShape extends Handle {
    IsSame(other: OcShape): boolean;
    IsEqual(other: OcShape): boolean;
    Orientation(): unknown;
    Location(): Handle & { IsEqual(other: unknown): boolean };
    Oriented(orientation: unknown): OcShape;
}

interface Triangulation extends Handle {
    NbNodes(): number;
}

export interface Tolerance {
    tolerance: number;
    angularTolerance: number;
}

/** The triangles of one face as the view gets them: its own vertices (smooth within the face) and indices into them. */
interface FaceTriangles {
    vertices: Float32Array;
    normals: Float32Array;
    triangles: Uint32Array;
}

/** A face as it was meshed, with the triangles it was given. */
interface Kept {
    face: OcShape;
    hash: number;
    triangulation: Triangulation;
    /** Hash codes of its edges, sorted: how a rebuilt twin is found. */
    edges: string;
    edgeHashes: number[];
    /** The mesh its triangles were made in. */
    made: number;
    tolerance: Tolerance;
    pass: number;
    mesh: FaceTriangles;
    /** Hash codes of its seam edges (where its surface meets itself), which outlines leave out. */
    seams: number[];
    /** Its edges in order, with their outlines (point pairs) as replicad's meshEdges gives them. */
    edgeLines: [number, Float32Array][];
}

/** A mesh as replicad's mesh() and meshEdges() give it (face groups in index units, by face hash code). */
export interface FacesMesh {
    mesh: { vertices: ArrayLike<number>; normals: ArrayLike<number>; triangles: ArrayLike<number>; faceGroups: { start: number; count: number; faceId: number }[] };
    lines: { lines: ArrayLike<number>; edgeGroups: { start: number; count: number; edgeId: number }[] };
    /** Hash codes of the seam edges. */
    seams: Set<number>;
}

/** How the last solid was meshed, for tests and timing. */
export interface MeshPlan {
    faces: number;
    /** Faces that kept their triangles. */
    kept: number;
    /** New faces meshed as the face they were rebuilt from. */
    twins: number;
    /** Faces meshed now. */
    meshed: number;
    /** The whole solid was meshed afresh. */
    fresh: boolean;
    /** Milliseconds spent: finding what to keep, OpenCascade's meshing, reading out new faces, edge lines, remembering. */
    ms?: { plan: number; mesh: number; read: number; lines: number; remember: number };
}

/** Faces of the solids meshed in the last this many meshes can be kept. */
const PASSES = 12;
/** A part keeps the tolerance of its kept faces while the one its size asks for is within this ratio of it. */
const RATIO = 1.1;

const byFace = new Map<number, Kept[]>();
const byEdges = new Map<string, Kept[]>();
let pass = 0;
let apart = 0;
export let lastPlan: MeshPlan | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oc = (): any => getOC();

const hashOf = (shape: OcShape): number => oc().ReplicadShapeHasher.HashCode(shape, 2147483647);

/** The faces or edges of a shape, each once (as replicad's iterTopo, without its quadratic search). */
function explore(shape: OcShape, kind: 'face' | 'edge'): OcShape[] {
    const o = oc();
    const type = kind === 'face' ? o.TopAbs_ShapeEnum.TopAbs_FACE : o.TopAbs_ShapeEnum.TopAbs_EDGE;
    const explorer = new o.TopExp_Explorer(shape, type, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const out: OcShape[] = [];
    const seen = new Map<number, OcShape[]>();
    try {
        for (; explorer.More(); explorer.Next()) {
            const item = explorer.Current() as OcShape;
            const hash = hashOf(item);
            const same = seen.get(hash);
            if (same?.some((s) => s.IsSame(item))) {
                item.delete();
                continue;
            }
            const typed = (kind === 'face' ? o.TopoDS.Face(item) : o.TopoDS.Edge(item)) as OcShape;
            item.delete();
            if (same) {
                same.push(typed);
            } else {
                seen.set(hash, [typed]);
            }
            out.push(typed);
        }
    } finally {
        explorer.delete();
    }
    return out;
}

function triangulationOf(face: OcShape): Triangulation | null {
    const o = oc();
    const location = new o.TopLoc_Location();
    try {
        return (o.BRep_Tool.Triangulation(face, location, 0) as Triangulation | null) ?? null;
    } finally {
        location.delete();
    }
}

/** Every edge of the face has its points on the face's triangulation. */
const whole = (face: OcShape): boolean => oc().BRepTools.Triangulation(face, Number.MAX_VALUE, false) as boolean;

const sameTolerance = (a: Tolerance, b: Tolerance): boolean => a.tolerance === b.tolerance && a.angularTolerance === b.angularTolerance;

const near = (kept: Tolerance, asked: Tolerance): boolean => kept.angularTolerance === asked.angularTolerance
    && kept.tolerance <= asked.tolerance * RATIO && kept.tolerance * RATIO >= asked.tolerance;

const edgeHashes = (edges: OcShape[]): number[] => edges.map(hashOf).sort((a, b) => a - b);

/**
 * The diagonal of a box about the solid from its faces' geometry, within a few tenths of a percent of the tightest box
 * (which takes a large part most of a second); enough to choose a mesh tolerance by. Triangles are not used, so it is
 * the same whether the solid was meshed or not.
 */
export function quickDiagonal(shape: Shape3D): number {
    const o = oc();
    const box = new o.Bnd_Box();
    try {
        o.BRepBndLib.Add(shape.wrapped, box, false);
        if (box.IsVoid()) {
            return 0;
        }
        const [lo, hi] = [box.CornerMin(), box.CornerMax()];
        const diagonal = Math.hypot(hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z());
        lo.delete();
        hi.delete();
        return diagonal;
    } finally {
        box.delete();
    }
}

/** Hash codes of a face's seam edges (`edges`: its edges). */
const seamsOf = (face: OcShape, edges: OcShape[]): number[] =>
    edges.filter((edge) => oc().BRep_Tool.IsClosed(edge, face)).map(hashOf);

function sameLocation(a: OcShape, b: OcShape): boolean {
    const [la, lb] = [a.Location(), b.Location()];
    try {
        return la.IsEqual(lb);
    } finally {
        la.delete();
        lb.delete();
    }
}

function pointsOn(edge: OcShape, triangulation: Triangulation): number {
    const o = oc();
    const location = new o.TopLoc_Location();
    try {
        const polygon = o.BRep_Tool.PolygonOnTriangulation(edge, triangulation, location) as { NbNodes(): number; delete(): void } | null;
        if (!polygon) {
            return -1;
        }
        const n = polygon.NbNodes();
        polygon.delete();
        return n;
    } finally {
        location.delete();
    }
}

/** A face's triangles read out as replicad's extractor gives them (the same points, normals and triangles). */
function readFace(face: OcShape): FaceTriangles {
    const o = oc();
    const location = new o.TopLoc_Location();
    const triangulation = o.BRep_Tool.Triangulation(face, location, 0);
    if (!triangulation) {
        location.delete();
        return { vertices: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0) };
    }
    const moved = !location.IsIdentity();
    const trsf = location.Transformation();
    if (!triangulation.HasNormals()) {
        o.BRepLib_ToolTriangulatedShape.ComputeNormals(face, triangulation);
    }
    const forward = face.Orientation() === o.TopAbs_Orientation.TopAbs_FORWARD;
    const n = triangulation.NbNodes();
    const vertices = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const sign = forward ? 1 : -1;
    for (let i = 1; i <= n; i++) {
        let p = triangulation.Node(i);
        let d = triangulation.Normal(i);
        if (moved) {
            const [q, e] = [p.Transformed(trsf), d.Transformed(trsf)];
            p.delete();
            d.delete();
            [p, d] = [q, e];
        }
        const k = (i - 1) * 3;
        vertices[k] = p.X();
        vertices[k + 1] = p.Y();
        vertices[k + 2] = p.Z();
        normals[k] = d.X() * sign;
        normals[k + 1] = d.Y() * sign;
        normals[k + 2] = d.Z() * sign;
        p.delete();
        d.delete();
    }
    const m = triangulation.NbTriangles();
    const triangles = new Uint32Array(m * 3);
    for (let t = 1; t <= m; t++) {
        const triangle = triangulation.Triangle(t);
        const [a, b, c] = [triangle.Value(1) - 1, triangle.Value(2) - 1, triangle.Value(3) - 1];
        triangle.delete();
        // A reversed face turns its triangles round, as its normals.
        triangles.set(forward ? [a, b, c] : [b, a, c], (t - 1) * 3);
    }
    triangulation.delete();
    trsf.delete();
    location.delete();
    return { vertices, normals, triangles };
}

/** The triangles of each face in replicad's mesh of a solid, by face hash code. */
function splitFaces(mesh: FacesMesh['mesh']): Map<number, FaceTriangles> {
    const out = new Map<number, FaceTriangles>();
    for (const group of mesh.faceGroups) {
        let [lo, hi] = [Infinity, -1];
        for (let i = group.start; i < group.start + group.count; i++) {
            lo = Math.min(lo, mesh.triangles[i]);
            hi = Math.max(hi, mesh.triangles[i]);
        }
        if (hi < 0 || out.has(group.faceId)) {
            continue;
        }
        const triangles = new Uint32Array(group.count);
        for (let i = 0; i < group.count; i++) {
            triangles[i] = mesh.triangles[group.start + i] - lo;
        }
        const slice = (a: ArrayLike<number>): Float32Array => Float32Array.from({ length: (hi - lo + 1) * 3 }, (_, i) => a[lo * 3 + i]);
        out.set(group.faceId, { vertices: slice(mesh.vertices), normals: slice(mesh.normals), triangles });
    }
    return out;
}

/** `face`, new, is `kept` rebuilt: the same surface, place and turn, with the same edges in the same order. */
function isTwin(face: OcShape, edges: OcShape[], kept: Kept): boolean {
    const o = oc();
    if (face.Orientation() !== kept.face.Orientation() || !sameLocation(face, kept.face)) {
        return false;
    }
    const [a, b] = [o.BRep_Tool.Surface(face) as Handle, o.BRep_Tool.Surface(kept.face) as Handle];
    const sameSurface = a.isAliasOf(b);
    a.delete();
    b.delete();
    if (!sameSurface) {
        return false;
    }
    const theirs = explore(kept.face, 'edge');
    const now = triangulationOf(kept.face);
    try {
        return theirs.length === edges.length && theirs.every((e, k) => e.IsEqual(edges[k]))
            && !!now && kept.triangulation.isAliasOf(now) && whole(kept.face);
    } finally {
        theirs.forEach((e) => e.delete());
        now?.delete();
    }
}

/** Which faces of a solid keep their triangles, which are meshed as their twin, and the tolerance to mesh at. */
interface Plan {
    faces: OcShape[];
    /** Per face: what it keeps (its own record, or its twin's), null when it is meshed now. */
    uses: (Kept | null)[];
    twins: Set<number>;
    tolerance: Tolerance;
    /** A face's triangles cannot be vouched for: the whole solid is meshed afresh. */
    stale: boolean;
    /** Hash codes of the edges of the faces meshed now, and per such face its edges in order. */
    meshEdges: Set<number>;
    order: Map<number, number[]>;
}

function plan(shape: Shape3D, asked: Tolerance): Plan {
    const faces = explore(shape.wrapped as unknown as OcShape, 'face');
    const uses: (Kept | null)[] = faces.map(() => null);
    const out: Plan = { faces, uses, twins: new Set(), tolerance: asked, stale: false, meshEdges: new Set(), order: new Map() };
    const used = new Set<Kept>();
    const triangulations = faces.map(triangulationOf);
    const edgesOf = new Map<number, OcShape[]>();
    try {
        // Faces with triangles must be ones meshed here before, as they were, all at one tolerance near the one asked.
        for (const [i, face] of faces.entries()) {
            const triangulation = triangulations[i];
            if (!triangulation) {
                continue;
            }
            const kept = byFace.get(hashOf(face))?.find((k) => k.face.IsSame(face));
            if (!kept || !near(kept.tolerance, asked) || (used.size && !sameTolerance(kept.tolerance, out.tolerance))
                || !kept.triangulation.isAliasOf(triangulation) || !whole(face)) {
                out.stale = true;
                return out;
            }
            out.tolerance = kept.tolerance;
            uses[i] = kept;
            used.add(kept);
        }
        // A new face with a twin: a face meshed before on the same surface, at the same place, within the same edges.
        faces.forEach((face, i) => {
            if (triangulations[i]) {
                return;
            }
            const edges = explore(face, 'edge');
            edgesOf.set(i, edges);
            const twin = (byEdges.get(edgeHashes(edges).join(' ')) ?? []).find((k) => !used.has(k)
                && (used.size ? sameTolerance(k.tolerance, out.tolerance) : near(k.tolerance, asked)) && isTwin(face, edges, k));
            if (twin) {
                out.tolerance = twin.tolerance;
                uses[i] = twin;
                used.add(twin);
                out.twins.add(i);
            }
        });
        // Two faces kept from different meshes (or a twin, meshed beside other neighbours perhaps) must have the same points
        // along the edge between them. A twin that does not is meshed now, from its neighbours' points; kept faces that
        // do not mean the solid is meshed afresh.
        const across = new Map<number, number[]>();
        uses.forEach((use, i) => {
            for (const hash of use?.edgeHashes ?? []) {
                across.set(hash, [...(across.get(hash) ?? []), i]);
            }
        });
        const byHash = new Map<number, Map<number, OcShape>>();
        const edgeOf = (i: number, hash: number): OcShape | undefined => {
            let edges = byHash.get(i);
            if (!edges) {
                const list = edgesOf.get(i) ?? explore(faces[i], 'edge');
                edgesOf.set(i, list);
                edges = new Map(list.map((e): [number, OcShape] => [hashOf(e), e]));
                byHash.set(i, edges);
            }
            return edges.get(hash);
        };
        for (const [hash, pair] of across) {
            const [i, j] = pair;
            const [a, b] = [uses[i], uses[j]];
            if (pair.length !== 2 || !a || !b || (a.made === b.made && !out.twins.has(i) && !out.twins.has(j))) {
                continue;
            }
            const edge = edgeOf(i, hash);
            if (!edge || pointsOn(edge, a.triangulation) === pointsOn(edge, b.triangulation)) {
                continue;
            }
            const twin = out.twins.has(j) ? j : out.twins.has(i) ? i : -1;
            if (twin < 0) {
                out.stale = true;
                return out;
            }
            out.twins.delete(twin);
            uses[twin] = null;
        }
        uses.forEach((use, i) => {
            if (!use) {
                const order = (edgesOf.get(i) ?? []).map(hashOf);
                order.forEach((h) => out.meshEdges.add(h));
                out.order.set(i, order);
            }
        });
        return out;
    } finally {
        triangulations.forEach((t) => t?.delete());
        for (const edges of edgesOf.values()) {
            edges.forEach((e) => e.delete());
        }
    }
}

/**
 * Runs `make` with every mesh made apart from the faces' own triangles (on a copy of the solid): for an interim coarse
 * mesh, which must not replace the triangles the next mesh of the view keeps.
 */
export function meshApart<T>(make: () => T): T {
    apart++;
    try {
        return make();
    } finally {
        apart--;
    }
}

/** The mesh of `shape` at about `asked`, meshing only what it has to: see the top of this file. */
export function meshFaces(shape: Shape3D, asked: Tolerance): FacesMesh {
    const o = oc();
    if (apart) {
        const copier = new o.BRepBuilderAPI_Transform(shape.wrapped, new o.gp_Trsf(), true, false);
        const copy = cast(copier.Shape()) as Shape3D;
        copier.delete();
        try {
            return asOriginal(shape, copy, { mesh: copy.mesh(asked), lines: copy.meshEdges(asked), seams: new Set() });
        } finally {
            copy.delete();
        }
    }
    pass++;
    let clock = performance.now();
    const lap = (): number => {
        const now = performance.now();
        const ms = now - clock;
        clock = now;
        return Math.round(ms);
    };
    const p = plan(shape, asked);
    const planned = lap();
    const kept = p.uses.filter(Boolean).length - p.twins.size;
    if (p.stale || 2 * (kept + p.twins.size) < p.faces.length) {
        const info: MeshPlan = { faces: p.faces.length, kept: 0, twins: 0, meshed: p.faces.length, fresh: true };
        lastPlan = info;
        o.BRepTools.Clean(shape.wrapped, true);
        const mesh = shape.mesh(asked);
        const meshed = lap();
        const lines = shape.meshEdges(asked);
        const drawn = lap();
        const split = splitFaces(mesh);
        const seams = new Set<number>();
        remember(p.faces, p.faces.map(() => null), asked, (face) => split.get(hashOf(face)) ?? readFace(face), splitEdges(lines), seams);
        info.ms = { plan: planned, mesh: meshed, read: 0, lines: drawn, remember: lap() };
        return { mesh, lines, seams };
    }
    const info: MeshPlan = { faces: p.faces.length, kept, twins: p.twins.size, meshed: p.faces.length - kept - p.twins.size, fresh: false };
    lastPlan = info;
    // Each twin turned as the face it stands for, so that the new faces next to it are meshed along its points.
    const placed: OcShape[] = [];
    const compounds: Shape3D[] = [];
    const compound = (pick: (i: number) => boolean): Shape3D => {
        const builder = new o.TopoDS_Builder();
        const made = new o.TopoDS_Compound();
        builder.MakeCompound(made);
        p.faces.forEach((face, i) => {
            if (!pick(i)) {
                return;
            }
            if (p.twins.has(i)) {
                const turned = p.uses[i]!.face.Oriented(face.Orientation());
                placed.push(turned);
                builder.Add(made, turned);
            } else {
                builder.Add(made, face);
            }
        });
        builder.delete();
        const out = cast(made) as Shape3D;
        compounds.push(out);
        return out;
    };
    try {
        // Only the new faces go to OpenCascade, with the kept ones beside them, whose points along the shared edges they take.
        const fresh = p.faces.map((_, i) => !p.uses[i]);
        if (fresh.some(Boolean)) {
            const beside = p.uses.map((use) => !!use && use.edgeHashes.some((h) => p.meshEdges.has(h)));
            const part = compound((i) => fresh[i] || beside[i]);
            new o.BRepMesh_IncrementalMesh(part.wrapped, p.tolerance.tolerance, false, p.tolerance.angularTolerance, false).delete();
        }
        const meshed = lap();
        const made = new Map<number, FaceTriangles>();
        const pieces = p.faces.map((face, i) => {
            const use = p.uses[i];
            // A kept face turned the other way in this solid has the same triangles, read out the other way round.
            if (use && use.face.Orientation() === face.Orientation()) {
                return use.mesh;
            }
            if (use) {
                return readFace(face);
            }
            const read = readFace(face);
            made.set(i, read);
            return read;
        });
        const mesh = join(pieces, p.faces.map(hashOf));
        const read = lap();
        // Outlines: the kept faces' edges have theirs; those of the new faces are read out from them alone.
        const outlines = fresh.some(Boolean) ? splitEdges(compound((i) => fresh[i]).meshEdges(p.tolerance)) : new Map<number, Float32Array>();
        const lines = joinLines(p.faces.map((_, i) => p.uses[i]?.edgeLines
            ?? (p.order.get(i) ?? []).flatMap((h): [number, Float32Array][] => (outlines.has(h) ? [[h, outlines.get(h)!]] : []))));
        const drawn = lap();
        const seams = new Set<number>();
        remember(p.faces, p.uses, p.tolerance, (face, i) => made.get(i) ?? readFace(face), outlines, seams);
        info.ms = { plan: planned, mesh: meshed, read, lines: drawn, remember: lap() };
        return { mesh, lines, seams };
    } finally {
        placed.forEach((f) => f.delete());
        compounds.forEach((c) => c.delete());
    }
}

/** A mesh of `copy`, a copy of `shape`, told by the faces and edges of `shape` (a copy keeps their order). */
function asOriginal(shape: Shape3D, copy: Shape3D, meshed: FacesMesh): FacesMesh {
    const ids = (kind: 'face' | 'edge'): Map<number, number> => {
        const [mine, theirs] = [explore(shape.wrapped as unknown as OcShape, kind), explore(copy.wrapped as unknown as OcShape, kind)];
        const map = new Map(theirs.map((s, i) => [hashOf(s), mine[i] ? hashOf(mine[i]) : hashOf(s)]));
        [...mine, ...theirs].forEach((s) => s.delete());
        return map;
    };
    const [faces, edges] = [ids('face'), ids('edge')];
    const seams = new Set<number>();
    for (const face of explore(shape.wrapped as unknown as OcShape, 'face')) {
        const own = explore(face, 'edge');
        seamsOf(face, own).forEach((h) => seams.add(h));
        own.forEach((e) => e.delete());
        face.delete();
    }
    return {
        mesh: { ...meshed.mesh, faceGroups: meshed.mesh.faceGroups.map((g) => ({ ...g, faceId: faces.get(g.faceId) ?? g.faceId })) },
        lines: { ...meshed.lines, edgeGroups: meshed.lines.edgeGroups.map((g) => ({ ...g, edgeId: edges.get(g.edgeId) ?? g.edgeId })) },
        seams,
    };
}

/** The outline points of each edge in replicad's edge lines, by edge hash code. */
function splitEdges(lines: FacesMesh['lines']): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>();
    for (const group of lines.edgeGroups) {
        if (!out.has(group.edgeId)) {
            out.set(group.edgeId, Float32Array.from({ length: group.count * 3 }, (_, i) => lines.lines[group.start * 3 + i]));
        }
    }
    return out;
}

/** The edge lines of the faces' edges, each edge once, in order, grouped by edge as replicad groups them. */
function joinLines(faces: [number, Float32Array][][]): FacesMesh['lines'] {
    const seen = new Set<number>();
    const parts: [number, Float32Array][] = [];
    for (const [hash, points] of faces.flat()) {
        if (!seen.has(hash)) {
            seen.add(hash);
            parts.push([hash, points]);
        }
    }
    const lines = new Float32Array(parts.reduce((n, [, points]) => n + points.length, 0));
    const edgeGroups: FacesMesh['lines']['edgeGroups'] = [];
    let at = 0;
    for (const [edgeId, points] of parts) {
        lines.set(points, at);
        edgeGroups.push({ start: at / 3, count: points.length / 3, edgeId });
        at += points.length;
    }
    return { lines, edgeGroups };
}

/** One mesh of the faces' triangles, in order, grouped by face as replicad groups them. */
function join(pieces: FaceTriangles[], ids: number[]): FacesMesh['mesh'] {
    const vertexCount = pieces.reduce((n, piece) => n + piece.vertices.length, 0);
    const indexCount = pieces.reduce((n, piece) => n + piece.triangles.length, 0);
    const vertices = new Float32Array(vertexCount);
    const normals = new Float32Array(vertexCount);
    const triangles = new Uint32Array(indexCount);
    const faceGroups: FacesMesh['mesh']['faceGroups'] = [];
    let v = 0;
    let t = 0;
    pieces.forEach((piece, i) => {
        vertices.set(piece.vertices, v);
        normals.set(piece.normals, v);
        const base = v / 3;
        for (let k = 0; k < piece.triangles.length; k++) {
            triangles[t + k] = piece.triangles[k] + base;
        }
        if (piece.triangles.length) {
            faceGroups.push({ start: t, count: piece.triangles.length, faceId: ids[i] });
        }
        v += piece.vertices.length;
        t += piece.triangles.length;
    });
    return { vertices, normals, triangles, faceGroups };
}

/** CPU milliseconds meshing a face takes, roughly (measured on a part with a modelled thread). */
function cost(face: OcShape): number {
    const o = oc();
    const surface = new o.BRepAdaptor_Surface(face, false);
    const type = surface.GetType();
    surface.delete();
    const kinds = o.GeomAbs_SurfaceType;
    if (type === kinds.GeomAbs_Plane) {
        return 1;
    }
    const edges = explore(face, 'edge');
    const n = edges.length;
    edges.forEach((e) => e.delete());
    // A cylinder between many edges (the wall of a thread, between its grooves) takes OpenCascade seconds.
    return 6 + 0.15 * n * n;
}

/**
 * Roughly how long (CPU ms) meshing `shape` at `asked` takes now, with the faces it can keep, and with none kept (only
 * worked out when `now` comes to `least` or more).
 */
export function meshWork(shape: Shape3D, asked: Tolerance, least = 0): { now: number; whole: number } {
    const p = plan(shape, asked);
    try {
        const kept = p.uses.filter(Boolean).length;
        const all = p.stale || 2 * kept < p.faces.length;
        const costs = p.faces.map((face, i) => (all || !p.uses[i] ? cost(face) : null));
        const now = costs.reduce<number>((sum, ms) => sum + (ms ?? 0), 0);
        const whole = now < least ? now : costs.reduce<number>((sum, ms, i) => sum + (ms ?? cost(p.faces[i])), 0);
        return { now, whole };
    } finally {
        p.faces.forEach((f) => f.delete());
    }
}

/** After meshing: the faces and the triangles they have now, for the next mesh to keep. */
function remember(faces: OcShape[], uses: (Kept | null)[], tolerance: Tolerance, mesh: (face: OcShape, i: number) => FaceTriangles,
    outlines: Map<number, Float32Array>, seams: Set<number>): void {
    faces.forEach((face, i) => {
        const use = uses[i];
        if (use) {
            // Kept, or a twin: the face rebuilt has no triangles of its own, and the next mesh finds the twin again.
            use.pass = pass;
            use.seams.forEach((h) => seams.add(h));
            face.delete();
            return;
        }
        const edges = explore(face, 'edge');
        const own = seamsOf(face, edges);
        own.forEach((h) => seams.add(h));
        const triangulation = triangulationOf(face);
        if (!triangulation) {
            edges.forEach((e) => e.delete());
            face.delete();
            return;
        }
        const hashes = edgeHashes(edges);
        const edgeLines = edges.map(hashOf).flatMap((h): [number, Float32Array][] => (outlines.has(h) ? [[h, outlines.get(h)!]] : []));
        const record: Kept = {
            face, hash: hashOf(face), triangulation, edges: hashes.join(' '), edgeHashes: hashes, made: pass, tolerance, pass,
            mesh: mesh(face, i), seams: own, edgeLines,
        };
        edges.forEach((e) => e.delete());
        (byFace.get(record.hash) ?? []).filter((k) => k.face.IsSame(face)).forEach(drop);
        add(byFace, record.hash, record);
        add(byEdges, record.edges, record);
    });
    // Let go of faces no recent mesh had.
    [...byFace.values()].flat().filter((k) => k.pass < pass - PASSES).forEach(drop);
}

function add<K>(map: Map<K, Kept[]>, key: K, record: Kept): void {
    const list = map.get(key);
    if (list) {
        list.push(record);
    } else {
        map.set(key, [record]);
    }
}

function drop(k: Kept): void {
    for (const [map, key] of [[byFace, k.hash], [byEdges, k.edges]] as [Map<unknown, Kept[]>, unknown][]) {
        const rest = (map.get(key) ?? []).filter((x) => x !== k);
        if (rest.length) {
            map.set(key, rest);
        } else {
            map.delete(key);
        }
    }
    k.face.delete();
    k.triangulation.delete();
}

/** Forgets every face meshed so far (for tests). */
export function forgetMeshedFaces(): void {
    [...byFace.values()].flat().forEach(drop);
}
