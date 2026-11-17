// The assembly tree's components in their folders, after the FeatureManager of a SolidWorks assembly: drag one or
// several components (Ctrl / Shift+click) to reorder them, or into, out of and between folders, with the part tree's
// insertion marks; Add to new folder, Create new folder, rename (two slow clicks, F2), Expand / Collapse; a folder's
// eye hides or shows every part in it; selecting a folder lights its parts in the view, and a part selected in the
// view opens the folders round it. The rows and drop rules are in componentTree.ts.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import type { FeatureFolder, Part } from '@jarvis/core';
import { componentRowOf } from '@jarvis/core/componentFolders';
import type { TreePlace } from '@jarvis/core/folders';
import type { ComponentState } from '@jarvis/core/mates';
import { ContextMenu, InlineInput, showError, tool, type MenuEntry } from './menus';
import { load, menuAt, store, STORAGE_KEY, type Menu } from './browserUtil';
import { onSelect, runTool, select, useStudio } from './state';
import { StepIcon } from './stepIcons';
import { useSlowRename } from './treeSlowClick';
import { useMateAnalysis } from './mates/mateAnalysis';
import { setComponentPicks } from './componentPicks';
import {
    componentTreeRows, dropPlace, dropZone, folderChain, folderPrefix, folderShown, isDragged, placeArgs, rangeKeys, rowIds, rowIndex,
    rowParts, rowsIn, shownKeys, withHidden, type DropZone, type FolderRow, type TreeRow,
} from './componentTree';
import { folderKey } from './treeFolders';
import './componentTree.css';

/** What the tree adds to a design's own row (Browser.tsx ComponentRow). */
export interface DesignRowProps {
    /** Extra classes: in the tree's selection, being dragged. */
    className: string;
    onClick: (event: MouseEvent) => void;
    draggable: boolean;
    onDragStart: (event: DragEvent) => void;
    onDragEnd: () => void;
    /** The row's right-click menu with the folder entries, or the selection's menu when the row is part of one. */
    menu: (items: MenuEntry[]) => MenuEntry[];
}

const OPEN_KEY = `${STORAGE_KEY}.componentFolders.open`;

interface TreeUi {
    /** Open folders by id (remembered). */
    open: ReadonlySet<string>;
    /** The folder being named, by id. */
    renaming: string | null;
}

export const useComponentTreeUi = create<TreeUi>(() => ({
    open: new Set(load(OPEN_KEY, '').split(',').filter(Boolean)),
    renaming: null,
}));

function setOpen(ids: readonly string[], open: boolean): void {
    const next = new Set(useComponentTreeUi.getState().open);
    ids.forEach((id) => (open ? next.add(id) : next.delete(id)));
    useComponentTreeUi.setState({ open: next });
    store(OPEN_KEY, [...next].join(','));
}

/** Adds a folder (component_folders_add) and names it in place, as SolidWorks does. */
async function addFolder(args: Record<string, unknown>): Promise<void> {
    const result = await tool('component_folders_add', args);
    const id = /\(id ([^)]+)\)/.exec(result.text)?.[1];
    if (!result.isError && id) {
        useComponentTreeUi.setState({ renaming: id });
    }
}

function setPartsHidden(ids: readonly string[], hide: boolean): void {
    void tool('view_set', { hidden: withHidden(useStudio.getState().history?.view.hidden, ids, hide) });
}

/** The right-click menu of the tree's empty space. */
export function componentTreeMenu(folders: readonly FeatureFolder[] | undefined): MenuEntry[] {
    const ids = (folders ?? []).map((f) => f.id);
    const open = useComponentTreeUi.getState().open;
    return [
        { label: 'Create new folder', title: 'An empty folder after the components', onSelect: () => void addFolder({ at: 'end' }) },
        'separator',
        { label: 'Expand all folders', onSelect: () => setOpen(ids, true), disabled: !ids.some((id) => !open.has(id)) },
        { label: 'Collapse all folders', onSelect: () => setOpen(ids, false), disabled: !ids.some((id) => open.has(id)) },
    ];
}

/** Puts `extra` before the last group of a menu (Delete), as the part tree does. */
function withEntries(items: MenuEntry[], extra: MenuEntry[]): MenuEntry[] {
    const at = items.lastIndexOf('separator');
    return at >= 0 ? [...items.slice(0, at), 'separator', ...extra, ...items.slice(at)] : [...items, 'separator', ...extra];
}

