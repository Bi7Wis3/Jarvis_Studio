// A SolidWorks assembly's mates (SwMate, as JarvisHistoryExport.vbs writes them) as studio mates (@jarvis/core/mates),
// and the fixed or floating state of its components. Values are the SolidWorks API's: swMateType_e for the type,
// swMateAlign_e for the alignment (0 aligned, 1 anti-aligned, 2 closest), swSelectType_e for each entity (1 edge,
// 2 face, 3 vertex, 4 datum plane, 5 datum axis, 6 datum point, 11 and 25 sketch points, 20 component), and
// IMateEntity2.EntityParams [point, vector, radius1, radius2] in the assembly's space, in metres. What cannot be read
// as a standard mate stays as SolidWorks wrote it (Project.importedMates).

import { effectivePart, type Part, type Project, type Vec3 } from '@jarvis/core';
import type { ImportedMates } from '@jarvis/core/imported';
import {
    eulerToMat, MATE_LABELS, nextMateName, prepareMate, refGeometry, solveAssembly, validMateTypes, withFixed, withMate, type AssemblyMates, type Mate,
    type MateGeom, type MatePick, type MateRef, type MateType,
} from '@jarvis/core/mates';
import { findMates, type MateKernel } from '../../mates.js';
import type { ProjectStore } from '../../store.js';
import type { SwMate } from './format.js';

/** swMateType_e values of the standard mates (SolidWorks API help, swMateType_e). */
export const SW_MATE_TYPES: Record<number, MateType> = {
    0: 'coincident', 1: 'concentric', 2: 'perpendicular', 3: 'parallel', 4: 'tangent', 5: 'distance', 6: 'angle', 16: 'lock',
};

/** swSelectType_e values the converter reads. */
const SEL = { edge: 1, face: 2, vertex: 3, plane: 4, axis: 5, point: 6, sketchPoint: 11, component: 20, extSketchPoint: 25 } as const;

const NEAR = 1e-6;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** A value to 1e-9 (mm or degrees): float noise off what the API gave. */
const round = (v: number): number => Math.round(v * 1e9) / 1e9 + 0;
/** Coordinates to 1e-9 mm: float noise off what the API gave. */
const tidy = (v: Vec3): Vec3 => v.map((c) => Math.round(c * 1e9) / 1e9 + 0) as Vec3;

function across(d: Vec3): Vec3 {
    const seed: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c: Vec3 = [d[1] * seed[2] - d[2] * seed[1], d[2] * seed[0] - d[0] * seed[2], d[0] * seed[1] - d[1] * seed[0]];
    return unit(c);
}

/** A world point and direction in a part's frame (the inverse of its placement). */
function toPart(part: Part | undefined): { point: (p: Vec3) => Vec3; dir: (d: Vec3) => Vec3 } {
    if (!part) {
        return { point: (p) => p, dir: (d) => d };
    }
    const R = eulerToMat(part.rotation);
    const back = (v: Vec3): Vec3 => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
    return { point: (p) => back(sub(p, part.position)), dir: back };
}

/** One entity as a reference, with the direction SolidWorks gave it (part frame), or why it cannot be read. */
type Entity = { ref: MateRef; direction: Vec3 | null } | { reason: string };

/** Planes, axes or points of the part (or the assembly) that match a datum entity. */
function matchReference(part: Part | undefined, parts: readonly Part[], picks: MatePick[], fits: (g: MateGeom) => boolean): MatePick | null {
    const steps = part ? effectivePart(part, parts as Part[]).features ?? [] : [];
    const candidates: MatePick[] = [...picks];
    for (const f of steps) {
        if (f.op === 'plane' && picks.some((p) => p.kind === 'plane')) {
            candidates.push({ kind: 'plane', plane: { step: f.id } });
        } else if (f.op === 'axis' && picks.some((p) => p.kind === 'axis')) {
            candidates.push({ kind: 'axis', axis: { step: f.id } });
        } else if (f.op === 'point' && picks.some((p) => p.kind === 'point')) {
            candidates.push({ kind: 'point', point: { step: f.id } });
        }
    }
    for (const pick of candidates) {
        const g = refGeometry({ ...(part ? { part: part.id } : {}), pick }, parts);
        if (g && fits(g)) {
            return pick;
        }
    }
    return null;
}

