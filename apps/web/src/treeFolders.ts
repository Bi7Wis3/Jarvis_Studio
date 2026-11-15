// Folders in the feature tree (SolidWorks user folders): the rows they wrap, the visible lines with the rollback
// gaps in and around them, where a drop lands, and which rows a selection may group. The rules for the folders
// themselves (what they hold, keeping each one a run of the history) are in @jarvis/core/folders.

import type { Feature, FeatureFolder } from '@jarvis/core';
import { folderLayout, type LayoutItem, type TreePlace } from '@jarvis/core/folders';
import { blockIds, type TreeNode } from './featureTree';

const FOLDER = '__folder:';

/** The tree key of a folder row (never a step id: step ids have no underscores or colons). */
export const folderKey = (id: string): string => `${FOLDER}${id}`;

export interface StepRow {
    kind: 'node';
    key: string;
    node: TreeNode;
    /** 1, 2, ...: its place among the top-level step rows; the rollback gap below it has this number. */
    pos: number;
    parent: FolderRow | null;
}

export interface FolderRow {
    kind: 'folder';
    key: string;
    id: string;
    name: string;
    items: TreeRow[];
    /** Step rows above it, and above its end: the gaps start..end lie at its edges and inside it. */
    start: number;
    end: number;
    parent: FolderRow | null;
}

export type TreeRow = StepRow | FolderRow;

/**
 * The tree's top-level step rows (buildFeatureTree) wrapped in the part's folders. Nested sketches stay under their
 * step wherever their own step sits.
 */
export function folderRows(tree: readonly TreeNode[], features: readonly Feature[], folders: readonly FeatureFolder[] | undefined): TreeRow[] {
    let count = 0;
    if (!folders?.length) {
        return tree.map((node) => ({ kind: 'node', key: node.key, node, pos: ++count, parent: null }));
    }
    const top = new Map(tree.map((n) => [n.stepId, n]));
    const walk = (items: readonly LayoutItem[], parent: FolderRow | null): TreeRow[] => {
        const out: TreeRow[] = [];
        for (const item of items) {
            if (item.kind === 'step') {
                const node = top.get(item.id);
                if (node) {
                    out.push({ kind: 'node', key: node.key, node, pos: ++count, parent });
                }
                continue;
            }
            const row: FolderRow = { kind: 'folder', key: folderKey(item.id), id: item.id, name: item.name, items: [], start: count, end: count, parent };
            row.items = walk(item.items, row);
            row.end = count;
            out.push(row);
        }
        return out;
    };
    return walk(folderLayout(features.map((f) => f.id), folders), null);
}

/** Every row by key (folders and top-level step rows). */
export function rowIndex(rows: readonly TreeRow[], out = new Map<string, TreeRow>()): Map<string, TreeRow> {
    for (const row of rows) {
        out.set(row.key, row);
        if (row.kind === 'folder') {
            rowIndex(row.items, out);
        }
    }
    return out;
}

/** The folders a row is in, outermost first. */
export function folderChain(row: TreeRow | undefined): FolderRow[] {
    const chain: FolderRow[] = [];
    for (let at = row?.parent ?? null; at; at = at.parent) {
        chain.unshift(at);
    }
    return chain;
}

/** All rows inside a folder, sub-folders' too, in order. */
export function rowsIn(folder: FolderRow): TreeRow[] {
    return folder.items.flatMap((row) => (row.kind === 'folder' ? [row, ...rowsIn(row)] : [row]));
}

export function stepRowsIn(folder: FolderRow): StepRow[] {
    return rowsIn(folder).filter((r): r is StepRow => r.kind === 'node');
}

/** The steps a row stands for: a step row's own and the sketches only it uses; a folder's, all its rows'. */
export function rowSteps(row: TreeRow): string[] {
    return row.kind === 'node' ? blockIds(row.node) : stepRowsIn(row).flatMap((r) => blockIds(r.node));
}

/** The steps a row shows, its nested sketches included (what selecting it highlights in the view). */
export function shownSteps(row: TreeRow): string[] {
    const nodes = row.kind === 'node' ? [row.node] : stepRowsIn(row).map((r) => r.node);
    return [...new Set(nodes.flatMap((n) => [n.stepId, ...n.children.map((c) => c.stepId)]).filter((id): id is string => !!id))];
}

/** Folders the rollback bar at `gap` is inside: they show open. */
export function barFolders(rows: readonly TreeRow[], gap: number): Set<string> {
    const keys = new Set<string>();
    for (const row of rowIndex(rows).values()) {
        if (row.kind === 'folder' && row.start < gap && gap < row.end) {
            keys.add(row.key);
        }
    }
    return keys;
}

/** One visible line: a folder, a step (or a sketch under it), or a rollback gap at a depth. */
export type TreeLine =
    | { kind: 'ufolder'; key: string; depth: number; row: FolderRow }
    | { kind: 'node'; key: string; depth: number; node: TreeNode }
    | { kind: 'gap'; key: string; gap: number; depth: number };

