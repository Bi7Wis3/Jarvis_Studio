import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type { Feature } from '@jarvis/core';
import { Icon } from './icons';
import { ContextMenu, showError } from './menus';
import { familyOf, type ToolFamily } from './toolFamilies';
import { clearEditing, clearPicked, runTool, select, setRollback, setWorkspace, useStudio } from './state';
import {
    closeSketch, deleteSelected, enterKey, fitSketch, redoSketch, setTool, toggleConstructionSelected, sketchEscape, startSketch, toggleLineArc, typeKey,
    undoSketch,
    useSketcher,
    type SketchTool,
} from './sketcher';
import {
    ALL_TOOLS, VIEWS, discardSketch, editorFor, finishNeedsPanel, finishTool, fitView, setView,
    sketchPlaneTool,
    type Ctx, type ToolDef, type ToolGroup, type UiSettings,
} from './toolDefs';
import { FieldInput, useToolForm } from './toolForm';
import { PropertyManager, usePropertyManager, usesPanel } from './PropertyManager';
import { copySelection, cutSelection, moreHint, pasteAtCursor, useSketchMore } from './sketchMoreTools';
import './toolbar.css';
import { openSketchXpert } from './sketchXpertAuto';
import { useSketchToggles } from './sketchToggles';
import { lastSketchCommand, noteSketchCommand } from './sketchRepeat';
import { confirmDiscard, isSketchForm, keepSketch, sketchPlaneText, sketchStatusText, useDiscardAsk } from './sketchBar';
import { arrangedItems, arrangeToolbars, ICON_SIZES, toolbarWidth, withOption, type ArrangedToolbar } from './toolbarLayout';
import { setToolbarPrefs, useToolbarArrangement } from './toolbarStore';
import { modeGroups, toolbarOptionsTool } from './toolbarOptions';

// Estimated widths matching the CSS, used to decide which groups collapse into menus (buttons: toolbarLayout.ts).
const GROUP_PAD = 9;
const MENU_W = 38;
const FAMILY_KEY = 'jarvis.toolbar.families';
// A collapsed group's name beside its icon: gap, then about this much per letter.
const LABEL_GAP = 5;
const LABEL_CHAR_W = 6.6;
const BAR_PAD = 10;
const SWITCH_W = 142;
const SIDE_GAP = 20;
/** Bottom of the toolbar (top 12 + 38 high), see .toolbar in styles.css. */
const BAND_BOTTOM = 52;

type Layout = { kind: 'hidden' } | { kind: 'all' }
    | { kind: 'groups'; collapsed: Set<string>; named: Set<string>; showActive: boolean };

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

