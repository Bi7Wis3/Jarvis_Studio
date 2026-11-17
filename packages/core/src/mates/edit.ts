// Changes to a project's mates as the tree, the Mate form and the assistant make them: names (Coincident1, ...),
// a new mate's alignment, value and side as the components stand, folders, fixed and floating components, and the
// repairs on load and when parts are deleted.

import type { Part, Project, Vec3 } from '../index';
import {
    across, compose, copyTransform, cross, dot, IDENTITY_RIGID, invert, len, mulVec, placementOf, rigidOf, scale, sub, transpose, unit,
} from './math';
import { directionOf, mateRows, worldGeom, type Side } from './residuals';
import { refGeometry } from './resolve';
import { fixedParts } from './solver';
import { STANDARD_MATES, type AssemblyMates, type Mate, type MateFolder, type MateGeom, type MateRef, type MateType } from './types';
import { hasAlignment, hasFlip, MATE_LABELS } from './valid';

/** The next free name for a mate of a type: Coincident1, Coincident2, ... */
export function nextMateName(mates: readonly Pick<Mate, 'name'>[], type: MateType): string {
    const label = MATE_LABELS[type];
    let n = 0;
    for (const m of mates) {
        const match = new RegExp(`^${label}(\\d+)$`).exec(m.name);
        if (match) {
            n = Math.max(n, Number(match[1]));
        }
    }
    return `${label}${n + 1}`;
}

/** A mate id not used yet. */
export function nextMateId(mates: readonly Pick<Mate, 'id'>[]): string {
    const used = new Set(mates.map((m) => m.id));
    let n = mates.length + 1;
    while (used.has(`mate-${n}`)) {
        n++;
    }
    return `mate-${n}`;
}

/** A folder name not used yet: Folder1, Folder2, ... */
export function nextFolderName(folders: readonly MateFolder[] | undefined, base = 'Folder'): string {
    let n = 1;
    while ((folders ?? []).some((f) => f.name === `${base}${n}`)) {
        n++;
    }
    return `${base}${n}`;
}

/** One side of a mate in the world as the parts stand now, or null when it does not resolve. */
export function sideNow(ref: MateRef, parts: readonly Part[], geometry: (ref: MateRef) => MateGeom | null = (r) => refGeometry(r, parts)): Side | null {
    const part = ref.part ? parts.find((p) => p.id === ref.part) : undefined;
    if (ref.part && !part) {
        return null;
    }
    const T = part ? compose(copyTransform(part.repeat, ref.copy ?? 0), rigidOf(part)) : IDENTITY_RIGID;
    const g = ref.pick.kind === 'component' ? ({ type: 'point', point: [0, 0, 0] } as MateGeom) : geometry(ref);
    return g ? { T, geom: worldGeom(g, T) } : null;
}

/** The value a distance or angle mate has as the components stand, and which side it is on. */
export function measureMate(mate: Mate, a: Side, b: Side): { value: number; flip: boolean } | null {
    if (mate.type === 'angle') {
        const da = directionOf(a.geom);
        const db0 = directionOf(b.geom);
        if (!da || !db0) {
            return null;
        }
        const db = mate.alignment === 'antiAligned' ? scale(db0, -1) : db0;
        const value = (Math.atan2(len(cross(da, db)), dot(da, db)) * 180) / Math.PI;
        return { value, flip: mate.flip ?? false };
    }
    if (mate.type !== 'distance') {
        return null;
    }
    const zero = mateRows({ ...mate, value: 0, flip: false }, a, b, 1);
    if (!zero || zero.dims === 0) {
        return null;
    }
    const dimRows = zero.rows.slice(zero.rows.length - zero.dims);
    if (dimRows.length === 1) {
        // A signed distance (from a plane, along cones) or |w| - extra: the value is what makes the row zero.
        const v = dimRows[0];
        const signed = mateRows({ ...mate, value: 1, flip: false }, a, b, 1);
        const slope = signed ? signed.rows[signed.rows.length - 1] - v : -1;
        // Signed rows fall by one when the value grows by one; unsigned ones (|w| - D) too, but never go below -D.
        const value = -v / slope;
        if (value >= 0) {
            return { value, flip: false };
        }
        return { value: -value, flip: true };
    }
    return { value: Math.hypot(...dimRows), flip: false };
}

