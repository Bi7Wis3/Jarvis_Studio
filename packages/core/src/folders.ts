// Feature tree folders (SolidWorks user folders in a part): named, nestable groups of history steps. The history
// order stays the truth; a folder says which run of it it holds. Everything here keeps one rule: what a folder holds,
// its sub-folders included, is one unbroken run of the history, so grouping never changes parent/child order.
//
// The tree is worked on as a layout: the steps in history order with the folders wrapped round them. Operations
// edit the layout and write it back as the step order and the folder list.

import type { Feature, FeatureFolder, Part, Project } from './index';
import { absorbedSketches, consumedSketches } from './visibility';

export interface LayoutStep {
    kind: 'step';
    id: string;
}

export interface LayoutFolder {
    kind: 'folder';
    id: string;
    name: string;
    items: LayoutItem[];
}

export type LayoutItem = LayoutStep | LayoutFolder;

/** Where items go: just before or after a step or folder, or at the start or end of a folder (null: the tree). */
export type TreePlace = { before: string } | { after: string } | { into: string | null; at?: 'start' | 'end' };

/** A tree edit: the new step order and folders (undefined when there are none). */
export interface TreeChange {
    order: string[];
    folders: FeatureFolder[] | undefined;
}

const DEFAULT_NAME = 'Folder';

function uniqueId(base: string, used: Set<string>): string {
    let id = base;
    for (let n = 2; used.has(id); n++) {
        id = `${base}-${n}`;
    }
    used.add(id);
    return id;
}

/**
 * The layout of `stepIds` (history order) with `folders` round them. Whatever the folders say is made consistent:
 * unknown ids are dropped, a step or folder is held by the first folder that names it, cycles are broken, and a
 * folder whose steps are not one run is split into one folder per run (same name). Empty folders keep their place:
 * a nested one by its parent's item order, a top-level one by `before`.
 */
export function folderLayout(stepIds: readonly string[], folders: readonly FeatureFolder[] | undefined): LayoutItem[] {
    const steps = new Set(stepIds);
    const byId = new Map<string, FeatureFolder>();
    for (const f of folders ?? []) {
        if (f && typeof f.id === 'string' && f.id && !byId.has(f.id) && !steps.has(f.id)) {
            byId.set(f.id, f);
        }
    }
    const stepFolder = new Map<string, string>();
    const parentOf = new Map<string, string>();
    const itemOrder = new Map<string, string[]>();
    /** Is `a` the folder `b` or one of its ancestors? */
    const above = (a: string, b: string): boolean => {
        for (let at: string | undefined = b; at !== undefined; at = parentOf.get(at)) {
            if (at === a) {
                return true;
            }
        }
        return false;
    };
    for (const f of byId.values()) {
        const list: string[] = [];
        for (const item of Array.isArray(f.items) ? f.items : []) {
            if (typeof item !== 'string') {
                continue;
            }
            if (steps.has(item)) {
                if (!stepFolder.has(item)) {
                    stepFolder.set(item, f.id);
                    list.push(item);
                }
            } else if (byId.has(item) && !parentOf.has(item) && !above(item, f.id)) {
                parentOf.set(item, f.id);
                list.push(item);
            }
        }
        itemOrder.set(f.id, list);
    }
    const pathOf = (id: string): string[] => {
        const path: string[] = [];
        for (let at = stepFolder.get(id); at !== undefined; at = parentOf.get(at)) {
            path.unshift(at);
        }
        return path;
    };
    const nameOf = (f: FeatureFolder): string => (typeof f.name === 'string' && f.name.trim() ? f.name : DEFAULT_NAME);

    const root: LayoutItem[] = [];
    const used = new Set<string>([...steps, ...byId.keys()]);
    // The first node made for each folder; a later run of the same folder becomes a copy with an id of its own.
    const first = new Map<string, LayoutFolder>();
    const stack: { id: string; node: LayoutFolder }[] = [];
    const container = () => (stack.length ? stack[stack.length - 1].node.items : root);
    for (const id of stepIds) {
        const path = pathOf(id);
        let k = 0;
        while (k < stack.length && k < path.length && stack[k].id === path[k]) {
            k++;
        }
        stack.length = k;
        for (let d = k; d < path.length; d++) {
            const f = byId.get(path[d])!;
            const node: LayoutFolder = { kind: 'folder', id: first.has(f.id) ? uniqueId(f.id, used) : f.id, name: nameOf(f), items: [] };
            if (!first.has(f.id)) {
                first.set(f.id, node);
            }
            container().push(node);
            stack.push({ id: f.id, node });
        }
        container().push({ kind: 'step', id });
    }

    // Folders that hold no step: in their parent after the item they followed there, or above their `before` step.
    const place = (f: FeatureFolder): void => {
        if (first.has(f.id)) {
            return;
        }
        const node: LayoutFolder = { kind: 'folder', id: f.id, name: nameOf(f), items: [] };
        const parent = parentOf.get(f.id);
        if (parent !== undefined) {
            place(byId.get(parent)!);
            first.set(f.id, node);
            const into = first.get(parent)!.items;
            const order = itemOrder.get(parent)!;
            let at = 0;
            for (let i = order.indexOf(f.id) - 1; i >= 0; i--) {
                const found = into.findIndex((item) => item.id === order[i]);
                if (found >= 0) {
                    at = found + 1;
                    break;
                }
            }
            into.splice(at, 0, node);
            return;
        }
        first.set(f.id, node);
        const anchor = typeof f.before === 'string' && steps.has(f.before)
            ? root.findIndex((item) => holdsStep(item, f.before!))
            : -1;
        root.splice(anchor >= 0 ? anchor : root.length, 0, node);
    };
    byId.forEach(place);
    return root;
}

