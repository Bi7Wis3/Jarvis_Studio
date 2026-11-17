// Assembly mates on the server (@jarvis/core/mates): the tools Jarvis and the toolbar use to add, edit, suppress and
// remove mates, fix and float components, group mates in folders and move components within their freedom; the
// service that solves the mates again when a part's model changes (SolidWorks rebuilds an assembly's mates); and the
// route the Mate form asks for the exact geometry of what was picked.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_PRINT, effectivePart, type Part, type Project } from '@jarvis/core';
import {
    MATE_LABELS, MateSystem, prepareMate, refLabel, solveAssembly, STANDARD_MATES, withFixed, withFolder, withMate, withoutFolders,
    withoutMates, moveToFolder, nextFolderName, type AssemblyMates, type AssemblyResult, type Mate, type MateRef,
} from '@jarvis/core/mates';
import { combineContext, meshKey, type CadKernel } from './cad/kernel.js';
import type { MateEntityAnswer, ModelMatePick } from './cad/mateEntities.js';
import type { ProjectStore } from './store.js';
import type { HostTool } from './tools.js';

/** What the mates need of the kernel: the geometry of picked faces, edges and vertices. */
export type MateKernel = Pick<CadKernel, 'entities'>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const facePick = z.object({ at: vec3, normal: vec3.optional() });
const pick = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('face'), at: vec3.describe('A point on the face (part frame)'), normal: vec3.optional().describe('Its outward normal there') }),
    z.object({ kind: z.literal('edge'), at: vec3.describe('A point on the edge'), faces: z.array(facePick).optional().describe('The faces that meet at it') }),
    z.object({ kind: z.literal('vertex'), at: vec3, faces: z.array(facePick).optional() }),
    z.object({ kind: z.literal('plane'), plane: z.union([z.enum(['top', 'front', 'right']), z.object({ step: z.string() })]) })
        .describe('A base plane (top: normal +Y, front: +Z, right: +X) or a plane step by id'),
    z.object({ kind: z.literal('axis'), axis: z.union([z.enum(['x', 'y', 'z']), z.object({ step: z.string() })]) }),
    z.object({ kind: z.literal('point'), point: z.union([z.literal('origin'), z.object({ step: z.string() })]) }),
    z.object({ kind: z.literal('sketch'), step: z.string().describe('Sketch step id'), item: z.string().describe('A point or curve id of its sketch') }),
    z.object({ kind: z.literal('component') }).describe('The whole component (Lock mates)'),
]);
const ref = z.object({
    part: z.string().optional().describe('Part id; leave out for the assembly\'s own planes, axes and origin (they never move)'),
    copy: z.number().int().min(0).optional().describe('Which copy of a patterned part (0: the part itself)'),
    pick,
});
const end = z.enum(['centre', 'min', 'max']);
const mateFields = {
    type: z.enum(STANDARD_MATES as [string, ...string[]]),
    refs: z.array(ref).length(2).describe('The two entities to mate, on two different components'),
    alignment: z.enum(['aligned', 'antiAligned']).optional()
        .describe('Normals or axes the same way or opposite (tangent: which side); default: the nearer one'),
    value: z.number().min(0).optional().describe('Distance in mm or angle in degrees (0-180); default: as the parts stand'),
    flip: z.boolean().optional().describe('Flip dimension: to the other side (distance) or turning the other way (angle)'),
    lockRotation: z.boolean().optional().describe('Concentric: no turning about the axis'),
    alignAxes: z.boolean().optional().describe('Coincident between two origins: their axes line up too'),
    ends: z.tuple([end, end]).optional().describe('Distance to cylinders or spheres: from the axis or centre, the nearest or farthest side'),
    name: z.string().optional(),
};

const isModelPick = (p: MateRef['pick']): p is ModelMatePick => p.kind === 'face' || p.kind === 'edge' || p.kind === 'vertex';

/**
 * The mates with the geometry of their faces, edges and vertices found again on their parts as they are now (`found`);
 * a pick that is gone loses it (the solver then reports the mate). When the kernel cannot answer, `found` stays.
 */