function convertEntity(e: NonNullable<SwMate['entities']>[number], type: MateType, components: Record<string, string>, parts: readonly Part[]): Entity {
    const partId = e.component ? components[e.component] : undefined;
    if (e.component && !partId) {
        return { reason: `${e.component} was not imported` };
    }
    const part = partId ? parts.find((p) => p.id === partId) : undefined;
    const owner = partId ? { part: partId } : {};
    if (type === 'lock') {
        return partId ? { ref: { ...owner, pick: { kind: 'component' } }, direction: null } : { reason: 'a lock to the assembly itself' };
    }
    const params = e.params ?? [];
    if (params.length < 6 || params.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        return { reason: 'SolidWorks gave no geometry for one of its entities' };
    }
    const frame = toPart(part);
    const P = tidy(frame.point([params[0] * 1000, params[1] * 1000, params[2] * 1000]));
    const raw: Vec3 = [params[3], params[4], params[5]];
    const V = len(raw) > 1e-9 ? tidy(unit(frame.dir(raw))) : null;
    const r1 = round((params[6] ?? 0) * 1000);
    const r2 = round((params[7] ?? 0) * 1000);
    switch (e.referenceType) {
        case SEL.face:
            if (V && Math.abs(r1) < NEAR && Math.abs(r2) < NEAR) {
                return { ref: { ...owner, pick: { kind: 'face', at: P, normal: V }, found: { type: 'plane', origin: P, normal: V } }, direction: V };
            }
            if (V && r1 > NEAR && Math.abs(r2) < NEAR) {
                // A point on the cylinder, without a normal: whether it is a hole or a shaft is not given.
                return {
                    ref: { ...owner, pick: { kind: 'face', at: tidy(add(P, scale(across(V), r1))) }, found: { type: 'cylinder', point: P, direction: V, radius: r1 } },
                    direction: V,
                };
            }
            return { reason: 'a conical, spherical or other curved face (its parameters are not described in the API help)' };
        case SEL.edge:
            if (V && Math.abs(r1) < NEAR) {
                return { ref: { ...owner, pick: { kind: 'edge', at: P }, found: { type: 'line', point: P, direction: V } }, direction: V };
            }
            if (V && r1 > NEAR) {
                return { ref: { ...owner, pick: { kind: 'edge', at: tidy(add(P, scale(across(V), r1))) }, found: { type: 'circle', centre: P, normal: V, radius: r1 } }, direction: V };
            }
            return { reason: 'an edge SolidWorks gave no direction for' };
        case SEL.vertex:
            return { ref: { ...owner, pick: { kind: 'vertex', at: P }, found: { type: 'point', point: P } }, direction: null };
        case SEL.plane: {
            if (!V) {
                return { reason: 'a plane without a normal' };
            }
            const pick = matchReference(part, parts, [{ kind: 'plane', plane: 'front' }, { kind: 'plane', plane: 'top' }, { kind: 'plane', plane: 'right' }],
                (g) => g.type === 'plane' && Math.abs(Math.abs(dot(g.normal, V)) - 1) < 1e-9 && Math.abs(dot(sub(P, g.origin), g.normal)) < NEAR);
            return pick ? { ref: { ...owner, pick }, direction: V } : { reason: 'a plane the studio part has no match for' };
        }
        case SEL.axis: {
            if (!V) {
                return { reason: 'an axis without a direction' };
            }
            const pick = matchReference(part, parts, [{ kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'z' }],
                (g) => g.type === 'line' && Math.abs(Math.abs(dot(g.direction, V)) - 1) < 1e-9 && len(sub(sub(P, g.point), scale(g.direction, dot(sub(P, g.point), g.direction)))) < NEAR);
            return pick ? { ref: { ...owner, pick }, direction: V } : { reason: 'an axis the studio part has no match for' };
        }
        case SEL.point:
        case SEL.sketchPoint:
        case SEL.extSketchPoint: {
            const pick = matchReference(part, parts, [{ kind: 'point', point: 'origin' }],
                (g) => (g.type === 'frame' ? len(sub(P, g.origin)) < NEAR : g.type === 'point' && len(sub(P, g.point)) < NEAR));
            return pick ? { ref: { ...owner, pick }, direction: null } : { reason: 'a sketch or reference point other than an origin' };
        }
        default:
            return { reason: `an entity of selection type ${e.referenceType ?? '?'}` };
    }
}

