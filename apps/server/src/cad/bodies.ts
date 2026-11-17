// Solid bodies of a part (SolidWorks: the Solid Bodies folder). The kernel's result may be several solids; each is a
// body named after the step that changed it last (Feature[1], Feature[2] when one step changed several), and keeps
// its key while later steps change it, so that hiding it or making it see-through lasts. Also which mesh faces and
// edges belong to which body, and the marks a cosmetic (hidden) thread leaves in the view.

import { measureShapeVolumeProperties, type Shape3D, type Solid } from 'replicad';
import type { Vec3 } from '@jarvis/core';
import type { BodyInfo } from '@jarvis/core/visibility';
import { MESH_TOLERANCES, type MeshQuality } from './meshQuality.js';
import { MINOR_DEPTH, type ThreadGhost } from './thread.js';

export type BodyRecord = BodyInfo;

type Box = [Vec3, Vec3];

function boxOf(shape: Shape3D): Box {
    const box = shape.boundingBox;
    const [min, max] = box.bounds;
    box.delete();
    return [min as Vec3, max as Vec3];
}

function overlap(a: Box, b: Box): number {
    let volume = 1;
    for (let k = 0; k < 3; k++) {
        const d = Math.min(a[1][k], b[1][k]) - Math.max(a[0][k], b[0][k]);
        if (d < 0) {
            return 0;
        }
        // Flat overlaps (two bodies touching) still count, a little.
        volume *= Math.max(d, 1e-6);
    }
    return volume;
}

function contains(box: Box, p: Vec3, margin: number): boolean {
    return [0, 1, 2].every((k) => p[k] >= box[0][k] - margin && p[k] <= box[1][k] + margin);
}

/** Volume and centre of mass, to tell a body a step left alone from one it changed. */
function signature(solid: Solid): { volume: number; centre: Vec3; size: number } {
    const props = measureShapeVolumeProperties(solid);
    const result = { volume: props.volume, centre: props.centerOfMass as Vec3 };
    props.delete();
    const [min, max] = boxOf(solid);
    return { ...result, size: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) };
}

function sameSignature(a: ReturnType<typeof signature>, b: ReturnType<typeof signature>): boolean {
    const size = Math.max(a.size, b.size, 1);
    return Math.abs(a.volume - b.volume) <= 1e-7 * Math.max(Math.abs(a.volume), 1)
        && Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1], a.centre[2] - b.centre[2]) <= 1e-7 * size;
}

/** The bodies of a part's base shape (one per solid). */
export function baseBodies(shape: Shape3D | null): BodyRecord[] {
    if (!shape) {
        return [];
    }
    const solids = shape.solids;
    const records = solids.map((_, i): BodyRecord => (solids.length > 1 ? { key: `base#${i + 1}`, by: '', n: i + 1 } : { key: 'base', by: '' }));
    solids.forEach((s) => s.delete());
    return records;
}

/** The solids of a body before a step, taken before the step runs. Free them with `release`. */
export function solidsOf(shape: Shape3D | null): Solid[] {
    return shape ? shape.solids : [];
}

export function release(solids: Solid[]): void {
    solids.forEach((s) => s.delete());
}

/**
 * The bodies after step `stepId`: `records` belong to `before` (its solids, in order). A body the step left as it was
 * keeps its record; one it changed keeps its key and is named after the step; a new one gets a key of its own.
 * `touched`: points where the step marks a body it does not change (a cosmetic thread), which names it too.
 */
export function trackBodies(records: BodyRecord[], before: Solid[], after: Shape3D | null, stepId: string, touched: Vec3[] = []): BodyRecord[] {
    try {
        return track(records, before, after, stepId, touched);
    } catch {
        // Never a reason for the build to fail: the bodies are then simply named after this step.
        const count = after ? after.solids.length : 0;
        return Array.from({ length: count }, (_, i): BodyRecord => (count > 1 ? { key: `${stepId}#${i + 1}`, by: stepId, n: i + 1 } : { key: records[0]?.key ?? stepId, by: stepId }));
    }
}

