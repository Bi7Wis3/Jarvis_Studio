import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Feature } from '@jarvis/core';
import { Icon } from './icons';
import { clearEditing, clearPicked, runTool, select, setRollback, setWorkspace, useStudio } from './state';
import {
    applyTyped, closeSketch, deleteSelected, fitSketch, redoSketch, setTool, toggleConstructionSelected, sketchEnter, sketchEscape, startSketch, typeKey,
    undoSketch,
    useSketcher,
    type SketchTool,
} from './sketcher';
import {
    ALL_TOOLS, ASSEMBLY_GROUPS, PART_GROUPS, SKETCH_GROUPS, VIEWS, discardSketch, editorFor, finishNeedsPanel, finishTool, fitView, setView,
    sketchPlaneTool,
    type Ctx, type ToolDef, type ToolGroup, type UiSettings,
} from './toolDefs';
import { FieldInput, useToolForm } from './toolForm';
import { PropertyManager, usePropertyManager, usesPanel } from './PropertyManager';
import { planeLabel } from './sketchMath';
import './toolbar.css';

// Estimated widths matching the CSS, used to decide which groups collapse into menus.
const BUTTON_W = 28;
const BUTTON_GAP = 2;
const GROUP_PAD = 9;
const MENU_W = 38;
const BAR_PAD = 10;
const SWITCH_W = 142;
const SIDE_GAP = 20;
/** Bottom of the toolbar (top 12 + 38 high), see .toolbar in styles.css. */
const BAND_BOTTOM = 52;

type Layout = { kind: 'hidden' } | { kind: 'all' } | { kind: 'groups'; collapsed: Set<string> };

interface Anchor {
    left: number;
    width: number;
    bottom: number;
}

function anchorOf(element: Element | null): Anchor {
    const r = element?.getBoundingClientRect();
    return r ? { left: r.left, width: r.width, bottom: r.bottom } : { left: window.innerWidth / 2, width: 0, bottom: 64 };
}

function tip(tool: ToolDef, part: boolean): string {
    if (tool.soon) {
        return `${tool.label} · ${tool.soon}`;
    }
    if (tool.needsPart && !part) {
        return `${tool.label} · select a part first`;
    }
    return `${tool.label}${tool.hint ? ` · ${tool.hint}` : ''}${tool.shortcut ? ` (${tool.shortcut})` : ''}`;
}

function groupWidth(group: ToolGroup, collapsed: boolean): number {
    const n = group.tools.length;
    return (collapsed ? MENU_W : n * BUTTON_W + (n - 1) * BUTTON_GAP) + GROUP_PAD;
}

/** The free band for the toolbar between the title and the activity panel. */
function measureRoom(): { room: number; centre: number } {
    const width = window.innerWidth;
    // Only what reaches up into the toolbar's band counts: the title does, the status chip below it does not.
    const header = [...document.querySelectorAll('main > header > *')]
        .map((e) => {
            const range = document.createRange();
            range.selectNodeContents(e);
            return range.getBoundingClientRect();
        })
        .filter((r) => r.width > 0 && r.top < BAND_BOTTOM);
    const activity = document.querySelector('main > .activity')?.getBoundingClientRect();
    const left = Math.max(24, ...header.map((r) => r.right)) + SIDE_GAP;
    const right = (activity?.left ?? width - 24) - SIDE_GAP;
    // Centred on the window when that fits, else in the middle of the free band.
    const centred = 2 * Math.min(width / 2 - left, right - width / 2);
    return { room: Math.max(centred, right - left), centre: centred >= right - left - 1 ? width / 2 : (left + right) / 2 };
}

/** Collapses groups into menus, lowest priority first, until the toolbar fits. */
function computeLayout(groups: ToolGroup[], room: number): Layout {
    if (window.innerWidth < 760) {
        return { kind: 'hidden' };
    }
    const collapsed = new Set<string>();
    const total = () => BAR_PAD + SWITCH_W + groups.reduce((sum, g) => sum + groupWidth(g, collapsed.has(g.id)), 0);
    const order = groups.filter((g) => g.collapse !== undefined).sort((a, b) => a.collapse! - b.collapse!);
    for (const group of order) {
        if (total() <= room) {
            break;
        }
        collapsed.add(group.id);
    }
    if (total() <= room) {
        return { kind: 'groups', collapsed };
    }
    return room >= MENU_W + BAR_PAD + SWITCH_W ? { kind: 'all' } : { kind: 'hidden' };
}