function holdsStep(item: LayoutItem, id: string): boolean {
    return item.kind === 'step' ? item.id === id : item.items.some((child) => holdsStep(child, id));
}

/** The step ids of a layout (or of one folder's items) in order. */
export function layoutSteps(items: readonly LayoutItem[]): string[] {
    const out: string[] = [];
    const walk = (list: readonly LayoutItem[]) => {
        for (const item of list) {
            if (item.kind === 'step') {
                out.push(item.id);
            } else {
                walk(item.items);
            }
        }
    };
    walk(items);
    return out;
}

/** The folder list a layout stands for (parents before their sub-folders), undefined when it has none. */
export function layoutFolders(items: readonly LayoutItem[]): FeatureFolder[] | undefined {
    const out: FeatureFolder[] = [];
    const order = layoutSteps(items);
    let seen = 0;
    const walk = (list: readonly LayoutItem[], top: boolean) => {
        for (const item of list) {
            if (item.kind === 'step') {
                seen++;
                continue;
            }
            const folder: FeatureFolder = { id: item.id, name: item.name, items: item.items.map((child) => child.id) };
            const empty = layoutSteps(item.items).length === 0;
            if (top && empty && seen < order.length) {
                folder.before = order[seen];
            }
            out.push(folder);
            walk(item.items, false);
        }
    };
    walk(items, true);
    return out.length ? out : undefined;
}

/** The folders made consistent with the step order (see folderLayout). */
export function normalizeFolders(stepIds: readonly string[], folders: readonly FeatureFolder[] | undefined): FeatureFolder[] | undefined {
    return folders?.length ? layoutFolders(folderLayout(stepIds, folders)) : undefined;
}

/** Folder nodes of a layout by id. */
function folderNodes(items: readonly LayoutItem[], out = new Map<string, LayoutFolder>()): Map<string, LayoutFolder> {
    for (const item of items) {
        if (item.kind === 'folder') {
            out.set(item.id, item);
            folderNodes(item.items, out);
        }
    }
    return out;
}

/** The container (folder node, or null for the tree) of every item, by item object. */
function parents(items: LayoutItem[], parent: LayoutFolder | null = null, out = new Map<LayoutItem, LayoutFolder | null>()) {
    for (const item of items) {
        out.set(item, parent);
        if (item.kind === 'folder') {
            parents(item.items, item, out);
        }
    }
    return out;
}

/** Longest common subsequence of two id lists (common start and end trimmed first, as most edits are local). */
function commonSubsequence(a: readonly string[], b: readonly string[]): string[] {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        start++;
    }
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) {
        end++;
    }
    const x = a.slice(start, a.length - end);
    const y = b.slice(start, b.length - end);
    const w = y.length + 1;
    const table = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
        for (let j = y.length - 1; j >= 0; j--) {
            table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
        }
    }
    const middle: string[] = [];
    for (let i = 0, j = 0; i < x.length && j < y.length;) {
        if (x[i] === y[j]) {
            middle.push(x[i]);
            i++;
            j++;
        } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return [...a.slice(0, start), ...middle, ...a.slice(a.length - end)];
}

