// The sketch tools that select and change existing geometry, as a session next to the sketcher: box selection,
// copy and paste, dynamic mirror, jog line, segment, replace entity, modify sketch, check sketch for feature and the
// tangent arc's intent zones. The sketcher calls the hooks here (moreDown, moreMove, moreUp, moreClick, afterDrawn);
// the forms are in sketchMoreForms.tsx.

import { create } from 'zustand';
import type { SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, isDimension, pointOf } from './solver';
import { geometryEntities, pickAt, tangentAt, type Pick, type PointRef } from './sketchGeometry';
import { boxSelect, combineBox } from './sketchBoxSelect';
import { fragmentOf, getClipboard, pasteFragment, setClipboard } from './sketchClipboard';
import { isMirrorLine, mirrorDrawn } from './sketchDynamicMirror';
import { jogLine, jogPreview } from './sketchJog';
import { resegment, segmentEntity, type SegmentMode } from './sketchSegment';
import { replaceEntity, type ReplaceOptions } from './sketchReplace';
import { checkSketchFor, withPoints, type CheckResult, type ContourType } from './sketchFeatureCheck';
import { flipSketch, frameLocked, mapLabels, movedPlane, scaleSketch } from './sketchModifySketch';
import { addZonedArc, ZONE_IDLE, zoneMove, type ZoneState } from './sketchTangentZones';
import { transformEntities } from './sketchEdit';
import { transformWithItems } from './sketchItemTransform';
import { curvePointIds } from './sketchCurves';
import { dist, type NewEntity, type Pt } from './sketchMath';
import {
    commitGeometry, deleteSelected, dimensionAnchor, recordFrame, setHighlight, setTool, useSketcher, type Selected, type SketchTool,
} from './sketcher';

/** The tools of this module that take clicks in the view (sketcher tool `m:<name>`). */
export type MoreTool = 'jog' | 'pick';

/** A form's selection box waiting for a click in the view. */
export interface Picker {
    /** Why the pick is refused, or null to take it. */
    accept: (g: SketchGeometry, pick: Pick) => string | null;
    onPick: (pick: Pick) => void;
    /** Which model edges a click brings into the sketch to pick: straight ones (the default), or any curve. */
    models?: 'line' | 'curve';
    /** The tool to go back to when the picking ends. */
    back: SketchTool;
}

interface MoreState {
    /** Select tool: the selection box being dragged (sketch coordinates, and screen x to tell its direction). */
    box: { from: Pt; to: Pt; fromX: number; toX: number; slop: number } | null;
    /** Dynamic mirror: the line new geometry is mirrored about, and the images made so far. */
    dynamicMirror: { line: string; images: Record<string, string> } | null;
    picker: Picker | null;
    /** Jog line: the line clicked and where. */
    jog: { line: string; from: Pt } | null;
    /** What a click of the current tool here would take. */
    hover: string | null;
    preview: NewEntity[];
    /** Tangent arc: the intent zone chosen by the pointer's way off the end point. */
    zone: ZoneState;
    /** Check sketch for feature: the last result. */
    check: CheckResult | null;
    /** Ctrl-drag (copy) or Shift-drag (move) of entities: what goes, from where the press was to where the pointer is. */
    xdrag: { ids: string[]; from: Pt; to: Pt; copy: boolean; slop: number; moved: boolean } | null;
}

export const useSketchMore = create<MoreState>(() => ({
    box: null, dynamicMirror: null, picker: null, jog: null, hover: null, preview: [], zone: ZONE_IDLE, check: null, xdrag: null,
}));

const more = () => useSketchMore.getState();
const sk = () => useSketcher.getState();
const say = (message: string | null) => useSketcher.setState({ message });

const isAxis = (id: string) => id === AXIS_U || id === AXIS_V;

// ---- Box selection ------------------------------------------------------------------------------------------

/** Select tool, a press on empty space: starts a selection box (and keeps the view still). */
export function boxStart(raw: Pt, tolerance: number, screenX = 0): boolean {
    useSketchMore.setState({ box: { from: raw, to: raw, fromX: screenX, toX: screenX, slop: tolerance * 0.4 } });
    return true;
}

