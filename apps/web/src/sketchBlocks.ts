// Sketch blocks (SolidWorks Make Block, Insert Block, Edit Block, Explode Block, Save Block, Add/Remove): a block
// definition holds entities with their own relations in block coordinates (insertion point at 0, 0), and may hold
// sketch text, equation curves and instances of other blocks (nested blocks). Each instance is built from it at its
// insertion point, angle and scale; its entities have ids made from the instance's id and the block's own ids, so
// relations to an instance survive when it is turned, scaled or its block is changed. In the solver an instance is one
// rigid body (sketchBlockRigid.ts): relations to its entities move and turn it as a whole.

import type { SketchBlock, SketchBlockInsert, SketchConstraint, SketchCurve, SketchEquationCurve, SketchGeometry, SketchPoint, SketchText } from '@jarvis/core';
import { ORIGIN, curveOf, pointOf } from './solver';
import { fragmentOf } from './sketchClipboard';
import { constraintRefs, newId } from './sketchGeometry';
import { curvePointIds, mapCurvePoints } from './sketchCurves';
import { expandOwned, ownerOf } from './sketchItems';

type Pt = [number, number];

export interface Placement {
    at: Pt;
    angle: number;
    scale: number;
}

export function placeOf(p: Placement): (q: Pt) => Pt {
    const r = (p.angle * Math.PI) / 180;
    const [c, s] = [Math.cos(r), Math.sin(r)];
    return ([x, y]) => [p.at[0] + p.scale * (x * c - y * s) + 0, p.at[1] + p.scale * (x * s + y * c) + 0];
}

/** Sketch coordinates back to block coordinates. */
export function unplaceOf(p: Placement): (q: Pt) => Pt {
    const r = (p.angle * Math.PI) / 180;
    const [c, s] = [Math.cos(r), Math.sin(r)];
    return ([x, y]) => {
        const [dx, dy] = [(x - p.at[0]) / p.scale, (y - p.at[1]) / p.scale];
        return [dx * c + dy * s + 0, -dx * s + dy * c + 0];
    };
}

/** The id an instance gives one of its block's entities. */
export const instanceId = (insert: string, id: string) => `${insert}.${id}`;
/** The id of an instance's insertion point. */
export const originId = (insert: string) => `${insert}.insertion`;

const SCALED = new Set(['distance', 'length', 'radius', 'diameter', 'arcLength', 'pathLength']);

/** A relation with its ids renamed (every field that names an entity). */
export function renameConstraint(k: SketchConstraint, rename: (id: string) => string): SketchConstraint {
    const out = { ...k } as SketchConstraint & Record<string, unknown>;
    for (const key of ['a', 'b', 'line', 'point', 'curve', 'about', 'vertex'] as const) {
        if (typeof out[key] === 'string') {
            out[key] = rename(out[key] as string);
        }
    }
    if (Array.isArray(out.curves)) {
        out.curves = (out.curves as string[]).map(rename);
    }
    return out;
}

/** A relation renamed, its lengths scaled (angles stay) and its label position dropped. */
function mapConstraint(k: SketchConstraint, rename: (id: string) => string, scale: number, id: string): SketchConstraint {
    const out = { ...renameConstraint(k, rename), id } as SketchConstraint & Record<string, unknown>;
    if (SCALED.has(k.kind) && 'value' in k) {
        (out as { value: number }).value = k.value * scale;
    }
    delete out.at;
    return out;
}

/** The geometry, its text, equation curves and block instances moved by `by` (block coordinates and back). */
export function shiftGeometry(g: SketchGeometry, by: Pt): SketchGeometry {
    const move = (p: Pt): Pt => [p[0] + by[0] + 0, p[1] + by[1] + 0];
    return {
        ...g,
        points: g.points.map((p) => ({ ...p, u: p.u + by[0] + 0, v: p.v + by[1] + 0 })),
        ...(g.texts ? { texts: g.texts.map((t) => (t.along?.length ? t : { ...t, at: move(t.at) })) } : {}),
        ...(g.equations ? { equations: g.equations.map((e) => ({ ...e, offset: move(e.offset ?? [0, 0]) })) } : {}),
        ...(g.inserts ? { inserts: g.inserts.map((i) => ({ ...i, at: move(i.at) })) } : {}),
    };
}

/** The block's own content: entities, relations and items, without the definitions list of the sketch. */
function contentOf(g: SketchGeometry): SketchGeometry {
    const { blocks: _b, pictures: _p, segments: _s, patterns: _q, ...rest } = g;
    return {
        ...rest,
        constraints: g.constraints.map((k) => {
            const { at: _, ...plain } = k as SketchConstraint & { at?: Pt };
            return plain as SketchConstraint;
        }),
    };
}