/** The direction a studio reference has, to compare with SolidWorks' (datum planes and axes may face the other way). */
function studioDirection(ref: MateRef, parts: readonly Part[]): Vec3 | null {
    const g = ref.found ?? refGeometry(ref, parts);
    if (!g) {
        return null;
    }
    return g.type === 'plane' ? g.normal : g.type === 'line' || g.type === 'cylinder' || g.type === 'cone' ? g.direction : g.type === 'circle' ? g.normal : null;
}

export interface ConvertedMates {
    mates: (Omit<Mate, 'id'> & { source: SwMate })[];
    skipped: { mate: SwMate; reason: string }[];
}

/** SolidWorks' mates as studio mates (unsolved, not yet checked against the parts' bodies), and those that are not. */
export function convertSwMates(imported: ImportedMates, parts: readonly Part[]): ConvertedMates {
    const out: ConvertedMates = { mates: [], skipped: [] };
    for (const raw of imported.mates as SwMate[]) {
        const m = raw ?? ({} as SwMate);
        const type = SW_MATE_TYPES[m.type ?? -1];
        if (!type) {
            out.skipped.push({ mate: m, reason: 'not a standard mate the studio has yet' });
            continue;
        }
        const limited = typeof m.min === 'number' && typeof m.max === 'number' && Math.abs(m.min - m.max) > 1e-12;
        if (limited) {
            out.skipped.push({ mate: m, reason: 'a limit mate (advanced mates are not in the studio yet)' });
            continue;
        }
        const entities = m.entities ?? [];
        if (entities.length !== 2) {
            out.skipped.push({ mate: m, reason: `${entities.length} entities where a standard mate has two` });
            continue;
        }
        const sides = entities.map((e) => convertEntity(e, type, imported.components, parts));
        const lost = sides.find((s): s is { reason: string } => 'reason' in s);
        if (lost) {
            out.skipped.push({ mate: m, reason: lost.reason });
            continue;
        }
        const ok = sides as { ref: MateRef; direction: Vec3 | null }[];
        const [ga, gb] = ok.map((s) => s.ref.found ?? refGeometry(s.ref, parts));
        if (type !== 'lock' && ga && gb && !validMateTypes(ga, gb).includes(type)) {
            out.skipped.push({ mate: m, reason: `a ${MATE_LABELS[type].toLowerCase()} mate between entities the studio does not take it for` });
            continue;
        }
        // swMateAlign_e: 0 aligned, 1 anti-aligned, 2 closest (left to the studio: the nearer one as the parts stand).
        let alignment: Mate['alignment'] = m.alignment === 0 ? 'aligned' : m.alignment === 1 ? 'antiAligned' : undefined;
        for (const side of ok) {
            const ours = studioDirection(side.ref, parts);
            if (alignment && side.direction && ours && dot(ours, side.direction) < 0) {
                alignment = alignment === 'aligned' ? 'antiAligned' : 'aligned';
            }
        }
        const value = typeof m.value === 'number' && Number.isFinite(m.value)
            ? type === 'distance' ? round(Math.abs(m.value) * 1000) : type === 'angle' ? round((Math.abs(m.value) * 180) / Math.PI) : undefined
            : undefined;
        out.mates.push({
            source: m,
            name: typeof m.name === 'string' ? m.name : '',
            type,
            refs: ok.map((s) => s.ref),
            ...(alignment ? { alignment } : {}),
            ...(value !== undefined ? { value } : {}),
            ...(m.suppressed ? { suppressed: true } : {}),
        });
    }
    return out;
}

/** The parts SolidWorks fixed (IComponent2.IsFixed), and those it left floating; all fixed when the export does not say. */
export function fixedStates(components: Record<string, string>, fixed: Map<string, boolean | undefined>): { fixed: string[]; floating: string[] } {
    const out = { fixed: [] as string[], floating: [] as string[] };
    for (const [name, part] of Object.entries(components)) {
        (fixed.get(name) === false ? out.floating : out.fixed).push(part);
    }
    return out;
}