/** Whether the box is drawn right to left (screen): a cross selection. */
export const crossing = (box: NonNullable<MoreState['box']>) => box.toX < box.fromX;

/** Every dimension's label position: where the user put it, else where it is drawn by default. */
function labelSpots(g: SketchGeometry, labels: Record<string, Pt>): Record<string, Pt> {
    return Object.fromEntries(g.constraints.filter(isDimension).map((c) => [c.id, labels[c.id] ?? dimensionAnchor(g, c)]));
}

/** Pointer released: the box selects (Shift adds, Ctrl turns over); a press without a drag stays a click. */
function boxEnd(mods: { shift?: boolean; ctrl?: boolean }): void {
    const box = more().box;
    useSketchMore.setState({ box: null });
    if (!box || dist(box.from, box.to) <= box.slop) {
        return;
    }
    const s = sk();
    const boxed = boxSelect(s.geometry, box.from, box.to, crossing(box), labelSpots(s.geometry, s.labels)) as Selected[];
    const mode = mods.ctrl ? 'toggle' : mods.shift ? 'add' : 'replace';
    useSketcher.setState({ selection: combineBox(s.selection, boxed, mode), message: null });
}

// ---- Presses an open form takes (a sketch picture dragged in the view) ---------------------------------------

/** What a press on empty space does for the open form: how the pointer then moves it, until it is released. */
export type PressHook = (raw: Pt, tolerance: number) => { move: (raw: Pt) => void; up: () => void } | null;

let pressHook: PressHook | null = null;
let pressing: ReturnType<PressHook> = null;

export function setPressHook(hook: PressHook | null): void {
    pressHook = hook;
    pressing = null;
}

/** Select tool, a press on empty space: true when the open form takes it (then no selection box starts). */
export function moreDown(raw: Pt, tolerance: number): boolean {
    pressing = pressHook?.(raw, tolerance) ?? null;
    return !!pressing;
}

// ---- Hooks the sketcher calls ---------------------------------------------------------------------------------

const toolOf = (tool: SketchTool): MoreTool | null => (tool.startsWith('m:') ? tool.slice(2) as MoreTool : null);

/** Pointer moved: true when this module took the move. */
export function moreMove(raw: Pt, tolerance: number, screenX?: number): boolean {
    if (pressing) {
        pressing.move(raw);
        return true;
    }
    if (more().xdrag) {
        dragCopyMove(raw);
        return true;
    }
    const box = more().box;
    if (box) {
        useSketchMore.setState({ box: { ...box, to: raw, toX: screenX ?? box.toX + (raw[0] - box.to[0]) } });
        useSketcher.setState({ cursor: raw });
        return true;
    }
    const s = sk();
    if (s.tool === 'tangentArc' && !s.draft.length && more().zone !== ZONE_IDLE) {
        useSketchMore.setState({ zone: ZONE_IDLE });
    }
    if (s.tool === 'tangentArc' && s.draft.length === 1 && s.draft[0].point) {
        const t = tangentAt(s.geometry, s.draft[0].point);
        if (t) {
            const next = zoneMove(more().zone, s.draft[0].at, t.dir, raw, tolerance);
            if (next !== more().zone) {
                useSketchMore.setState({ zone: next });
            }
        }
        return false;
    }
    const tool = toolOf(s.tool);
    if (!tool) {
        return false;
    }
    const g = s.geometry;
    const pick = pickFor(tool, g, raw, tolerance);
    const jog = more().jog;
    useSketchMore.setState({ hover: pick?.id ?? null, preview: tool === 'jog' && jog ? jogPreview(g, jog.line, jog.from, raw) : [] });
    useSketcher.setState({ cursor: raw, snapKind: null, snapGuides: [], snapHints: [] });
    return true;
}

function pickFor(tool: MoreTool, g: SketchGeometry, raw: Pt, tolerance: number): Pick | null {
    if (tool === 'jog') {
        const pick = pickAt(g, raw, tolerance);
        return more().jog ? null : pick?.type === 'curve' && curveOf(g, pick.id)?.kind === 'line' ? pick : null;
    }
    const picker = more().picker;
    const pick = pickAt(g, raw, tolerance);
    return picker && pick && !picker.accept(g, pick) ? pick : null;
}