function useCtx(): Ctx {
    const history = useStudio((s) => s.history);
    const selected = useStudio((s) => s.selected);
    const workspace = useStudio((s) => s.workspace);
    const activePart = useStudio((s) => s.activePart);
    const editing = useStudio((s) => s.editing);
    const id = workspace === 'part' ? activePart : selected;
    const part = (id && history?.parts.find((p) => p.id === id)) || null;
    const editPart = editing && history?.parts.find((p) => p.id === editing.partId);
    const feature = editing?.featureId ? editPart?.features?.find((f) => f.id === editing.featureId) ?? null : null;
    const edit = editPart && (!editing!.featureId || feature) ? { partId: editPart.id, feature } : null;
    return { part, project: history, edit };
}

const CONSTRAINT_HINT = 'Pick the geometry in the view (or select it first, then press the button)';

function sketchHint(tool: SketchTool): string {
    return tool.startsWith('c:') ? `${tool.slice(2)[0].toUpperCase()}${tool.slice(3)}: ${CONSTRAINT_HINT.toLowerCase()}`
        : SKETCH_HINTS[tool as keyof typeof SKETCH_HINTS];
}

const SKETCH_HINTS: Record<Exclude<SketchTool, `c:${string}`>, string> = {
    select: 'Click to select, Shift adds · drag points, lines or dimension values to move · double-click a dimension to edit · Delete removes',
    dimension: 'Drag a line or circle outwards to dimension it · or click two points, a point and a line/axis/origin, or two lines, then where the value goes',
    line: 'Click points · type a length (or length,angle) + Enter · click the start to close · Esc stops',
    centerline: 'Click points for a construction line · type a length (or length,angle) + Enter · Esc stops',
    point: 'Click to place a sketch point · it snaps to points, middles and curves',
    xform: 'Click points in the view for the form (move: from, then to) · Shift+click changes the selection',
    rect: 'Click two corners · type width,height + Enter',
    circle: 'Click the centre, then a point · type the diameter + Enter',
    arc: 'Click start and end, then a point on the arc · type a radius + Enter',
    slot: 'Click both centres, then the width · type a length, then the width',
    polygon: 'Click the centre, then a corner · sides in sketch settings',
    centerRect: 'Click the centre, then a corner · type width,height + Enter',
    centerArc: 'Click the centre, then the start, then where it ends · type the radius, then the angle + Enter',
    trim: 'Click the piece of a curve to remove, up to where other curves cross it',
    extend: 'Click near the end of a line or arc to lengthen it to the next curve',
    fillet: 'Click a corner, or two lines, to round it · type a radius + Enter to change it',
    chamfer: 'Click a corner, or two lines, to cut it · type a distance + Enter to change it',
    offset: 'Click a curve, then click where the copy goes · or type the distance + Enter',
    mirror: 'Click the curves to mirror, then an axis or a centre line · or press Enter and click any line',
};

const SKETCH_KEYS: Record<string, SketchTool> = {
    l: 'line', r: 'rect', c: 'circle', a: 'arc', s: 'slot', p: 'polygon', d: 'dimension', v: 'select', t: 'trim', o: 'offset', m: 'mirror',
};

function WorkspaceSwitch() {
    const workspace = useStudio((s) => s.workspace);
    const sketching = useSketcher((s) => s.active);
    return (
        <div className="tb-switch" role="tablist" aria-label="Workspace">
            {(['part', 'assembly'] as const).map((ws) => (
                <button
                    key={ws}
                    type="button"
                    role="tab"
                    aria-selected={workspace === ws}
                    className={workspace === ws ? 'on' : ''}
                    title={ws === 'part' ? 'Part: sketch and edit one part\'s features' : 'Assembly: place, fasten, pattern and export parts'}
                    onClick={() => {
                        if (sketching) {
                            // Leaving mid-sketch would lose it: ask, and stay if the answer is no.
                            discardSketch();
                            if (useSketcher.getState().active) {
                                return;
                            }
                        }
                        setWorkspace(ws);
                    }}
                >
                    {ws === 'part' ? 'Part' : 'Assembly'}
                </button>
            ))}
        </div>
    );
}

