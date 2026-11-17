// The assembly's side of the tree for mates, after the FeatureManager: the assembly's own planes and origin at the
// top, under each component its Mates folder, origin, planes and reference steps (picked from here into the Mate
// form), and the Mates folder at the bottom with every mate (icon by type, red and yellow marks), in folders.

import { useState, type DragEvent, type MouseEvent } from 'react';
import { effectivePart, type Part } from '@jarvis/core';
import {
    fixedParts, MATE_LABELS, matesOf, type AssemblyMates, type AssemblyResult, type ComponentState, type Mate, type MatePick, type MateStatus,
} from '@jarvis/core/mates';
import { Icon } from '../icons';
import { ContextMenu, InlineInput, tool, type MenuEntry } from '../menus';
import { menuAt, type Menu } from '../browserUtil';
import { confirmDeletes } from '../options';
import { StepIcon } from '../stepIcons';
import { useStudio } from '../state';
import { editMate, openMateForm } from './MateForm';
import { PREFIX, PREFIX_TITLE, useComponentState, useMateAnalysis } from './mateAnalysis';
import { pickMateItem, useMateForm, useMateSelection } from './mateState';
import './mates.css';

const PLANES: { plane: 'front' | 'top' | 'right'; label: string }[] = [
    { plane: 'front', label: 'Front plane' },
    { plane: 'top', label: 'Top plane' },
    { plane: 'right', label: 'Right plane' },
];

/** The prefix before a component's name: (f) fixed, (-) under defined, (+) over defined, (?) not solved. */
export function ComponentPrefix({ partId }: { partId: string }) {
    return <PrefixView state={useComponentState(partId)} />;
}

/** The prefix for a component's state and freedom. */
export function PrefixView({ state }: { state: { state: ComponentState; dof: number } | null }) {
    if (!state || !PREFIX[state.state]) {
        return null;
    }
    const title = state.state === 'under' ? `${PREFIX_TITLE.under} (${state.dof} degree${state.dof === 1 ? '' : 's'} of freedom)` : PREFIX_TITLE[state.state];
    return <span className={`mt-prefix ${state.state}`} title={title}>{PREFIX[state.state].trim()}</span>;
}

/** A reference row: picked into the Mate form when it is open. */
function RefRow(props: { label: string; icon: string; pick: MatePick; part?: string; nested?: boolean }) {
    const open = useMateForm((s) => s.open);
    return (
        <li
            className={`br-row component nested mt-ref ${open ? 'pickable' : ''}`}
            onClick={(e) => {
                e.stopPropagation();
                pickMateItem({ ...(props.part ? { part: props.part } : {}), pick: props.pick });
            }}
            title={open ? `${props.label}: click to mate it` : `${props.label} (open Mate to pick it)`}
        >
            <StepIcon name={props.icon} />
            <span className="br-text one-line"><span className="br-name">{props.label}</span></span>
        </li>
    );
}

/** The assembly's own origin and planes, at the top of the tree. */
export function AssemblyReferences() {
    const [open, setOpen] = useState(false);
    return (
        <ul className="mt-assembly-refs">
            <li className="br-row component mt-folder" onClick={() => setOpen(!open)} aria-expanded={open} title="The assembly's planes and origin">
                <span className="br-caret">{open ? '▾' : '▸'}</span>
                <Icon name="ref-plane" size={14} />
                <span className="br-text one-line"><span className="br-name">Planes and origin</span></span>
            </li>
            {open && (
                <>
                    {PLANES.map((p) => <RefRow key={p.plane} label={p.label} icon="ref-plane" pick={{ kind: 'plane', plane: p.plane }} />)}
                    <RefRow label="Origin" icon="ref-point" pick={{ kind: 'point', point: 'origin' }} />
                </>
            )}
        </ul>
    );
}