/** A click in the view: true when this module took it. */
export function moreClick(raw: Pt, tolerance: number): boolean {
    const s = sk();
    const tool = toolOf(s.tool);
    if (!tool) {
        return false;
    }
    const g = s.geometry;
    if (tool === 'jog') {
        jogClick(g, raw, tolerance);
        return true;
    }
    const picker = more().picker;
    const pick = pickAt(g, raw, tolerance);
    if (!picker || !pick) {
        return true;
    }
    const refused = picker.accept(g, pick);
    if (refused) {
        say(refused);
        return true;
    }
    say(null);
    picker.onPick(pick);
    return true;
}

/** Pointer released: true when this module took it. */
export function moreUp(mods: { shift?: boolean; ctrl?: boolean } = {}): boolean {
    if (pressing) {
        const p = pressing;
        pressing = null;
        p.up();
        return true;
    }
    if (more().xdrag) {
        dragCopyEnd();
        return true;
    }
    if (more().box) {
        boxEnd(mods);
        return true;
    }
    return false;
}

/** Esc: drops what this module has in progress; true when it did. */
export function moreEscape(): boolean {
    if (more().xdrag) {
        useSketchMore.setState({ xdrag: null });
        useSketcher.setState({ editPreview: [] });
        return true;
    }
    if (more().jog) {
        useSketchMore.setState({ jog: null, preview: [] });
        return true;
    }
    if (more().box) {
        useSketchMore.setState({ box: null });
        return true;
    }
    return false;
}

/** What the toolbar's hint line says for this module's tools. */
export function moreHint(tool: SketchTool): string {
    return toolOf(tool) === 'jog'
        ? 'Click a line where the jog starts, then where it ends and how deep · the tool stays on for more jogs · Esc stops'
        : 'Click the entity for the selection box in the form';
}

/** Geometry a draw tool made: with dynamic mirror on, mirrored about its line. */
export function afterDrawn(before: SketchGeometry, next: SketchGeometry): SketchGeometry {
    const dm = more().dynamicMirror;
    if (!dm) {
        return next;
    }
    if (!isMirrorLine(next, dm.line)) {
        useSketchMore.setState({ dynamicMirror: null });
        return next;
    }
    const r = mirrorDrawn(before, next, dm.line, dm.images);
    useSketchMore.setState({ dynamicMirror: { line: dm.line, images: r.images } });
    return r.g;
}

/** The tangent arc from `start` to `end`, as the intent zone says; the zone starts over for the next arc. */
export function zonedTangentArc(g: SketchGeometry, start: string, end: PointRef) {
    const r = addZonedArc(g, start, end, more().zone.intent);
    useSketchMore.setState({ zone: ZONE_IDLE });
    return r;
}

// ---- Copy and paste -----------------------------------------------------------------------------------------

const selectedGeometry = () => sk().selection.filter((x) => x.type !== 'constraint').map((x) => x.id);

/** Ctrl+C: keeps the selected curves and points (with the relations among them) for pasting. */
export function copySelection(): boolean {
    const f = fragmentOf(sk().geometry, selectedGeometry());
    if (!f) {
        say('Select the curves or points to copy.');
        return false;
    }
    setClipboard(f);
    const n = selectedGeometry().length;
    say(`Copied ${n} item${n === 1 ? '' : 's'}; Ctrl+V pastes ${n === 1 ? 'it' : 'them'} at the pointer.`);
    return true;
}

/** Ctrl+X: copies, then deletes the selection. */
export function cutSelection(): boolean {
    if (!copySelection()) {
        return false;
    }
    deleteSelected();
    return true;
}

/** Ctrl+V: the copied entities with their centre at the pointer, selected. */
export function pasteAtCursor(): boolean {
    const f = getClipboard();
    if (!f) {
        say('Nothing copied yet: select curves and press Ctrl+C.');
        return false;
    }
    const s = sk();
    const at = s.cursor ?? [f.centre[0] + 5, f.centre[1] + 5];
    const r = pasteFragment(s.geometry, f, at);
    if (!commitGeometry(r.g)) {
        return false;
    }
    useSketcher.setState({ selection: r.created, message: 'Pasted.' });
    return true;
}

