import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { effectivePart, type FeatureFolder, type Part } from '@jarvis/core';
import { labelInsets } from './Labels';
import { ContextMenu, InlineInput, showError, tool, type MenuEntry } from './menus';
import { runTool, select, setHidden, setWorkspace, useStudio } from './state';
import { confirmDeletes } from './options';
import { load, menuAt, NONE, store, STORAGE_KEY, type Menu } from './browserUtil';
import { PartHistory } from './FeatureTree';
import { usePropertyManager } from './PropertyManager';
import { valueText } from './numberText';
import { componentMenu, type PartListActions } from './contextMenus';
import { appActions, duplicatePart, editPattern, insertInstance, menuContext, removePattern, usePartRequest } from './viewMenu';
import './browser.css';
import { usePartRebuilding } from './kernelActivity';
import { AssemblyReferences, ComponentBranch, ComponentPrefix, MatesFolder } from './mates/MatesTree';
import { ComponentTree, componentTreeMenu, type DesignRowProps } from './ComponentTree';

const PANEL_INSET = 274;

/** Where the property manager draws itself (see Toolbar). */
const setSlot = (element: HTMLDivElement | null) => usePropertyManager.setState({ slot: element });

/** Left panel: the part's modelling history in the part workspace, the components list in the assembly. */
export function Browser() {
    const history = useStudio((s) => s.history);
    const workspace = useStudio((s) => s.workspace);
    const activePart = useStudio((s) => s.activePart);
    const [open, setOpen] = useState(() => load(STORAGE_KEY, 'open') !== 'closed');
    const editingFeature = usePropertyManager((s) => s.open);
    // Rename and Delete from the view's menu happen in the components list: show it.
    const request = usePartRequest((s) => s.rename ?? s.remove);
    useEffect(() => {
        if (request) {
            setOpen(true);
        }
    }, [request]);

    useEffect(() => {
        store(STORAGE_KEY, open ? 'open' : 'closed');
        labelInsets.left = open ? PANEL_INSET : 0;
        return () => {
            labelInsets.left = 0;
        };
    }, [open]);

    if (!history) {
        return null;
    }
    const active = workspace === 'part' ? history.parts.find((p) => p.id === activePart) : undefined;
    // An instance is edited through its source design.
    const part = active?.instanceOf ? history.parts.find((p) => p.id === active.instanceOf) ?? active : active;
    if (!open && !editingFeature) {
        return (
            <button type="button" className="br-toggle" onClick={() => setOpen(true)} title="Show browser">
                <span className="br-toggle-icon">☰</span>
                {part ? part.name : history.name}
            </button>
        );
    }
    return (
        <nav className={`br ${editingFeature ? 'pm-on' : ''}`} aria-label={editingFeature ? 'Property manager' : part ? `History of ${part.name}` : `Parts of ${history.name}`}>
            <div className="pm-slot" ref={setSlot} hidden={!editingFeature} />
            {open && (
                <Hideable hidden={editingFeature}>
                    {part
                        ? <PartHistory key={part.id} part={part} parts={history.parts} onMinimise={() => setOpen(false)} />
                        : <Components name={history.name} parts={history.parts} folders={history.componentFolders} onMinimise={() => setOpen(false)} />}
                </Hideable>
            )}
        </nav>
    );
}

/**
 * Keeps the tree mounted (expanded rows, filter, selection) while the property manager takes its place, and puts
 * its scroll position back when it shows again.
 */
function Hideable({ hidden, children }: { hidden: boolean; children: ReactNode }) {
    const box = useRef<HTMLDivElement>(null);
    const scrolls = useRef(new Map<Element, number>());
    useEffect(() => {
        const element = box.current;
        const remember = (event: Event) => {
            if (event.target instanceof Element && element?.contains(event.target)) {
                scrolls.current.set(event.target, event.target.scrollTop);
            }
        };
        element?.addEventListener('scroll', remember, true);
        return () => element?.removeEventListener('scroll', remember, true);
    }, []);
    useLayoutEffect(() => {
        if (!hidden) {
            for (const [element, top] of scrolls.current) {
                if (element.isConnected) {
                    element.scrollTop = top;
                }
            }
        }
    }, [hidden]);
    return <div ref={box} className="br-tree" hidden={hidden}>{children}</div>;
}

// ---- Assembly workspace: the components list -----------------------------------------------------------