/** One line under the toolbar while sketching: what the tool expects, the plane and the profile status, and the way out. */
function SketchBar({ centre, onFinish }: { centre: number; onFinish: () => void }) {
    const { active, stage, tool, plane, offset, edit, dof, message, notice, geometry } = useSketcher();
    if (!active) {
        return null;
    }
    if (stage === 'plane') {
        return (
            <div className="sk-bar" style={{ left: centre }}>
                Choose a sketch plane, or click a flat face of the part
                <button type="button" className="sk-exit" onClick={discardSketch} title="Leave without a sketch (Esc)">Cancel</button>
            </div>
        );
    }
    return (
        <div className="sk-bar" style={{ left: centre }}>
            <b>{edit ? 'Editing sketch' : 'Sketch'}</b>
            <span className="sk-plane">{planeLabel(plane)}{offset ? ` ${offset > 0 ? '+' : ''}${offset} mm` : ''}</span>
            <span className={message ? 'sk-message' : notice ? 'sk-notice' : ''}>{message ?? notice ?? sketchHint(tool)}</span>
            <span className={`sk-dof ${dof === 0 ? 'done' : ''}`} title="Degrees of freedom left">
                {!geometry.curves.length ? 'empty' : dof < 0 ? '…' : dof === 0 ? 'Fully constrained' : `${dof} DOF`}
            </span>
            <button type="button" className="sk-done" onClick={onFinish} title="Save the sketch and go back to the part (Enter)">
                Exit sketch
            </button>
            <button type="button" className="sk-exit" onClick={discardSketch} title="Leave the sketch without saving it">Discard</button>
        </div>
    );
}