/**
 * Brings an imported assembly's mates in as studio mates (one change with the import, no undo step of its own): each
 * converted mate whose faces, edges and vertices the kernel finds on the rebuilt parts is added and solved; the rest
 * stay in Project.importedMates. Components are fixed or floating as in SolidWorks. Returns the report's lines.
 */
export async function importMates(store: ProjectStore, kernel: MateKernel, imported: ImportedMates,
    fixed: Map<string, boolean | undefined>): Promise<string[]> {
    const project: Project = store.get();
    const converted = convertSwMates(imported, project.parts);
    const located = await findMates(project, converted.mates.map((m, i) => ({ ...m, id: `sw-${i}` })), kernel);
    const kept: Mate[] = [];
    const skipped = [...converted.skipped];
    located.forEach((m, i) => {
        const source = converted.mates[i].source;
        const missing = m.refs.some((r) => (r.pick.kind === 'face' || r.pick.kind === 'edge' || r.pick.kind === 'vertex') && !r.found);
        const changed = m.refs.some((r, k) => r.found && converted.mates[i].refs[k].found && r.found.type !== converted.mates[i].refs[k].found!.type);
        if (missing || changed) {
            skipped.push({ mate: source, reason: missing ? 'an entity it joins was not found on the rebuilt part' : 'an entity it joins is a different shape on the rebuilt part' });
        } else {
            kept.push(m);
        }
    });
    const states = fixedStates(imported.components, fixed);
    const lines: string[] = [];
    store.mutate((draft) => {
        let assembly: AssemblyMates = withFixed(draft.assembly, draft.parts, states.fixed, true);
        assembly = withFixed(assembly, draft.parts, states.floating, false);
        const added: Mate[] = [];
        for (const m of kept) {
            const { id: _id, source: _source, ...rest } = m as Mate & { source?: SwMate };
            const taken = assembly.mates.some((x) => x.name === rest.name);
            const prepared = prepareMate({ ...rest, id: 'new', name: taken || !rest.name ? nextMateName(assembly.mates, rest.type) : rest.name }, draft.parts);
            assembly = withMate(assembly, { ...prepared, id: undefined });
            added.push(assembly.mates[assembly.mates.length - 1]);
        }
        const solved = added.length ? solveAssembly(draft.parts, assembly, { analyse: true, only: [...new Set(added.flatMap((m) => m.refs.flatMap((r) => (r.part ? [r.part] : []))))] }) : null;
        for (const [id, placement] of Object.entries(solved?.placements ?? {})) {
            const part = draft.parts.find((p) => p.id === id);
            if (part) {
                part.position = placement.position;
                part.rotation = placement.rotation;
            }
        }
        draft.assembly = assembly;
        if (skipped.length) {
            draft.importedMates = [...(draft.importedMates ?? []), { ...imported, mates: skipped.map((s) => s.mate) }];
        }
        if (added.length) {
            const bad = added.filter((m) => solved?.mates[m.id] && solved.mates[m.id].state !== 'ok' && solved.mates[m.id].state !== 'suppressed');
            lines.push(`${added.length === 1 ? '1 mate' : `${added.length} mates`} brought in as studio mates (${added.map((m) => `${m.name}: ${MATE_LABELS[m.type].toLowerCase()}`).join(', ')})`
                + `${bad.length ? `; ${bad.map((m) => `${m.name} ${solved!.mates[m.id].state === 'error' ? 'does not hold' : 'over defines the assembly'}`).join(', ')}` : '; they hold as SolidWorks placed the parts'}.`);
        }
    }, { undoable: false });
    if (skipped.length) {
        lines.push(`${skipped.length === 1 ? '1 mate' : `${skipped.length} mates`} kept as SolidWorks wrote them, not yet studio mates: `
            + `${skipped.map((s) => `${s.mate.name ?? '?'} (${s.reason})`).join('; ')}.`);
    }
    const partName = (id: string) => project.parts.find((p) => p.id === id)?.name ?? id;
    lines.push(`Fixed as in SolidWorks: ${states.fixed.map(partName).join(', ') || 'none'}${states.floating.length ? `; floating: ${states.floating.map(partName).join(', ')}` : ''}.`);
    return lines;
}