function track(records: BodyRecord[], before: Solid[], after: Shape3D | null, stepId: string, touched: Vec3[]): BodyRecord[] {
    const now = after ? after.solids : [];
    try {
        if (!now.length) {
            return [];
        }
        const nowBoxes = touched.length || now.length > 1 || before.length > 1 ? now.map(boxOf) : [];
        const marked = (j: number): boolean => touched.some((p) => contains(nowBoxes[j], p, 1e-3));
        if (before.length === 1 && now.length === 1 && records.length === 1) {
            return [before[0].isSame(now[0]) && !marked(0) ? records[0] : { key: records[0].key, by: stepId }];
        }
        const result: (BodyRecord | null)[] = now.map(() => null);
        const changed: boolean[] = now.map(() => false);
        const claimed = new Set<number>();
        // Left alone: the very same solid, or one with the same volume and centre of mass.
        now.forEach((solid, j) => {
            const i = before.findIndex((b, k) => !claimed.has(k) && records[k] && b.isSame(solid));
            if (i >= 0) {
                claimed.add(i);
                result[j] = records[i];
            }
        });
        if (result.some((r) => !r) && claimed.size < before.length) {
            const old = new Map(before.map((b, i) => [i, claimed.has(i) || !records[i] ? null : signature(b)]));
            now.forEach((solid, j) => {
                if (result[j]) {
                    return;
                }
                const mine = signature(solid);
                const i = [...old.entries()].find(([k, sig]) => sig && !claimed.has(k) && sameSignature(sig, mine))?.[0];
                if (i !== undefined) {
                    claimed.add(i);
                    result[j] = records[i];
                }
            });
        }
        // Changed: each keeps the key of the earlier body it overlaps most (a cut or a join changes a body in place).
        const free = now.map((_, j) => j).filter((j) => !result[j]);
        if (free.length) {
            const beforeBoxes = before.map((b, i) => (claimed.has(i) || !records[i] ? null : boxOf(b)));
            const pairs = free.flatMap((j) => beforeBoxes.flatMap((box, i) => (box ? [{ i, j, v: overlap(box, nowBoxes[j]) }] : [])))
                .filter((p) => p.v > 0)
                .sort((a, b) => b.v - a.v);
            for (const { i, j } of pairs) {
                if (!claimed.has(i) && !result[j]) {
                    claimed.add(i);
                    result[j] = { key: records[i].key, by: stepId };
                    changed[j] = true;
                }
            }
        }
        // New: a body the step made apart from the others.
        const keys = new Set(result.flatMap((r) => (r ? [r.key] : [])));
        const fresh = now.map((_, j) => j).filter((j) => !result[j]);
        fresh.forEach((j, k) => {
            let key = fresh.length > 1 ? `${stepId}#${k + 1}` : stepId;
            for (let n = 2; keys.has(key); n++) {
                key = `${stepId}#${k + 1}.${n}`;
            }
            keys.add(key);
            result[j] = { key, by: stepId };
            changed[j] = true;
        });
        now.forEach((_, j) => {
            if (!changed[j] && touched.length && marked(j)) {
                result[j] = { key: result[j]!.key, by: stepId };
                changed[j] = true;
            }
        });
        const named = changed.filter(Boolean).length;
        let n = 0;
        return result.map((r, j) => {
            const record = r!;
            if (!changed[j]) {
                return record;
            }
            n++;
            return named > 1 ? { key: record.key, by: stepId, n } : { key: record.key, by: stepId };
        });
    } finally {
        release(now);
    }
}

/**
 * Per face ordinal and per edge ordinal of a mesh (in the order the mesher met them, `faceIds` and `edgeIds` being
 * their hash codes): the index of the solid of `shape` it belongs to.
 */