// ---- Ctrl-drag and Shift-drag -----------------------------------------------------------------------------------

/**
 * A press with Ctrl or Shift held on an entity (select tool): Ctrl-drag copies it, Shift-drag moves it (SolidWorks:
 * Cutting, Copying, and Pasting Sketch Entities). What goes is the selection when the entity is in it, else the
 * entity; text, equation curves and block instances go whole. A press without a drag stays a click.
 */
export function dragCopyStart(raw: Pt, tolerance: number, pickId: string, copy: boolean): boolean {
    if (pickId === ORIGIN || isAxis(pickId)) {
        return false;
    }
    // An end point of a curve dragged with Ctrl is an ordinary drag (SolidWorks: Ctrl-drag of an end point only
    // leaves out inference lines), unless it is selected.
    const g = sk().geometry;
    if (!curveOf(g, pickId) && g.curves.some((c) => curvePointIds(c).includes(pickId)) && !selectedGeometry().includes(pickId)) {
        return false;
    }
    const selected = selectedGeometry();
    const ids = selected.includes(pickId) ? selected : [pickId];
    useSketchMore.setState({ xdrag: { ids, from: raw, to: raw, copy, slop: tolerance * 0.4, moved: false } });
    return true;
}

/** The copy or move by `by`, without solving. */
function dragResult(g: SketchGeometry, ids: string[], by: Pt, copy: boolean) {
    const t = { kind: 'move' as const, by };
    return transformWithItems(g, ids, t, copy) ?? transformEntities(g, ids, t, copy);
}

function dragCopyMove(raw: Pt): void {
    const x = more().xdrag!;
    const moved = x.moved || dist(raw, x.from) > x.slop;
    useSketchMore.setState({ xdrag: { ...x, to: raw, moved } });
    if (!moved) {
        return;
    }
    // The ghost: where the entities would go.
    const g = sk().geometry;
    const r = dragResult(g, x.ids, [raw[0] - x.from[0], raw[1] - x.from[1]], true);
    const made = 'error' in r ? new Set<string>() : new Set(r.created);
    useSketcher.setState({ cursor: raw, editPreview: 'error' in r ? [] : geometryEntities(r.g).filter((e) => made.has(e.id)) as NewEntity[] });
}

function dragCopyEnd(): void {
    const x = more().xdrag!;
    useSketchMore.setState({ xdrag: null });
    useSketcher.setState({ editPreview: [] });
    if (!x.moved) {
        return;
    }
    const by: Pt = [x.to[0] - x.from[0], x.to[1] - x.from[1]];
    const r = dragResult(sk().geometry, x.ids, by, x.copy);
    if ('error' in r) {
        say(r.error);
        return;
    }
    if (!commitGeometry(r.g)) {
        return;
    }
    const selection: Selected[] = x.copy
        ? r.created.map((id) => ({ type: r.g.curves.some((c) => c.id === id) ? 'curve' as const : 'point' as const, id }))
        : sk().selection;
    const n = x.ids.length;
    const what = `${n} item${n === 1 ? '' : 's'}`;
    useSketcher.setState({
        selection,
        message: x.copy ? `Copied ${what}.` : r.dropped ? `Moved ${what}; removed ${r.dropped} relation${r.dropped === 1 ? '' : 's'} to the rest of the sketch.` : `Moved ${what}.`,
    });
}

// ---- Dynamic mirror -------------------------------------------------------------------------------------------

let stopWatching: (() => void) | null = null;

function setMirror(line: string | null): void {
    stopWatching?.();
    stopWatching = null;
    useSketchMore.setState({ dynamicMirror: line ? { line, images: {} } : null });
    if (line) {
        // Off again when the sketch closes.
        stopWatching = useSketcher.subscribe((s) => {
            if (!s.active) {
                setMirror(null);
            }
        });
        say('Dynamic mirror on: what you draw now is mirrored about the line. Click Dynamic mirror again to stop.');
    } else {
        say('Dynamic mirror off.');
    }
}

/**
 * The Dynamic mirror button: off when on; else on about the selected line or centreline, or (nothing selected)
 * the next line clicked.
 */