/** What sits under an expanded component: its Mates folder, origin, planes and reference steps. */
export function ComponentBranch({ part }: { part: Part }) {
    const parts = useStudio((s) => s.history?.parts) ?? [];
    const assembly = useStudio((s) => s.history?.assembly);
    const analysis = useMateAnalysis();
    const [open, setOpen] = useState(true);
    const mates = matesOf(assembly, part.id);
    const steps = (effectivePart(part, parts).features ?? []).filter((f) => f.op === 'plane' || f.op === 'axis' || f.op === 'point');
    return (
        <>
            {mates.length > 0 && (
                <li className="br-row component nested mt-folder" onClick={() => setOpen(!open)} aria-expanded={open}
                    title={`The mates of ${part.name}`}>
                    <span className="br-caret">{open ? '▾' : '▸'}</span>
                    <Icon name="mates" size={14} />
                    <span className="br-text one-line"><span className="br-name">Mates</span></span>
                    <span className="br-count">{mates.length}</span>
                </li>
            )}
            {open && mates.map((m) => <MateRow key={m.id} mate={m} parts={parts} status={analysis.mates[m.id]} nested />)}
            <RefRow label="Origin" icon="ref-point" part={part.id} pick={{ kind: 'point', point: 'origin' }} />
            {PLANES.map((p) => <RefRow key={p.plane} label={p.label} icon="ref-plane" part={part.id} pick={{ kind: 'plane', plane: p.plane }} />)}
            {steps.map((f) => (
                <RefRow
                    key={f.id}
                    label={f.name ?? f.id}
                    icon={f.op === 'plane' ? 'ref-plane' : f.op === 'axis' ? 'ref-axis' : 'ref-point'}
                    part={part.id}
                    pick={f.op === 'plane' ? { kind: 'plane', plane: { step: f.id } } : f.op === 'axis' ? { kind: 'axis', axis: { step: f.id } }
                        : { kind: 'point', point: { step: f.id } }}
                />
            ))}
        </>
    );
}

const stateMark = (status: MateStatus | undefined) => (status?.state === 'error' ? 'error' : status?.state === 'warning' ? 'warning' : '');

/** The names of a mate's components, as SolidWorks lists them after the mate's name. */
function componentNames(mate: Mate, parts: readonly Part[]): string {
    return mate.refs.map((r) => (r.part ? parts.find((p) => p.id === r.part)?.name ?? r.part : 'Assembly')).join(', ');
}

/** The mate rows' shared actions. */
function mateMenu(mate: Mate, status: MateStatus | undefined, selected: string[], actions: {
    rename: () => void; remove: (ids: string[]) => void; wrong: () => void;
}, folder: string | null): MenuEntry[] {
    const ids = selected.includes(mate.id) ? selected : [mate.id];
    const entries: MenuEntry[] = [
        { header: ids.length > 1 ? `${ids.length} mates` : mate.name },
        { label: 'Edit mate', icon: 'mate', hint: 'double-click', onSelect: () => editMate(mate.id), disabled: ids.length > 1 },
        {
            label: mate.suppressed ? 'Unsuppress' : 'Suppress',
            onSelect: () => void tool('mates_update', { updates: ids.map((id) => ({ id, suppressed: !mate.suppressed })) }),
        },
        ...(status && status.state !== 'ok' && status.state !== 'suppressed' ? [{ label: 'What\'s wrong', onSelect: actions.wrong }] : []),
        'separator',
        { label: 'Add to new folder', icon: 'mates', onSelect: () => void tool('mate_folders', { action: 'add', mates: ids }) },
        ...(folder ? [{ label: 'Take out of the folder', onSelect: () => void tool('mate_folders', { action: 'move', mates: ids, folder: null }) }] : []),
        { label: 'Rename', onSelect: actions.rename, disabled: ids.length > 1 },
        'separator',
        { label: ids.length > 1 ? `Delete ${ids.length} mates` : 'Delete', icon: 'delete', danger: true, onSelect: () => actions.remove(ids) },
    ];
    return entries;
}