export function bodyOrdinals(shape: Shape3D, faceIds: number[], edgeIds: number[]): { faceBody: Uint32Array; edgeBody: Uint32Array } {
    const faceBody = new Uint32Array(faceIds.length);
    const edgeBody = new Uint32Array(edgeIds.length);
    const solids = shape.solids;
    if (solids.length > 1) {
        const faceOf = new Map<number, number>();
        const edgeOf = new Map<number, number>();
        solids.forEach((solid, i) => {
            for (const face of solid.faces) {
                if (!faceOf.has(face.hashCode)) {
                    faceOf.set(face.hashCode, i);
                }
                face.delete();
            }
            for (const edge of solid.edges) {
                if (!edgeOf.has(edge.hashCode)) {
                    edgeOf.set(edge.hashCode, i);
                }
                edge.delete();
            }
        });
        faceIds.forEach((id, k) => {
            faceBody[k] = faceOf.get(id) ?? 0;
        });
        edgeIds.forEach((id, k) => {
            edgeBody[k] = edgeOf.get(id) ?? 0;
        });
    }
    release(solids);
    return { faceBody, edgeBody };
}

// ---- Cosmetic threads ---------------------------------------------------------------------------------------

/** Threads a hidden thread step shows, not built (see markCosmetic). */
const cosmetic = new WeakSet<ThreadGhost>();

export function markCosmetic(ghosts: ThreadGhost[]): void {
    ghosts.forEach((g) => cosmetic.add(g));
}

export const isCosmetic = (ghost: ThreadGhost): boolean => cosmetic.has(ghost);

/** Root depth of an external ISO thread per unit of pitch, as thread.ts cuts it. */
const ROOT_DEPTH = 0.6134;
/** How far the end circles stand off the faces they lie in, so they are not lost in them. */
const LIFT = 0.02;
const DASHES = 24;

interface ThreadMark {
    origin: Vec3;
    axis: Vec3;
    radius: number;
    low: number;
    high: number;
}

/**
 * Where a thread runs, from its ghost: a hole is marked at the thread's major diameter, a shaft at its minor diameter
 * (as a SolidWorks cosmetic thread), from its start to its end along the axis.
 */
export function threadMark(ghost: ThreadGhost): ThreadMark {
    const { spec } = ghost;
    const internal = spec.rBase > spec.rCrest;
    const radius = internal ? spec.rCrest + (MINOR_DEPTH * spec.pitch) / 2 : spec.rCrest - ROOT_DEPTH * spec.pitch;
    const length = Math.hypot(...ghost.axis);
    const axis = ghost.axis.map((v) => v / length) as Vec3;
    return { origin: ghost.origin, axis, radius, low: spec.y0 - spec.wBase / 2 - 0.01, high: spec.y0 + spec.height + spec.wBase / 2 + 0.01 };
}

function basis(axis: Vec3): [Vec3, Vec3] {
    const seed: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const k = seed[0] * axis[0] + seed[1] * axis[1] + seed[2] * axis[2];
    const u0: Vec3 = [seed[0] - k * axis[0], seed[1] - k * axis[1], seed[2] - k * axis[2]];
    const l = Math.hypot(...u0);
    const u: Vec3 = [u0[0] / l, u0[1] / l, u0[2] / l];
    const w: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    return [u, w];
}

/** Dashed segments of a thread's marks: a circle at each end and four lines along it between them. */
export function markSegments(mark: ThreadMark): number[] {
    const { origin, axis, radius, low, high } = mark;
    const [u, w] = basis(axis);
    const at = (y: number, angle: number, r = radius): number[] => [0, 1, 2].map((k) => origin[k] + axis[k] * y
        + r * (Math.cos(angle) * u[k] + Math.sin(angle) * w[k]));
    const out: number[] = [];
    for (const y of [low - LIFT, high + LIFT]) {
        const steps = DASHES * 4;
        for (let i = 0; i < steps; i += 4) {
            // A dash over three steps of four, then a gap.
            for (let s = i; s < i + 3; s++) {
                out.push(...at(y, (2 * Math.PI * s) / steps), ...at(y, (2 * Math.PI * (s + 1)) / steps));
            }
        }
    }
    const length = high - low;
    const dash = Math.max(length / 30, 0.05);
    for (let q = 0; q < 4; q++) {
        const angle = (q * Math.PI) / 2;
        for (let y = low; y < high - 1e-9; y += 2 * dash) {
            out.push(...at(y, angle), ...at(Math.min(y + dash, high), angle));
        }
    }
    return out;
}