/** CAD toolbar: workspace switch and grouped tools at the top centre, each opening a popup under its button. */
export function Toolbar() {
    const ctx = useCtx();
    const grid = useStudio((s) => s.grid);
    const edges = useStudio((s) => s.edges);
    const selected = useStudio((s) => s.selected);
    const history = useStudio((s) => s.history);
    const current = useStudio((s) => s.current);
    const workspace = useStudio((s) => s.workspace);
    const editing = useStudio((s) => s.editing);
    const sketchActive = useSketcher((s) => s.active);
    const sketchStage = useSketcher((s) => s.stage);
    const sketchTool = useSketcher((s) => s.tool);
    const showOthers = useStudio((s) => s.partView === 'inContext');
    const groups = sketchActive ? SKETCH_GROUPS : workspace === 'part' ? PART_GROUPS : ASSEMBLY_GROUPS;
    const [band, setBand] = useState(() => measureRoom());
    const layout = computeLayout(groups, band.room);
    const [popup, setPopup] = useState<{ tool: ToolDef; anchor: Anchor } | null>(null);
    const [menu, setMenu] = useState<{ group: string; anchor: Anchor } | null>(null);
    // Feature forms open in the property manager in the left panel, the rest in a popup under their button.
    const slot = usePropertyManager((s) => s.slot);
    const inPanel = !!popup && usesPanel(popup.tool, workspace, sketchActive);
    const bar = useRef<HTMLDivElement>(null);
    const latest = useRef({ popup, menu, ctx });
    latest.current = { popup, menu, ctx };

    useEffect(() => {
        usePropertyManager.setState({ open: inPanel });
    }, [inPanel]);
    useEffect(() => () => usePropertyManager.setState({ open: false }), []);

    useLayoutEffect(() => {
        const update = () => setBand((old) => {
            const next = measureRoom();
            return Math.abs(next.room - old.room) < 1 && Math.abs(next.centre - old.centre) < 1 ? old : next;
        });
        update();
        const observer = new ResizeObserver(update);
        for (const element of document.querySelectorAll('main > header, main > header > *, main > .activity')) {
            observer.observe(element);
        }
        window.addEventListener('resize', update);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', update);
        };
    }, []);

    // A part removed (by Jarvis, undo or another browser) or another project opened drops the selection.
    useEffect(() => {
        if (selected && history && !history.parts.some((p) => p.id === selected)) {
            select(null);
        }
    }, [selected, history]);
    useEffect(() => {
        select(null);
        closeSketch();
    }, [current]);

    const anchorFor = (id: string): Anchor => {
        const element = document.querySelector(`[data-tool="${id}"]`) ?? bar.current;
        return anchorOf(element);
    };

    // History editing requested by the browser panel: open the matching editor, prefilled.
    useEffect(() => {
        if (!editing || !history) {
            return;
        }
        const part = history.parts.find((p) => p.id === editing.partId);
        const feature = editing.featureId ? part?.features?.find((f) => f.id === editing.featureId) ?? null : null;
        if (!part || (editing.featureId && !feature)) {
            clearEditing();
            return;
        }
        const editor = editorFor(part, feature);
        setMenu(null);
        if (editor === 'sketch') {
            const ref = feature && 'sketchRef' in feature ? feature.sketchRef : undefined;
            const referenced = ref ? part.features?.find((f) => f.id === ref) : undefined;
            const sketchData = feature
                ? feature.op === 'sketch' ? feature.sketch
                    : ('sketch' in feature && feature.sketch) || (referenced?.op === 'sketch' ? referenced.sketch : null)
                : part.shape.kind === 'sketch' ? part.shape.sketch : null;
            if (!sketchData) {
                clearEditing();
                return;
            }
            const op = feature?.op === 'revolve' || (part.shape.kind === 'sketch' && part.shape.revolve) ? 'revolve' : 'extrude';
            startSketch(part.id, op, { partId: part.id, featureId: feature?.id ?? null, sketch: sketchData });
            rollBackTo(part.id, feature);
            // A feature's own sketch: open its values with it, once the sketch toolbar is there. A plain sketch
            // step is just edited, and saved on exit.
            if (finishNeedsPanel()) {
                window.setTimeout(() => setPopup({ tool: finishTool, anchor: anchorFor('sk-finish') }), 60);
            }
            return;
        }
        setPopup({ tool: editor, anchor: anchorFor(editor.id) });
        // Only the trigger is consumed here; `editing` stays set until the popup closes so ctx.edit is known.
    }, [editing?.partId, editing?.featureId, !!history]);

    // Picking the sketch plane: show the plane popup.
    useEffect(() => {
        if (sketchActive && sketchStage === 'plane') {
            window.setTimeout(() => setPopup({ tool: sketchPlaneTool, anchor: anchorFor('sk-finish') }), 30);
        } else {
            setPopup((p) => (p?.tool.id === sketchPlaneTool.id ? null : p));
        }
        if (!sketchActive) {
            setPopup((p) => (p?.tool.id === finishTool.id ? null : p));
        }
    }, [sketchActive, sketchStage]);

    const closePopup = () => {
        const tool = latest.current.popup?.tool;
        setPopup(null);
        if (tool?.id === finishTool.id) {
            useSketcher.setState({ finishing: null });
            return;
        }
        if (tool?.id === sketchPlaneTool.id && useSketcher.getState().stage === 'plane') {
            closeSketch();
        }
        if (useStudio.getState().editing && !useSketcher.getState().active) {
            clearEditing();
        }
    };

    const open = (tool: ToolDef, anchor: Anchor) => {
        setMenu(null);
        if (tool.soon || (tool.needsPart && !latest.current.ctx.part)) {
            return;
        }
        if (tool.instant && !tool.popupIf?.(latest.current.ctx)) {
            tool.instant(latest.current.ctx);
            return;
        }
        if (useStudio.getState().editing && !useSketcher.getState().active) {
            clearEditing();
        }
        setPopup((p) => (p?.tool.id === tool.id ? null : { tool, anchor }));
    };

    // Other panels ask for a tool's form by id (the components list opens Pattern for a part).
    useEffect(() => {
        const onRequest = (event: Event) => {
            const id = (event as CustomEvent<string>).detail;
            if (ALL_TOOLS.some((t) => t.id === id)) {
                openById(id);
            }
        };
        window.addEventListener('jarvis:open-tool', onRequest);
        return () => window.removeEventListener('jarvis:open-tool', onRequest);
    });

    const openById = (id: string) => {
        const tool = ALL_TOOLS.find((t) => t.id === id)!;
        const group = groups.find((g) => g.tools.includes(tool));
        const element = document.querySelector(`[data-tool="${id}"]`)
            ?? (group && document.querySelector(`[data-group="${group.id}"]`))
            ?? document.querySelector('[data-group="all"]') ?? bar.current;
        open(tool, anchorOf(element));
    };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const typing = !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
            const { popup: openPopup, menu: openMenu } = latest.current;
            const sk = useSketcher.getState();
            if (event.key === 'Escape') {
                // In a text field Esc belongs to that field (the prompt bar uses it to stop Jarvis).
                if (typing) {
                    return;
                }
                if (openMenu) {
                    setMenu(null);
                } else if (openPopup) {
                    closePopup();
                } else if (sk.active) {
                    sketchEscape();
                } else if (useStudio.getState().picked.length) {
                    // Picked faces and edges go first; a second Esc clears the part selection.
                    clearPicked();
                } else {
                    select(null);
                }
                return;
            }
            if (typing) {
                return;
            }
            const key = event.key.toLowerCase();
            if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                if (key === 'z' || key === 'y') {
                    event.preventDefault();
                    if (sk.active) {
                        if (key === 'y' || event.shiftKey) {
                            redoSketch();
                        } else {
                            undoSketch();
                        }
                    } else {
                        void runTool(key === 'y' || event.shiftKey ? 'redo' : 'undo');
                    }
                }
                return;
            }
            if (event.altKey || event.ctrlKey || event.metaKey) {
                return;
            }
            if (sk.active && sk.stage === 'draw') {
                // Typed dimensions first, then sketch shortcuts.
                if (typeKey(event.key)) {
                    event.preventDefault();
                    return;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (sk.typed) {
                        applyTyped();
                    } else if (sketchEnter()) {
                        // An edit tool's next step.
                    } else if (!openPopup) {
                        openById(finishTool.id);
                    }
                    return;
                }
                if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    deleteSelected();
                    return;
                }
                if (key === 'x') {
                    event.preventDefault();
                    toggleConstructionSelected();
                    return;
                }
                if (SKETCH_KEYS[key]) {
                    event.preventDefault();
                    setTool(SKETCH_KEYS[key]);
                    return;
                }
                if (key === 'f') {
                    fitSketch();
                }
                return;
            }
            const view = VIEWS.find((v) => v.key === event.key);
            if (view) {
                void setView(view.azimuth, view.elevation);
            } else if (event.key === 'Delete' && latest.current.ctx.part && useStudio.getState().workspace === 'assembly') {
                openById('delete');
            } else if (key === 'f') {
                void fitView();
            } else if (key === 'g') {
                useStudio.setState((s) => ({ grid: !s.grid }));
            } else if (key === 's' && useStudio.getState().workspace === 'part') {
                startSketch(latest.current.ctx.part?.id ?? null, 'extrude');
            } else {
                return;
            }
            event.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [groups]);

    if (layout.kind === 'hidden') {
        return null;
    }

    const settings: UiSettings = { grid, edges, showOthers, sketchTool: sketchActive ? sketchTool : null };
    const button = (tool: ToolDef) => {
        const disabled = !!tool.soon || (!!tool.needsPart && !ctx.part);
        const on = tool.active?.(ctx, settings) ?? false;
        const openNow = popup?.tool.id === tool.id;
        return (
            <button
                key={tool.id}
                type="button"
                className={`tb-btn ${on ? 'on' : ''} ${openNow ? 'open' : ''} ${tool.danger ? 'danger' : ''}`}
                data-tool={tool.id}
                data-tip={openNow ? undefined : tip(tool, !!ctx.part)}
                aria-label={tool.label}
                aria-pressed={tool.active ? on : undefined}
                aria-disabled={disabled}
                onClick={(event) => open(tool, anchorOf(event.currentTarget))}
            >
                <Icon name={tool.icon} />
            </button>
        );
    };
    const menuButton = (group: ToolGroup | null) => {
        const id = group?.id ?? 'all';
        return (
            <button
                key={id}
                type="button"
                className={`tb-btn tb-menu ${menu?.group === id ? 'open' : ''}`}
                data-group={id}
                data-tip={menu?.group === id ? undefined : group?.label ?? 'Tools'}
                aria-label={group?.label ?? 'Tools'}
                aria-haspopup="menu"
                onClick={(event) => {
                    const anchor = anchorOf(event.currentTarget);
                    setPopup(null);
                    setMenu((m) => (m?.group === id ? null : { group: id, anchor }));
                }}
            >
                <Icon name={group?.icon ?? 'menu'} />
                <svg className="caret" width="7" height="7" viewBox="0 0 8 8" aria-hidden="true">
                    <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
                </svg>
            </button>
        );
    };

    return (
        <>
            <div
                className={`toolbar ${sketchActive ? 'sketching' : ''}`}
                ref={bar}
                role="toolbar"
                aria-label="CAD tools"
                style={{ left: band.centre }}
            >
                <WorkspaceSwitch />
                {layout.kind === 'all'
                    ? <div className="tb-group">{menuButton(null)}</div>
                    : groups.map((group) => (
                        <div key={group.id} className={`tb-group g-${group.id}`} role="group" aria-label={group.label}>
                            {layout.collapsed.has(group.id) ? menuButton(group) : group.tools.map(button)}
                        </div>
                    ))}
                {workspace === 'part' && !sketchActive && ctx.part && (
                    <span className="tb-active" title="Part being edited">{ctx.part.name}</span>
                )}
            </div>
            <SketchBar centre={band.centre} onFinish={() => openById(finishTool.id)} />
            {menu && (
                <ToolMenu
                    groups={menu.group === 'all' ? groups : groups.filter((g) => g.id === menu.group)}
                    anchor={menu.anchor}
                    ctx={ctx}
                    settings={settings}
                    onPick={(tool) => open(tool, menu.anchor)}
                    onClose={() => setMenu(null)}
                />
            )}
            {popup && inPanel && slot && createPortal(
                <PropertyManager key={`${popup.tool.id}:${ctx.part?.id ?? ''}:${ctx.edit?.feature?.id ?? ''}`} tool={popup.tool} ctx={ctx} onClose={closePopup} />,
                slot,
            )}
            {popup && !inPanel && (
                <Popup
                    key={`${popup.tool.id}:${ctx.part?.id ?? ''}:${ctx.edit?.feature?.id ?? ''}`}
                    tool={popup.tool}
                    anchor={popup.anchor}
                    ctx={ctx}
                    onClose={closePopup}
                />
            )}
        </>
    );
}