/**
 * The folders after the step order changed from `before` to `after` by an edit that did not say where folders go
 * (a reorder, steps added or removed). Steps that kept their order keep their folder. A step that moved or is new
 * lands where it now stands: inside a folder when it sits between two of that folder's steps; at a folder's edge it
 * stays in the folder it came from (a new step stays outside). A folder whose steps all moved goes with them.
 * Removed steps leave their folder, which stays (empty) where it was.
 */
export function fitFolders(before: readonly string[], after: readonly string[], folders: readonly FeatureFolder[] | undefined): FeatureFolder[] | undefined {
    if (!folders?.length) {
        return undefined;
    }
    const tree = folderLayout(before, folders);
    if (before.length === after.length && before.every((id, i) => id === after[i])) {
        return layoutFolders(tree);
    }
    const now = new Set(after);
    const was = new Set(before);
    const kept = new Set(commonSubsequence(before.filter((id) => now.has(id)), after.filter((id) => was.has(id))));
    // The folders each old step was in (outermost first), by node.
    const up = parents(tree);
    const oldChain = new Map<string, LayoutFolder[]>();
    const chainOf = (item: LayoutItem): LayoutFolder[] => {
        const chain: LayoutFolder[] = [];
        for (let at = up.get(item); at; at = up.get(at)) {
            chain.unshift(at);
        }
        return chain;
    };
    for (const [item] of up) {
        if (item.kind === 'step') {
            oldChain.set(item.id, chainOf(item));
        }
    }
    // Only the steps that kept their order stay in place; the others are put back one by one.
    const prune = (list: LayoutItem[]): LayoutItem[] => list.filter((item) => {
        if (item.kind === 'step') {
            return kept.has(item.id);
        }
        item.items = prune(item.items);
        return true;
    });
    const root = prune(tree);
    const parentOf = parents(root);
    const stepNode = new Map<string, LayoutStep>();
    for (const [item] of parentOf) {
        if (item.kind === 'step') {
            stepNode.set(item.id, item);
        }
    }
    const chain = (item: LayoutItem): LayoutFolder[] => {
        const list: LayoutFolder[] = [];
        for (let at = parentOf.get(item) ?? null; at; at = parentOf.get(at) ?? null) {
            list.unshift(at);
        }
        return list;
    };
    const itemsOf = (folder: LayoutFolder | null) => (folder ? folder.items : root);
    /** The child of `container` that is or holds `item`. */
    const branch = (container: LayoutFolder | null, item: LayoutItem): LayoutItem => {
        let at: LayoutItem = item;
        for (let up = parentOf.get(at) ?? null; up !== container; up = parentOf.get(at) ?? null) {
            if (!up) {
                return at;
            }
            at = up;
        }
        return at;
    };
    const insert = (item: LayoutItem, container: LayoutFolder | null, index: number) => {
        itemsOf(container).splice(index, 0, item);
        parentOf.set(item, container);
    };
    const detach = (item: LayoutItem) => {
        const list = itemsOf(parentOf.get(item) ?? null);
        list.splice(list.indexOf(item), 1);
    };
    const hasStep = (folder: LayoutFolder): boolean => layoutSteps(folder.items).length > 0;

    after.forEach((id, i) => {
        if (kept.has(id)) {
            return;
        }
        const prev = i > 0 ? stepNode.get(after[i - 1]) : undefined;
        let next: LayoutStep | undefined;
        for (let j = i + 1; j < after.length && !next; j++) {
            next = kept.has(after[j]) ? stepNode.get(after[j]) : undefined;
        }
        const p = prev ? chain(prev) : [];
        const q = next ? chain(next) : [];
        let common = 0;
        while (common < p.length && common < q.length && p[common] === q[common]) {
            common++;
        }
        // Where the step may go: after `prev` in its folder or any outer one down to the common folder, or before
        // `next` in the common folder or any inner one up to next's.
        const spots: { container: LayoutFolder | null; depth: number; side: 'p' | 'q' }[] = [];
        if (prev) {
            for (let d = p.length; d >= common; d--) {
                spots.push({ container: d ? p[d - 1] : null, depth: d, side: 'p' });
            }
        }
        if (next) {
            for (let d = prev ? common + 1 : common; d <= q.length; d++) {
                spots.push({ container: d ? q[d - 1] : null, depth: d, side: 'q' });
            }
        }
        if (!spots.length) {
            spots.push({ container: null, depth: 0, side: 'p' });
        }
        // The deepest of those that is one of the folders the step was in; else the common folder.
        const old = oldChain.get(id) ?? [];
        let spot = spots.find((s) => s.depth === common) ?? spots[0];
        let deepest = -1;
        for (const s of spots) {
            const at = s.container ? old.indexOf(s.container) : -1;
            if (at > deepest) {
                deepest = at;
                spot = s;
            }
        }
        const indexAt = (s: typeof spot): number => {
            const list = itemsOf(s.container);
            if (s.side === 'p' && prev) {
                return list.indexOf(branch(s.container, prev)) + 1;
            }
            return next ? list.indexOf(branch(s.container, next)) : list.length;
        };
        let container = spot.container;
        let index = indexAt(spot);
        // An old folder of the step (below that one) that holds no step now: its steps all moved, and it goes with
        // them; the step goes into the folder it was directly in, inside it.
        const rest = old.slice(deepest + 1);
        if (rest.length && !hasStep(rest[0])) {
            detach(rest[0]);
            insert(rest[0], container, indexAt(spot));
            container = rest[rest.length - 1];
            index = container.items.length;
        }
        const node: LayoutStep = { kind: 'step', id };
        insert(node, container, index);
        stepNode.set(id, node);
    });
    return layoutFolders(root);
}