/** Whether block `id` holds an instance of `target`, directly or through blocks inside it. */
export function blockContains(blocks: SketchBlock[], id: string, target: string, seen = new Set<string>()): boolean {
    const block = blocks.find((b) => b.id === id);
    if (!block || seen.has(id)) {
        return false;
    }
    seen.add(id);
    return (block.geometry.inserts ?? []).some((i) => i.block === target || blockContains(blocks, i.block, target, seen));
}

/**
 * Block coordinates from entities of the sketch: the curves and points, with whole texts, equation curves and block
 * instances among them, and the relations among them only (relations to the origin, the axes, the rest of the sketch
 * and locks stay behind), moved so `insertion` is 0, 0.
 */
export function blockGeometry(g: SketchGeometry, ids: string[], insertion: Pt): SketchGeometry | string {
    const all = expandOwned(g, ids);
    const picked = new Set(all);
    const owners = new Map<string, NonNullable<ReturnType<typeof ownerOf>>>();
    for (const id of all) {
        const owner = ownerOf(g, id);
        if (owner) {
            owners.set(owner.id, owner);
        }
    }
    const texts = (g.texts ?? []).filter((t) => owners.has(t.id));
    if (texts.some((t) => t.along?.some((c) => !picked.has(c)))) {
        return 'Text that runs along curves goes into a block with those curves: select them too.';
    }
    const f = fragmentOf(g, all);
    if (!f || !f.curves.length) {
        return 'Select the sketch entities for the block.';
    }
    // A curve that starts on the sketch origin gets a point of its own there (the block cannot hold the origin).
    const usesOrigin = f.curves.some((c) => curvePointIds(c).includes(ORIGIN));
    const originCopy = 'block-origin';
    // An offset of curves goes in as plain entities (it is not rebuilt inside a block); the other items stay items.
    const ownedPts = new Set([...owners.values()].filter((o) => o.kind !== 'offset').flatMap((o) => o.owned.points));
    const content: SketchGeometry = {
        points: [
            ...f.points.map(({ fixed: _, ...p }): SketchPoint => (ownedPts.has(p.id) ? { ...p, fixed: true } : p)),
            ...(usesOrigin ? [{ id: originCopy, u: 0, v: 0 }] : []),
        ],
        curves: usesOrigin ? f.curves.map((c) => mapCurvePoints(c, (id) => (id === ORIGIN ? originCopy : id))) : f.curves,
        constraints: f.constraints,
        ...(texts.length ? { texts } : {}),
        ...((g.equations ?? []).some((e) => owners.has(e.id)) ? { equations: g.equations!.filter((e) => owners.has(e.id)) } : {}),
        ...((g.inserts ?? []).some((i) => owners.has(i.id)) ? { inserts: g.inserts!.filter((i) => owners.has(i.id)) } : {}),
    };
    return shiftGeometry(content, [-insertion[0], -insertion[1]]);
}

/** The middle of the entities' extent (the default insertion point). */
export function entitiesCentre(g: SketchGeometry, ids: string[]): Pt | null {
    return fragmentOf(g, expandOwned(g, ids))?.centre ?? null;
}

function checkPlacement(p: Placement): string | null {
    return !Number.isFinite(p.at[0]) || !Number.isFinite(p.at[1]) || !Number.isFinite(p.angle) ? 'The position and angle must be numbers.'
        : !(p.scale > 0) ? 'The scale must be above zero.' : null;
}

function freeId(prefix: string, taken: { id: string }[]): string {
    const used = new Set(taken.map((x) => x.id));
    let n = 1;
    while (used.has(`${prefix}${n}`)) {
        n += 1;
    }
    return `${prefix}${n}`;
}

/**
 * Builds (or builds again) the entities of an instance from its block, in place: entities that still exist keep
 * their ids and the relations on them; the rest of the old ones go with their relations. `blocks` are the
 * definitions (the sketch's, also for an instance inside another block's geometry).
 */
