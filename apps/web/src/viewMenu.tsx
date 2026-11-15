// The 3D view's right-click menu: what the press landed on (offered by the part, sketch and reference handlers in
// the view), opened only for a right-click that did not drag (a right-drag pans the camera), and the app actions
// the menus in contextMenus.tsx call.

import { useEffect } from 'react';
import { create } from 'zustand';
import { useThree } from '@react-three/fiber';
import { Euler, MathUtils, Vector3 } from 'three';
import { shapeHalfExtents, type Part, type SketchPlane, type Vec3 } from '@jarvis/core';
import {
    sketchSpaceMenu, viewMenu, type MenuActions, type MenuContext, type PartListActions, type SketchMenuActions, type ViewTarget,
} from './contextMenus';
import { ContextMenu, showError, tool, type MenuEntry } from './menus';
import { copyWholeSketch, pasteWholeSketch } from './sketchPasteSketch';
import type { P3 } from './picking';
import {
    choosePlane, chooseFace, closeSketch, deleteSelected, endChain, fitSketch, pickSketch, startSketch, useSketcher,
} from './sketcher';
import { pickAt, type Pick } from './sketchGeometry';
import { sketchPointAt } from './SketchDrawing';
import { planeFrame } from './sketchMath';
import { normalToAngles } from './viewProjection';
import { AXIS_U, AXIS_V, ORIGIN } from './solver';
import { editItem, focusPart, runTool, select, setHidden, setSketchHidden, setWorkspace, useStudio } from './state';
import { fitView, setView, VIEWS } from './toolDefs';
import { presetToolValues, useToolSession } from './toolSession';
import { runItemAction } from './sketchItemActions';
import { toggleDimensionLock } from './sketchDimTools';
import { hiddenStepsNow } from './stepVisibility';
import { clearPieces, onPickedPiece } from './sketchPieces';

/** A right-click that moves further than this (screen pixels) is a pan, not a click. */
const CLICK_SLOP_PX = 4;

export const useViewMenu = create<{ menu: { x: number; y: number; items: MenuEntry[] } | null }>(() => ({ menu: null }));

const closeMenu = () => useViewMenu.setState({ menu: null });

/** The open view menu, drawn on the page. */
export function ViewMenu() {
    const menu = useViewMenu((s) => s.menu);
    return menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} /> : null;
}

// ---- Requests to the components list (rename and delete happen in its rows) -------------------------------------

export const usePartRequest = create<{ rename: string | null; remove: string | null }>(() => ({ rename: null, remove: null }));

/** Adds a copy of a part beside it, as a new design. */
export function duplicatePart(part: Part): void {
    const { id: _id, instanceOf: _source, ...rest } = part;
    const width = shapeHalfExtents(part.shape)[0] * 2;
    const position: Vec3 = [part.position[0] + width + 10, part.position[1], part.position[2]];
    void tool('parts_add', { parts: [{ ...rest, name: `${part.name} copy`, position }] });
}

/** Adds another placement of a design beside its last one. */
export function insertInstance(source: Part, parts: Part[]): void {
    const members = [source, ...parts.filter((p) => p.instanceOf === source.id)];
    const last = members[members.length - 1];
    const width = shapeHalfExtents(source.shape)[0] * 2;
    void tool('parts_instance', {
        partId: source.id,
        instances: [{ position: [last.position[0] + width + 10, last.position[1], last.position[2]], rotation: last.rotation }],
    });
}

/** Opens the Pattern form for a part (the toolbar owns the form). */
export function editPattern(part: Part): void {
    select(part.id);
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'pattern' })), 0);
}

export const removePattern = (part: Part): void => void tool('parts_update', { updates: [{ id: part.id, repeat: null }] });

const viewListActions: PartListActions = {
    rename: (part) => usePartRequest.setState({ rename: part.id }),
    remove: (part) => usePartRequest.setState({ remove: part.id }),
    insertInstance: (part) => insertInstance(part, useStudio.getState().history?.parts ?? []),
    duplicate: duplicatePart,
    editPattern,
    removePattern,
};

// ---- App actions -------------------------------------------------------------------------------------------------

/** Calls `run` once a form for `toolId` has opened (a new one, not the form open now); gives up after a while. */
function whenOpen(toolId: string, run: (set: ((patch: Record<string, unknown>) => void) | null) => void): void {
    const before = useToolSession.getState().owner;
    let done = false;
    const stop = useToolSession.subscribe((s) => {
        if (!done && s.toolId === toolId && s.owner !== before) {
            done = true;
            stop();
            // After the form's own effects (its preselection) have run.
            window.setTimeout(() => run(s.set as ((patch: Record<string, unknown>) => void) | null), 0);
        }
    });
    window.setTimeout(() => {
        done = true;
        stop();
    }, 3000);
}