export function toggleDynamicMirror(): void {
    if (more().dynamicMirror) {
        setMirror(null);
        return;
    }
    const s = sk();
    const lines = s.selection.filter((x) => x.type === 'curve' && isMirrorLine(s.geometry, x.id));
    if (lines.length === 1) {
        useSketcher.setState({ selection: [] });
        setMirror(lines[0].id);
        return;
    }
    startPicker({
        back: 'select',
        accept: (g, pick) => (pick.type === 'curve' && isMirrorLine(g, pick.id) ? null : 'Click a line, a centreline or an axis to mirror about.'),
        onPick: (pick) => {
            stopPicker();
            setMirror(pick.id);
        },
    });
    say('Dynamic mirror: click the line, centreline or axis to mirror about.');
}

// ---- Picking for the forms ------------------------------------------------------------------------------------

/** Clicks in the view now go to `picker` (a form's selection box). */
export function startPicker(picker: Picker): void {
    useSketchMore.setState({ picker, hover: null });
    if (sk().tool !== 'm:pick') {
        setTool('m:pick');
    }
}

export function stopPicker(): void {
    const picker = more().picker;
    useSketchMore.setState({ picker: null, hover: null });
    if (sk().tool === 'm:pick') {
        setTool(picker?.back ?? 'select');
    }
}

export const isCurve = (g: SketchGeometry, pick: Pick) => pick.type === 'curve' && !isAxis(pick.id) && !!curveOf(g, pick.id);

// ---- Jog line -------------------------------------------------------------------------------------------------

export function startJog(): void {
    useSketchMore.setState({ jog: null, preview: [] });
    setTool('m:jog');
    say(null);
}

function jogClick(g: SketchGeometry, raw: Pt, tolerance: number): void {
    const jog = more().jog;
    if (!jog) {
        const pick = pickAt(g, raw, tolerance);
        const line = pick?.type === 'curve' && !isAxis(pick.id) && curveOf(g, pick.id)?.kind === 'line' ? pick.id : null;
        if (!line) {
            say('Click a line where the jog starts.');
            return;
        }
        useSketchMore.setState({ jog: { line, from: raw } });
        say(null);
        return;
    }
    const r = jogLine(g, jog.line, jog.from, raw);
    if ('error' in r) {
        say(r.error);
        return;
    }
    useSketchMore.setState({ jog: null, preview: [] });
    if (commitGeometry(r.g)) {
        say(r.dropped ? `Jogged; removed ${r.dropped} relation${r.dropped === 1 ? '' : 's'} on the whole line (its length, middle or equal length).` : 'Jogged.');
    }
}

// ---- Segment, replace -----------------------------------------------------------------------------------------

export function applySegment(curve: string, count: number, mode: SegmentMode): string | null {
    const r = segmentEntity(sk().geometry, curve, count, mode);
    if ('error' in r) {
        return r.error;
    }
    if (!commitGeometry(r.g)) {
        return sk().message ?? 'The segments could not be applied.';
    }
    useSketcher.setState({
        selection: mode === 'points' ? r.points.map((id) => ({ type: 'point' as const, id })) : r.curves.map((id) => ({ type: 'curve' as const, id })),
        message: r.dropped ? `Segmented; removed ${r.dropped} relation${r.dropped === 1 ? '' : 's'} on the whole line.` : 'Segmented.',
    });
    return null;
}

/** Segment on an earlier group: its entity is segmented again with a new number of instances (or mode). */
export function applyResegment(group: string, count: number, mode: SegmentMode): string | null {
    const r = resegment(sk().geometry, group, count, mode);
    if ('error' in r) {
        return r.error;
    }
    if (!commitGeometry(r.g)) {
        return sk().message ?? 'The segments could not be applied.';
    }
    useSketcher.setState({
        selection: mode === 'points' ? r.points.map((id) => ({ type: 'point' as const, id })) : r.curves.map((id) => ({ type: 'curve' as const, id })),
        message: `Segmented again: ${count} ${mode === 'points' ? 'point' : 'piece'}${count === 1 ? '' : 's'}.`,
    });
    return null;
}