/**
 * The visible lines of the rows from depth 1. A gap follows each step row; the gap after the last row in a folder
 * shows below the folder (the bar there is outside it), and a closed folder shows only the gap after its end.
 * While filtering (`matches`), only matching rows and their folders show; a folder whose name matches shows all of it.
 */
export function treeLines(rows: readonly TreeRow[], opts: {
    open: (key: string) => boolean; matches: Set<string> | null; query: string; gaps: boolean;
}): TreeLine[] {
    const out: TreeLine[] = [];
    let pending: number | null = 0;
    const flush = (depth: number) => {
        if (pending !== null && opts.gaps) {
            out.push({ kind: 'gap', key: `gap-${pending}`, gap: pending, depth });
        }
        pending = null;
    };
    const q = opts.query.trim().toLowerCase();
    const named = (row: FolderRow) => !!q && row.name.toLowerCase().includes(q);
    const shows = (row: TreeRow): boolean => (row.kind === 'node'
        ? !opts.matches || opts.matches.has(row.key)
        : !opts.matches || named(row) || row.items.some(shows));
    const walk = (items: readonly TreeRow[], depth: number, all: boolean) => {
        for (const row of items) {
            if (!all && !shows(row)) {
                continue;
            }
            flush(depth);
            if (row.kind === 'folder') {
                out.push({ kind: 'ufolder', key: row.key, depth, row });
                if (opts.open(row.key)) {
                    walk(row.items, depth + 1, all || named(row));
                } else if (row.end > row.start) {
                    pending = row.end;
                }
                continue;
            }
            out.push({ kind: 'node', key: row.key, depth, node: row.node });
            if (row.node.children.length && opts.open(row.key)) {
                row.node.children
                    .filter((c) => all || !opts.matches || opts.matches.has(c.key))
                    .forEach((c) => out.push({ kind: 'node', key: c.key, depth: depth + 1, node: c }));
            }
            pending = row.pos;
        }
    };
    walk(rows, 1, false);
    flush(1);
    return out;
}

/** The id a row has in the folder layout: a step row's step, a folder's id. */
const itemId = (row: TreeRow): string => (row.kind === 'node' ? row.node.stepId! : row.id);

/** Is `row` one of `dragged` or inside a dragged folder? */
export function isDragged(row: TreeRow | undefined, dragged: ReadonlySet<string>): boolean {
    return !!row && (dragged.has(row.key) || folderChain(row).some((f) => dragged.has(f.key)));
}

export type DropZone = 'before' | 'after' | 'into';

/**
 * Where items dropped on `target` go. Above a row: just below the row above it (so they land above the sketches
 * the row is built from too), or at the start of its folder. Below a row: just below it. Into a folder: at its
 * start when the items come from above it, else at its end (so the history order changes as little as it can).
 */
export function dropPlace(rows: readonly TreeRow[], target: TreeRow, zone: DropZone, dragged: ReadonlySet<string>, fromAbove: boolean): TreePlace {
    if (zone === 'into' && target.kind === 'folder') {
        return { into: target.id, at: fromAbove ? 'start' : 'end' };
    }
    if (zone === 'after') {
        return { after: itemId(target) };
    }
    const siblings = target.parent ? target.parent.items : rows;
    for (let i = siblings.indexOf(target) - 1; i >= 0; i--) {
        if (!dragged.has(siblings[i].key)) {
            return { after: itemId(siblings[i]) };
        }
    }
    return { into: target.parent?.id ?? null, at: 'start' };
}

/** The step and folder ids to move for dragged rows (a step row takes the sketches only it uses). */
export function dragIds(rows: readonly TreeRow[]): string[] {
    return rows.flatMap((row) => (row.kind === 'node' ? blockIds(row.node) : [row.id]));
}

/**
 * The rows of `keys` in tree order when they follow one another in one folder (or at the top), as a folder's
 * items must; else null.
 */
export function siblingRun(index: ReadonlyMap<string, TreeRow>, rows: readonly TreeRow[], keys: readonly string[]): TreeRow[] | null {
    const picked = keys.map((k) => index.get(k));
    if (!picked.length || picked.some((r) => !r)) {
        return null;
    }
    const parent = picked[0]!.parent;
    if (picked.some((r) => r!.parent !== parent)) {
        return null;
    }
    const siblings = parent ? parent.items : rows;
    const at = [...new Set(picked.map((r) => siblings.indexOf(r!)))].sort((a, b) => a - b);
    return at.every((i, k) => k === 0 || i === at[k - 1] + 1) ? at.map((i) => siblings[i]) : null;
}

/** Row keys of the lines from `from` to `to` (either way round): what Shift+click selects. */
export function rangeKeys(lines: readonly { key: string; kind: string; node?: TreeNode }[], from: string, to: string): string[] {
    const keys = lines.filter((l) => l.kind === 'ufolder' || (l.kind === 'node' && l.node?.parentId === null)).map((l) => l.key);
    const a = keys.indexOf(from);
    const b = keys.indexOf(to);
    if (a < 0 || b < 0) {
        return b < 0 ? [] : [to];
    }
    return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}