function buildInstance(g: SketchGeometry, blocks: SketchBlock[], insert: SketchBlockInsert): { g: SketchGeometry; insert: SketchBlockInsert } {
    const block = blocks.find((b) => b.id === insert.block)!;
    const place = placeOf(insert);
    const b = block.geometry;
    const pointIds = b.points.map((q) => instanceId(insert.id, q.id));
    const curveIds = b.curves.map((c) => instanceId(insert.id, c.id));
    const origin = originId(insert.id);
    // An instance made before ids followed the block: its entities were made in the block's order.
    const rename = new Map<string, string>();
    if (insert.points.length && !insert.points.every((id) => id.startsWith(`${insert.id}.`))) {
        insert.points.slice(0, pointIds.length).forEach((id, i) => rename.set(id, pointIds[i]));
        insert.curves.slice(0, curveIds.length).forEach((id, i) => rename.set(id, curveIds[i]));
    }
    const next = new Set([...pointIds, ...curveIds, origin]);
    const old = new Set([...insert.points, ...insert.curves].filter((id) => !next.has(rename.get(id) ?? id)));
    const r = (id: string) => rename.get(id) ?? id;
    const placed = new Map<string, SketchPoint>();
    b.points.forEach((q, i) => {
        const [u, v] = place([q.u, q.v]);
        placed.set(pointIds[i], { id: pointIds[i], u, v, fixed: true });
    });
    placed.set(origin, { id: origin, u: insert.at[0] + 0, v: insert.at[1] + 0, fixed: true });
    const built = new Map<string, SketchCurve>();
    b.curves.forEach((c, i) => {
        const copy = { ...mapCurvePoints(c, (id) => instanceId(insert.id, id)), id: curveIds[i] } as SketchCurve;
        const sized = copy.kind === 'circle' ? { ...copy, radius: copy.radius * insert.scale } : copy;
        built.set(curveIds[i], insert.construction ? { ...sized, construction: true } : sized);
    });
    // Replaced in place where they were, new ones at the end.
    const points = g.points.filter((p) => !old.has(p.id)).map((p) => placed.get(r(p.id)) ?? p);
    const seenP = new Set(points.map((p) => p.id));
    points.push(...[...placed.values()].filter((p) => !seenP.has(p.id)));
    const curves = g.curves.filter((c) => !old.has(c.id)).map((c) => built.get(r(c.id)) ?? c);
    const seenC = new Set(curves.map((c) => c.id));
    curves.push(...[...built.values()].filter((c) => !seenC.has(c.id)));
    const constraints = g.constraints.map((k) => (rename.size ? renameConstraint(k, r) : k)).filter((k) => !constraintRefs(k).some((id) => old.has(id)));
    const done: SketchBlockInsert = { ...insert, points: [...pointIds, origin], curves: curveIds, origin };
    const inserts = (g.inserts ?? []).some((i) => i.id === insert.id)
        ? g.inserts!.map((i) => (i.id === insert.id ? done : i)) : [...(g.inserts ?? []), done];
    return { g: { ...g, points, curves, constraints, inserts }, insert: done };
}

/** Make Block: the entities (whole texts, equation curves and blocks among them) become a block and one instance in their place. */
export function makeBlock(g: SketchGeometry, ids: string[], insertion: Pt, name: string): { g: SketchGeometry; block: SketchBlock; insert: SketchBlockInsert } | string {
    const geometry = blockGeometry(g, ids, insertion);
    if (typeof geometry === 'string') {
        return geometry;
    }
    const taken = g.blocks ?? [];
    const id = freeId('blk', taken);
    const block: SketchBlock = { id, name: name.trim() || `Block${id.slice(3)}`, geometry };
    // The originals go (with what tied them to the rest), the instance takes their place; points that other
    // curves still use stay for them.
    const curves = new Set(geometry.curves.map((c) => c.id));
    const kept = new Set(g.curves.filter((c) => !curves.has(c.id)).flatMap(curvePointIds));
    const gone = new Set([...curves, ...geometry.points.map((p) => p.id).filter((p) => !kept.has(p))]);
    const items = new Set([...(geometry.texts ?? []), ...(geometry.equations ?? []), ...(geometry.inserts ?? [])].map((x) => x.id));
    const without: SketchGeometry = {
        ...g,
        points: g.points.filter((p) => !gone.has(p.id)),
        curves: g.curves.filter((c) => !gone.has(c.id)),
        constraints: g.constraints.filter((k) => !constraintRefs(k).some((r) => gone.has(r))),
        ...(g.texts ? { texts: g.texts.filter((t) => !items.has(t.id)) } : {}),
        ...(g.equations ? { equations: g.equations.filter((e) => !items.has(e.id)) } : {}),
        ...(g.inserts ? { inserts: g.inserts.filter((i) => !items.has(i.id)) } : {}),
        blocks: [...taken, block],
    };
    const r = insertBlock(without, block.id, { at: insertion, angle: 0, scale: 1 });
    return typeof r === 'string' ? r : { g: r.g, block, insert: r.insert };
}