export function applyReplace(oldId: string, newId: string, o: ReplaceOptions): string | null {
    const r = replaceEntity(sk().geometry, oldId, newId, o);
    if ('error' in r) {
        return r.error;
    }
    if (!commitGeometry(r.g)) {
        return sk().message ?? 'The replacement does not solve.';
    }
    useSketcher.setState({
        selection: [{ type: 'curve', id: newId }],
        message: r.dropped ? `Replaced; ${r.dropped} relation${r.dropped === 1 ? '' : 's'} could not hold on the new entity and went.` : 'Replaced.',
    });
    return null;
}

// ---- Modify sketch --------------------------------------------------------------------------------------------

/**
 * Moves the sketch by `by`, or turns it by `angle` degrees about `centre` (sketch coordinates as they are now).
 * keepView: the camera stays (a drag in the view); else it turns to frame the sketch where it now is.
 */
export function moveSketchFrame(by: Pt, centre: Pt = [0, 0], angle = 0, keepView = false): string | null {
    const s = sk();
    const locked = frameLocked(s.plane);
    if (locked) {
        return locked;
    }
    if (!by[0] && !by[1] && !angle) {
        return null;
    }
    const plane = movedPlane(s.plane, s.offset, s.context, by, centre, angle);
    // One undo step: the geometry stays as it is (a copy, so undo and redo can tell the two apart) on the moved plane.
    recordFrame(s.geometry, { plane: s.plane, offset: s.offset });
    useSketcher.setState({
        plane, offset: 0, ...(keepView ? {} : { look: s.look + 1, fitToSketch: true }), message: angle ? 'Turned the sketch.' : 'Moved the sketch.',
        geometry: { ...s.geometry }, undo: [...s.undo.slice(-80), s.geometry], redo: [],
    });
    return null;
}

/** Moves the sketch so the point `id` goes to (u, v) of the sketch as it is now. */
export function positionPoint(id: string, to: Pt): string | null {
    const p = pointOf(sk().geometry, id);
    if (!p || id === ORIGIN) {
        return 'Pick a sketch point to position.';
    }
    return moveSketchFrame([to[0] - p.u, to[1] - p.v]);
}

/** Scales the sketch about its origin, or about `centre` (a movable origin: the sketch moves to keep it still). */
export function scaleWholeSketch(factor: number, centre: Pt | null = null): string | null {
    const s = sk();
    if (centre && (centre[0] || centre[1]) && frameLocked(s.plane)) {
        return frameLocked(s.plane);
    }
    const r = scaleSketch(s.geometry, factor);
    if ('error' in r) {
        return r.error;
    }
    if (!commitGeometry(r)) {
        return sk().message ?? 'The scaled sketch does not solve.';
    }
    useSketcher.setState({ labels: mapLabels(s.labels, (p) => [p[0] * factor, p[1] * factor]), message: 'Scaled the sketch.' });
    if (centre && (centre[0] || centre[1])) {
        // The plane moves in the same undo step as the scale.
        const t = sk();
        const by: Pt = [centre[0] * (1 - factor), centre[1] * (1 - factor)];
        recordFrame(t.undo[t.undo.length - 1], { plane: t.plane, offset: t.offset });
        useSketcher.setState({ plane: movedPlane(t.plane, t.offset, t.context, by, [0, 0], 0), offset: 0, look: t.look + 1, fitToSketch: true });
    }
    return null;
}

export function flipWholeSketch(about: 'x' | 'y' | 'both'): string | null {
    const s = sk();
    const [su, sv] = about === 'x' ? [1, -1] : about === 'y' ? [-1, 1] : [-1, -1];
    if (!commitGeometry(flipSketch(s.geometry, about))) {
        return sk().message ?? 'The flipped sketch does not solve.';
    }
    useSketcher.setState({ labels: mapLabels(s.labels, (p) => [p[0] * su, p[1] * sv]), message: 'Flipped the sketch.' });
    return null;
}

// ---- Check sketch for feature ---------------------------------------------------------------------------------

export function checkSketch(contour: ContourType): CheckResult {
    const g = sk().geometry;
    const r = checkSketchFor(g, contour);
    useSketchMore.setState({ check: r });
    setHighlight(withPoints(g, r.refs));
    return r;
}

export function clearCheck(): void {
    useSketchMore.setState({ check: null });
    setHighlight([]);
}