/**
 * A hole's mesh is flat facets inside its round wall, by up to r (1 - cos(a / 2)) for the display quality's angular
 * tolerance a: a helix drawn just off the true wall would sit behind them and show only in pieces. In a hole the helix
 * is moved that much further in; on a shaft the facets are inside it anyway.
 */
function spiralSink(ghost: ThreadGhost, mark: ThreadMark, quality: MeshQuality): (p: Vec3) => Vec3 {
    if (!(ghost.spec.rBase > ghost.spec.rCrest)) {
        return (p) => p;
    }
    const half = MESH_TOLERANCES[quality].angular / 2;
    const { origin: o, axis: a } = mark;
    return (p) => {
        const q: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
        const s = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
        const radial: Vec3 = [q[0] - s * a[0], q[1] - s * a[1], q[2] - s * a[2]];
        const r = Math.hypot(...radial);
        if (r < 1e-9) {
            return p;
        }
        const k = (r - r * (1 - Math.cos(half))) / r;
        return [o[0] + s * a[0] + radial[0] * k, o[1] + s * a[1] + radial[1] * k, o[2] + s * a[2] + radial[2] * k];
    };
}

/**
 * The marks of the cosmetic threads among `ghosts`, as line segments with the body each lies on: the helix a thread
 * step draws on its hole's or shaft's surface (see ThreadGhost.spiral), else circles and lines where it runs.
 */
export function cosmeticMarks(shape: Shape3D | null, ghosts: ThreadGhost[], quality: MeshQuality = 'normal'): { lines: Float32Array; body: Uint32Array } | null {
    const marks: ThreadMark[] = [];
    const spirals: { mark: ThreadMark; segments: number[] }[] = [];
    const seen = new Set<string>();
    for (const ghost of ghosts.filter(isCosmetic)) {
        const mark = threadMark(ghost);
        if (ghost.spiral) {
            const sink = spiralSink(ghost, mark, quality);
            const segments = ghost.spiral.flatMap((line) => line.slice(1).flatMap((p, i) => [...sink(line[i]), ...sink(p)]));
            if (segments.length) {
                spirals.push({ mark, segments });
            }
            continue;
        }
        // Every start of a multi-start thread has its own ghost on the same cylinder.
        const key = JSON.stringify([mark.origin, mark.axis, mark.radius, mark.low, mark.high].flat().map((v) => Math.round(v * 1e6)));
        if (!seen.has(key)) {
            seen.add(key);
            marks.push(mark);
        }
    }
    if (!marks.length && !spirals.length) {
        return null;
    }
    const solids = shape ? shape.solids : [];
    const boxes = solids.length > 1 ? solids.map(boxOf) : [];
    release(solids);
    const lines: number[] = [];
    const body: number[] = [];
    for (const { mark, segments } of [...marks.map((m) => ({ mark: m, segments: markSegments(m) })), ...spirals]) {
        const middle = [0, 1, 2].map((k) => mark.origin[k] + mark.axis[k] * (mark.low + mark.high) / 2) as Vec3;
        const index = Math.max(0, boxes.findIndex((box) => contains(box, middle, mark.radius)));
        for (let i = 0; i < segments.length; i++) {
            lines.push(segments[i]);
        }
        for (let i = 0; i < segments.length / 6; i++) {
            body.push(index);
        }
    }
    return { lines: Float32Array.from(lines), body: Uint32Array.from(body) };
}