/** Insert Block: another instance of a block of the sketch. */
export function insertBlock(g: SketchGeometry, blockId: string, p: Placement, options: Partial<Pick<SketchBlockInsert, 'lockAngle' | 'construction'>> = {}):
    { g: SketchGeometry; insert: SketchBlockInsert } | string {
    const block = g.blocks?.find((b) => b.id === blockId);
    if (!block) {
        return 'Choose a block to insert.';
    }
    const bad = checkPlacement(p);
    if (bad) {
        return bad;
    }
    const id = freeId('ins', g.inserts ?? []);
    const insert: SketchBlockInsert = { id, block: blockId, at: [p.at[0] + 0, p.at[1] + 0], angle: p.angle, scale: p.scale, curves: [], points: [], ...options };
    return buildInstance(g, g.blocks!, insert);
}

/** Moves, turns or scales one instance, or changes its options (lock angle, construction). */
export function placeInsert(g: SketchGeometry, insertId: string, p: Placement, options: Partial<Pick<SketchBlockInsert, 'lockAngle' | 'construction' | 'hidden'>> = {}):
    SketchGeometry | string {
    const insert = g.inserts?.find((i) => i.id === insertId);
    const block = insert && g.blocks?.find((b) => b.id === insert.block);
    if (!insert || !block) {
        return 'That block instance is gone.';
    }
    const bad = checkPlacement(p);
    if (bad) {
        return bad;
    }
    return buildInstance(g, g.blocks!, { ...insert, at: [p.at[0] + 0, p.at[1] + 0], angle: p.angle, scale: p.scale, ...options }).g;
}

/** Every instance of `blockId` in `g` built again from the definitions. */
function rebuildInstances(g: SketchGeometry, blocks: SketchBlock[], blockId: string): SketchGeometry {
    let out = g;
    for (const insert of g.inserts ?? []) {
        if (insert.block === blockId) {
            out = buildInstance(out, blocks, out.inserts!.find((i) => i.id === insert.id)!).g;
        }
    }
    return out;
}

/** A changed definition: every instance of the block is built again, also inside the blocks that hold it. */
export function redefineBlock(g: SketchGeometry, blockId: string, geometry: SketchGeometry, patch: Partial<SketchBlock> = {}): SketchGeometry {
    let out: SketchGeometry = { ...g, blocks: (g.blocks ?? []).map((b) => (b.id === blockId ? { ...b, ...patch, geometry: contentOf(geometry) } : b)) };
    for (const holder of out.blocks!) {
        if ((holder.geometry.inserts ?? []).some((i) => i.block === blockId)) {
            out = redefineBlock(out, holder.id, rebuildInstances(holder.geometry, out.blocks!, blockId));
        }
    }
    return rebuildInstances(out, out.blocks!, blockId);
}

/** Changes a block's colour or link (no entity changes). */
export function setBlockProps(g: SketchGeometry, blockId: string, patch: Partial<Pick<SketchBlock, 'colour' | 'link' | 'name'>>): SketchGeometry {
    return {
        ...g,
        blocks: (g.blocks ?? []).map((b) => {
            if (b.id !== blockId) {
                return b;
            }
            const next = { ...b, ...patch } as SketchBlock & Record<string, unknown>;
            for (const [key, value] of Object.entries(patch)) {
                if (value === undefined || value === '') {
                    delete next[key];
                }
            }
            return next;
        }),
    };
}

/** The block's ids to the instance's ids (made in the block's order). */
function instanceMap(block: SketchBlock, insert: SketchBlockInsert): Map<string, string> {
    const map = new Map<string, string>();
    block.geometry.points.forEach((p, i) => map.set(p.id, insert.points[i]));
    block.geometry.curves.forEach((c, i) => map.set(c.id, insert.curves[i]));
    return map;
}

/**
 * Explode Block: this instance becomes plain entities, free to move, with the block's relations and dimensions among
 * them (lengths scaled with the instance). Text, equation curves and blocks inside it stay what they are where the
 * instance's placement allows it (text and equation curves have no angle of their own; an equation curve no scale):
 * otherwise they become plain entities too, and the message says so. The definition stays for other instances.
 */
export function explodeBlock(g: SketchGeometry, insertId: string): SketchGeometry | string {
    return explodeWithNote(g, insertId)?.g ?? 'Select a block instance to explode.';
}