function groupWidth(group: ArrangedToolbar, collapsed: boolean): number {
    return collapsed ? MENU_W + GROUP_PAD : toolbarWidth(group);
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
function computeLayout(groups: ArrangedToolbar[], room: number, reserved = 0): Layout {
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
        // A menu that shows only an icon hides what is in it: name the collapsed groups while there is room.
        const named = new Set<string>();
        let used = total();
        for (const group of groups.filter((g) => collapsed.has(g.id))) {
            const width = LABEL_GAP + (group.short ?? group.label).length * LABEL_CHAR_W;
            if (used + width <= room) {
                named.add(group.id);
                used += width;
            }
        }
        // The name of the part being edited (`reserved` wide) is also in the tree: it only stays when it still fits.
        return { kind: 'groups', collapsed, named, showActive: used + reserved <= room };
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

const CONSTRAINT_HINT = 'Pick the geometry in the view (or select it first, then press the button) · model edges and corners can be picked too';

function sketchHint(tool: SketchTool): string {
    if (tool.startsWith('m:')) {
        return moreHint(tool);
    }
    if (tool === 'trim') {
        return TRIM_HINTS[useSketcher.getState().editOptions.trimMode];
    }
    return tool.startsWith('c:') ? `${tool.slice(2)[0].toUpperCase()}${tool.slice(3)}: ${CONSTRAINT_HINT.toLowerCase()}`
        : SKETCH_HINTS[tool as keyof typeof SKETCH_HINTS];
}

const TRIM_HINTS = {
    power: 'Power trim: drag across curves to trim each where the pointer crosses · or click a piece to remove it',
    corner: 'Corner: click two curves on the sides to keep · they are trimmed or extended to meet',
    inside: 'Trim away inside: click two boundaries, then the curves to cut away between them',
    outside: 'Trim away outside: click two boundaries, then the curves to cut away outside them',
    closest: 'Trim to closest: click the piece of a curve to remove, up to where other curves cross it',
};

const SKETCH_HINTS: Record<Exclude<SketchTool, `c:${string}` | `m:${string}`>, string> = {
    select: 'Click to select, Shift adds · drag points, lines or dimension values to move · double-click a dimension to edit · Delete removes',
    dimension: 'Drag a line or circle outwards to dimension it · or click two items (points, lines, circles: to the centre), then where the value goes · for an angle, the side picks which angle · model edges and corners can be picked too',
    line: 'Click points · type a length (or length,angle) + Enter · click the start to close · Enter or double-click ends the chain',
    centerline: 'Click points for a construction line · type a length (or length,angle) + Enter · Enter ends the chain',
    point: 'Click to place a sketch point · it snaps to points, middles and curves',
    xform: 'Click points in the view for the form (move: from, then to) · Shift+click changes the selection',
    rect: 'Click two corners · type width,height + Enter',
    circle: 'Click the centre, then a point · type the diameter + Enter',
    arc: 'Click start and end, then a point on the arc · type a radius + Enter',
    slot: 'Click both centres (they snap to points), then the width · type a length, then the width',
    polygon: 'Click the centre, then a corner (or the middle of a side, with an inscribed circle) · sides and circle in the form',
    centerRect: 'Click the centre, then a corner · type width,height + Enter',
    centerArc: 'Click the centre, then the start, then where it ends · type the radius, then the angle + Enter',
    tangentArc: 'Click the end of a line or arc, then where the arc ends · it goes on tangent from there · Enter or double-click ends',
    perimeterCircle: 'Click three points the circle passes through',
    rect3: 'Click two corners for the first side (any angle), then a point for the width',
    midpointLine: 'Click the middle, then an end · the line grows both ways · type its length + Enter',
    centerRect3: 'Click the centre, then the middle of a side (any angle), then a point for the width',
    parallelogram: 'Click two corners for the first side, then the next corner · the last one closes it',
    centerSlot: 'Click the centre, then an end centre, then the width · type the width + Enter',
    arcSlot3: 'Click the start and end of the arc, then a point on it, then the width · type the width + Enter',
    centerArcSlot: 'Click the arc centre, then the start, go round to the end and click, then the width · type the width + Enter',
    trim: 'Click the piece of a curve to remove, up to where other curves cross it',
    extend: 'Click near the end of a line or arc to lengthen it to the next curve',
    fillet: 'Click a corner, or two lines or arcs, to round it · type a radius + Enter to change it · options in the form',
    chamfer: 'Click a corner, or two lines, to cut it · type a distance + Enter to change it · options in the form',
    offset: 'Click a curve (or select curves first), then click where the copy goes · or type the distance + Enter',
    mirror: 'Click the curves to mirror, then an axis or a centre line · or press Enter and click any line',
    split: 'Click a line or arc where it splits in two · a circle: click two points',
    ellipse: 'Click the centre, then the end of the first axis, then the second axis · type each radius + Enter',
    partialEllipse: 'Click the centre, the end of the first axis, the second axis (the arc starts there), then go round and click where it ends',
    spline: 'Click the points the spline runs through · double-click or Enter ends it · click its first point to close it',
    styleSpline: 'Click the control vertices; the curve follows their polygon · double-click or Enter ends it · Curve Type in the form',
    parabola: 'Click the focus, then the vertex, then on the parabola where it starts and where it ends',
    conic: 'Click both ends, then the top vertex (where the end tangents meet), then click to set Rho',
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
                            // Leaving mid-sketch would lose it: the sketch bar asks, and the switch waits for a yes.
                            discardSketch(() => setWorkspace(ws));
                            return;
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
function SketchBar({ centre, top, onFinish }: { centre: number; top: number; onFinish: () => void }) {
    // What the bar shows (the trim hint follows the trim mode), not the whole sketcher: pointer moves do not redraw it.
    const { active, stage, tool, plane, offset, edit, dof, message, notice, geometry, redundant, conflicting } = useSketcher(useShallow((s) => ({
        active: s.active, stage: s.stage, tool: s.tool, plane: s.plane, offset: s.offset, edit: s.edit, dof: s.dof, message: s.message,
        notice: s.notice, geometry: s.geometry, redundant: s.redundant, conflicting: s.conflicting, trimMode: s.editOptions.trimMode,
    })));
    const asking = useDiscardAsk((a) => !!a.asking);
    const over = redundant.length > 0 || conflicting.length > 0;
    if (!active) {
        return null;
    }
    if (stage === 'plane') {
        return (
            <div className="sk-bar" style={{ left: centre, top }}>
                Choose a sketch plane, or click a flat face of the part
                <button type="button" className="sk-exit" onClick={() => discardSketch()} title="Leave without a sketch (Esc)">Cancel</button>
            </div>
        );
    }
    if (asking) {
        return (
            <div className="sk-bar" style={{ left: centre, top }} role="alertdialog" aria-label="Discard this sketch?">
                <b>Discard this sketch?</b>
                <span className="sk-ask" title="What you drew or changed in it will be lost.">What you drew or changed in it will be lost.</span>
                <button type="button" className="sk-exit" onClick={confirmDiscard} title="Leave the sketch without saving it">Discard</button>
                <button type="button" className="sk-done" onClick={keepSketch} title="Back to the sketch (Esc)" autoFocus>Keep sketching</button>
            </div>
        );
    }
    const hint = message ?? notice ?? sketchHint(tool);
    return (
        <div className="sk-bar" style={{ left: centre, top }}>
            <b>{edit ? 'Editing sketch' : 'Sketch'}</b>
            <span className="sk-plane">{sketchPlaneText(plane, offset)}</span>
            <span className={message ? 'sk-message' : notice ? 'sk-notice' : ''} title={hint}>{hint}</span>
            <span
                className={`sk-dof ${dof === 0 && !over ? 'done' : ''} ${over ? 'over' : ''}`}
                title={over ? 'Over defined: click to open SketchXpert' : 'Sketch status and degrees of freedom left'}
                onClick={over ? openSketchXpert : undefined}
            >
                {sketchStatusText(geometry, dof, over)}
            </span>
            <button type="button" className="sk-done" onClick={onFinish} title="Save the sketch and go back to the part">
                Exit sketch
            </button>
            <button type="button" className="sk-exit" onClick={() => discardSketch()} title="Leave the sketch without saving it">Discard</button>
        </div>
    );
}

/** CAD toolbar: workspace switch and grouped tools at the top centre, each opening a popup under its button. */
export function Toolbar() {
    const ctx = useCtx();
    const grid = useStudio((s) => s.grid);
    const edges = useStudio((s) => s.edges);
    const perspective = useStudio((s) => s.perspective);
    const selected = useStudio((s) => s.selected);
    const history = useStudio((s) => s.history);
    const current = useStudio((s) => s.current);
    const workspace = useStudio((s) => s.workspace);
    const editing = useStudio((s) => s.editing);
    const sketchActive = useSketcher((s) => s.active);
    const sketchStage = useSketcher((s) => s.stage);
    const sketchTool = useSketcher((s) => s.tool);
    // The sketch toggles' buttons show their state.
    useSketchToggles();
    // Dynamic mirror is a switch outside the sketcher's tool: its button follows it.
    useSketchMore((m) => !!m.dynamicMirror);
    const showOthers = useStudio((s) => s.partView === 'inContext');
    // The mode's toolbars as the user arranged them (toolbarLayout.ts); hidden and emptied ones are not drawn.
    const mode = sketchActive ? 'sketch' : workspace;
    const arrangement = useToolbarArrangement((s) => s.arrangement);
    const toolbars = useMemo(() => arrangeToolbars(mode, modeGroups(mode), arrangement), [mode, arrangement]);
    const groups = useMemo(() => toolbars.filter((t) => !t.hidden && t.tools.length > 0), [toolbars]);
    const [barMenu, setBarMenu] = useState<{ x: number; y: number } | null>(null);
    const [band, setBand] = useState(() => measureRoom());
    // The name of the part being edited sits at the end of the bar (see .tb-active).
    const activeNameWidth = workspace === 'part' && !sketchActive && ctx.part ? Math.min(140, ctx.part.name.length * 7) + 24 : 0;
    const layout = computeLayout(groups, band.room, activeNameWidth);
    const [popup, setPopup] = useState<{ tool: ToolDef; anchor: Anchor } | null>(null);
    const [menu, setMenu] = useState<{ group: string; anchor: Anchor } | null>(null);
    // The variant last used in each family is the one its button shows.
    const [lastUsed, setLastUsed] = useState<Record<string, string>>(() => {
        try {
            return JSON.parse(localStorage.getItem(FAMILY_KEY) ?? '{}') as Record<string, string>;
        } catch {
            return {};
        }
    });
    // Feature forms open in the property manager in the left panel, the rest in a popup under their button.
    const slot = usePropertyManager((s) => s.slot);
    const inPanel = !!popup && usesPanel(popup.tool, workspace, sketchActive);
    const bar = useRef<HTMLDivElement | null>(null);
    // The sketch bar sits under the toolbar, which grows with large icons or text under them.
    const [barBottom, setBarBottom] = useState(BAND_BOTTOM);
    const barObserver = useRef<ResizeObserver | null>(null);
    const setBar = useCallback((element: HTMLDivElement | null) => {
        bar.current = element;
        barObserver.current?.disconnect();
        if (element) {
            const measure = () => setBarBottom(Math.round(element.getBoundingClientRect().bottom));
            barObserver.current = new ResizeObserver(measure);
            barObserver.current.observe(element);
            measure();
        }
    }, []);
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
            // However the sketch ends (Exit, Discard, another project), none of its forms stays open in part mode.
            setPopup((p) => (p && isSketchForm(p.tool) ? null : p));
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
            closeSketch(true);
        }
        if (useStudio.getState().editing && !useSketcher.getState().active) {
            clearEditing();
        }
    };

    const open = (tool: ToolDef, anchor: Anchor) => {
        setMenu(null);
        if (tool.soon) {
            return;
        }
        const family = familyOf(tool.id);
        if (family) {
            setLastUsed((old) => {
                if (old[family.id] === tool.id) {
                    return old;
                }
                const next = { ...old, [family.id]: tool.id };
                try {
                    localStorage.setItem(FAMILY_KEY, JSON.stringify(next));
                } catch {
                    // Private mode: the choice lasts for this visit only.
                }
                return next;
            });
        }
        if (tool.needsPart && !latest.current.ctx.part) {
            // A tool that works on a part, with none selected: take the only part there is, else say what to do
            // (a greyed button that does nothing leaves the user guessing).
            const all = useStudio.getState().project?.parts ?? [];
            if (all.length === 1) {
                select(all[0].id);
                window.setTimeout(() => open(tool, anchor), 0);
            } else {
                showError(all.length ? `${tool.label} works on one part: click a part in the view or in the list first.`
                    : `${tool.label} needs a part, and there is none yet.`);
            }
            return;
        }
        if (tool.instant && !tool.popupIf?.(latest.current.ctx)) {
            tool.instant(latest.current.ctx);
            noteSketchCommand(tool, latest.current.ctx);
            return;
        }
        if (useStudio.getState().editing && !useSketcher.getState().active) {
            clearEditing();
        }
        setPopup((p) => (p?.tool.id === tool.id ? null : { tool, anchor }));
        noteSketchCommand(tool, latest.current.ctx);
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
        const family = familyOf(id);
        const element = document.querySelector(`[data-tool="${id}"]`)
            ?? (family && document.querySelector(`[data-family="${family.id}"]`))
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
                } else if (useDiscardAsk.getState().asking) {
                    keepSketch();
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
            // While Discard asks in the sketch bar, keys go to its buttons only (Esc above keeps the sketch).
            if (typing || useDiscardAsk.getState().asking) {
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
                // Sketch entities: copy, cut, and paste at the pointer.
                if (sk.active && sk.stage === 'draw' && (key === 'c' || key === 'x' || key === 'v')) {
                    event.preventDefault();
                    if (key === 'c') {
                        copySelection();
                    } else if (key === 'x') {
                        cutSelection();
                    } else {
                        pasteAtCursor();
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
                    // Enter ends what is in progress first; with nothing in progress it repeats the last command.
                    const again = lastSketchCommand();
                    if (enterKey() === 'repeat' && !openPopup && again) {
                        openById(again);
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
                if (key === 'a' && toggleLineArc()) {
                    // A while drawing lines: the next piece is a tangent arc (or a line again).
                    event.preventDefault();
                    return;
                }
                if (SKETCH_KEYS[key]) {
                    event.preventDefault();
                    // Edit tools with a form open it, as their button does.
                    const form = ALL_TOOLS.some((t) => t.id === `sk-${SKETCH_KEYS[key]}` && !t.instant);
                    if (form) {
                        openById(`sk-${SKETCH_KEYS[key]}`);
                    } else {
                        setTool(SKETCH_KEYS[key]);
                    }
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
                startSketch(latest.current.ctx.part?.id ?? null, 'sketch');
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

    const settings: UiSettings = { grid, edges, perspective: sketchActive && sketchStage === 'draw' ? perspective.sketch : perspective.model, showOthers, sketchTool: sketchActive ? sketchTool : null };
    const button = (tool: ToolDef, toolbar: ArrangedToolbar) => {
        const disabled = !!tool.soon || (!!tool.needsPart && !ctx.part);
        const on = tool.active?.(ctx, settings) ?? false;
        const openNow = popup?.tool.id === tool.id;
        return (
            <button
                key={tool.id}
                type="button"
                className={`tb-btn ${on ? 'on' : ''} ${openNow ? 'open' : ''} ${tool.danger ? 'danger' : ''}`}
                data-tool={tool.id}
                data-tip={openNow || toolbar.tips === 'off' ? undefined
                    : toolbar.tips === 'name' && !disabled ? tool.label : tip(tool, !!ctx.part)}
                aria-label={tool.label}
                aria-pressed={tool.active ? on : undefined}
                aria-disabled={disabled}
                onClick={(event) => open(tool, anchorOf(event.currentTarget))}
            >
                <Icon name={tool.icon} size={ICON_SIZES[toolbar.size].icon} />
                {toolbar.labels && <span className="tb-btn-label">{tool.label}</span>}
            </button>
        );
    };
    /** One button for a family: the variant in use (active, else last used), and an arrow that lists them all. */
    const familyButton = (family: ToolFamily, tools: ToolDef[], toolbar: ArrangedToolbar) => {
        const key = `family:${family.id}`;
        const shown = tools.find((t) => t.active?.(ctx, settings)) ?? tools.find((t) => t.id === lastUsed[family.id]) ?? tools[0];
        return (
            <span key={key} className={`tb-family ${menu?.group === key ? 'open' : ''}`} data-family={family.id}>
                {button(shown, toolbar)}
                <button
                    type="button"
                    className="tb-more"
                    title={`${family.label}: ${tools.map((t) => t.label).join(', ')}`}
                    aria-label={`${family.label}: all variants`}
                    aria-haspopup="menu"
                    onClick={(event) => {
                        const anchor = anchorOf(event.currentTarget.parentElement);
                        setMenu((m) => (m?.group === key ? null : { group: key, anchor }));
                    }}
                >
                    <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true">
                        <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                </button>
            </span>
        );
    };
    const items = (group: ArrangedToolbar) => arrangedItems(group)
        .map((item) => ('family' in item ? familyButton(item.family, item.tools, group) : button(item.tool, group)));
    /** What an open menu lists: every group, one group, or the variants of one family. */
    const menuGroups = (id: string): ToolGroup[] => {
        if (id === 'all') {
            return groups;
        }
        if (!id.startsWith('family:')) {
            return groups.filter((g) => g.id === id);
        }
        for (const group of groups) {
            for (const item of arrangedItems(group)) {
                if ('family' in item && `family:${item.family.id}` === id) {
                    return [{ id, label: item.family.label, icon: item.tools[0].icon, tools: item.tools }];
                }
            }
        }
        return [];
    };
    const menuButton = (group: ToolGroup | null) => {
        const id = group?.id ?? 'all';
        const named = !!group && layout.kind === 'groups' && layout.named.has(group.id);
        return (
            <button
                key={id}
                type="button"
                className={`tb-btn tb-menu ${menu?.group === id ? 'open' : ''} ${named ? 'named' : ''}`}
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
                {named && <span className="tb-menu-name">{group.short ?? group.label}</span>}
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
                ref={setBar}
                role="toolbar"
                aria-label="CAD tools"
                style={{ left: band.centre }}
                onContextMenu={(event) => {
                    // Right-click on the toolbars: show or hide them, or customise them (as on SolidWorks' window border).
                    event.preventDefault();
                    setMenu(null);
                    setBarMenu({ x: event.clientX, y: event.clientY });
                }}
            >
                <WorkspaceSwitch />
                {layout.kind === 'all'
                    ? <div className="tb-group">{menuButton(null)}</div>
                    : groups.map((group) => (
                        <div
                            key={group.id}
                            className={`tb-group g-${group.id} tb-${group.size} ${group.labels ? 'tb-labels' : ''}`}
                            role="group"
                            aria-label={group.label}
                        >
                            {layout.collapsed.has(group.id) ? menuButton(group) : items(group)}
                        </div>
                    ))}
                {workspace === 'part' && !sketchActive && ctx.part && (layout.kind !== 'groups' || layout.showActive) && (
                    <span className="tb-active" title="Part being edited">{ctx.part.name}</span>
                )}
            </div>
            <SketchBar centre={band.centre} top={barBottom + 6} onFinish={() => openById(finishTool.id)} />
            {barMenu && (
                <ContextMenu
                    x={barMenu.x}
                    y={barMenu.y}
                    onClose={() => setBarMenu(null)}
                    items={[
                        { header: mode === 'sketch' ? 'Sketch toolbars' : mode === 'part' ? 'Part toolbars' : 'Assembly toolbars' },
                        ...toolbars.map((t) => ({
                            label: t.label,
                            checked: !t.hidden,
                            onSelect: () => setToolbarPrefs(t.key, withOption(useToolbarArrangement.getState().arrangement[t.key], 'hidden', !t.hidden)),
                        })),
                        'separator',
                        {
                            label: 'Customize toolbars…', icon: 'toolbars', title: 'Tools, order, icon size and text of each toolbar, in the left panel',
                            onSelect: () => open(toolbarOptionsTool, anchorOf(bar.current)),
                        },
                    ]}
                />
            )}
            {menu && (
                <ToolMenu
                    groups={menuGroups(menu.group)}
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
            if (!ref.current?.contains(target) && !target.closest('.tb-menu, .tb-more')) {
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