/** The folders of every part of `next` fitted to its step order, after an edit of `prev` (ProjectStore.mutate). */
export function fitProjectFolders(prev: Pick<Project, 'parts'>, next: Pick<Project, 'parts'>): void {
    for (const part of next.parts) {
        const old = prev.parts.find((p) => p.id === part.id);
        if (!part.folders?.length && !old?.folders?.length) {
            continue;
        }
        const ids = (part.features ?? []).map((f) => f.id);
        const untouched = JSON.stringify(old?.folders ?? null) === JSON.stringify(part.folders ?? null);
        const was = (old?.features ?? []).map((f) => f.id);
        if (untouched && was.length === ids.length && was.every((id, i) => id === ids[i])) {
            continue;
        }
        let folders: FeatureFolder[] | undefined;
        try {
            folders = untouched && old ? fitFolders(was, ids, old.folders) : normalizeFolders(ids, part.folders);
        } catch {
            // Never in the way of an edit: at worst the folders are rebuilt from what they say.
            folders = normalizeFolders(ids, untouched ? old?.folders : part.folders);
        }
        setFolders(part, folders);
    }
}

/** Makes every part's folders consistent with its steps (a project read from disk). */
export function repairProjectFolders(project: Pick<Project, 'parts'>): void {
    for (const part of project.parts ?? []) {
        if (part.folders !== undefined) {
            setFolders(part, Array.isArray(part.folders) ? normalizeFolders((part.features ?? []).map((f) => f.id), part.folders) : undefined);
        }
    }
}

function setFolders(part: Part, folders: FeatureFolder[] | undefined): void {
    if (folders?.length) {
        part.folders = folders;
    } else {
        delete part.folders;
    }
}

// ---- Steps and what they build on ----

const REF_KEYS = ['sketchRef', 'planeRef', 'axisRef', 'pointRef'];

/** Ids of the steps a step refers to: sketches, planes, axes and points by reference, and repeated steps. */
export function stepDeps(feature: Feature): string[] {
    const ids = new Set<string>();
    const scan = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(scan);
        } else if (value && typeof value === 'object') {
            for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
                if (REF_KEYS.includes(key) && typeof v === 'string') {
                    ids.add(v);
                } else {
                    scan(v);
                }
            }
        }
    };
    const { id: _id, name: _name, suppressed: _s, ...body } = feature;
    scan(body);
    if ((feature.op === 'pattern' || feature.op === 'mirror') && Array.isArray(feature.features)) {
        feature.features.forEach((id) => ids.add(id));
    }
    return [...ids];
}

/** What is wrong with a step order: the first step that uses a step not above it, or null. */
export function orderProblem(features: readonly Feature[]): string | null {
    const all = new Set(features.map((f) => f.id));
    const seen = new Set<string>();
    for (const f of features) {
        const late = stepDeps(f).find((id) => all.has(id) && !seen.has(id));
        if (late) {
            return `${f.name ?? f.id} uses ${features.find((g) => g.id === late)?.name ?? late}, which would then be below it`;
        }
        seen.add(f.id);
    }
    return null;
}

/**
 * `ids` with the sketch steps they are built from that nothing else uses (the sketches the tree shows under them),
 * which move with them.
 */