function popupTitle(tool: ToolDef, ctx: Ctx): string {
    if (!ctx.edit || tool.id === 'no-edit') {
        return tool.label;
    }
    if (tool.id === 'sk-finish') {
        const op = ctx.edit.feature?.op;
        return op === 'revolve' ? 'Edit revolve' : op === 'extrude' ? 'Edit extrude' : op === 'sketch' ? 'Edit sketch' : 'Edit sketch body';
    }
    return `Edit ${tool.label.toLowerCase()}`;
}

/** While a sketch feature is edited, build the part only up to just before it, and restore afterwards. */
let rolledBack: string | null = null;

function rollBackTo(partId: string, feature: Feature | null): void {
    const part = useStudio.getState().history?.parts.find((p) => p.id === partId);
    const index = feature ? part?.features?.findIndex((f) => f.id === feature.id) ?? -1 : -1;
    if (index >= 0) {
        rolledBack = partId;
        setRollback(partId, index);
    }
}

useSketcher.subscribe((s, prev) => {
    if (prev.active && !s.active && rolledBack) {
        setRollback(rolledBack, null);
        rolledBack = null;
    }
});

/** Places a floating panel centred under its anchor, kept inside the window. */
function useFloating(anchor: Anchor) {
    const ref = useRef<HTMLDivElement>(null);
    const [left, setLeft] = useState(anchor.left);
    useLayoutEffect(() => {
        const width = ref.current?.offsetWidth ?? 280;
        const centred = anchor.left + anchor.width / 2 - width / 2;
        setLeft(Math.max(8, Math.min(window.innerWidth - width - 8, centred)));
    }, [anchor.left, anchor.width]);
    return { ref, style: { left, top: anchor.bottom + 8, maxHeight: `calc(100vh - ${anchor.bottom + 8 + 96}px)` } };
}