/** The assembly: its name at the top (as a feature tree shows the document's name), then its parts by name. */
function Components(props: { name: string; parts: Part[]; folders: FeatureFolder[] | undefined; onMinimise: () => void }) {
    const { name, parts, folders, onMinimise } = props;
    const [collapsed, setCollapsed] = useState<Set<string>>(
        () => new Set(load(`${STORAGE_KEY}.collapsed`, '').split(',').filter(Boolean)),
    );
    const [renaming, setRenaming] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [menu, setMenu] = useState<Menu>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const toggle = (group: string) => {
        const next = new Set(collapsed);
        if (next.has(group)) {
            next.delete(group);
        } else {
            next.add(group);
        }
        setCollapsed(next);
        store(`${STORAGE_KEY}.collapsed`, [...next].join(','));
    };

    const instancesOf = (id: string) => parts.filter((p) => p.instanceOf === id);
    // Options > General > Confirmations: ask first, or delete at once (a design with its instances, as the row would).
    const askRemove = (id: string) => {
        const part = parts.find((p) => p.id === id);
        if (confirmDeletes() || !part) {
            setConfirming(id);
        } else {
            void removeParts(part.instanceOf ? [id] : [id, ...instancesOf(id).map((p) => p.id)]);
        }
    };
    // The view's menu asks for these by part (viewMenu.tsx).
    const request = usePartRequest();
    useEffect(() => {
        if (request.rename) {
            setRenaming(request.rename);
        }
        if (request.remove) {
            askRemove(request.remove);
        }
        if (request.rename || request.remove) {
            usePartRequest.setState({ rename: null, remove: null });
        }
    }, [request.rename, request.remove]);

    // The same menu as a right-click on the part in the view (contextMenus.tsx).
    const listActions: PartListActions = {
        rename: (part) => setRenaming(part.id),
        remove: (part) => askRemove(part.id),
        insertInstance: (part) => {
            insertInstance(part, parts);
            setExpanded((e) => new Set(e).add(part.id));
        },
        duplicate: duplicatePart,
        editPattern,
        removePattern,
    };
    const partMenu = (part: Part): MenuEntry[] => componentMenu(part, menuContext(), appActions, listActions);
    const patternMenu = (part: Part): MenuEntry[] => [
        { label: 'Edit pattern', hint: 'double-click', onSelect: () => editPattern(part) },
        'separator',
        { label: 'Remove pattern', danger: true, onSelect: () => removePattern(part) },
    ];

    const designs = parts.filter((p) => !p.instanceOf || !parts.some((q) => q.id === p.instanceOf));
    // Every component is a part: screws, nuts and bearings sit in the same list as the rest.
    const groups = [{ id: 'parts', label: 'Parts', parts: designs }];
    const toggleOpen = (id: string) => setExpanded((e) => {
        const next = new Set(e);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        return next;
    });
    /** A part's row; `open` (when it has things under it) adds the expander; `extra` is what the tree adds to a design's. */
    const row = (part: Part, design: Part, nested: boolean, open?: boolean, extra?: DesignRowProps) => {
        const all = part.id === design.id ? [design, ...instancesOf(design.id)] : [part];
        return (
            <ComponentRow
                key={part.id}
                part={effectivePart(part, parts)}
                nested={nested}
                open={open}
                onToggle={() => toggleOpen(part.id)}
                renaming={renaming === part.id}
                confirming={confirming === part.id}
                deleteIds={all.map((p) => p.id)}
                onRenamed={() => setRenaming(null)}
                onConfirmed={() => setConfirming(null)}
                onMenu={(event) => setMenu(menuAt(event, extra ? extra.menu(partMenu(part)) : partMenu(part)))}
                extra={extra}
            />
        );
    };
    const patternRow = (part: Part) => (
        <PatternRow
            key={`${part.id}:pattern`}
            part={part}
            onEdit={() => editPattern(part)}
            onMenu={(event) => setMenu(menuAt(event, patternMenu(part)))}
        />
    );

    return (
        <>
            <div className="br-head" onContextMenu={(e) => setMenu(menuAt(e, componentTreeMenu(folders)))}>
                <span className="br-title br-doc" title={`${name}: the assembly and its parts`}>{name}</span>
                <span className="br-count">{parts.length}</span>
                <button type="button" className="br-min" onClick={onMinimise} title="Minimise" aria-label="Minimise panel">–</button>
            </div>
            <div className="br-list" onContextMenu={(e) => e.target === e.currentTarget && setMenu(menuAt(e, componentTreeMenu(folders)))}>
                {parts.length === 0 && <p className="br-empty">No parts yet. Ask Jarvis or use the toolbar to add one.</p>}
                {parts.length > 0 && <AssemblyReferences />}
                {groups.filter((g) => g.parts.length > 0 || folders?.length).map((group) => (
                    <section key={group.id} className="br-group">
{groups.length > 1 && (
                                                    <button
                                type="button"
                                className="br-group-head"
                                onClick={() => toggle(group.id)}
                                aria-expanded={!collapsed.has(group.id)}
                            >
                                <span className="caret">{collapsed.has(group.id) ? '▸' : '▾'}</span>
                                {group.label}
                                <span className="br-count">{group.parts.length}</span>
                            </button>
                        )}
                        {!collapsed.has(group.id) && (
                            // The designs in their order and folders, dragged to reorder (ComponentTree.tsx).
                            <ComponentTree parts={parts} folders={folders} renameComponent={setRenaming} renderDesign={(design, extra) => {
                                const instances = instancesOf(design.id);
                                // What sits under a part: its pattern, its mates, origin and planes (mates/MatesTree.tsx),
                                // then the other places it is used, each with its own.
                                const open = expanded.has(design.id);
                                return (
                                    <>
                                        <ul>{row(design, design, false, open, extra)}</ul>
                                        {open && (
                                            <ul>
                                                {design.repeat && patternRow(design)}
                                                <ComponentBranch part={design} />
                                                {instances.flatMap((inst) => [
                                                    row(inst, design, true, expanded.has(inst.id)),
                                                    ...(expanded.has(inst.id) ? [<ComponentBranch key={`${inst.id}:branch`} part={inst} />] : []),
                                                    ...(inst.repeat ? [patternRow(inst)] : []),
                                                ])}
                                            </ul>
                                        )}
                                    </>
                                );
                            }} />
                        )}
                    </section>
                ))}
                {parts.length > 0 && <MatesFolder />}
            </div>
            {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        </>
    );
}

/** Removes parts; a design that still has instances goes together with them. */
async function removeParts(ids: string[]): Promise<void> {
    const result = await runTool('parts_remove', { ids });
    if (result.isError) {
        showError(/Still instanced/.test(result.text)
            ? 'This part still has instances. Use "Delete with all instances" from its menu.'
            : result.text);
    }
}

/** A part's pattern as its own item under the part: double-click edits it. */
function PatternRow({ part, onEdit, onMenu }: { part: Part; onEdit: () => void; onMenu: (event: MouseEvent) => void }) {
    const r = part.repeat!;
    const detail = r.kind === 'linear'
        ? `step ${r.step.map(valueText).join(', ')} mm`
        : `over ${r.angle ?? 360}°`;
    return (
        <li
            className="br-row component nested pattern"
            onDoubleClick={onEdit}
            onContextMenu={onMenu}
            title={`${r.kind === 'linear' ? 'Linear' : 'Circular'} pattern of ${part.name}: ${r.count} in all, ${detail} (double-click to edit)`}
        >
            <span className="br-pattern-icon" aria-hidden="true">{r.kind === 'linear' ? '⋯' : '⁘'}</span>
            <span className="br-text one-line"><span className="br-name">{r.kind === 'linear' ? 'Linear pattern' : 'Circular pattern'}</span></span>
            <span className="br-count">×{r.count}</span>
            <span className="br-actions">
                <button type="button" onClick={onMenu} title="More" aria-label={`More actions for the pattern of ${part.name}`}>⋯</button>
            </span>
        </li>
    );
}

function ComponentRow(props: {
    part: Part;
    nested: boolean;
    /** Set when the part has a pattern or instances under it: whether they are shown. */
    open?: boolean;
    onToggle?: () => void;
    renaming: boolean;
    confirming: boolean;
    /** What Delete removes: the part, or a design together with its instances. */
    deleteIds: string[];
    onRenamed: () => void;
    onConfirmed: () => void;
    onMenu: (event: MouseEvent) => void;
    /** A design's row in the tree: selection with Ctrl and Shift, dragging (ComponentTree.tsx). */
    extra?: DesignRowProps;
}) {
    const { part, nested, open, onToggle, renaming, confirming, deleteIds, onRenamed, onConfirmed, onMenu, extra } = props;
    const selected = useStudio((s) => s.selected === part.id);
    const hidden = useStudio((s) => s.history?.view.hidden?.includes(part.id) ?? false);
    const focused = useStudio((s) => s.history?.view.focus === part.id);
    const error = useStudio((s) => s.meshes.errors[part.id]);
    // Rolled back in its own history: the steps below the bar are not built, so the view may show little or nothing.
    const rolledTo = useStudio((s) => (s.history?.view.rollback?.partId === part.id ? s.history.view.rollback.count : null));
    // Its shown mesh is being rebuilt: the old one stays on screen until the new one lands (kernelActivity.ts).
    const rebuilding = usePartRebuilding(part.id);

    if (confirming) {
        const others = deleteIds.length - 1;
        return (
            <li className="br-row confirm">
                <span className="br-confirm-text">
                    Delete {part.name}{others > 0 ? ` and ${others} instance${others > 1 ? 's' : ''}` : ''}?
                </span>
                <button
                    type="button"
                    className="danger"
                    autoFocus
                    onClick={() => {
                        onConfirmed();
                        void removeParts(deleteIds);
                    }}
                >
                    Delete
                </button>
                <button type="button" onClick={onConfirmed}>Keep</button>
            </li>
        );
    }
    const features = part.features?.length ?? 0;
    return (
        <li
            className={`br-row component ${nested ? 'nested' : ''} ${selected ? 'current' : ''} ${focused ? 'focused' : ''} ${hidden ? 'hidden' : ''} ${extra?.className ?? ''}`}
            onClick={extra?.onClick ?? (() => select(selected ? null : part.id))}
            draggable={!!extra?.draggable && !renaming}
            onDragStart={extra?.onDragStart}
            onDragEnd={extra?.onDragEnd}
            onDoubleClick={() => setWorkspace('part', part.id, 'isolated')}
            onContextMenu={onMenu}
            title={`${part.description ?? part.name}${features ? ` · ${features} feature${features === 1 ? '' : 's'}` : ''}`
                + `${part.instanceOf ? ' · instance' : ''} (double-click to edit the part)`}
            aria-selected={selected}
            aria-expanded={open}
        >
            {open !== undefined && (
                <button
                    type="button"
                    className="br-caret"
                    onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={open ? 'Collapse' : 'Show what is under it: its mates, origin and planes, pattern and instances'}
                    aria-label={open ? 'Collapse' : 'Expand'}
                >
                    {open ? '▾' : '▸'}
                </button>
            )}
            <span className="br-swatch" style={{ background: part.material.color }} />
            <ComponentPrefix partId={part.id} />
            <span className="br-text one-line">
                {renaming ? (
                    <InlineInput
                        value={part.name}
                        label="Part name"
                        onCommit={(name) => {
                            onRenamed();
                            void tool('parts_update', { updates: [{ id: part.id, name }] });
                        }}
                        onCancel={onRenamed}
                    />
                ) : <span className="br-name">{part.name}</span>}
            </span>
            {part.instanceOf && <span className="br-tag" title="Another placement of the same design">instance</span>}
            {rolledTo !== null && rolledTo < (part.features?.length ?? 0) && (
                <span className="br-tag" title={`Its history is rolled back: ${rolledTo} of ${part.features?.length ?? 0} steps are built. `
                    + 'Double-click the part and choose Roll to end under its tree.'}>
                    rolled back
                </span>
            )}
            {part.repeat && <span className="br-count" title="Patterned">×{part.repeat.count}</span>}
            {error && <span className="br-warn" title={`Built only up to the failing step: ${error}`}>⚠</span>}
            {rebuilding && <span className="cad-busy" title="Being rebuilt" aria-label="Being rebuilt" />}
            <span className={`br-actions ${hidden ? 'has-off' : ''}`}>
                <button
                    type="button"
                    className={hidden ? 'off' : ''}
                    onClick={(e) => { e.stopPropagation(); setHidden(part.id, !hidden); }}
                    title={hidden ? 'Show part' : 'Hide part'}
                    aria-label={`${hidden ? 'Show' : 'Hide'} ${part.name}`}
                >
                    {hidden ? '◌' : '◉'}
                </button>
                <button type="button" onClick={onMenu} title="More" aria-label={`More actions for ${part.name}`}>⋯</button>
            </span>
        </li>
    );
}
