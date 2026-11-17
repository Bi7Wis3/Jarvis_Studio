// The assembly tree's components in their folders (SolidWorks: folders of components in an assembly's FeatureManager):
// the rows, where a drop lands, what a Shift+click takes, the parts a selection stands for, and a folder's prefix and
// eye. The rules for the order and the folders are in @jarvis/core/componentFolders; the server's parts_reorder and
// component_folders_* tools apply them.

import type { FeatureFolder, Part } from '@jarvis/core';
import { componentLayout, componentRowOf } from '@jarvis/core/componentFolders';
import type { LayoutItem, TreePlace } from '@jarvis/core/folders';
import type { ComponentState } from '@jarvis/core/mates';
import { folderKey } from './treeFolders';

/** A design's row (its instances and pattern show under it). Its key is the part's id. */
export interface PartRow {
    kind: 'part';
    key: string;
    id: string;
    parent: FolderRow | null;
    /** 1, 2, ...: its place among the rows, top to bottom. */
    pos: number;
}

export interface FolderRow {
    kind: 'folder';
    key: string;
    id: string;
    name: string;
    items: TreeRow[];
    parent: FolderRow | null;
    /** The rows above it (start) and above its end (end). */
    start: number;
    end: number;
}

export type TreeRow = PartRow | FolderRow;

/** The tree's rows: the designs in the parts' order, wrapped in their folders. */
export function componentTreeRows(parts: readonly Part[], folders: readonly FeatureFolder[] | undefined): TreeRow[] {
    let count = 0;
    const walk = (items: readonly LayoutItem[], parent: FolderRow | null): TreeRow[] => items.map((item) => {
        if (item.kind === 'step') {
            return { kind: 'part', key: item.id, id: item.id, parent, pos: ++count };
        }
        const row: FolderRow = { kind: 'folder', key: folderKey(item.id), id: item.id, name: item.name, items: [], parent, start: count, end: count };
        row.items = walk(item.items, row);
        row.end = count;
        return row;
    });
    return walk(componentLayout(parts, folders), null);
}

/** Every row by key, folders and designs. */
export function rowIndex(rows: readonly TreeRow[], out = new Map<string, TreeRow>()): Map<string, TreeRow> {
    for (const row of rows) {
        out.set(row.key, row);
        if (row.kind === 'folder') {
            rowIndex(row.items, out);
        }
    }
    return out;
}

/** All rows inside a folder, sub-folders' too, in order. */
export function rowsIn(folder: FolderRow): TreeRow[] {
    return folder.items.flatMap((row) => (row.kind === 'folder' ? [row, ...rowsIn(row)] : [row]));
}

/** The folders a row is in, outermost first. */
export function folderChain(row: TreeRow | undefined): FolderRow[] {
    const chain: FolderRow[] = [];
    for (let at = row?.parent ?? null; at; at = at.parent) {
        chain.unshift(at);
    }
    return chain;
}

/** The parts rows stand for: a design and its instances; a folder, all of its designs' (sub-folders included). */
export function rowParts(parts: readonly Part[], rows: readonly TreeRow[]): string[] {
    const designs = new Set(rows.flatMap((row) => (row.kind === 'part' ? [row.id] : rowsIn(row).filter((r) => r.kind === 'part').map((r) => r.id))));
    const rowOf = componentRowOf(parts);
    return parts.filter((p) => designs.has(rowOf.get(p.id)!)).map((p) => p.id);
}

/** The keys of the rows as they show, top to bottom (a closed folder hides its rows). */
export function shownKeys(rows: readonly TreeRow[], open: (id: string) => boolean): string[] {
    return rows.flatMap((row) => (row.kind === 'folder' ? [row.key, ...(open(row.id) ? shownKeys(row.items, open) : [])] : [row.key]));
}

/** What Shift+click selects: the shown rows from `from` to `to`, either way round. */
export function rangeKeys(keys: readonly string[], from: string, to: string): string[] {
    const a = keys.indexOf(from);
    const b = keys.indexOf(to);
    if (a < 0 || b < 0) {
        return b < 0 ? [] : [to];
    }
    return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Is `row` one of the dragged rows or inside a dragged folder? */
export function isDragged(row: TreeRow | undefined, dragged: ReadonlySet<string>): boolean {
    return !!row && (dragged.has(row.key) || folderChain(row).some((f) => dragged.has(f.key)));
}

export type DropZone = 'before' | 'after' | 'into';

/**
 * Where on a row a drop lands, by the pointer's height on it (0 top, 1 bottom), as in the part tree: on a folder its
 * top edge is above it, a closed folder's bottom edge below it, the rest into it; on a design the upper half is above.
 */
export function dropZone(row: TreeRow, y: number, open: boolean): DropZone {
    if (row.kind === 'folder') {
        return y < 0.25 ? 'before' : !open && y > 0.75 ? 'after' : 'into';
    }
    return y < 0.5 ? 'before' : 'after';
}

/**
 * Where items dropped on `target` go: just above or below it, or into a folder, at its start when they all come from
 * above it, else at its end.
 */
export function dropPlace(target: TreeRow, zone: DropZone, moving: readonly TreeRow[]): TreePlace {
    if (zone === 'into' && target.kind === 'folder') {
        const fromAbove = moving.every((r) => (r.kind === 'part' ? r.pos : r.end) <= target.start);
        return { into: target.id, at: fromAbove ? 'start' : 'end' };
    }
    return zone === 'before' ? { before: target.id } : { after: target.id };
}

/** The ids parts_reorder takes for rows. */
export const rowIds = (rows: readonly TreeRow[]): string[] => rows.map((r) => r.id);

/** A place as the tools take it (before, after, into and at). */
export function placeArgs(place: TreePlace): Record<string, string> {
    if ('before' in place) {
        return { before: place.before };
    }
    if ('after' in place) {
        return { after: place.after };
    }
    return { ...(place.into ? { into: place.into } : {}), at: place.at ?? 'end' };
}

/**
 * A folder's prefix, as SolidWorks shows it for folders of components: (+) when one in it is over defined, (-) when one
 * is under defined, (f) when all are fixed; none when they are all fully defined (or empty).
 */
export function folderPrefix(states: readonly (ComponentState | undefined)[]): '(+) ' | '(-) ' | '(f) ' | '' {
    if (states.includes('over')) {
        return '(+) ';
    }
    if (states.includes('under')) {
        return '(-) ';
    }
    return states.length && states.every((s) => s === 'fixed') ? '(f) ' : '';
}

/** Whether the parts of a folder are all shown, all hidden or some of each. */
export function folderShown(ids: readonly string[], hidden: readonly string[] | undefined): 'shown' | 'hidden' | 'mixed' | 'empty' {
    const off = ids.filter((id) => hidden?.includes(id)).length;
    return !ids.length ? 'empty' : off === 0 ? 'shown' : off === ids.length ? 'hidden' : 'mixed';
}

/** The hidden list with `ids` hidden or shown. */
export function withHidden(hidden: readonly string[] | undefined, ids: readonly string[], hide: boolean): string[] {
    const next = new Set(hidden ?? []);
    ids.forEach((id) => (hide ? next.add(id) : next.delete(id)));
    return [...next];
}
