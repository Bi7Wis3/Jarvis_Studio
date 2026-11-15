// Customize toolbars (SolidWorks: Tools > Customize, Toolbars and Commands tabs): per mode, which toolbars show, and
// per toolbar its tools and their order, icon size, text under the icons and how variants are shown. Opened from a
// right-click on the toolbar (in the left panel) and from the options page. The arrangement is kept by toolbarStore.

import { useMemo, useState, type DragEvent } from 'react';
import { Icon } from './icons';
import { useSketcher } from './sketcher';
import { useStudio } from './state';
import { familyOf } from './toolFamilies';
import { ASSEMBLY_GROUPS, PART_GROUPS, SKETCH_GROUPS, type ToolDef, type ToolGroup } from './toolDefs';
import {
    addedTool, arrangeToolbars, modeTools, movedTool, removedTool, TOOLBAR_MODES, withOption, withTools,
    type ArrangedToolbar, type FamilyStyle, type IconSize, type TipStyle, type ToolbarMode,
} from './toolbarLayout';
import { resetArrangement, setToolbarPrefs, useToolbarArrangement } from './toolbarStore';
import './toolbarOptions.css';

/** The toolbars of a mode, as toolDefs.tsx defines them. */
export function modeGroups(mode: ToolbarMode): ToolGroup[] {
    return mode === 'sketch' ? SKETCH_GROUPS : mode === 'part' ? PART_GROUPS : ASSEMBLY_GROUPS;
}

/** The mode the toolbar is in now: sketching, else the workspace. */
export function useToolbarMode(): ToolbarMode {
    const workspace = useStudio((s) => s.workspace);
    const sketching = useSketcher((s) => s.active);
    return sketching ? 'sketch' : workspace;
}

const SIZES: { value: IconSize; label: string }[] = [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }];