export async function findMates(project: Project, mates: readonly Mate[], kernel: MateKernel): Promise<Mate[]> {
    const out = mates.map((m) => ({ ...m, refs: m.refs.map((r) => ({ ...r })) }));
    const byPart = new Map<string, MateRef[]>();
    for (const m of out) {
        for (const r of m.refs) {
            if (r.part && isModelPick(r.pick)) {
                byPart.set(r.part, [...(byPart.get(r.part) ?? []), r]);
            }
        }
    }
    const print = project.print ?? DEFAULT_PRINT;
    await Promise.all([...byPart].map(async ([partId, refs]) => {
        const part = project.parts.find((p) => p.id === partId);
        if (!part) {
            refs.forEach((r) => delete r.found);
            return;
        }
        let answers: MateEntityAnswer[] | null = null;
        try {
            answers = await kernel.entities(effectivePart(part, project.parts), print, refs.map((r) => r.pick as ModelMatePick),
                combineContext(part, project.parts));
        } catch {
            return;
        }
        refs.forEach((r, i) => {
            const a = answers![i];
            if (a && !('error' in a)) {
                r.found = a;
            } else {
                delete r.found;
            }
        });
    }));
    return out;
}

/** The parts a mate joins. */
const partsOf = (mates: readonly Mate[]): string[] => [...new Set(mates.flatMap((m) => m.refs.flatMap((r) => (r.part ? [r.part] : []))))];

/** Moves the draft's parts to the solved placements. */
function place(draft: Project, result: AssemblyResult): string[] {
    const moved: string[] = [];
    for (const [id, placement] of Object.entries(result.placements)) {
        const part = draft.parts.find((p) => p.id === id);
        if (part) {
            part.position = placement.position;
            part.rotation = placement.rotation;
            moved.push(part.name);
        }
    }
    return moved;
}

/** A line per mate: its name, type and state. */
function stateLines(mates: readonly Mate[], result: AssemblyResult): string[] {
    return mates.map((m) => {
        const s = result.mates[m.id];
        const state = !s || s.state === 'ok' ? 'holds' : s.state === 'suppressed' ? 'suppressed'
            : `${s.state === 'error' ? 'ERROR' : 'warning'}: ${s.message ?? ''}`;
        return `${m.name} (${m.id}, ${MATE_LABELS[m.type].toLowerCase()}): ${state}`;
    });
}

const PREFIX: Record<string, string> = { fixed: '(f) ', under: '(-) ', over: '(+) ', unsolved: '(?) ', defined: '' };

function componentLines(parts: readonly Part[], ids: readonly string[], result: AssemblyResult): string[] {
    return ids.flatMap((id) => {
        const part = parts.find((p) => p.id === id);
        const state = result.components[id];
        return part && state ? [`${PREFIX[state]}${part.name} (${id}): ${state === 'fixed' ? 'fixed' : state === 'defined' ? 'fully defined'
            : state === 'under' ? `${result.dof[id] ?? '?'} degree(s) of freedom left` : state === 'over' ? 'over defined' : 'not solved'}`] : [];
    });
}

function needPart(project: Project, id: string | undefined): void {
    if (id && !project.parts.some((p) => p.id === id)) {
        throw new Error(`No part with id "${id}".`);
    }
}

function needMate(assembly: AssemblyMates | undefined, id: string): Mate {
    const mate = assembly?.mates.find((m) => m.id === id || m.name === id);
    if (!mate) {
        throw new Error(`No mate "${id}".`);
    }
    return mate;
}

type MateSpec = Omit<Mate, 'id' | 'name'> & { name?: string };