function ToolMenu(props: {
    groups: ToolGroup[];
    anchor: Anchor;
    ctx: Ctx;
    settings: UiSettings;
    onPick: (tool: ToolDef) => void;
    onClose: () => void;
}) {
    const { groups, anchor, ctx, settings, onPick, onClose } = props;
    const { ref, style } = useFloating(anchor);
    useEffect(() => {
        const away = (event: PointerEvent) => {
            const target = event.target as HTMLElement;
            if (!ref.current?.contains(target) && !target.closest('.tb-menu')) {
                onClose();
            }
        };
        window.addEventListener('pointerdown', away);
        return () => window.removeEventListener('pointerdown', away);
    }, [onClose]);
    return (
        <div className="tb-float tb-list" ref={ref} style={style} role="menu">
            {groups.map((group) => (
                <div key={group.id} className="tb-list-group">
                    {groups.length > 1 && <div className="tb-list-head">{group.label}</div>}
                    {group.tools.map((tool) => {
                        const disabled = !!tool.soon || (!!tool.needsPart && !ctx.part);
                        const on = tool.active?.(ctx, settings);
                        return (
                            <button
                                key={tool.id}
                                type="button"
                                role="menuitem"
                                className={on ? 'on' : ''}
                                disabled={disabled}
                                title={disabled ? tip(tool, !!ctx.part) : tool.hint}
                                onClick={() => onPick(tool)}
                            >
                                <Icon name={tool.icon} size={16} />
                                <span>{tool.label}</span>
                                {tool.soon ? <em>soon</em> : tool.shortcut && <kbd>{tool.shortcut}</kbd>}
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

function Popup({ tool, anchor, ctx, onClose }: { tool: ToolDef; anchor: Anchor; ctx: Ctx; onClose: () => void }) {
    const { values, result, busy, form, missingPart, fields, change, api, submit } = useToolForm(tool, ctx, onClose);
    const { ref, style } = useFloating(anchor);

    let body: ReactNode;
    if (missingPart) {
        body = <p className="tb-note">Select a part in the viewport or the project tree.</p>;
    } else {
        body = (
            <>
                {tool.top?.(api, ctx)}
                {fields.length > 0 && (
                    <div className="tb-fields">
                        {fields.map((f) => <FieldInput key={f.key} field={f} values={values} change={change} />)}
                    </div>
                )}
                {tool.extra?.(api, ctx)}
            </>
        );
    }

    return (
        <div className="tb-float tb-popup" ref={ref} style={{ ...style, width: tool.width ?? 268 }} role="dialog" aria-label={tool.label}>
            <form
                ref={form}
                onSubmit={submit}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        onClose();
                    }
                }}
            >
                <div className="tb-head">
                    <Icon name={tool.icon} size={16} />
                    <span className="tb-title">{popupTitle(tool, ctx)}</span>
                    {tool.needsPart && ctx.part && <span className="tb-target" title={ctx.part.id}>{ctx.part.name}</span>}
                    <button type="button" className="tb-close" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
                </div>
                {body}
                {result && <pre className={`tb-result ${result.isError ? 'error' : ''}`}>{result.text}</pre>}
                {!tool.noApply && (
                    <div className="tb-actions">
                        <span className="tb-keys">Enter to apply · Esc to close</span>
                        <button type="submit" className={`tb-apply ${tool.danger ? 'danger' : ''}`} disabled={busy || missingPart}>
                            {busy ? 'Working…' : ctx.edit && (tool.op || tool.shapes || tool.id === 'sk-finish') ? 'Update' : tool.applyLabel ?? 'Apply'}
                        </button>
                    </div>
                )}
            </form>
        </div>
    );
}