/**
 * A new or edited mate made ready to solve: its alignment where the user gave none (the one closer to how the
 * components stand), its value and side from how they stand when not given, and what it holds (a lock's relative
 * placement, a locked concentric's marks, an angle's turning axis).
 */
export function prepareMate(mate: Mate, parts: readonly Part[], geometry?: (ref: MateRef) => MateGeom | null): Mate {
    const out: Mate = { ...mate, refs: mate.refs.map((r) => ({ ...r })) };
    const a = sideNow(out.refs[0], parts, geometry);
    const b = out.refs[1] ? sideNow(out.refs[1], parts, geometry) : null;
    if (!a || !b) {
        return out;
    }
    if (out.type !== 'lock' && !out.alignment && hasAlignment(out.type, a.geom, b.geom)) {
        const off = (alignment: Mate['alignment']) => {
            const rows = mateRows({ ...out, alignment, value: out.value ?? measureMate({ ...out, alignment }, a, b)?.value ?? 0 }, a, b, 1)?.rows ?? [];
            return Math.hypot(...rows);
        };
        out.alignment = off('aligned') <= off('antiAligned') ? 'aligned' : 'antiAligned';
    }
    if ((out.type === 'distance' || out.type === 'angle') && (out.value === undefined || out.flip === undefined)) {
        const measured = measureMate(out, a, b);
        if (measured) {
            out.value ??= measured.value;
            if (out.flip === undefined && out.type === 'distance' && hasFlip(out.type, a.geom, b.geom)) {
                out.flip = measured.flip || undefined;
            }
        }
    }
    if (out.type === 'lock') {
        const rel = compose(invert(a.T), b.T);
        out.hold = { relative: placementOf(rel) };
    }
    if (out.type === 'concentric' && out.lockRotation && !out.hold?.across) {
        // A mark across each axis, the same in the world now (B's laid onto the plane across its own axis).
        const da = directionOf(a.geom) ?? [0, 1, 0];
        const db = directionOf(b.geom) ?? da;
        const mark = across(da);
        const flat = sub(mark, scale(db, dot(mark, db)));
        const markB = len(flat) > 1e-9 ? unit(flat) : across(db);
        out.hold = { ...out.hold, across: [mulVec(transpose(a.T.R), mark), mulVec(transpose(b.T.R), markB)] };
    } else if (out.type === 'concentric' && out.hold?.across) {
        const { across: _drop, ...rest } = out.hold;
        out.hold = Object.keys(rest).length ? rest : undefined;
    }
    if (out.type === 'angle' && !out.hold?.about) {
        const da = directionOf(a.geom);
        const db = directionOf(b.geom);
        if (da && db) {
            const k = len(cross(da, db)) > 1e-9 ? unit(cross(da, db)) : across(da);
            out.hold = { ...out.hold, about: mulVec(transpose(a.T.R), k) };
        }
    }
    return out;
}

/** The assembly's mates with a mate added (named and given an id when it has none). */
export function withMate(assembly: AssemblyMates | undefined, mate: Omit<Mate, 'id' | 'name'> & Partial<Pick<Mate, 'id' | 'name'>>,
    folder?: string): AssemblyMates {
    const mates = assembly?.mates ?? [];
    const full: Mate = { ...mate, id: mate.id ?? nextMateId(mates), name: mate.name?.trim() || nextMateName(mates, mate.type) };
    const next: AssemblyMates = { ...assembly, mates: [...mates, full] };
    if (folder) {
        next.folders = (next.folders ?? []).map((f) => (f.id === folder ? { ...f, mates: [...f.mates, full.id] } : f));
    }
    return next;
}