/** The view direction for a world normal: from the side it points to, as the standard views are given. */
function lookAlong(normal: P3): void {
    // Already looking straight at it: Normal to a second time looks from the other side (viewProjection.ts).
    const { azimuth, elevation } = normalToAngles(normal);
    void setView(azimuth, elevation);
}

export const appActions: MenuActions = {
    openTool(id, o = {}) {
        if (o.select) {
            select(o.select);
        }
        if (o.picks) {
            useStudio.setState({ picked: o.picks });
        }
        if (o.values) {
            presetToolValues(id, o.values);
        }
        if (o.patch || o.then) {
            whenOpen(id, (set) => {
                if (o.patch && set) {
                    set(o.patch);
                }
                o.then?.();
            });
        }
        const fire = () => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id }));
        // The same form open already: the toolbar button closes it, so close and open it again, fresh.
        if (useToolSession.getState().toolId === id) {
            fire();
            window.setTimeout(fire, 30);
        } else {
            fire();
        }
    },
    sketchOnFace(partId, face, intent) {
        const s = useStudio.getState();
        if (s.workspace !== 'part' || s.activePart !== partId) {
            setWorkspace('part', partId);
        }
        startSketch(partId, intent);
        chooseFace(face.normal, face.point, face.curved);
    },
    sketchOnPlane(partId, plane, offset, intent) {
        startSketch(partId, intent);
        choosePlane(plane, offset);
    },
    newSketch(partId) {
        startSketch(useStudio.getState().workspace === 'part' ? partId : null, 'sketch');
    },
    lookAlong,
    lookAtPlane(partId, plane: SketchPlane, offset) {
        const part = useStudio.getState().history?.parts.find((p) => p.id === partId);
        if (!part) {
            return;
        }
        const { n } = planeFrame(plane, offset, part.features ?? []);
        const world = new Vector3(...n).applyEuler(new Euler(...part.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
        lookAlong([world.x, world.y, world.z]);
    },
    setView(id) {
        const view = VIEWS.find((v) => v.id === id);
        if (view) {
            void setView(view.azimuth, view.elevation);
        }
    },
    fit: () => void fitView(),
    edit: editItem,
    setSketchHidden,
    copySketch(partId, featureId) {
        const step = useStudio.getState().history?.parts.find((p) => p.id === partId)?.features?.find((f) => f.id === featureId);
        if (step?.op === 'sketch') {
            const error = copyWholeSketch(step.sketch, step.name ?? 'the sketch');
            if (error) {
                showError(error);
            }
        }
    },
    pasteSketch(partId, target) {
        const error = pasteWholeSketch(partId, target);
        if (error) {
            showError(error);
        }
    },
    toggle(setting) {
        if (setting === 'grid') {
            useStudio.setState((s) => ({ grid: !s.grid }));
        } else if (setting === 'edges') {
            useStudio.setState((s) => ({ edges: !s.edges }));
        } else if (setting === 'sketches') {
            useSketcher.setState((s) => ({ showSketches: !s.showSketches }));
        } else if (setting === 'others') {
            useStudio.setState((s) => ({ partView: s.partView === 'inContext' ? 'isolated' : 'inContext' }));
        } else {
            void runTool('view_set', { labels: !useStudio.getState().history?.view.labels });
        }
    },
    undo: () => void runTool('undo'),
    redo: () => void runTool('redo'),
    pickSketch,
    editPart: (partId, view) => setWorkspace('part', partId, view),
    setHidden,
    zoomToPart: focusPart,
};

export function menuContext(): MenuContext {
    const s = useStudio.getState();
    const parts = s.history?.parts ?? [];
    return {
        workspace: s.workspace,
        part: s.workspace === 'part' ? parts.find((p) => p.id === s.activePart) ?? null : null,
        parts,
        hiddenSketches: [...hiddenStepsNow()],
        hiddenParts: s.history?.view.hidden ?? [],
        settings: {
            grid: s.grid,
            edges: s.edges,
            sketches: useSketcher.getState().showSketches,
            others: s.partView === 'inContext',
            labels: !!s.history?.view.labels,
        },
    };
}

// ---- The open sketch ---------------------------------------------------------------------------------------------

const FAMILY_KEY = 'jarvis.toolbar.families';

function lastUsedTools(): Record<string, string> {
    try {
        const parsed = JSON.parse(localStorage.getItem(FAMILY_KEY) ?? '{}');
        return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
}

const sketchActions: SketchMenuActions = {
    openTool: (id) => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id })),
    deleteSelected,
    endChain,
    fitSketch,
    closeSketch: () => closeSketch(true),
    itemAction: runItemAction,
};