function ToolbarSection(props: { toolbar: ArrangedToolbar; defaults: string[]; groups: ToolGroup[]; open: boolean; onToggle: () => void }) {
    const { toolbar, defaults, groups, open, onToggle } = props;
    const prefs = useToolbarArrangement((s) => s.arrangement[toolbar.key]);
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const ids = toolbar.tools.map((t) => t.id);
    const setIds = (next: string[]) => setToolbarPrefs(toolbar.key, withTools(prefs, defaults, next));
    const hasFamilies = toolbar.tools.some((t) => familyOf(t.id));
    const addable = groups
        .map((g) => ({ group: g, tools: g.tools.filter((t, i, list) => !ids.includes(t.id) && list.findIndex((o) => o.id === t.id) === i) }))
        .filter((g) => g.tools.length);
    const drop = (event: DragEvent, to: number) => {
        event.preventDefault();
        event.stopPropagation();
        if (dragging !== null && dragging !== to) {
            setIds(movedTool(ids, dragging, to));
        }
        setDragging(null);
        setOver(null);
    };
    const row = (tool: ToolDef, i: number) => (
        <li
            key={tool.id}
            className={`tbo-tool ${dragging === i ? 'dragging' : ''} ${over === i && dragging !== i ? 'over' : ''}`}
            draggable
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tool.id);
                setDragging(i);
            }}
            onDragOver={(event) => {
                if (dragging !== null) {
                    event.preventDefault();
                    setOver(i);
                }
            }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(event) => drop(event, i)}
            onDragEnd={() => {
                setDragging(null);
                setOver(null);
            }}
            title="Drag to move it along the toolbar"
        >
            <span className="tbo-grip" aria-hidden="true">⋮⋮</span>
            <Icon name={tool.icon} size={15} />
            <span className="tbo-label">{tool.label}</span>
            <button type="button" onClick={() => setIds(movedTool(ids, i, i - 1))} disabled={i === 0} aria-label={`Move ${tool.label} left`} title="Earlier on the toolbar">
                <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 6.5l3-3 3 3" /></svg>
            </button>
            <button type="button" onClick={() => setIds(movedTool(ids, i, i + 1))} disabled={i === ids.length - 1} aria-label={`Move ${tool.label} right`} title="Later on the toolbar">
                <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
            </button>
            <button type="button" className="tbo-remove" onClick={() => setIds(removedTool(ids, i))} aria-label={`Remove ${tool.label}`} title="Remove from this toolbar">
                ×
            </button>
        </li>
    );
    return (
        <section className={`tbo-bar pm-section ${open ? 'open' : ''}`}>
            <div className="tbo-head">
                <label className="tbo-show" title={toolbar.hidden ? 'Hidden: tick to show this toolbar' : 'Shown: clear to hide this toolbar'}>
                    <input
                        type="checkbox"
                        checked={!toolbar.hidden}
                        onChange={(event) => setToolbarPrefs(toolbar.key, withOption(prefs, 'hidden', !event.target.checked))}
                    />
                    <Icon name={toolbar.icon} size={15} />
                    <span>{toolbar.label}</span>
                </label>
                {toolbar.customised && <em className="tbo-changed" title="Changed from the default">changed</em>}
                <button type="button" className="tbo-expand" onClick={onToggle} aria-expanded={open} aria-label={`${toolbar.label}: options`}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
                </button>
            </div>
            {open && (
                <div className="tbo-body">
                    <div className="tb-field">
                        <span>Icon size</span>
                        <span className="tbo-choice" role="radiogroup" aria-label="Icon size">
                            {SIZES.map((s) => (
                                <button
                                    key={s.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={toolbar.size === s.value}
                                    className={toolbar.size === s.value ? 'on' : ''}
                                    onClick={() => setToolbarPrefs(toolbar.key, withOption(prefs, 'size', s.value))}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </span>
                    </div>
                    <label className="tb-check">
                        <input type="checkbox" checked={toolbar.labels} onChange={(e) => setToolbarPrefs(toolbar.key, withOption(prefs, 'labels', e.target.checked))} />
                        <span>Text under the icons</span>
                    </label>
                    <label className="tb-field">
                        <span>Tooltips</span>
                        <span className="tb-input">
                            <select value={toolbar.tips} onChange={(e) => setToolbarPrefs(toolbar.key, withOption(prefs, 'tips', e.target.value as TipStyle))}>
                                <option value="full">Name, what it does and its key</option>
                                <option value="name">Name only</option>
                                <option value="off">None</option>
                            </select>
                        </span>
                    </label>
                    {hasFamilies && (
                        <label className="tb-field">
                            <span>Variants of a tool</span>
                            <span className="tb-input">
                                <select
                                    value={toolbar.families}
                                    onChange={(e) => setToolbarPrefs(toolbar.key, withOption(prefs, 'families', e.target.value as FamilyStyle))}
                                >
                                    <option value="flyout">One button with a list</option>
                                    <option value="separate">A button each</option>
                                </select>
                            </span>
                        </label>
                    )}
                    <div className="tb-field">
                        <span>Tools, in order</span>
                        <ul className="tbo-tools" aria-label={`${toolbar.label} tools`} onDragOver={(e) => dragging !== null && e.preventDefault()}
                            onDrop={(e) => drop(e, ids.length - 1)}>
                            {toolbar.tools.length === 0 && <li className="tbo-empty">No tools: the toolbar is not shown.</li>}
                            {toolbar.tools.map(row)}
                        </ul>
                    </div>
                    {addable.length > 0 && (
                        <label className="tb-field">
                            <span>Add a tool</span>
                            <span className="tb-input">
                                <select
                                    value=""
                                    onChange={(e) => {
                                        if (e.target.value) {
                                            setIds(addedTool(ids, e.target.value));
                                        }
                                    }}
                                >
                                    <option value="">Choose a tool…</option>
                                    {addable.map(({ group, tools }) => (
                                        <optgroup key={group.id} label={group.label}>
                                            {tools.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                                        </optgroup>
                                    ))}
                                </select>
                            </span>
                        </label>
                    )}
                    <div className="tbo-actions">
                        <button type="button" disabled={!toolbar.customised} onClick={() => setToolbarPrefs(toolbar.key, null)}>
                            Reset this toolbar
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}

/** The toolbars of one mode (the current one to start with), each with its options. */
export function ToolbarOptions({ mode: initial }: { mode?: ToolbarMode }) {
    const current = useToolbarMode();
    const [mode, setMode] = useState<ToolbarMode>(initial ?? current);
    const [open, setOpen] = useState<string | null>(null);
    const arrangement = useToolbarArrangement((s) => s.arrangement);
    const groups = modeGroups(mode);
    const toolbars = useMemo(() => arrangeToolbars(mode, groups, arrangement), [mode, groups, arrangement]);
    // Tools that can be put on a toolbar of this mode: every tool its toolbars have by default.
    const all = useMemo(() => modeTools(groups), [groups]);
    const anyChanged = Object.keys(arrangement).length > 0;
    return (
        <div className="tbo">
            <div className="tbo-modes" role="tablist" aria-label="Toolbars of">
                {TOOLBAR_MODES.map((m) => (
                    <button
                        key={m.value}
                        type="button"
                        role="tab"
                        aria-selected={mode === m.value}
                        className={mode === m.value ? 'on' : ''}
                        onClick={() => {
                            setMode(m.value);
                            setOpen(null);
                        }}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            <p className="tb-note tb-hint">
                Tick the toolbars to show while {mode === 'sketch' ? 'sketching' : `in the ${mode} workspace`}; open one to choose its tools
                ({all.length} to pick from), their order and its look.
            </p>
            {toolbars.map((toolbar) => (
                <ToolbarSection
                    key={toolbar.key}
                    toolbar={toolbar}
                    defaults={groups.find((g) => g.id === toolbar.id)!.tools.map((t) => t.id)}
                    groups={groups}
                    open={open === toolbar.key}
                    onToggle={() => setOpen((o) => (o === toolbar.key ? null : toolbar.key))}
                />
            ))}
            <div className="tbo-actions">
                <button type="button" disabled={!anyChanged} onClick={resetArrangement} title="Every toolbar of every mode back to its defaults">
                    Reset all toolbars
                </button>
            </div>
        </div>
    );
}

/** Customize toolbars as a left-panel form (opened from a right-click on the toolbar). Not a toolbar tool itself. */
export const toolbarOptionsTool: ToolDef = {
    id: 'toolbar-options',
    label: 'Customize toolbars',
    icon: 'toolbars',
    hint: 'which toolbars show, and their tools, order and look',
    noApply: true,
    panel: true,
    top: () => <ToolbarOptions />,
};