export function mateTools(store: ProjectStore, kernel: MateKernel): HostTool[] {
    return [
        {
            name: 'mates_add',
            description: 'Adds mates between parts (SolidWorks standard mates): coincident, parallel, perpendicular, tangent, '
                + 'concentric (lockRotation), lock, distance, angle. Each joins two entities on two parts: faces, edges and '
                + 'vertices (points in the part frame, as features pick them), base planes, axes and the origin, plane/axis/'
                + 'point steps, sketch points and lines, or the assembly\'s own planes and origin (no part). The floating parts '
                + 'move so every mate holds; fixed parts never move (the first part is fixed until components_fix says '
                + 'otherwise). Several mates in one call: multiple mate mode. positionOnly: move the parts as the mates would, '
                + 'without keeping the mates (Use for positioning only). Reports each mate\'s state and the parts\' freedom.',
            schema: {
                mates: z.array(z.object(mateFields)).min(1),
                folder: z.string().optional().describe('Put the new mates in this existing mate folder (id)'),
                newFolder: z.string().optional().describe('Put the new mates in a new folder of this name (Add to new folder)'),
                positionOnly: z.boolean().optional(),
            },
            run: async ({ mates: specs, folder, newFolder, positionOnly }: {
                mates: MateSpec[]; folder?: string; newFolder?: string; positionOnly?: boolean;
            }) => {
                const project = store.get();
                specs.forEach((s) => s.refs.forEach((r) => needPart(project, r.part)));
                if (folder && !project.assembly?.folders?.some((f) => f.id === folder)) {
                    throw new Error(`No mate folder "${folder}".`);
                }
                const found = await findMates(project, specs.map((s, i) => ({ ...s, id: `new-${i}`, name: s.name ?? '' })), kernel);
                let text = '';
                store.mutate((draft) => {
                    const prepared = found.map((m) => prepareMate(m, draft.parts));
                    let next: AssemblyMates = draft.assembly ?? { mates: [] };
                    const added: Mate[] = [];
                    if (!positionOnly) {
                        for (const m of prepared) {
                            next = withMate(next, { ...m, id: undefined, name: m.name || undefined }, folder);
                            added.push(next.mates[next.mates.length - 1]);
                        }
                        if (newFolder !== undefined) {
                            next = withFolder(next, newFolder.trim() || nextFolderName(next.folders), added.map((m) => m.id)).assembly;
                        }
                    }
                    const shown = positionOnly ? prepared : added;
                    const result = solveAssembly(draft.parts, next, { only: partsOf(shown), analyse: true, ...(positionOnly ? { extra: prepared } : {}) });
                    const moved = place(draft, result);
                    if (!positionOnly) {
                        draft.assembly = next;
                    }
                    text = [
                        positionOnly ? `Positioned only (no mate kept).` : `Added ${added.map((m) => m.name).join(', ')}.`,
                        ...stateLines(shown, result),
                        moved.length ? `Moved: ${moved.join(', ')}.` : 'Nothing had to move.',
                        ...componentLines(draft.parts, partsOf(shown), result),
                    ].join('\n');
                });
                return { text };
            },
        },
        {
            name: 'mates_update',
            description: 'Edits mates (by id or name): type, entities, alignment, value, flip, lock rotation, align axes, '
                + 'distance ends, name, suppressed. Only the fields given change; the parts move so the mates hold.',
            schema: {
                updates: z.array(z.object({
                    id: z.string(),
                    ...Object.fromEntries(Object.entries(mateFields).map(([k, v]) => [k, v.optional()])),
                    suppressed: z.boolean().optional(),
                })).min(1),
            },
            run: async ({ updates }: { updates: (Partial<Mate> & { id: string })[] }) => {
                const project = store.get();
                const edited = updates.map((u) => {
                    const was = needMate(project.assembly, u.id);
                    const { id: _id, ...fields } = u;
                    const next: Mate = { ...was, ...fields, id: was.id };
                    // What the mate holds is taken again when what it joins or how changes.
                    const fresh = u.refs !== undefined || (u.type !== undefined && u.type !== was.type)
                        || (u.lockRotation !== undefined && u.lockRotation !== was.lockRotation);
                    if (fresh) {
                        delete next.hold;
                        if (u.alignment === undefined && (u.refs !== undefined || u.type !== undefined)) {
                            delete next.alignment;
                        }
                    }
                    if (u.type !== undefined && u.type !== was.type) {
                        if (u.value === undefined) {
                            delete next.value;
                        }
                        if (u.flip === undefined) {
                            delete next.flip;
                        }
                    }
                    next.refs.forEach((r) => needPart(project, r.part));
                    return next;
                });
                const found = await findMates(project, edited.filter((m) => updates.find((u) => u.id === m.id || u.id === m.name)?.refs), kernel);
                let text = '';
                store.mutate((draft) => {
                    let next = draft.assembly ?? { mates: [] };
                    const done: Mate[] = [];
                    for (const m of edited) {
                        const located = found.find((f) => f.id === m.id) ?? m;
                        const prepared = prepareMate(located, draft.parts);
                        next = { ...next, mates: next.mates.map((x) => (x.id === m.id ? prepared : x)) };
                        done.push(prepared);
                    }
                    const result = solveAssembly(draft.parts, next, { only: partsOf(done), analyse: true });
                    const moved = place(draft, result);
                    draft.assembly = next;
                    text = ['Updated.', ...stateLines(done, result), moved.length ? `Moved: ${moved.join(', ')}.` : 'Nothing had to move.'].join('\n');
                });
                return { text };
            },
        },
        {
            name: 'mates_remove',
            description: 'Deletes mates (by id or name). The parts stay where they are, with the freedom the mates held.',
            schema: { ids: z.array(z.string()).min(1) },
            run: async ({ ids }: { ids: string[] }) => {
                const project = store.get();
                const gone = ids.map((id) => needMate(project.assembly, id).id);
                store.mutate((draft) => {
                    draft.assembly = withoutMates(draft.assembly ?? { mates: [] }, gone);
                });
                return { text: `Deleted ${gone.length} mate(s).` };
            },
        },
        {
            name: 'components_fix',
            description: 'Fixes parts in place ((f): they never move) or floats them (they move as their mates allow). '
                + 'By default the first part is fixed, as in SolidWorks.',
            schema: { ids: z.array(z.string()).min(1), fixed: z.boolean() },
            run: async ({ ids, fixed }: { ids: string[]; fixed: boolean }) => {
                const project = store.get();
                ids.forEach((id) => needPart(project, id));
                store.mutate((draft) => {
                    draft.assembly = withFixed(draft.assembly, draft.parts, ids, fixed);
                });
                return { text: `${fixed ? 'Fixed' : 'Floating'}: ${ids.join(', ')}.` };
            },
        },
        {
            name: 'mate_folders',
            description: 'Folders of the Mates folder: add (name, mates), rename (id, name), remove (ids; their mates stay), '
                + 'move (mates into folder id, or out of folders with folder null).',
            schema: {
                action: z.enum(['add', 'rename', 'remove', 'move']),
                id: z.string().optional(),
                ids: z.array(z.string()).optional(),
                name: z.string().optional(),
                mates: z.array(z.string()).optional(),
                folder: z.string().nullable().optional(),
            },
            run: async (args: { action: string; id?: string; ids?: string[]; name?: string; mates?: string[]; folder?: string | null }) => {
                const project = store.get();
                const mateIds = (args.mates ?? []).map((id) => needMate(project.assembly, id).id);
                let text = '';
                store.mutate((draft) => {
                    const assembly = draft.assembly ?? { mates: [] };
                    if (args.action === 'add') {
                        const made = withFolder(assembly, args.name?.trim() || nextFolderName(assembly.folders), mateIds);
                        draft.assembly = made.assembly;
                        text = `Added folder ${made.id}.`;
                    } else if (args.action === 'rename') {
                        if (!assembly.folders?.some((f) => f.id === args.id) || !args.name?.trim()) {
                            throw new Error('Give the id of a mate folder and its new name.');
                        }
                        draft.assembly = { ...assembly, folders: assembly.folders.map((f) => (f.id === args.id ? { ...f, name: args.name!.trim() } : f)) };
                        text = 'Renamed.';
                    } else if (args.action === 'remove') {
                        draft.assembly = withoutFolders(assembly, args.ids ?? (args.id ? [args.id] : []));
                        text = 'Removed; the mates stay in the Mates folder.';
                    } else {
                        if (args.folder && !assembly.folders?.some((f) => f.id === args.folder)) {
                            throw new Error(`No mate folder "${args.folder}".`);
                        }
                        draft.assembly = moveToFolder(assembly, mateIds, args.folder ?? null);
                        text = 'Moved.';
                    }
                });
                return { text };
            },
        },
        {
            name: 'mates_get',
            description: 'Lists the mates with their entities and states (errors and warnings, as What\'s Wrong says them), the '
                + 'mate folders, and each part\'s prefix and remaining degrees of freedom. Changes nothing.',
            schema: {},
            run: async () => {
                const project = store.get();
                const assembly = project.assembly;
                const result = solveAssembly(project.parts, assembly, { analyse: true });
                const mates = assembly?.mates ?? [];
                const lines = [
                    `${mates.length} mate(s).`,
                    ...mates.map((m) => `${stateLines([m], result)[0]} | ${m.refs.map((r, k) => refLabel(r, project.parts, k + 1)).join(' & ')}`
                        + `${m.value !== undefined ? ` | ${m.type === 'angle' ? `${m.value}°` : `${m.value} mm`}` : ''}${m.alignment ? ` | ${m.alignment}` : ''}`
                        + `${m.flip ? ' | flipped' : ''}${m.suppressed ? ' | suppressed' : ''}`),
                    ...(assembly?.folders ?? []).map((f) => `Folder ${f.name} (${f.id}): ${f.mates.join(', ') || 'empty'}`),
                    ...componentLines(project.parts, project.parts.map((p) => p.id), result),
                ];
                return { text: lines.join('\n') };
            },
        },
        {
            name: 'components_move',
            description: 'Moves a part towards a position and rotation within the freedom its mates leave (Move Component): '
                + 'parts mated to it follow, fixed parts stay. Leave out position or rotation to keep it.',
            schema: { id: z.string(), position: vec3.optional(), rotation: vec3.optional().describe('Euler XYZ degrees') },
            run: async ({ id, position, rotation }: { id: string; position?: [number, number, number]; rotation?: [number, number, number] }) => {
                const project = store.get();
                needPart(project, id);
                let text = '';
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === id)!;
                    const system = new MateSystem(draft.parts, draft.assembly);
                    const placements = system.drag({ part: id, placement: { position: position ?? part.position, rotation: rotation ?? part.rotation } });
                    const moved = place(draft, { placements, mates: {}, components: {}, dof: {}, converged: true });
                    text = moved.length ? `Moved: ${moved.join(', ')}.` : `${part.name} cannot move: it is fixed or its mates hold it.`;
                });
                return { text };
            },
        },
    ];
}

