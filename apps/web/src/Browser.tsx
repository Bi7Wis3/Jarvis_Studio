import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { effectivePart, shapeHalfExtents, type Part, type Vec3 } from '@jarvis/core';
import { labelInsets } from './Labels';
import { ContextMenu, InlineInput, showError, tool, type MenuEntry } from './menus';
import { focusPart, runTool, select, setHidden, setWorkspace, useStudio } from './state';
import { load, menuAt, NONE, store, STORAGE_KEY, type Menu } from './browserUtil';
import { PartHistory } from './FeatureTree';
import { usePropertyManager } from './PropertyManager';
import './browser.css';

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
                {part ? 'History' : 'Components'}
            </button>
        );
    }
    return (
        <nav className={`br ${editingFeature ? 'pm-on' : ''}`} aria-label={editingFeature ? 'Property manager' : part ? 'Part history' : 'Components'}>
            <div className="pm-slot" ref={setSlot} hidden={!editingFeature} />
            {open && (
                <Hideable hidden={editingFeature}>
                    {part
                        ? <PartHistory key={part.id} part={part} parts={history.parts} onMinimise={() => setOpen(false)} />
                        : <Components parts={history.parts} onMinimise={() => setOpen(false)} />}
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

function Components(props: { parts: Part[]; onMinimise: () => void }) {
    const { parts, onMinimise } = props;
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

    const duplicate = (part: Part) => {
        const { id: _id, instanceOf: _source, ...rest } = part;
        const width = shapeHalfExtents(part.shape)[0] * 2;
        const position: Vec3 = [part.position[0] + width + 10, part.position[1], part.position[2]];
        void tool('parts_add', { parts: [{ ...rest, name: `${part.name} copy`, position }] });
    };

    const instancesOf = (id: string) => parts.filter((p) => p.instanceOf === id);
    const insertInstance = (source: Part) => {
        const members = [source, ...instancesOf(source.id)];
        const last = members[members.length - 1];
        const width = shapeHalfExtents(source.shape)[0] * 2;
        void tool('parts_instance', {
            partId: source.id,
            instances: [{ position: [last.position[0] + width + 10, last.position[1], last.position[2]], rotation: last.rotation }],
        });
        setExpanded((e) => new Set(e).add(source.id));
    };

    const designMenu = (part: Part): MenuEntry[] => [
        { label: 'Edit part', hint: 'double-click', onSelect: () => setWorkspace('part', part.id, 'isolated') },
        { label: 'Edit in place', onSelect: () => setWorkspace('part', part.id, 'inContext') },
        { label: 'Insert instance', onSelect: () => insertInstance(part) },
        'separator',
        { label: 'Rename', onSelect: () => setRenaming(part.id) },
        { label: 'Duplicate as new part', onSelect: () => duplicate(part) },
        { label: 'Zoom to part', onSelect: () => focusPart(part.id) },
        'separator',
        {
            label: instancesOf(part.id).length ? 'Delete with all instances' : 'Delete',
            danger: true,
            onSelect: () => setConfirming(part.id),
        },
    ];
    const instanceMenu = (part: Part): MenuEntry[] => [
        { label: 'Edit part', hint: 'double-click', onSelect: () => setWorkspace('part', part.id, 'isolated') },
        { label: 'Edit in place', onSelect: () => setWorkspace('part', part.id, 'inContext') },
        { label: 'Rename', onSelect: () => setRenaming(part.id) },
        { label: 'Zoom to part', onSelect: () => focusPart(part.id) },
        'separator',
        { label: 'Delete instance', danger: true, onSelect: () => setConfirming(part.id) },
    ];

    const designs = parts.filter((p) => !p.instanceOf || !parts.some((q) => q.id === p.instanceOf));
    // Every component is a part: screws, nuts and bearings sit in the same list as the rest.
    const groups = [{ id: 'parts', label: 'Parts', parts: designs }];
    const row = (part: Part, design: Part, nested: boolean) => {
        const all = part.id === design.id ? [design, ...instancesOf(design.id)] : [part];
        return (
            <ComponentRow
                key={part.id}
                part={effectivePart(part, parts)}
                nested={nested}
                renaming={renaming === part.id}
                confirming={confirming === part.id}
                deleteIds={all.map((p) => p.id)}
                onRenamed={() => setRenaming(null)}
                onConfirmed={() => setConfirming(null)}
                onMenu={(event) => setMenu(menuAt(event, part.instanceOf ? instanceMenu(part) : designMenu(part)))}
            />
        );
    };

    return (
        <>
            <div className="br-head">
                <span className="br-title">Components</span>
                <span className="br-count">{parts.length}</span>
                <button type="button" className="br-min" onClick={onMinimise} title="Minimise" aria-label="Minimise panel">–</button>
            </div>
            <div className="br-list">
                {parts.length === 0 && <p className="br-empty">No parts yet. Ask Jarvis or use the toolbar to add one.</p>}
                {groups.filter((g) => g.parts.length > 0).map((group) => (
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
                            <ul>
                                {group.parts.map((design) => {
                                    const instances = instancesOf(design.id);
                                    if (instances.length === 0) {
                                        return row(design, design, false);
                                    }
                                    const open = expanded.has(design.id);
                                    return (
                                        <li key={design.id} className="br-instances">
                                            <InstanceHead
                                                part={design}
                                                members={[design, ...instances]}
                                                open={open}
                                                confirming={confirming === design.id}
                                                onToggle={() => setExpanded((e) => {
                                                    const next = new Set(e);
                                                    if (open) {
                                                        next.delete(design.id);
                                                    } else {
                                                        next.add(design.id);
                                                    }
                                                    return next;
                                                })}
                                                onConfirmed={() => setConfirming(null)}
                                                onMenu={(event) => setMenu(menuAt(event, designMenu(design)))}
                                            />
                                            {open && (
                                                <ul>
                                                    {row(design, design, true)}
                                                    {instances.map((inst) => row(inst, design, true))}
                                                </ul>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>
                ))}
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

/** Header of a design placed several times: "Wheel ×4", expandable to each instance. */
function InstanceHead(props: {
    part: Part;
    members: Part[];
    open: boolean;
    confirming: boolean;
    onToggle: () => void;
    onConfirmed: () => void;
    onMenu: (event: MouseEvent) => void;
}) {
    const { part, members, open, confirming, onToggle, onConfirmed, onMenu } = props;
    const hiddenIds = useStudio((s) => s.history?.view.hidden ?? NONE);
    const error = useStudio((s) => members.some((m) => s.meshes.errors[m.id]));
    const allHidden = members.every((m) => hiddenIds.includes(m.id));
    if (confirming) {
        return (
            <div className="br-row confirm">
                <span className="br-confirm-text">Delete {part.name} and its {members.length - 1} instance{members.length > 2 ? 's' : ''}?</span>
                <button
                    type="button"
                    className="danger"
                    autoFocus
                    onClick={() => {
                        onConfirmed();
                        void removeParts(members.map((m) => m.id));
                    }}
                >
                    Delete all
                </button>
                <button type="button" onClick={onConfirmed}>Keep</button>
            </div>
        );
    }
    return (
        <div
            className={`br-row component group ${allHidden ? 'hidden' : ''}`}
            onClick={onToggle}
            onDoubleClick={() => setWorkspace('part', part.id, 'isolated')}
            onContextMenu={onMenu}
            title={`${part.name}: one design placed ${members.length} times (double-click to edit the design)`}
        >
            <span className="br-caret">{open ? '▾' : '▸'}</span>
            <span className="br-swatch" style={{ background: part.material.color }} />
            <span className="br-text one-line"><span className="br-name">{part.name}</span></span>
            <span className="br-count">×{members.length}</span>
            {error && <span className="br-warn" title="A build error in this part">⚠</span>}
            <span className={`br-actions ${allHidden ? 'has-off' : ''}`}>
                <button
                    type="button"
                    className={allHidden ? 'off' : ''}
                    onClick={(e) => {
                        e.stopPropagation();
                        members.forEach((m) => setHidden(m.id, !allHidden));
                    }}
                    title={allHidden ? 'Show all instances' : 'Hide all instances'}
                    aria-label={`${allHidden ? 'Show' : 'Hide'} all ${part.name}`}
                >
                    {allHidden ? '◌' : '◉'}
                </button>
                <button type="button" onClick={onMenu} title="More" aria-label={`More actions for ${part.name}`}>⋯</button>
            </span>
        </div>
    );
}

function ComponentRow(props: {
    part: Part;
    nested: boolean;
    renaming: boolean;
    confirming: boolean;
    /** What Delete removes: the part, or a design together with its instances. */
    deleteIds: string[];
    onRenamed: () => void;
    onConfirmed: () => void;
    onMenu: (event: MouseEvent) => void;
}) {
    const { part, nested, renaming, confirming, deleteIds, onRenamed, onConfirmed, onMenu } = props;
    const selected = useStudio((s) => s.selected === part.id);
    const hidden = useStudio((s) => s.history?.view.hidden?.includes(part.id) ?? false);
    const focused = useStudio((s) => s.history?.view.focus === part.id);
    const error = useStudio((s) => s.meshes.errors[part.id]);

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
            className={`br-row component ${nested ? 'nested' : ''} ${selected ? 'current' : ''} ${focused ? 'focused' : ''} ${hidden ? 'hidden' : ''}`}
            onClick={() => select(selected ? null : part.id)}
            onDoubleClick={() => setWorkspace('part', part.id, 'isolated')}
            onContextMenu={onMenu}
            title={`${part.description ?? part.name}${features ? ` · ${features} feature${features === 1 ? '' : 's'}` : ''}`
                + `${part.instanceOf ? ' · instance' : ''} (double-click to edit the part)`}
            aria-selected={selected}
        >
            <span className="br-swatch" style={{ background: part.material.color }} />
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
            {part.repeat && <span className="br-count">×{part.repeat.count}</span>}
            {error && <span className="br-warn" title={`Built only up to the failing step: ${error}`}>⚠</span>}
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
