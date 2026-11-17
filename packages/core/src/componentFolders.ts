// The assembly tree's order and folders (SolidWorks: reordering components and folders of components in an
// assembly's FeatureManager). The tree's order is project.parts' order, as SolidWorks' tree order is the assembly's
// component order (and the BOM's). A row of the tree is a design, with its instances and pattern under it; folders
// hold rows and other folders, picked in any order, and what a folder holds is one run of rows: putting rows in a
// folder brings them together. The layout rules are the part tree's (folders.ts).

import type { FeatureFolder, Part, Project } from './index';
import {
    commonSubsequence, fitFolders, folderLayout, folderNodes, layoutFolders, layoutSteps, locate, nextFolderName, normalizeFolders,
    pickItems, slot, take, type LayoutFolder, type LayoutItem, type TreePlace,
} from './folders';

type PartRef = Pick<Part, 'id' | 'instanceOf'>;
type Tree = Pick<Project, 'parts' | 'componentFolders' | 'assembly'>;

/** A change of the assembly tree: the rows (designs) in their new order and the folders. */
export interface ComponentTreeChange {
    order: string[];
    folders: FeatureFolder[] | undefined;
    /** The rows that were moved (the others keep their order). */
    moved?: string[];
}

/** The tree's rows in order: the parts that are not an instance of another part (as the tree lists them). */
export function componentRows(parts: readonly PartRef[]): string[] {
    const ids = new Set(parts.map((p) => p.id));
    return parts.filter((p) => !p.instanceOf || !ids.has(p.instanceOf)).map((p) => p.id);
}

/** The row each part shows in: its own, or for an instance the design it is an instance of. */
export function componentRowOf(parts: readonly PartRef[]): Map<string, string> {
    const byId = new Map(parts.map((p) => [p.id, p]));
    const out = new Map<string, string>();
    for (const part of parts) {
        let at = part;
        for (const seen = new Set<string>(); at.instanceOf && byId.has(at.instanceOf) && !seen.has(at.id);) {
            seen.add(at.id);
            at = byId.get(at.instanceOf)!;
        }
        out.set(part.id, at.id);
    }
    return out;
}

/** The tree as rows and folders (see folderLayout: folders are made consistent with the rows). */
export function componentLayout(parts: readonly PartRef[], folders: readonly FeatureFolder[] | undefined): LayoutItem[] {
    return folderLayout(componentRows(parts), folders);
}

/**
 * The parts reordered so the rows stand in `order`. The rows that keep their order (all but `moved`, else as many as
 * can) stay where they are with their instances; a row that moved goes in just above the row that now follows it (at
 * the end when none does), its design first and its instances after it.
 */
export function partsInRowOrder<T extends PartRef>(parts: readonly T[], order: readonly string[], moved?: readonly string[]): T[] {
    const rows = componentRows(parts);
    if (order.length !== rows.length || new Set(order).size !== order.length || order.some((id) => !rows.includes(id))) {
        throw new Error('The new order must list every component of the tree once.');
    }
    if (rows.every((id, i) => id === order[i])) {
        return [...parts];
    }
    const rowOf = componentRowOf(parts);
    const isRow = new Set(rows);
    const stay = moved ? rows.filter((id) => !moved.includes(id)) : null;
    const inOrder = stay && order.filter((id) => stay.includes(id)).every((id, i) => id === stay[i]);
    const kept = new Set(inOrder ? stay : commonSubsequence(rows, order));
    // Parts outside any row (an instance loop, never made by the tools) stay where they are.
    const list = parts.filter((p) => kept.has(rowOf.get(p.id)!) || !isRow.has(rowOf.get(p.id)!));
    for (let i = order.length - 1; i >= 0; i--) {
        const row = order[i];
        if (kept.has(row)) {
            continue;
        }
        const block = parts.filter((p) => rowOf.get(p.id) === row);
        block.sort((a, b) => Number(b.id === row) - Number(a.id === row));
        const next = i + 1 < order.length ? list.findIndex((p) => p.id === order[i + 1]) : -1;
        list.splice(next >= 0 ? next : list.length, 0, ...block);
    }
    return list;
}

/** A folder or row id as the tree takes it; an instance stands for its design's row only where `instances` says so. */
function treeId(parts: readonly PartRef[], root: LayoutItem[], id: string, instances: 'row' | 'refuse'): string {
    if (folderNodes(root).has(id)) {
        return id;
    }
    const row = componentRowOf(parts).get(id);
    if (row === undefined) {
        throw new Error(`No component or folder "${id}".`);
    }
    if (row !== id && instances === 'refuse') {
        throw new Error(`${id} is an instance of ${row}: it stays under ${row} in the tree. Move ${row} instead.`);
    }
    return row;
}