export function explodeWithNote(g: SketchGeometry, insertId: string): { g: SketchGeometry; note: string | null } | null {
    const insert = g.inserts?.find((i) => i.id === insertId);
    const block = insert && g.blocks?.find((b) => b.id === insert.block);
    if (!insert || !block) {
        return null;
    }
    const map = instanceMap(block, insert);
    const r = (id: string) => map.get(id) ?? id;
    const place = placeOf(insert);
    const turned = Math.abs(((insert.angle % 360) + 360) % 360) > 1e-9 && Math.abs((((insert.angle % 360) + 360) % 360) - 360) > 1e-9;
    const dissolved: string[] = [];
    const b = block.geometry;
    // Items inside the block, in the sketch now.
    const texts: SketchText[] = [];
    for (const t of b.texts ?? []) {
        if (turned && !t.along?.length) {
            dissolved.push('text');
            continue;
        }
        texts.push({
            ...t, id: instanceId(insert.id, t.id), curves: t.curves.map(r), points: t.points.map(r), height: t.height * insert.scale,
            ...(t.along?.length ? { along: t.along.map(r) } : { at: place(t.at) }),
        });
    }
    const equations: SketchEquationCurve[] = [];
    for (const e of b.equations ?? []) {
        if (turned || Math.abs(insert.scale - 1) > 1e-12) {
            dissolved.push('equation curve');
            continue;
        }
        const off = e.offset ?? [0, 0];
        equations.push({ ...e, id: instanceId(insert.id, e.id), curves: e.curves.map(r), points: e.points.map(r), offset: [off[0] + insert.at[0] + 0, off[1] + insert.at[1] + 0] });
    }
    const nested: SketchBlockInsert[] = (b.inserts ?? []).map((i) => ({
        ...i, id: instanceId(insert.id, i.id), curves: i.curves.map(r), points: i.points.map(r), ...(i.origin ? { origin: r(i.origin) } : {}),
        at: place(i.at), angle: i.angle + insert.angle, scale: i.scale * insert.scale,
    }));
    const stillOwned = new Set([...texts, ...equations, ...nested].flatMap((x) => x.points));
    const origin = insert.origin ?? '';
    const points = g.points.filter((p) => p.id !== origin).map((p) => {
        if (!insert.points.includes(p.id) || stillOwned.has(p.id) || !p.fixed) {
            return p;
        }
        const { fixed: _, ...free } = p;
        return free;
    });
    let out: SketchGeometry = {
        ...g,
        points,
        constraints: g.constraints.filter((k) => !constraintRefs(k).includes(origin)),
        inserts: [...(g.inserts ?? []).filter((i) => i.id !== insertId), ...nested],
        ...(texts.length || g.texts ? { texts: [...(g.texts ?? []), ...texts] } : {}),
        ...(equations.length || g.equations ? { equations: [...(g.equations ?? []), ...equations] } : {}),
    };
    const constraints = [...out.constraints];
    for (const k of b.constraints) {
        if (constraintRefs(k).every((id) => map.has(id))) {
            const id = newId('k', { ...out, constraints });
            constraints.push(mapConstraint(k, r, insert.scale, id));
        }
    }
    out = { ...out, constraints };
    const kinds = [...new Set(dissolved)];
    return { g: out, note: kinds.length ? `The ${kinds.join(' and ')} inside the block became plain entities (the instance is turned or scaled).` : null };
}

/** Deletes a block definition that no instance uses. */
export function deleteBlockDefinition(g: SketchGeometry, blockId: string): SketchGeometry | string {
    if ((g.inserts ?? []).some((i) => i.block === blockId) || (g.blocks ?? []).some((b) => (b.geometry.inserts ?? []).some((i) => i.block === blockId))) {
        return 'The block is still in use: delete or explode its instances first.';
    }
    return { ...g, blocks: (g.blocks ?? []).filter((b) => b.id !== blockId) };
}

/** What a block file holds: the block, the blocks inside it, its colour. */
export interface BlockFileData {
    name: string;
    geometry: SketchGeometry;
    colour?: string;
    /** Definitions of the blocks nested in it (any depth). */
    blocks?: SketchBlock[];
}

/** The definitions a block uses inside it, at any depth. */
export function nestedDefinitions(blocks: SketchBlock[], id: string, out = new Map<string, SketchBlock>()): SketchBlock[] {
    const block = blocks.find((b) => b.id === id);
    for (const i of block?.geometry.inserts ?? []) {
        const inner = blocks.find((b) => b.id === i.block);
        if (inner && !out.has(inner.id)) {
            out.set(inner.id, inner);
            nestedDefinitions(blocks, inner.id, out);
        }
    }
    return [...out.values()];
}