/** One mate: its type's icon, name, the components it joins, and a red or yellow mark when it is not well. */
function MateRow({ mate, parts, status, nested, folder = null }: {
    mate: Mate; parts: readonly Part[]; status: MateStatus | undefined; nested?: boolean; folder?: string | null;
}) {
    const selected = useMateSelection((s) => s.selected);
    const isSelected = selected.includes(mate.id);
    const [menu, setMenu] = useState<Menu>(null);
    const [renaming, setRenaming] = useState(false);
    const [confirming, setConfirming] = useState<string[] | null>(null);
    const [wrong, setWrong] = useState(false);
    const mark = stateMark(status);
    const remove = (ids: string[]) => {
        if (confirmDeletes()) {
            setConfirming(ids);
        } else {
            void tool('mates_remove', { ids });
            useMateSelection.setState({ selected: [] });
        }
    };
    if (confirming) {
        return (
            <li className="br-row confirm">
                <span className="br-confirm-text">Delete {confirming.length > 1 ? `${confirming.length} mates` : mate.name}?</span>
                <button type="button" className="danger" autoFocus onClick={() => {
                    setConfirming(null);
                    void tool('mates_remove', { ids: confirming });
                    useMateSelection.setState({ selected: [] });
                }}>Delete</button>
                <button type="button" onClick={() => setConfirming(null)}>Keep</button>
            </li>
        );
    }
    const title = `${mate.name}: ${MATE_LABELS[mate.type].toLowerCase()} of ${componentNames(mate, parts)}${mate.value !== undefined
        ? ` (${mate.value}${mate.type === 'angle' ? '°' : ' mm'})` : ''}${mate.suppressed ? ' · suppressed' : ''}`
        + `${status?.message ? `\n${status.state === 'error' ? 'Error' : 'Warning'}: ${status.message}` : ''}\nDouble-click to edit it`;
    return (
        <>
            <li
                className={`br-row component mt-row ${nested ? 'nested' : ''} ${isSelected ? 'current' : ''} ${mate.suppressed ? 'mt-suppressed' : ''} ${mark}`}
                onClick={(e) => {
                    const ids = e.ctrlKey || e.metaKey ? (isSelected ? selected.filter((id) => id !== mate.id) : [...selected, mate.id])
                        : isSelected && selected.length === 1 ? [] : [mate.id];
                    useMateSelection.setState({ selected: ids });
                }}
                onDoubleClick={() => editMate(mate.id)}
                onContextMenu={(e) => setMenu(menuAt(e, mateMenu(mate, status, selected, {
                    rename: () => setRenaming(true), remove, wrong: () => setWrong(true),
                }, folder)))}
                draggable={!renaming}
                onDragStart={(e: DragEvent) => {
                    const ids = isSelected ? selected : [mate.id];
                    e.dataTransfer.setData('application/x-jarvis-mates', JSON.stringify(ids));
                    e.dataTransfer.effectAllowed = 'move';
                }}
                title={title}
                aria-selected={isSelected}
            >
                <Icon name={`mate-${mate.type}`} size={14} />
                <span className="br-text one-line">
                    {renaming ? (
                        <InlineInput value={mate.name} label="Mate name" onCommit={(name) => {
                            setRenaming(false);
                            void tool('mates_update', { updates: [{ id: mate.id, name }] });
                        }} onCancel={() => setRenaming(false)} />
                    ) : (
                        <span className="br-name">
                            {mark === 'error' && status?.reason !== 'missing' ? '(+) ' : status?.reason === 'missing' ? '(?) ' : ''}
                            {mate.name}
                            <span className="mt-parts"> ({componentNames(mate, parts)})</span>
                        </span>
                    )}
                </span>
                {mark && (
                    <button type="button" className={`mt-mark ${mark}`} onClick={(e) => { e.stopPropagation(); setWrong(!wrong); }}
                        title={`${status?.message ?? ''} (click: What's wrong)`} aria-label={mark === 'error' ? 'Mate error' : 'Mate warning'}>
                        {mark === 'error' ? '✕' : '!'}
                    </button>
                )}
            </li>
            {wrong && status?.message && (
                <li className={`mt-wrong ${mark}`} onClick={() => setWrong(false)} title="Click to close">
                    <b>What's wrong:</b> {status.message}
                </li>
            )}
            {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        </>
    );
}

/** Drop target of mates being dragged in the tree: into a folder, or out of the folders (null). */
function dropProps(folder: string | null, over: string | null, setOver: (key: string | null) => void) {
    const key = folder ?? 'root';
    return {
        className: over === key ? 'mt-drop' : '',
        onDragOver: (e: DragEvent) => {
            if (e.dataTransfer.types.includes('application/x-jarvis-mates')) {
                e.preventDefault();
                setOver(key);
            }
        },
        onDragLeave: () => setOver(null),
        onDrop: (e: DragEvent) => {
            setOver(null);
            const raw = e.dataTransfer.getData('application/x-jarvis-mates');
            if (raw) {
                e.preventDefault();
                void tool('mate_folders', { action: 'move', mates: JSON.parse(raw) as string[], folder });
            }
        },
    };
}

/** The Mates folder at the bottom of the tree: user folders first, then the mates in no folder. */
export function MatesFolder() {
    const parts = useStudio((s) => s.history?.parts) ?? [];
    const assembly = useStudio((s) => s.history?.assembly);
    return <MatesFolderView parts={parts} assembly={assembly} analysis={useMateAnalysis()} />;
}

/** The Mates folder drawn from given parts, mates and analysis. */
export function MatesFolderView({ parts, assembly, analysis }: { parts: readonly Part[]; assembly: AssemblyMates | undefined; analysis: AssemblyResult }) {
    const [open, setOpen] = useState(true);
    const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
    const [renaming, setRenaming] = useState<string | null>(null);
    const [menu, setMenu] = useState<Menu>(null);
    const [over, setOver] = useState<string | null>(null);
    const mates = assembly?.mates ?? [];
    const folders = assembly?.folders ?? [];
    const inFolder = new Set(folders.flatMap((f) => f.mates));
    const errors = mates.filter((m) => analysis.mates[m.id]?.state === 'error').length;
    const warnings = mates.filter((m) => analysis.mates[m.id]?.state === 'warning').length;
    const toggleFolder = (id: string) => setOpenFolders((s) => {
        const next = new Set(s);
        if (!next.delete(id)) {
            next.add(id);
        }
        return next;
    });
    const rootMenu = (e: MouseEvent) => setMenu(menuAt(e, [
        { header: 'Mates' },
        { label: 'Add mate', icon: 'mate', onSelect: openMateForm },
        { label: 'New folder', icon: 'mates', onSelect: () => void tool('mate_folders', { action: 'add', mates: [] }) },
        {
            label: 'Lock concentric rotation', title: 'Locks the rotation of every concentric mate',
            disabled: !mates.some((m) => m.type === 'concentric' && !m.lockRotation),
            onSelect: () => void tool('mates_update', { updates: mates.filter((m) => m.type === 'concentric' && !m.lockRotation).map((m) => ({ id: m.id, lockRotation: true })) }),
        },
    ]));
    const drop = dropProps(null, over, setOver);
    return (
        <ul className="mt-mates">
            <li
                className={`br-row component mt-folder mt-root ${drop.className}`}
                onClick={() => setOpen(!open)}
                onContextMenu={rootMenu}
                onDragOver={drop.onDragOver}
                onDragLeave={drop.onDragLeave}
                onDrop={drop.onDrop}
                aria-expanded={open}
                title={`The assembly's mates, solved together${errors ? `\n${errors} with errors` : ''}${warnings ? `\n${warnings} with warnings` : ''}`}
            >
                <span className="br-caret">{open ? '▾' : '▸'}</span>
                <Icon name="mates" size={14} />
                <span className="br-text one-line"><span className="br-name">{errors || warnings ? '(-) ' : ''}Mates</span></span>
                {errors > 0 && <span className="mt-mark error" title={`${errors} mate error(s)`}>✕</span>}
                {!errors && warnings > 0 && <span className="mt-mark warning" title={`${warnings} mate warning(s)`}>!</span>}
                <span className="br-count">{mates.length}</span>
            </li>
            {open && mates.length === 0 && <li className="br-empty">No mates yet: Mate on the toolbar joins two parts.</li>}
            {open && folders.map((f) => {
                const fopen = openFolders.has(f.id);
                const fdrop = dropProps(f.id, over, setOver);
                const held = f.mates.map((id) => mates.find((m) => m.id === id)).filter((m): m is Mate => !!m);
                return (
                    <li key={f.id} className="mt-folder-group">
                        <ul>
                            <li
                                className={`br-row component nested mt-folder ${fdrop.className}`}
                                onClick={() => toggleFolder(f.id)}
                                onDragOver={fdrop.onDragOver}
                                onDragLeave={fdrop.onDragLeave}
                                onDrop={fdrop.onDrop}
                                onContextMenu={(e) => setMenu(menuAt(e, [
                                    { header: f.name },
                                    { label: 'Rename', onSelect: () => setRenaming(f.id) },
                                    { label: 'Delete folder', icon: 'delete', title: 'The mates stay in the Mates folder', onSelect: () => void tool('mate_folders', { action: 'remove', ids: [f.id] }) },
                                ]))}
                                aria-expanded={fopen}
                                title={`Folder ${f.name}: ${held.length} mate(s). Drag mates onto it to put them in.`}
                            >
                                <span className="br-caret">{fopen ? '▾' : '▸'}</span>
                                <StepIcon name={fopen && held.length ? 'folder-open' : 'folder'} />
                                <span className="br-text one-line">
                                    {renaming === f.id ? (
                                        <InlineInput value={f.name} label="Folder name" onCommit={(name) => {
                                            setRenaming(null);
                                            void tool('mate_folders', { action: 'rename', id: f.id, name });
                                        }} onCancel={() => setRenaming(null)} />
                                    ) : <span className="br-name">{held.some((m) => stateMark(analysis.mates[m.id])) ? '(-) ' : ''}{f.name}</span>}
                                </span>
                                <span className="br-count">{held.length}</span>
                            </li>
                            {fopen && held.map((m) => <MateRow key={m.id} mate={m} parts={parts} status={analysis.mates[m.id]} nested folder={f.id} />)}
                        </ul>
                    </li>
                );
            })}
            {open && mates.filter((m) => !inFolder.has(m.id)).map((m) => <MateRow key={m.id} mate={m} parts={parts} status={analysis.mates[m.id]} />)}
            {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        </ul>
    );
}

/** A component's mate commands, for its menus in the tree and the view: Fix or Float, Mate, View mates. */
export function componentMateEntries(part: Part, fixed: boolean, mated: boolean, view: () => void): MenuEntry[] {
    return [
        { label: fixed ? 'Float' : 'Fix', title: fixed ? 'Let it move as its mates allow' : 'Fix it in place: it does not move',
            onSelect: () => void tool('components_fix', { ids: [part.id], fixed: !fixed }) },
        { label: 'Mate', icon: 'mate', onSelect: openMateForm },
        ...(mated ? [{ label: 'View mates', icon: 'mates', onSelect: view }] : []),
    ];
}

/** A component's mate commands as its right-click menus show them (contextMenus.tsx). */
export function componentMateMenu(part: Part): MenuEntry[] {
    const history = useStudio.getState().history;
    if (!history) {
        return [];
    }
    const mates = matesOf(history.assembly, part.id);
    return componentMateEntries(part, fixedParts(history.parts, history.assembly).has(part.id), mates.length > 0,
        () => useMateSelection.setState({ selected: mates.map((m) => m.id) }));
}