function treePlace(parts: readonly PartRef[], root: LayoutItem[], place: TreePlace): TreePlace {
    if ('before' in place) {
        return { before: treeId(parts, root, place.before, 'row') };
    }
    if ('after' in place) {
        return { after: treeId(parts, root, place.after, 'row') };
    }
    if (place.into !== null && place.into !== undefined && !folderNodes(root).has(place.into)) {
        throw new Error(`No component folder "${place.into}".`);
    }
    return place;
}

function changeOf(root: LayoutItem[], moved?: readonly LayoutItem[]): ComponentTreeChange {
    return { order: layoutSteps(root), folders: layoutFolders(root), ...(moved ? { moved: layoutSteps(moved) } : {}) };
}

/**
 * Moves components and folders (`ids`, anywhere in the tree) to `place`, together and in tree order. A design takes
 * its instances and pattern with it; an instance cannot move on its own.
 */
export function moveComponents(parts: readonly PartRef[], folders: readonly FeatureFolder[] | undefined, ids: readonly string[],
    place: TreePlace): ComponentTreeChange {
    const root = componentLayout(parts, folders);
    const items = pickItems(root, ids.map((id) => treeId(parts, root, id, 'refuse')));
    const target = treePlace(parts, root, place);
    const anchor = 'before' in target ? target.before : 'after' in target ? target.after : target.into;
    if (anchor && items.some((it) => it.id === anchor || (it.kind === 'folder' && locate(it.items, anchor)))) {
        throw new Error('into' in target ? 'A folder cannot go into itself.' : 'Items cannot be placed next to themselves.');
    }
    items.forEach((it) => take(root, it.id));
    const { list, index } = slot(root, target);
    list.splice(index, 0, ...items);
    return changeOf(root, items);
}

/**
 * Puts the rows in a new order given as a list: every design once (instances follow their design), or every part
 * once (the exact order of the parts, instances included). Folders keep what they hold where they can (fitFolders).
 */
export function reorderComponents(parts: readonly PartRef[], folders: readonly FeatureFolder[] | undefined, ids: readonly string[]): {
    parts: string[]; folders: FeatureFolder[] | undefined;
} {
    const rows = componentRows(parts);
    const all = parts.map((p) => p.id);
    const complete = (list: readonly string[]) => ids.length === list.length && new Set(ids).size === ids.length && list.every((id) => ids.includes(id));
    let order: string[];
    if (complete(rows)) {
        order = partsInRowOrder(parts, ids).map((p) => p.id);
    } else if (complete(all)) {
        order = [...ids];
    } else {
        const missing = rows.filter((id) => !ids.includes(id));
        const unknown = ids.filter((id) => !all.includes(id));
        throw new Error('ids must list every component that is not an instance once (or every part once)'
            + `${missing.length ? `; missing ${missing.join(', ')}` : ''}${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}.`);
    }
    const byId = new Map(parts.map((p) => [p.id, p]));
    return { parts: order, folders: fitFolders(rows, componentRows(order.map((id) => byId.get(id)!)), folders) };
}

/**
 * Adds folder `id`. With `items` (components and folders anywhere in the tree, in any order) the folder goes where
 * the first of them is in the tree and takes them all; without, it is empty, at `place` (default: the end).
 */
export function addComponentFolder(parts: readonly PartRef[], folders: readonly FeatureFolder[] | undefined,
    spec: { id: string; name: string; items?: readonly string[]; place?: TreePlace }): ComponentTreeChange {
    const root = componentLayout(parts, folders);
    if (locate(root, spec.id) || parts.some((p) => p.id === spec.id)) {
        throw new Error(`The id "${spec.id}" is in use.`);
    }
    const node: LayoutFolder = { kind: 'folder', id: spec.id, name: spec.name.trim() || 'Folder', items: [] };
    if (!spec.items?.length) {
        const { list, index } = slot(root, treePlace(parts, root, spec.place ?? { into: null }));
        list.splice(index, 0, node);
        return changeOf(root);
    }
    const picked = pickItems(root, spec.items.map((id) => treeId(parts, root, id, 'refuse')));
    const first = locate(root, picked[0].id)!;
    first.list.splice(first.index, 0, node);
    picked.forEach((it) => take(root, it.id));
    node.items = picked;
    // The first pick stays where it was; the others come to it.
    return changeOf(root, picked.slice(1));
}