export function withAbsorbed(features: readonly Feature[], ids: readonly string[]): string[] {
    const out = new Set(ids);
    const byId = new Map(features.map((f) => [f.id, f]));
    for (const id of ids) {
        const f = byId.get(id);
        for (const sketch of f ? consumedSketches(f) : []) {
            if (byId.get(sketch)?.op !== 'sketch' || out.has(sketch)) {
                continue;
            }
            if (features.every((g) => g.id === sketch || !stepDeps(g).includes(sketch) || out.has(g.id))) {
                out.add(sketch);
            }
        }
    }
    return [...out];
}

// ---- Tree edits ----

function reordered(features: readonly Feature[], order: readonly string[]): Feature[] {
    const byId = new Map(features.map((f) => [f.id, f]));
    return order.map((id) => byId.get(id)!);
}

function change(features: readonly Feature[], root: LayoutItem[]): TreeChange {
    const order = layoutSteps(root);
    const problem = orderProblem(reordered(features, order));
    if (problem) {
        throw new Error(`That order does not work: ${problem}. A step can only use steps above it.`);
    }
    return { order, folders: layoutFolders(root) };
}

/** Takes the item with `id` (a step or folder) out of the layout; null when there is none. */
function take(root: LayoutItem[], id: string): LayoutItem | null {
    for (let i = 0; i < root.length; i++) {
        const item = root[i];
        if (item.id === id) {
            root.splice(i, 1);
            return item;
        }
        if (item.kind === 'folder') {
            const found = take(item.items, id);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

/** The list that holds the item with `id` and its index there. */
function locate(root: LayoutItem[], id: string): { list: LayoutItem[]; index: number } | null {
    const index = root.findIndex((item) => item.id === id);
    if (index >= 0) {
        return { list: root, index };
    }
    for (const item of root) {
        if (item.kind === 'folder') {
            const found = locate(item.items, id);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

function slot(root: LayoutItem[], place: TreePlace): { list: LayoutItem[]; index: number } {
    if ('before' in place || 'after' in place) {
        const id = 'before' in place ? place.before : place.after;
        const found = locate(root, id);
        if (!found) {
            throw new Error(`No step or folder "${id}" to place them by.`);
        }
        return { list: found.list, index: found.index + ('after' in place ? 1 : 0) };
    }
    if (place.into === null || place.into === undefined) {
        return { list: root, index: place.at === 'start' ? 0 : root.length };
    }
    const folder = folderNodes(root).get(place.into);
    if (!folder) {
        throw new Error(`No folder "${place.into}".`);
    }
    return { list: folder.items, index: place.at === 'start' ? 0 : folder.items.length };
}

/** Steps and folders of `ids` in tree order, leaving out those inside another of them; throws on an unknown id. */
function pickItems(root: LayoutItem[], ids: readonly string[]): LayoutItem[] {
    const wanted = new Set(ids);
    const found = new Set<string>();
    const out: LayoutItem[] = [];
    const walk = (list: LayoutItem[], inside: boolean) => {
        for (const item of list) {
            const hit = wanted.has(item.id);
            if (hit) {
                found.add(item.id);
                if (!inside) {
                    out.push(item);
                }
            }
            if (item.kind === 'folder') {
                walk(item.items, inside || hit);
            }
        }
    };
    walk(root, false);
    const missing = ids.find((id) => !found.has(id));
    if (missing) {
        throw new Error(`No step or folder "${missing}".`);
    }
    return out;
}

/**
 * Moves steps and folders (`ids`, with the sketches only they use) to `place`. The history order changes as the tree
 * does; an order where a step would use one below it is refused.
 */
export function moveItems(features: readonly Feature[], folders: readonly FeatureFolder[] | undefined, ids: readonly string[], place: TreePlace): TreeChange {
    const root = folderLayout(features.map((f) => f.id), folders);
    const items = pickItems(root, withAbsorbed(features, ids));
    const anchor = 'before' in place ? place.before : 'after' in place ? place.after : place.into;
    if (anchor && items.some((it) => it.id === anchor || (it.kind === 'folder' && locate(it.items, anchor)))) {
        throw new Error('into' in place ? 'A folder cannot go into itself.' : 'Items cannot be placed next to themselves.');
    }
    // The place is found after the items are taken out, so it stays next to the same neighbour.
    items.forEach((it) => take(root, it.id));
    const { list, index } = slot(root, place);
    list.splice(index, 0, ...items);
    return change(features, root);
}

/** A free folder id from a name ("Folder3" gives folder3), not used by a step or folder. */
export function folderId(name: string, features: readonly Feature[], folders: readonly FeatureFolder[] | undefined): string {
    const used = new Set([...features.map((f) => f.id), ...(folders ?? []).map((f) => f.id)]);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'folder';
    return uniqueId(base, used);
}

/** The next free default name: Folder1, Folder2, ... */
export function nextFolderName(folders: readonly FeatureFolder[] | undefined): string {
    let n = 0;
    for (const f of folders ?? []) {
        const m = /^Folder(\d+)$/.exec(f.name);
        if (m) {
            n = Math.max(n, Number(m[1]));
        }
    }
    return `${DEFAULT_NAME}${n + 1}`;
}

/**
 * Adds folder `id`. With `items` (steps or folders that follow one another at one level of the tree; the sketches the
 * tree shows under a step count as part of it) the folder takes them, where they are; without, it is empty, at
 * `place` (default: the end of the tree).
 */
export function addFolder(features: readonly Feature[], folders: readonly FeatureFolder[] | undefined,
    spec: { id: string; name: string; items?: readonly string[]; place?: TreePlace }): TreeChange {
    const root = folderLayout(features.map((f) => f.id), folders);
    if (locate(root, spec.id)) {
        throw new Error(`The id "${spec.id}" is in use.`);
    }
    const node: LayoutFolder = { kind: 'folder', id: spec.id, name: spec.name.trim() || DEFAULT_NAME, items: [] };
    if (!spec.items?.length) {
        const { list, index } = slot(root, spec.place ?? { into: null });
        list.splice(index, 0, node);
        return change(features, root);
    }
    const nested = absorbedSketches(features);
    const picked = pickItems(root, spec.items);
    const rows = picked.filter((it) => it.kind === 'folder' || !nested.has(it.id));
    const heads = rows.length ? rows : picked;
    const where = locate(root, heads[0].id)!;
    const siblings = where.list;
    // The picked rows: one after another among the rows of one folder (sketches shown under a step are not rows).
    const rowList = siblings.filter((it) => it.kind === 'folder' || !nested.has(it.id) || heads.includes(it));
    const at = heads.map((it) => rowList.indexOf(it));
    if (at.some((i) => i < 0) || at.some((i, k) => k > 0 && i !== at[k - 1] + 1)) {
        throw new Error('A folder holds steps that follow one another: pick steps next to each other at one level of the tree.');
    }
    const moving = pickItems(root, withAbsorbed(features, spec.items));
    // The rows' neighbours in their folder: the new folder goes between them, after any items in between that the
    // moved steps build on.
    const before = rowList[at[0] - 1];
    const afterRow = rowList[at[at.length - 1] + 1];
    moving.forEach((it) => take(root, it.id));
    node.items = moving;
    const from = before ? siblings.indexOf(before) + 1 : 0;
    const to = afterRow ? siblings.indexOf(afterRow) : siblings.length;
    let problem: unknown = null;
    for (let i = from; i <= to; i++) {
        siblings.splice(i, 0, node);
        try {
            return change(features, root);
        } catch (e) {
            problem ??= e;
            siblings.splice(i, 1);
        }
    }
    throw problem instanceof Error ? problem : new Error('Those steps cannot be grouped.');
}

/** Renames a folder. */
export function renameFolder(folders: readonly FeatureFolder[] | undefined, id: string, name: string): FeatureFolder[] {
    if (!folders?.some((f) => f.id === id)) {
        throw new Error(`No folder "${id}".`);
    }
    return folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f));
}

/** Removes folders; what they hold stays where it is, in the folder above (SolidWorks keeps the features). */
export function removeFolders(features: readonly Feature[], folders: readonly FeatureFolder[] | undefined, ids: readonly string[]): TreeChange {
    const root = folderLayout(features.map((f) => f.id), folders);
    for (const id of ids) {
        const found = locate(root, id);
        const node = found?.list[found.index];
        if (!found || node?.kind !== 'folder') {
            throw new Error(`No folder "${id}".`);
        }
        found.list.splice(found.index, 1, ...node.items);
    }
    return change(features, root);
}

/** Step ids a folder holds, its sub-folders' included, in history order. */
export function folderSteps(stepIds: readonly string[], folders: readonly FeatureFolder[] | undefined, id: string): string[] {
    const node = folderNodes(folderLayout(stepIds, folders)).get(id);
    return node ? layoutSteps(node.items) : [];
}