const PREFIX_CLASS: Record<string, string> = { '(+) ': 'over', '(-) ': 'under', '(f) ': 'fixed' };
const PREFIX_TEXT: Record<string, string> = {
    '(+) ': 'A component in it is over defined',
    '(-) ': 'A component in it is under defined: it can still move',
    '(f) ': 'Every component in it is fixed',
};

interface TreeProps {
    parts: Part[];
    folders: FeatureFolder[] | undefined;
    /** A design's block: its row (with `row` applied to it) and what shows under it. */
    renderDesign: (design: Part, row: DesignRowProps) => ReactNode;
    /** Starts renaming a component (F2). */
    renameComponent: (id: string) => void;
}

/** The tree with the state it shows: open folders, the selected part, hidden parts, the components' mate states. */
export function ComponentTree(props: TreeProps) {
    const open = useComponentTreeUi((s) => s.open);
    const renaming = useComponentTreeUi((s) => s.renaming);
    const selected = useStudio((s) => s.selected);
    const hidden = useStudio((s) => s.history?.view.hidden);
    const states = useMateAnalysis().components;
    return <ComponentTreeView {...props} open={open} renaming={renaming} selected={selected} hidden={hidden} states={states} />;
}

export function ComponentTreeView(props: TreeProps & {
    open: ReadonlySet<string>;
    renaming: string | null;
    selected: string | null;
    hidden: readonly string[] | undefined;
    states: Readonly<Record<string, ComponentState>>;
}) {
    const { parts, folders, renderDesign, renameComponent, open, renaming, selected, hidden, states } = props;
    const rows = useMemo(() => componentTreeRows(parts, folders), [parts, folders]);
    const byKey = useMemo(() => rowIndex(rows), [rows]);
    const rowOf = useMemo(() => componentRowOf(parts), [parts]);
    const partsById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);
    // Rows selected together (Ctrl / Shift+click) by key: part ids and folder keys. The selected part is `selected`.
    const [selection, setSelection] = useState<string[]>([]);
    const anchor = useRef<string | null>(null);
    // The part this tree selected last, so the change is not taken for a pick in the view.
    const own = useRef<string | null | undefined>(undefined);
    const selecting = useRef(false);
    const [dragging, setDragging] = useState<string[] | null>(null);
    const [drop, setDrop] = useState<{ key: string; zone: DropZone } | null>(null);
    const dragged = useMemo(() => new Set(dragging ?? []), [dragging]);
    const [menu, setMenu] = useState<Menu>(null);
    const list = useRef<HTMLUListElement>(null);
    const scrollTo = useRef<string | null>(null);
    const isOpen = (id: string) => open.has(id);

    const ownSelect = (id: string | null) => {
        if (useStudio.getState().selected !== id) {
            own.current = id;
        }
        selecting.current = true;
        try {
            select(id);
        } finally {
            selecting.current = false;
        }
    };
    const startRename = (key: string) => {
        const row = byKey.get(key);
        if (row?.kind === 'folder') {
            useComponentTreeUi.setState({ renaming: row.id });
        } else if (row) {
            renameComponent(row.id);
        }
    };
    const slow = useSlowRename(startRename);

    useEffect(() => {
        if (scrollTo.current) {
            list.current?.querySelector(`[data-key="${CSS.escape(scrollTo.current)}"]`)?.scrollIntoView({ block: 'nearest' });
            scrollTo.current = null;
        }
    });
    // A part selected elsewhere (the view, an instance's row) is the tree's selection, and the folders round it open
    // to show it, as SolidWorks does for components.
    useEffect(() => {
        if (own.current !== undefined && own.current === selected) {
            own.current = undefined;
            return;
        }
        own.current = undefined;
        if (selected && selection.includes(selected)) {
            return;
        }
        setSelection(selected && byKey.has(selected) ? [selected] : []);
        const row = selected ? byKey.get(rowOf.get(selected) ?? selected) : undefined;
        const closed = folderChain(row).filter((f) => !open.has(f.id)).map((f) => f.id);
        if (closed.length) {
            setOpen(closed, true);
        }
        if (row) {
            anchor.current = row.key;
            scrollTo.current = row.key;
        }
    }, [selected]);
    // Nothing selected elsewhere (a click on empty space, Esc) lets go of the tree's folders and rows too.
    useEffect(() => onSelect((id) => {
        if (id === null && !selecting.current) {
            setSelection([]);
        }
    }), []);
    // A new folder is selected while it is named.
    useEffect(() => {
        if (renaming && byKey.has(folderKey(renaming))) {
            setSelection([folderKey(renaming)]);
            scrollTo.current = folderKey(renaming);
        }
    }, [renaming, byKey]);
    // Rows that are gone leave the selection.
    useEffect(() => {
        if (selection.some((k) => !byKey.has(k))) {
            setSelection(selection.filter((k) => byKey.has(k)));
        }
    }, [byKey]);
    // What is selected here is lit in the view: a folder's parts with their instances, and each selected design.
    const selectionParts = (keys: readonly string[]): string[] => keys.flatMap((k) => {
        const row = byKey.get(k);
        return !row ? [] : row.kind === 'folder' ? rowParts(parts, [row]) : [row.id];
    });
    useEffect(() => {
        setComponentPicks(selectionParts(selection));
    }, [selection, byKey, parts]);
    useEffect(() => () => setComponentPicks([]), []);

    // ---- Selection ----

    /** A plain click selects the row (a design clicked again is let go); Shift+click a range, Ctrl+click adds or takes. */
    const click = (key: string, event: MouseEvent) => {
        const row = byKey.get(key);
        if (!row) {
            return;
        }
        if (event.shiftKey && anchor.current && anchor.current !== key) {
            setSelection(rangeKeys(shownKeys(rows, isOpen), anchor.current, key));
            ownSelect(row.kind === 'part' ? key : null);
        } else if (event.ctrlKey || event.metaKey) {
            const now = selection.length ? selection : selected && byKey.has(selected) ? [selected] : [];
            const next = now.includes(key) ? now.filter((k) => k !== key) : [...now, key];
            setSelection(next);
            anchor.current = key;
            const last = [...next].reverse().find((k) => byKey.get(k)?.kind === 'part') ?? null;
            ownSelect(next.includes(key) && row.kind === 'part' ? key : last);
        } else if (row.kind === 'part') {
            const again = selected === key && selection.length <= 1;
            anchor.current = key;
            setSelection(again ? [] : [key]);
            ownSelect(again ? null : key);
        } else {
            anchor.current = key;
            setSelection([key]);
            ownSelect(null);
        }
    };
    /** A closed folder holding a selected row or the selected part is highlighted for it. */
    const holdsSelection = (row: FolderRow): boolean => {
        const inside = new Set(rowsIn(row).map((r) => r.key));
        return selection.some((k) => inside.has(k)) || (!!selected && inside.has(rowOf.get(selected) ?? selected));
    };

    // ---- Actions ----

    const move = async (ids: string[], place: TreePlace) => {
        const result = await runTool('parts_reorder', { ids, ...placeArgs(place) });
        if (result.isError) {
            showError(result.text);
        }
    };
    const deleteFolder = (row: FolderRow) => {
        list.current?.focus();
        setSelection([]);
        void tool('component_folders_remove', { ids: [row.id] });
    };
    const folderEntries = (row: TreeRow): MenuEntry[] => [
        {
            label: 'Add to new folder', title: row.kind === 'folder' ? 'A new folder round this one' : undefined,
            onSelect: () => void addFolder({ items: [row.id] }),
        },
        { label: 'Create new folder', title: 'An empty folder above this item', onSelect: () => void addFolder({ before: row.id }) },
    ];
    /** Several rows selected: what applies to all of them together. */
    const selectionMenu = (keys: string[]): MenuEntry[] => {
        const picked = keys.map((k) => byKey.get(k)).filter((r): r is TreeRow => !!r);
        const ids = selectionParts(keys);
        const shown = folderShown(ids, hidden);
        return [
            { header: `${keys.length} items selected` },
            { label: 'Add to new folder', onSelect: () => void addFolder({ items: rowIds(picked) }) },
            'separator',
            { label: 'Hide components', icon: 'eye-off', onSelect: () => setPartsHidden(ids, true), disabled: shown === 'hidden' },
            { label: 'Show components', icon: 'eye', onSelect: () => setPartsHidden(ids, false), disabled: shown === 'shown' },
        ];
    };
    const together = (key: string) => selection.length > 1 && selection.includes(key);
    const folderMenu = (row: FolderRow): MenuEntry[] => {
        if (together(row.key)) {
            return selectionMenu(selection);
        }
        const ids = rowParts(parts, [row]);
        const shown = folderShown(ids, hidden);
        const inner = rowsIn(row).filter((r): r is FolderRow => r.kind === 'folder').map((r) => r.id);
        const empty = !row.items.length;
        return [
            { header: row.name },
            { label: 'Rename tree item', hint: 'F2', onSelect: () => startRename(row.key) },
            'separator',
            { label: 'Expand all', title: 'This folder and every folder in it', onSelect: () => setOpen([row.id, ...inner], true), disabled: empty },
            { label: 'Collapse all', title: 'This folder and every folder in it', onSelect: () => setOpen([row.id, ...inner], false), disabled: empty },
            isOpen(row.id)
                ? { label: 'Collapse item', onSelect: () => setOpen([row.id], false), disabled: empty }
                : { label: 'Expand item', onSelect: () => setOpen([row.id], true), disabled: empty },
            'separator',
            {
                label: 'Hide components', icon: 'eye-off', title: 'Every part in the folder and its sub-folders',
                onSelect: () => setPartsHidden(ids, true), disabled: shown === 'hidden' || shown === 'empty',
            },
            {
                label: 'Show components', icon: 'eye', title: 'Every part in the folder and its sub-folders',
                onSelect: () => setPartsHidden(ids, false), disabled: shown === 'shown' || shown === 'empty',
            },
            'separator',
            ...folderEntries(row),
            'separator',
            {
                label: 'Delete folder', hint: 'Del', icon: 'delete', title: 'The components in it stay where they are', danger: true,
                onSelect: () => deleteFolder(row),
            },
        ];
    };

    // ---- Keyboard: F2 renames, Delete removes a folder, the arrows open and close one ----

    const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        const key = selection.length === 1 ? selection[0] : selection.length ? null : selected;
        const row = key ? byKey.get(key) : undefined;
        if (event.key === 'F2' && row) {
            startRename(row.key);
        } else if (event.key === 'Delete' && row?.kind === 'folder') {
            deleteFolder(row);
        } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && row?.kind === 'folder') {
            setOpen([row.id], event.key === 'ArrowRight');
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    };

    // ---- Drag to reorder, and into or out of folders (a design takes its instances and pattern along) ----

    const startDrag = (event: DragEvent, key: string) => {
        slow.cancel();
        const keys = together(key) ? selection.filter((k) => byKey.has(k)) : [key];
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-jarvis-components', JSON.stringify(keys));
        setDragging(keys);
    };
    const endDrag = () => {
        setDragging(null);
        setDrop(null);
    };
    const dragOver = (event: DragEvent<HTMLElement>, key: string) => {
        const row = byKey.get(key);
        // Nothing lands on what is dragged or inside a dragged folder.
        if (!dragging || !row || isDragged(row, dragged)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        const zone = dropZone(row, (event.clientY - rect.top) / Math.max(rect.height, 1), row.kind === 'folder' && isOpen(row.id));
        if (drop?.key !== key || drop.zone !== zone) {
            setDrop({ key, zone });
        }
    };
    const dropOn = (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const target = drop ? byKey.get(drop.key) : undefined;
        const moving = (dragging ?? []).map((k) => byKey.get(k)).filter((r): r is TreeRow => !!r);
        if (drop && target && moving.length && !isDragged(target, dragged)) {
            void move(rowIds(moving), dropPlace(target, drop.zone, moving));
        }
        endDrag();
    };
    const dropClass = (key: string): string => (drop?.key !== key ? '' : `drop-${drop.zone}`);

    // ---- Rendering ----

    const designProps = (row: TreeRow): DesignRowProps => ({
        className: [selection.includes(row.key) ? 'current' : '', isDragged(row, dragged) ? 'dragged' : ''].join(' '),
        onClick: (event) => click(row.key, event),
        draggable: renaming === null,
        onDragStart: (event) => startDrag(event, row.key),
        onDragEnd: endDrag,
        menu: (items) => (together(row.key) ? selectionMenu(selection) : withEntries(items, folderEntries(row))),
    });

    const folderTitle = (row: FolderRow, count: number, prefix: string, shown: string): string => [
        `Folder ${row.name}: ${count ? `${count} component${count === 1 ? '' : 's'}` : 'empty'}`,
        ...(prefix ? [PREFIX_TEXT[prefix]] : []),
        ...(shown === 'hidden' ? ['Hidden'] : shown === 'mixed' ? ['Some of its components are hidden'] : []),
        'Drag components onto it to put them in, or out of it to take them out',
    ].join('\n');

    const folderRow = (row: FolderRow): ReactNode => {
        const opened = isOpen(row.id) && row.items.length > 0;
        const ids = rowParts(parts, [row]);
        const shown = folderShown(ids, hidden);
        const prefix = folderPrefix(ids.map((id) => states[id]));
        const current = selection.includes(row.key) || (!opened && holdsSelection(row));
        const classes = [
            'br-row', 'component', 'ct-folder', current ? 'current' : '', shown === 'hidden' ? 'hidden' : '',
            isDragged(row, dragged) ? 'dragged' : '', dropClass(row.key),
        ].join(' ');
        const hide = shown !== 'hidden';
        return (
            <li key={row.key} className="ct-folder-group">
                <ul>
                    <li
                        className={classes}
                        data-key={row.key}
                        role="treeitem"
                        aria-expanded={row.items.length ? opened : undefined}
                        aria-selected={current}
                        title={folderTitle(row, ids.length, prefix, shown)}
                        draggable={renaming !== row.id}
                        onDragStart={(event) => startDrag(event, row.key)}
                        onDragEnd={endDrag}
                        onDragOver={(event) => dragOver(event, row.key)}
                        onDrop={dropOn}
                        // Two slow clicks on the name rename it (treeSlowClick.ts).
                        onMouseDown={(event) => slow.down(row.key, event.button === 0 && selection.length === 1 && selection[0] === row.key)}
                        onClick={(event) => {
                            click(row.key, event);
                            slow.click(row.key, event);
                        }}
                        onDoubleClick={() => {
                            slow.cancel();
                            setOpen([row.id], !opened);
                        }}
                        onContextMenu={(event) => setMenu(menuAt(event, folderMenu(row)))}
                    >
                        {row.items.length > 0 && (
                            <button
                                type="button"
                                className="br-caret"
                                onClick={(e) => { e.stopPropagation(); setOpen([row.id], !opened); }}
                                onDoubleClick={(e) => e.stopPropagation()}
                                title={opened ? 'Collapse' : 'Expand'}
                                aria-label={opened ? 'Collapse' : 'Expand'}
                            >
                                {opened ? '▾' : '▸'}
                            </button>
                        )}
                        <StepIcon name={opened ? 'folder-open' : 'folder'} />
                        {prefix && <span className={`mt-prefix ${PREFIX_CLASS[prefix]}`} title={PREFIX_TEXT[prefix]}>{prefix.trim()}</span>}
                        <span className="br-text one-line">
                            {renaming === row.id ? (
                                <InlineInput
                                    value={row.name}
                                    label="Folder name"
                                    onCommit={(name) => {
                                        useComponentTreeUi.setState({ renaming: null });
                                        list.current?.focus();
                                        void tool('component_folders_rename', { id: row.id, name });
                                    }}
                                    onCancel={() => {
                                        useComponentTreeUi.setState({ renaming: null });
                                        list.current?.focus();
                                    }}
                                />
                            ) : <span className="br-name ft-name">{row.name}</span>}
                        </span>
                        <span className="br-count">{ids.length}</span>
                        <span className={`br-actions ${shown === 'hidden' || shown === 'mixed' ? 'has-off' : ''}`}>
                            <button
                                type="button"
                                className={shown === 'hidden' || shown === 'mixed' ? 'off' : ''}
                                disabled={shown === 'empty'}
                                onClick={(e) => { e.stopPropagation(); setPartsHidden(ids, hide); }}
                                onDoubleClick={(e) => e.stopPropagation()}
                                title={hide ? 'Hide every part in the folder' : 'Show every part in the folder'}
                                aria-label={`${hide ? 'Hide' : 'Show'} the components of ${row.name}`}
                            >
                                {shown === 'hidden' ? '◌' : shown === 'mixed' ? '◐' : '◉'}
                            </button>
                            <button type="button" onClick={(e) => setMenu(menuAt(e, folderMenu(row)))} title="More" aria-label={`More actions for ${row.name}`}>⋯</button>
                        </span>
                    </li>
                    {opened && <ul className="ct-in" style={{ '--ct-depth': folderChain(row).length + 1 } as CSSProperties}>{items(row.items)}</ul>}
                </ul>
            </li>
        );
    };

    const items = (entries: readonly TreeRow[]): ReactNode[] => entries.map((row) => {
        if (row.kind === 'folder') {
            return folderRow(row);
        }
        const design = partsById.get(row.id);
        return design && (
            <li key={row.key} data-key={row.key} className={`br-instances ${dropClass(row.key)}`} onDragOver={(event) => dragOver(event, row.key)} onDrop={dropOn}>
                {renderDesign(design, designProps(row))}
            </li>
        );
    });

    return (
        <>
            <ul className="ct-tree" ref={list} tabIndex={-1} role="tree" aria-label="Components" onKeyDown={onKey}>
                {items(rows)}
            </ul>
            {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        </>
    );
}