/** The open sketch's menu at a screen point: what is there is selected first, as a right-click does in SolidWorks. */
function sketchItems(x: number, y: number): MenuEntry[] {
    const s = useSketcher.getState();
    let selection = s.selection.filter((item): item is Pick => item.type !== 'constraint');
    const drawing = s.draft.length > 0;
    if (s.stage === 'draw' && !drawing) {
        const hit = sketchPointAt(x, y);
        const pick = hit ? pickAt(s.geometry, hit.p, hit.tolerance) : null;
        const own = pick && pick.id !== ORIGIN && pick.id !== AXIS_U && pick.id !== AXIS_V ? pick : null;
        // On empty space the selection stays: its menu then still applies to it (so does a piece picked with Alt).
        if (own && !selection.some((p) => p.id === own.id) && !onPickedPiece(hit!.p, hit!.tolerance)) {
            selection = [own];
            useSketcher.setState({ selection: [own] });
            clearPieces();
        }
    }
    return sketchSpaceMenu({
        stage: s.stage, tool: s.tool, geometry: s.geometry, draft: s.draft.length, selection, lastUsed: lastUsedTools(),
    }, sketchActions);
}

// ---- The right-click gate ----------------------------------------------------------------------------------------

interface Press {
    x: number;
    y: number;
    released: boolean;
    /** The browser's contextmenu event has come (on press on Linux, on release on Windows). */
    menu: boolean;
    scheduled: boolean;
    best: ViewTarget | null;
    rank: number;
}

let press: Press | null = null;

/**
 * Called by the view's right-click handlers with what is under the pointer. The highest `rank` wins, and the nearest
 * (the first offered) among equals: sketch curves (2) over faces, edges and reference geometry (1).
 */
export function offerTarget(target: ViewTarget, rank = 1): void {
    if (press && rank > press.rank) {
        press.best = target;
        press.rank = rank;
    }
}

function openFor(p: Press): void {
    const studio = useStudio.getState();
    let items: MenuEntry[] = [];
    // A right-click while a dimension follows the pointer locks its type instead (SolidWorks: locking dimensions).
    if (useSketcher.getState().active && toggleDimensionLock()) {
        return;
    }
    if (useSketcher.getState().active) {
        items = sketchItems(p.x, p.y);
    } else if (studio.mode === 'select' && !studio.placingDecal) {
        items = viewMenu(p.best ?? { kind: 'empty' }, menuContext(), appActions, viewListActions);
    }
    useViewMenu.setState({ menu: items.length ? { x: p.x, y: p.y, items } : null });
}

function maybeOpen(p: Press): void {
    if (p.released && p.menu && !p.scheduled) {
        p.scheduled = true;
        // After the view's handlers for this event have offered their targets.
        window.setTimeout(() => {
            if (press === p) {
                press = null;
            }
            openFor(p);
        }, 0);
    }
}

/** Mounted in the Canvas: watches right presses on the view and opens the menu for one that did not drag. */
export function RightClickGate() {
    const gl = useThree((s) => s.gl);
    const connected = useThree((s) => s.events.connected) as HTMLElement | undefined;
    useEffect(() => {
        const element = connected ?? gl.domElement;
        const down = (event: PointerEvent) => {
            if (event.button === 2) {
                press = { x: event.clientX, y: event.clientY, released: false, menu: false, scheduled: false, best: null, rank: -1 };
            }
        };
        const up = (event: PointerEvent) => {
            const p = press;
            if (event.button !== 2 || !p || p.released) {
                return;
            }
            p.released = true;
            if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > CLICK_SLOP_PX) {
                press = null;
                return;
            }
            maybeOpen(p);
        };
        const menu = (event: MouseEvent) => {
            // The browser's own menu never shows over the model.
            event.preventDefault();
            if (press) {
                press.menu = true;
                maybeOpen(press);
            }
        };
        element.addEventListener('pointerdown', down, { capture: true });
        element.addEventListener('contextmenu', menu, { capture: true });
        window.addEventListener('pointerup', up, true);
        return () => {
            element.removeEventListener('pointerdown', down, { capture: true });
            element.removeEventListener('contextmenu', menu, { capture: true });
            window.removeEventListener('pointerup', up, true);
        };
    }, [gl, connected]);
    return null;
}