/** A signature of what the mates depend on: their data, the fixed parts, the mated parts' models and placements. */
function signature(project: Project): string {
    const assembly = project.assembly;
    if (!assembly?.mates.length) {
        return '';
    }
    const print = project.print ?? DEFAULT_PRINT;
    const ids = partsOf(assembly.mates);
    const parts = ids.map((id) => {
        const part = project.parts.find((p) => p.id === id);
        return part ? [id, meshKey(effectivePart(part, project.parts), print, combineContext(part, project.parts)), part.position, part.rotation, part.repeat ?? null] : [id];
    });
    return JSON.stringify([assembly, project.parts.map((p) => p.id), parts]);
}

/**
 * Solves the mates again when what they depend on changes behind them: a part's model (its faces move), a part moved
 * or deleted, an undo. The faces, edges and vertices are found again (`found`) and the floating parts move so the
 * mates hold; this follows the change it answers, so it is not an undo step of its own.
 */
export class MateService {
    private last = '';
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(private readonly store: ProjectStore, private readonly kernel: MateKernel) {}

    /** Asks for a check soon (changes come in bursts). */
    check(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.run();
        }, 60);
    }

    stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private async run(): Promise<void> {
        if (this.running) {
            this.check();
            return;
        }
        const project = this.store.get();
        const sig = signature(project);
        if (!sig || sig === this.last) {
            this.last = sig;
            return;
        }
        this.running = true;
        try {
            const mates = project.assembly!.mates;
            const found = await findMates(project, mates, this.kernel);
            if (this.store.get() !== project) {
                // Changed again meanwhile: start over with the newest.
                this.check();
                return;
            }
            const changed = JSON.stringify(found.map((m) => m.refs.map((r) => r.found ?? null)))
                !== JSON.stringify(mates.map((m) => m.refs.map((r) => r.found ?? null)));
            const assembly = { ...project.assembly!, mates: found };
            const system = new MateSystem(project.parts, assembly);
            const off = found.some((m) => (system.offBy(m.id) ?? 0) > 1e-6);
            const result = off ? system.solve() : null;
            if (changed || (result && Object.keys(result.placements).length)) {
                this.store.mutate((draft) => {
                    draft.assembly = { ...draft.assembly!, mates: found };
                    if (result) {
                        place(draft, result);
                    }
                }, { undoable: false });
            }
            this.last = signature(this.store.get());
        } catch (error) {
            console.warn(`[mates] ${error instanceof Error ? error.message : String(error)}`);
            this.last = sig;
        } finally {
            this.running = false;
        }
    }
}

/** The Mate form's question: the exact geometry of picks on a part as it is now. */
export function registerMateRoutes(app: FastifyInstance, store: ProjectStore, kernel: MateKernel): void {
    app.post('/api/mate-geometry', async (request, reply) => {
        const body = request.body as { partId?: unknown; picks?: unknown } | null;
        const parsed = z.object({ partId: z.string(), picks: z.array(pick).max(50) }).safeParse(body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'Expected { partId, picks }.' });
        }
        const project = store.get();
        const part = project.parts.find((p) => p.id === parsed.data.partId);
        if (!part) {
            return reply.code(404).send({ error: `No part with id "${parsed.data.partId}".` });
        }
        const picks = parsed.data.picks.filter(isModelPick);
        if (picks.length !== parsed.data.picks.length) {
            return reply.code(400).send({ error: 'Only faces, edges and vertices are found by the kernel.' });
        }
        const answers = await kernel.entities(effectivePart(part, project.parts), project.print ?? DEFAULT_PRINT, picks, combineContext(part, project.parts));
        return { answers };
    });
}