/** Removes mates and their places in folders. */
export function withoutMates(assembly: AssemblyMates, ids: readonly string[]): AssemblyMates {
    const gone = new Set(ids);
    return {
        ...assembly,
        mates: assembly.mates.filter((m) => !gone.has(m.id)),
        ...(assembly.folders ? { folders: assembly.folders.map((f) => ({ ...f, mates: f.mates.filter((id) => !gone.has(id)) })) } : {}),
    };
}

/** A new folder holding some mates (taken out of the folders they were in). */
export function withFolder(assembly: AssemblyMates, name: string, ids: readonly string[]): { assembly: AssemblyMates; id: string } {
    const folders = assembly.folders ?? [];
    const used = new Set(folders.map((f) => f.id));
    let n = folders.length + 1;
    while (used.has(`mate-folder-${n}`)) {
        n++;
    }
    const id = `mate-folder-${n}`;
    const moving = new Set(ids);
    return {
        id,
        assembly: {
            ...assembly,
            folders: [...folders.map((f) => ({ ...f, mates: f.mates.filter((m) => !moving.has(m)) })), { id, name, mates: [...ids] }],
        },
    };
}

/** Mates moved into a folder, or out of every folder (`folder` null). */
export function moveToFolder(assembly: AssemblyMates, ids: readonly string[], folder: string | null): AssemblyMates {
    const moving = new Set(ids);
    return {
        ...assembly,
        folders: (assembly.folders ?? []).map((f) => ({
            ...f,
            mates: f.id === folder ? [...f.mates.filter((m) => !moving.has(m)), ...ids] : f.mates.filter((m) => !moving.has(m)),
        })),
    };
}

/** Folders removed; their mates stay in the Mates folder. */
export function withoutFolders(assembly: AssemblyMates, ids: readonly string[]): AssemblyMates {
    const folders = (assembly.folders ?? []).filter((f) => !ids.includes(f.id));
    const next: AssemblyMates = { ...assembly, folders };
    if (!folders.length) {
        delete next.folders;
    }
    return next;
}

/** Fixes or floats components; the default (the first part fixed) becomes an explicit list. */
export function withFixed(assembly: AssemblyMates | undefined, parts: readonly Pick<Part, 'id'>[], ids: readonly string[], fixed: boolean): AssemblyMates {
    const now = fixedParts(parts, assembly);
    for (const id of ids) {
        if (fixed) {
            now.add(id);
        } else {
            now.delete(id);
        }
    }
    return { mates: [], ...assembly, fixed: parts.map((p) => p.id).filter((id) => now.has(id)) };
}

/** The folder a mate is in, if any. */
export const folderOf = (assembly: AssemblyMates | undefined, mateId: string): MateFolder | undefined =>
    assembly?.folders?.find((f) => f.mates.includes(mateId));

/** The mates that join a part (its own Mates folder in the tree). */
export const matesOf = (assembly: AssemblyMates | undefined, partId: string): Mate[] =>
    (assembly?.mates ?? []).filter((m) => m.refs.some((r) => r.part === partId));

const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Keeps a project's mates well formed after reading it: unknown types and malformed entries dropped, names and ids
 * unique, folders holding only mates that exist, fixed parts that exist. A reference to something that no longer
 * resolves stays: the solver reports it as an error.
 */