/** A block as written to a file. */
export function blockFileOf(g: SketchGeometry, blockId: string, name: string): BlockFileData | null {
    const block = g.blocks?.find((b) => b.id === blockId);
    if (!block) {
        return null;
    }
    const nested = nestedDefinitions(g.blocks!, blockId).map(({ link: _, ...b }) => b);
    return { name, geometry: block.geometry, ...(block.colour ? { colour: block.colour } : {}), ...(nested.length ? { blocks: nested } : {}) };
}

const sameBlock = (a: SketchBlock, b: { name: string; geometry: SketchGeometry; colour?: string }) =>
    a.name === b.name && (a.colour ?? '') === (b.colour ?? '') && JSON.stringify(a.geometry) === JSON.stringify(b.geometry);

/**
 * Adds a block definition read from a file (a new id; the name of the file), with the blocks nested in it (one
 * already here unchanged is used again). `link`: the definition follows the file (Link to file).
 */
export function addBlockDefinition(g: SketchGeometry, name: string, geometry: SketchGeometry, extra: { colour?: string; blocks?: SketchBlock[]; link?: string } = {}):
    { g: SketchGeometry; block: SketchBlock } {
    let blocks = [...(g.blocks ?? [])];
    const ids = new Map<string, string>();
    const clean = (geom: SketchGeometry): SketchGeometry => ({
        ...contentOf(geom),
        ...(geom.inserts ? { inserts: geom.inserts.map((i) => ({ ...i, block: ids.get(i.block) ?? i.block })) } : {}),
    });
    // Nested definitions first, innermost before the blocks that hold them.
    const pending = [...(extra.blocks ?? [])];
    for (let guard = 0; pending.length && guard < 200; guard++) {
        const ready = pending.findIndex((b) => (b.geometry.inserts ?? []).every((i) => ids.has(i.block) || !pending.some((p) => p.id === i.block)));
        const next = pending.splice(ready < 0 ? 0 : ready, 1)[0];
        const def = { name: next.name, geometry: clean(next.geometry), ...(next.colour ? { colour: next.colour } : {}) };
        const known = blocks.find((b) => sameBlock(b, def));
        if (known) {
            ids.set(next.id, known.id);
            continue;
        }
        const id = freeId('blk', blocks);
        ids.set(next.id, id);
        blocks = [...blocks, { id, ...def }];
    }
    const def = { name, geometry: clean(geometry), ...(extra.colour ? { colour: extra.colour } : {}) };
    const known = blocks.find((b) => sameBlock(b, def) && (b.link ?? '') === (extra.link ?? ''));
    if (known) {
        return { g: { ...g, blocks }, block: known };
    }
    const block: SketchBlock = { id: freeId('blk', blocks), ...def, ...(extra.link ? { link: extra.link } : {}) };
    return { g: { ...g, blocks: [...blocks, block] }, block };
}

/**
 * Link to file: a linked block takes the file's content again (and the blocks nested in it); every instance is
 * built again. Null when nothing changed.
 */
export function updateFromFile(g: SketchGeometry, blockId: string, file: BlockFileData): SketchGeometry | null {
    const block = g.blocks?.find((b) => b.id === blockId);
    if (!block) {
        return null;
    }
    // The nested definitions come in (or are found); the file's own content goes under this block's id.
    const added = addBlockDefinition(g, file.name, file.geometry, { colour: file.colour, blocks: file.blocks, link: `\u0000${blockId}` });
    const content = added.block.geometry;
    const before = new Set((g.blocks ?? []).map((b) => b.id));
    const blocks = (added.g.blocks ?? []).filter((b) => before.has(b.id) || b.id !== added.block.id);
    if (JSON.stringify(content) === JSON.stringify(block.geometry) && (file.colour ?? '') === (block.colour ?? '')) {
        return null;
    }
    return redefineBlock({ ...g, blocks }, blockId, content, { colour: file.colour });
}

// ---- Edit Block: the block opened in the sketcher ---------------------------------------------------------------

/** The block's entities at an instance's insertion point (not turned or scaled, so its own relations hold as they are). */
export function blockAt(block: SketchBlock, at: Pt): SketchGeometry {
    return shiftGeometry(block.geometry, at);
}

/** The edited entities back in block coordinates. */
export function blockFrom(g: SketchGeometry, at: Pt): SketchGeometry {
    return contentOf(shiftGeometry(g, [-at[0], -at[1]]));
}

// ---- Add/Remove ------------------------------------------------------------------------------------------------