/** Removes folders; what they hold stays where it is, in the folder above or at the top of the tree. */
export function removeComponentFolders(parts: readonly PartRef[], folders: readonly FeatureFolder[] | undefined, ids: readonly string[]): ComponentTreeChange {
    const root = componentLayout(parts, folders);
    for (const id of ids) {
        const found = locate(root, id);
        const node = found?.list[found.index];
        if (!found || node?.kind !== 'folder') {
            throw new Error(`No component folder "${id}".`);
        }
        found.list.splice(found.index, 1, ...node.items);
    }
    return changeOf(root);
}

/** A free id for a new folder: "folder_" and the name ("Folder3" gives folder_folder3), never a part's id. */
export function componentFolderId(name: string, parts: readonly PartRef[], folders: readonly FeatureFolder[] | undefined): string {
    const used = new Set([...parts.map((p) => p.id), ...(folders ?? []).map((f) => f.id)]);
    const base = `folder_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'folder'}`;
    let id = base;
    for (let n = 2; used.has(id); n++) {
        id = `${base}-${n}`;
    }
    return id;
}

/** The next free default name: Folder1, Folder2, ... */
export const nextComponentFolderName = nextFolderName;

/** The parts a folder holds, its sub-folders' included, with the instances of its designs, in the parts' order. */
export function componentFolderParts(parts: readonly PartRef[], folders: readonly FeatureFolder[] | undefined, id: string): string[] {
    const node = folderNodes(componentLayout(parts, folders)).get(id);
    if (!node) {
        return [];
    }
    const rows = new Set(layoutSteps(node.items));
    const rowOf = componentRowOf(parts);
    return parts.filter((p) => rows.has(rowOf.get(p.id)!)).map((p) => p.id);
}

/**
 * The fixed parts written out when an order would change which part is fixed by default: with no fixed list, the
 * first part is fixed (mates/solver.ts fixedParts), so the part that was first stays the fixed one.
 */
export function keepFixedParts(project: Tree, before: readonly PartRef[]): void {
    const was = before[0]?.id;
    if (project.assembly?.fixed || was === undefined || project.parts[0]?.id === was || !project.parts.some((p) => p.id === was)) {
        return;
    }
    project.assembly = { mates: [], ...project.assembly, fixed: [was] };
}

function setFolders(project: Pick<Project, 'componentFolders'>, folders: FeatureFolder[] | undefined): void {
    if (folders?.length) {
        project.componentFolders = folders;
    } else {
        delete project.componentFolders;
    }
}

/** Applies a tree change to a project: the parts in the new order (the fixed part kept) and the folders. */
export function applyComponentChange(project: Tree, change: ComponentTreeChange): void {
    const before = project.parts;
    project.parts = partsInRowOrder(project.parts, change.order, change.moved);
    keepFixedParts(project, before);
    setFolders(project, change.folders);
}

/** Puts the parts in an exact order (every part once) with the given folders, the fixed part kept. */
export function applyPartsOrder(project: Tree, order: readonly string[], folders: FeatureFolder[] | undefined): void {
    const before = project.parts;
    const byId = new Map(before.map((p) => [p.id, p]));
    project.parts = order.map((id) => byId.get(id)!);
    keepFixedParts(project, before);
    setFolders(project, folders);
}

/**
 * The folders of `next` fitted to its rows after an edit of `prev` (ProjectStore.mutate): parts that are gone leave
 * their folders (which stay), new parts go outside them, and folders an edit set are made consistent.
 */
export function fitComponentFolders(prev: Pick<Project, 'parts' | 'componentFolders'>, next: Pick<Project, 'parts' | 'componentFolders'>): void {
    if (!prev.componentFolders?.length && !next.componentFolders?.length) {
        return;
    }
    const ids = componentRows(next.parts);
    const was = componentRows(prev.parts);
    const untouched = JSON.stringify(prev.componentFolders ?? null) === JSON.stringify(next.componentFolders ?? null);
    if (untouched && was.length === ids.length && was.every((id, i) => id === ids[i])) {
        return;
    }
    let folders: FeatureFolder[] | undefined;
    try {
        folders = untouched ? fitFolders(was, ids, prev.componentFolders) : normalizeFolders(ids, next.componentFolders);
    } catch {
        // Never in the way of an edit: at worst the folders are rebuilt from what they say.
        folders = normalizeFolders(ids, untouched ? prev.componentFolders : next.componentFolders);
    }
    setFolders(next, folders);
}

/** Makes the folders consistent with the parts (a project read from disk): unknown ids and repeats dropped. */
export function repairComponentFolders(project: Pick<Project, 'parts' | 'componentFolders'>): void {
    if (project.componentFolders !== undefined) {
        setFolders(project, Array.isArray(project.componentFolders) ? normalizeFolders(componentRows(project.parts ?? []), project.componentFolders) : undefined);
    }
}