export function repairAssembly(project: Pick<Project, 'parts'> & { assembly?: AssemblyMates }): void {
    const assembly = project.assembly;
    if (!assembly) {
        return;
    }
    if (typeof assembly !== 'object' || !Array.isArray(assembly.mates)) {
        delete project.assembly;
        return;
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    const kept: Mate[] = [];
    for (const raw of assembly.mates as unknown[]) {
        const m = raw as Mate;
        if (!m || typeof m !== 'object' || !STANDARD_MATES.includes(m.type) || !Array.isArray(m.refs)
            || m.refs.some((r) => !r || typeof r !== 'object' || !r.pick || typeof r.pick.kind !== 'string')) {
            continue;
        }
        const mate: Mate = { ...m };
        if (typeof mate.id !== 'string' || !mate.id || ids.has(mate.id)) {
            mate.id = nextMateId([...kept, ...assembly.mates.filter((x) => typeof x?.id === 'string')]);
        }
        if (typeof mate.name !== 'string' || !mate.name.trim() || names.has(mate.name)) {
            mate.name = nextMateName(kept, mate.type);
        }
        if (mate.value !== undefined && !(typeof mate.value === 'number' && Number.isFinite(mate.value))) {
            delete mate.value;
        }
        mate.refs = mate.refs.map((r) => ({
            ...r,
            ...(r.found && typeof r.found === 'object' && typeof (r.found as { type?: unknown }).type === 'string' ? {} : { found: undefined }),
        }));
        for (const r of mate.refs) {
            if (r.found === undefined) {
                delete r.found;
            }
            if ('at' in r.pick && !isVec(r.pick.at)) {
                r.found = undefined;
                delete r.found;
            }
        }
        ids.add(mate.id);
        names.add(mate.name);
        kept.push(mate);
    }
    assembly.mates = kept;
    if (assembly.folders !== undefined) {
        const folders = Array.isArray(assembly.folders) ? assembly.folders.filter((f) => f && typeof f.id === 'string' && Array.isArray(f.mates)) : [];
        const seen = new Set<string>();
        assembly.folders = folders.map((f) => ({
            id: f.id,
            name: typeof f.name === 'string' && f.name.trim() ? f.name : f.id,
            mates: f.mates.filter((id) => ids.has(id) && !seen.has(id) && (seen.add(id), true)),
        }));
        if (!assembly.folders.length) {
            delete assembly.folders;
        }
    }
    if (assembly.fixed !== undefined) {
        const parts = new Set(project.parts.map((p) => p.id));
        assembly.fixed = Array.isArray(assembly.fixed) ? assembly.fixed.filter((id) => typeof id === 'string' && parts.has(id)) : undefined;
        if (assembly.fixed === undefined) {
            delete assembly.fixed;
        }
    }
}

/**
 * After a change to the project: mates of parts that were deleted go with them (as SolidWorks deletes a component's
 * mates), and so do those parts' places in the fixed list.
 */
export function fitAssembly(prev: Pick<Project, 'parts'>, next: Pick<Project, 'parts'> & { assembly?: AssemblyMates }): void {
    const assembly = next.assembly;
    if (!assembly) {
        return;
    }
    const now = new Set(next.parts.map((p) => p.id));
    const removed = prev.parts.map((p) => p.id).filter((id) => !now.has(id));
    if (removed.length === 0) {
        return;
    }
    const gone = new Set(removed);
    const dead = assembly.mates.filter((m) => m.refs.some((r) => r.part && gone.has(r.part))).map((m) => m.id);
    const fitted = dead.length ? withoutMates(assembly, dead) : assembly;
    if (fitted.fixed) {
        fitted.fixed = fitted.fixed.filter((id) => now.has(id));
    }
    next.assembly = fitted;
}

/** The world placement of the part side of a mate, for the form's labels: where its entity sits now. */
export function anchorNow(ref: MateRef, parts: readonly Part[]): Vec3 | null {
    const side = sideNow(ref, parts);
    if (!side) {
        return null;
    }
    const g = side.geom;
    return g.type === 'plane' ? g.origin : g.type === 'line' || g.type === 'cylinder' ? g.point : g.type === 'cone' ? g.apex
        : g.type === 'circle' ? g.centre : g.type === 'sphere' ? g.centre : g.type === 'point' ? g.point : g.type === 'frame' ? g.origin
            : side.T.t;
}