/** Makes ids not used in any of `gs`. */
function idMaker(...gs: SketchGeometry[]): (prefix: 'p' | 'c' | 'k') => string {
    const used = new Set(gs.flatMap((g) => [...g.points.map((p) => p.id), ...g.curves.map((c) => c.id), ...g.constraints.map((k) => k.id)]));
    const none: SketchGeometry = { points: [], curves: [], constraints: [] };
    return (prefix) => {
        let id = newId(prefix, none);
        while (used.has(id)) {
            id = newId(prefix, none);
        }
        used.add(id);
        return id;
    };
}

/**
 * Add/Remove (block entities): plain sketch curves in `add` go into the instance's block (every instance gets them);
 * curves of the instance in `remove` leave the block (text, equation curves and blocks inside it go whole) and stay in
 * the sketch as plain entities where this instance has them. Relations among the moved entities go with them;
 * relations between added entities and the instance become the block's own; other relations of added entities go
 * (relations inside a block cannot point outside it).
 */
export function addRemoveEntities(g: SketchGeometry, insertId: string, add: string[], remove: string[]): SketchGeometry | string {
    const insert = g.inserts?.find((i) => i.id === insertId);
    const block = insert && g.blocks?.find((b) => b.id === insert.block);
    if (!insert || !block) {
        return 'Select a block instance first.';
    }
    if (block.link) {
        return `The block is linked to the file ${block.link}: clear Link to file to change it here.`;
    }
    const map = instanceMap(block, insert);
    const back = new Map([...map].map(([k, v]) => [v, k]));
    const def = block.geometry;
    const removeCurves = new Set<string>();
    for (const id of remove) {
        const bid = back.get(id);
        if (bid && def.curves.some((c) => c.id === bid)) {
            const owner = ownerOf(def, bid);
            (owner ? owner.owned.curves : [bid]).forEach((c) => removeCurves.add(c));
        }
    }
    const addCurves = [...new Set(add)].filter((id) => !!curveOf(g, id) && !ownerOf(g, id));
    if (!removeCurves.size && !addCurves.length) {
        return 'Pick entities of the block to remove, or entities of the sketch to add.';
    }
    if (removeCurves.size >= def.curves.length && !addCurves.length) {
        return 'A block keeps at least one entity: explode it instead.';
    }
    const items = [...(def.texts ?? []), ...(def.equations ?? []), ...(def.inserts ?? [])];
    const removedItems = new Set(items.filter((x) => x.curves.some((c) => removeCurves.has(c))).map((x) => x.id));
    const keptCurves = def.curves.filter((c) => !removeCurves.has(c.id));
    const keptPoints = new Set([...keptCurves.flatMap(curvePointIds), ...items.filter((x) => !removedItems.has(x.id)).flatMap((x) => x.points)]);
    const touched = [...def.curves.filter((c) => removeCurves.has(c.id)).flatMap(curvePointIds), ...items.filter((x) => removedItems.has(x.id)).flatMap((x) => x.points)];
    const removedPoints = new Set(touched.filter((p) => !keptPoints.has(p)));
    const make = idMaker(g, def);
    let out = g;
    // The removed entities as plain entities of the sketch, where this instance has them.
    const copies = new Map<string, string>();
    for (const c of def.curves.filter((x) => removeCurves.has(x.id))) {
        for (const p of curvePointIds(c)) {
            if (removedPoints.has(p) && !copies.has(p)) {
                const at = pointOf(g, map.get(p)!)!;
                const id = make('p');
                copies.set(p, id);
                out = { ...out, points: [...out.points, { id, u: at.u, v: at.v }] };
            }
        }
        const id = make('c');
        copies.set(c.id, id);
        const copy = { ...mapCurvePoints(c, (p) => copies.get(p) ?? map.get(p)!), id } as SketchCurve;
        out = { ...out, curves: [...out.curves, copy.kind === 'circle' ? { ...copy, radius: copy.radius * insert.scale } : copy] };
    }
    const leaving = (r: string) => removeCurves.has(r) || removedPoints.has(r);
    for (const k of def.constraints.filter((x) => constraintRefs(x).some(leaving))) {
        if (constraintRefs(k).every((r) => copies.has(r) || map.has(r))) {
            out = { ...out, constraints: [...out.constraints, mapConstraint(k, (r) => copies.get(r) ?? map.get(r)!, insert.scale, make('k'))] };
        }
    }
    // The added entities in block coordinates; a point of the instance that stays in the block is used as it is.
    const unplace = unplaceOf(insert);
    const inBlock = new Map<string, string>();
    const next: SketchGeometry = {
        ...def,
        points: def.points.filter((p) => !removedPoints.has(p.id)),
        curves: keptCurves,
        constraints: def.constraints.filter((k) => !constraintRefs(k).some(leaving)),
        ...(def.texts ? { texts: def.texts.filter((t) => !removedItems.has(t.id)) } : {}),
        ...(def.equations ? { equations: def.equations.filter((e) => !removedItems.has(e.id)) } : {}),
        ...(def.inserts ? { inserts: def.inserts.filter((i) => !removedItems.has(i.id)) } : {}),
    };
    const blockRef = (id: string): string | null => {
        const own = back.get(id);
        return inBlock.get(id) ?? (own && (keptPoints.has(own) || keptCurves.some((c) => c.id === own)) ? own : null);
    };
    for (const id of addCurves) {
        const c = curveOf(g, id)!;
        for (const p of curvePointIds(c)) {
            if (blockRef(p)) {
                continue;
            }
            const q = pointOf(g, p)!;
            const [u, v] = unplace([q.u, q.v]);
            const nid = make('p');
            inBlock.set(p, nid);
            next.points = [...next.points, { id: nid, u, v }];
        }
        const nid = make('c');
        inBlock.set(id, nid);
        const copy = { ...mapCurvePoints(c, (p) => blockRef(p)!), id: nid } as SketchCurve;
        next.curves = [...next.curves, copy.kind === 'circle' ? { ...copy, radius: copy.radius / insert.scale } : copy];
    }
    // Relations of the added entities among themselves and with the instance become the block's.
    for (const k of g.constraints) {
        const refs = constraintRefs(k);
        if (k.kind !== 'fix' && refs.some((r) => inBlock.has(r)) && refs.every((r) => blockRef(r) !== null)) {
            next.constraints = [...next.constraints, mapConstraint(k, (r) => blockRef(r)!, 1 / insert.scale, make('k'))];
        }
    }
    // The added entities leave the sketch; their points stay where other curves use them.
    const added = new Set(addCurves);
    const used = new Set(out.curves.filter((c) => !added.has(c.id)).flatMap(curvePointIds));
    const gone = new Set([...addCurves, ...[...inBlock.keys()].filter((p) => !added.has(p) && !used.has(p) && p !== ORIGIN)]);
    out = {
        ...out,
        points: out.points.filter((p) => !gone.has(p.id)),
        curves: out.curves.filter((c) => !gone.has(c.id)),
        constraints: out.constraints.filter((k) => !constraintRefs(k).some((r) => gone.has(r))),
    };
    return redefineBlock(out, block.id, next);
}

/** The instance a curve or point of the sketch belongs to. */
export function insertOf(g: SketchGeometry, id: string): SketchBlockInsert | null {
    const owner = ownerOf(g, id);
    return owner?.kind === 'insert' ? g.inserts?.find((i) => i.id === owner.id) ?? null : null;
}

export const curveExists = (g: SketchGeometry, id: string) => !!curveOf(g, id) || !!pointOf(g, id);

// ---- Dragging an instance -----------------------------------------------------------------------------------------

/**
 * A press on a block instance drags it as one body: every point of it goes with the pointer (it slides), and
 * `grabbed` (the point pressed, or the nearest) is what follows the pointer when relations do not let it slide
 * (it turns about what holds it). Null when the press is not on a visible instance.
 */
export function blockDrag(g: SketchGeometry, pickId: string, raw: Pt): { points: { id: string; from: Pt }[]; grabbed: string } | null {
    const insert = insertOf(g, pickId);
    if (!insert || insert.hidden) {
        return null;
    }
    const points = insert.points.map((id) => pointOf(g, id)).filter((p): p is SketchPoint => !!p).map((p) => ({ id: p.id, from: [p.u, p.v] as Pt }));
    if (!points.length) {
        return null;
    }
    const near = points.reduce((a, b) => (Math.hypot(b.from[0] - raw[0], b.from[1] - raw[1]) < Math.hypot(a.from[0] - raw[0], a.from[1] - raw[1]) ? b : a));
    return { points, grabbed: points.some((p) => p.id === pickId) ? pickId : near.id };
}

/** The pull for a drag of an instance that cannot slide: only the grabbed point follows the pointer. */
export function grabbedTarget(drag: { points: { id: string; from: Pt }[]; grab: Pt }, grabbed: string, raw: Pt): { point: string; u: number; v: number } | null {
    const p = drag.points.find((x) => x.id === grabbed);
    return p ? { point: grabbed, u: p.from[0] + raw[0] - drag.grab[0], v: p.from[1] + raw[1] - drag.grab[1] } : null;
}
