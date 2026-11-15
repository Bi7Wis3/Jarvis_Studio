// Picking one piece of a curve that other curves cross: with the Select tool, Alt held over a curve lights only the
// piece between the crossings nearest the pointer (Trim to closest's piece), and Alt + click selects that piece
// (Shift as well adds it to the selection, or takes it out). Nothing changes in the sketch until something is done
// with the pieces: Delete trims them away as Trim to closest does; Construction geometry and the relations first
// split each piece out at its crossings (as Trim with Keep trimmed entities as construction cuts it, so the piece's
// ends stay on the curves that cross it), then apply to it, in one undo step. Actions that do not know pieces leave
// them alone. A plain click, Escape, an edit or another tool lets the pieces go.

import { create } from 'zustand';
import type { SketchGeometry } from '@jarvis/core';
import { closestParam, pointAt } from '@jarvis/core/curveIntersect';
import { AXIS_U, AXIS_V, curveOf } from './solver';
import { geometryEntities, pickAt } from './sketchGeometry';
import { dist, entityDistance, type Entity, type NewEntity, type Pt } from './sketchMath';
import { trimAt } from './sketchEdit';
import { geomOfCurve } from './sketchCut';
import { trimmable } from './sketchTrim';
import { commitGeometry, deleteSelected, sketchClick, useSketcher } from './sketcher';

/** A piece of a curve: the curve it lies on, a point inside it (away from its ends) and its shape. */
export interface Piece {
    id: string;
    at: Pt;
    entity: NewEntity;
}

interface PiecesState {
    /** The piece (or the whole curve, when nothing crosses it) Alt + click would select. */
    hover: NewEntity | null;
    picked: Piece[];
}

export const usePieces = create<PiecesState>(() => ({ hover: null, picked: [] }));

type Sketcher = ReturnType<typeof useSketcher.getState>;

/** Picking pieces works in the Select tool of an open sketch, with nothing being dragged. */
const picking = (s: Sketcher): boolean => s.active && s.stage === 'draw' && s.tool === 'select' && !s.drag && !s.finishing;

/** A point halfway along an entity (inside the piece, clear of the crossings at its ends). */
function middleOf(e: NewEntity): Pt {
    if (e.kind === 'line') {
        return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    }
    if (e.kind === 'arc' || e.kind === 'curve') {
        return e.m;
    }
    return e.kind === 'circle' ? [e.c[0] + e.r, e.c[1]] : [0, 0];
}

/**
 * The piece of the curve under `raw` between its nearest crossings with other curves, or `whole` when nothing
 * crosses it (or it cannot be cut: text, block instances); null away from any curve.
 */
export function pieceUnder(g: SketchGeometry, raw: Pt, tolerance: number): { piece: Piece | null; id: string; whole: NewEntity | null } | null {
    // On a sketch point (or a spline handle) the click is the point's.
    const hit = pickAt(g, raw, tolerance);
    if (!hit || hit.type !== 'curve' || hit.id === AXIS_U || hit.id === AXIS_V) {
        return null;
    }
    const c = curveOf(g, hit.id);
    const geom = c ? geomOfCurve(g, c) : null;
    const whole = (): NewEntity | null => {
        const e = geometryEntities({ ...g, curves: c ? [c] : [] })[0];
        if (!e) {
            return null;
        }
        const { id: _id, construction: _c, ...rest } = e as Entity & { construction?: boolean };
        return rest as NewEntity;
    };
    if (!c || !geom || !trimmable(g, c.id, {})) {
        return { piece: null, id: hit.id, whole: whole() };
    }
    const on = pointAt(geom, closestParam(geom, raw)) as Pt;
    const plan = trimAt(g, c.id, on);
    // Trim to closest takes the whole curve when nothing crosses it (a circle needs two crossings).
    if (!plan || !curveOf(plan.g, c.id)) {
        return { piece: null, id: hit.id, whole: whole() };
    }
    return { piece: { id: c.id, at: middleOf(plan.removed), entity: plan.removed }, id: c.id, whole: null };
}

// ---- Keeping the pieces in step with the sketch ---------------------------------------------------------------------

let watching = false;
/** Set while this module changes the sketcher's selection itself. */
let own = false;

function quietly(run: () => void): void {
    own = true;
    try {
        run();
    } finally {
        own = false;
    }
}

/** Pieces go when the sketch changes, the tool changes, the sketch closes, or the selection is cleared. */
function watch(): void {
    if (watching) {
        return;
    }
    watching = true;
    useSketcher.subscribe((s, prev) => {
        const p = usePieces.getState();
        if (!p.picked.length && !p.hover) {
            return;
        }
        const gone = s.geometry !== prev.geometry || s.tool !== prev.tool || !s.active || s.stage !== prev.stage;
        const cleared = !own && s.selection !== prev.selection && !s.selection.length;
        if (gone || cleared) {
            usePieces.setState({ picked: [], hover: null });
        }
    });
}

export function clearPieces(): void {
    if (usePieces.getState().picked.length || usePieces.getState().hover) {
        usePieces.setState({ picked: [], hover: null });
    }
}

// ---- Pointer -----------------------------------------------------------------------------------------------------

/** Where the pointer was last, so pressing or letting go of Alt without moving shows or hides the piece. */
let last: { raw: Pt; tolerance: number } | null = null;

/** Pointer moved: with Alt held over a curve, the piece Alt + click would select lights up. */
export function pieceHover(raw: Pt, tolerance: number, alt: boolean): void {
    last = { raw, tolerance };
    const s = useSketcher.getState();
    const hover = alt && picking(s) ? pieceUnder(s.geometry, raw, tolerance) : null;
    const shown = hover ? hover.piece?.entity ?? hover.whole : null;
    if (shown || usePieces.getState().hover) {
        watch();
        usePieces.setState({ hover: shown });
    }
}

/** Alt pressed or let go with the pointer still. */
export function pieceKey(alt: boolean): void {
    if (last) {
        pieceHover(last.raw, last.tolerance, alt);
    }
}

const samePiece = (a: Piece, b: Piece): boolean => a.id === b.id && entityDistance({ ...a.entity, id: '' } as Entity, b.at) < 1e-7;

/**
 * A click in the view (before the sketcher's own): Alt + click on a curve selects the piece under the pointer
 * (Shift: adds or removes it) and is taken (true); a plain click lets the pieces go and goes on as usual.
 */
export function pieceClick(raw: Pt, tolerance: number, alt: boolean, shift: boolean): boolean {
    const s = useSketcher.getState();
    if (!picking(s)) {
        return false;
    }
    if (!alt) {
        if (!shift) {
            clearPieces();
        }
        return false;
    }
    const hit = pieceUnder(s.geometry, raw, tolerance);
    if (!hit) {
        // Alt + click away from the curves is the shaded contours' (sketchContours.ts).
        return false;
    }
    watch();
    if (!hit.piece) {
        // Nothing crosses it: the whole curve, as a plain click selects it.
        if (!shift) {
            clearPieces();
        }
        sketchClick(raw, tolerance, shift);
        return true;
    }
    const piece = hit.piece;
    const picked = usePieces.getState().picked;
    if (shift) {
        const there = picked.some((p) => samePiece(p, piece));
        usePieces.setState({ picked: there ? picked.filter((p) => !samePiece(p, piece)) : [...picked, piece] });
        return true;
    }
    quietly(() => useSketcher.setState({ selection: [] }));
    usePieces.setState({ picked: [piece] });
    return true;
}

/** Whether `raw` is on a selected piece (a right-click there keeps the pieces as the selection). */
export function onPickedPiece(raw: Pt, tolerance: number): boolean {
    return usePieces.getState().picked.some((p) => entityDistance({ ...p.entity, id: '' } as Entity, raw) < tolerance);
}

// ---- Acting on the pieces -----------------------------------------------------------------------------------------

/** The curve that now holds the piece's point (after other pieces were split out, its own id may have moved on). */
function curveOfPiece(g: SketchGeometry, p: Piece): string | null {
    const d = (id: string): number => {
        const c = curveOf(g, id);
        const geom = c ? geomOfCurve(g, c) : null;
        return geom ? dist(pointAt(geom, closestParam(geom, p.at)) as Pt, p.at) : Infinity;
    };
    if (d(p.id) < 1e-6) {
        return p.id;
    }
    let best: { id: string; d: number } | null = null;
    for (const c of g.curves) {
        const k = d(c.id);
        if (k < 1e-6 && (!best || k < best.d)) {
            best = { id: c.id, d: k };
        }
    }
    return best?.id ?? null;
}

/**
 * The piece split out of its curve at its crossings, as a curve of its own (which keeps the curve's construction
 * flag); null when it cannot be. Trim with Keep trimmed entities as construction does the cutting: the curve's other
 * parts stay as they were, and the piece's ends are held on the curves that cross there.
 */
function splitOut(g: SketchGeometry, p: Piece): { g: SketchGeometry; id: string } | null {
    const id = curveOfPiece(g, p);
    const c = id ? curveOf(g, id) : undefined;
    if (!id || !c) {
        return null;
    }
    const was = !!c.construction;
    const plain = was ? { ...g, curves: g.curves.map((k) => (k.id === id ? { ...k, construction: false } : k)) } : g;
    const plan = trimAt(plain, id, p.at, { construction: true });
    if (!plan) {
        return null;
    }
    const before = new Set(plain.curves.map((k) => k.id));
    const fresh = plan.g.curves.filter((k) => !before.has(k.id));
    const ghost = fresh.find((k) => k.construction);
    if (!ghost) {
        // Nothing crosses it after all: the piece is the whole curve.
        return { g, id };
    }
    const parts = new Set([id, ...fresh.map((k) => k.id)]);
    const curves = plan.g.curves.map((k) => {
        if (k.id === ghost.id && !was) {
            const { construction: _c, ...rest } = k;
            return rest as typeof k;
        }
        return was && parts.has(k.id) ? { ...k, construction: true } : k;
    });
    return { g: { ...plan.g, curves }, id: ghost.id };
}

/** Every selected piece split out (see splitOut), with the new curves' ids. */
export function splitOutPieces(g: SketchGeometry, pieces: Piece[]): { g: SketchGeometry; ids: string[] } | null {
    let out = g;
    const ids: string[] = [];
    for (const p of pieces) {
        const r = splitOut(out, p);
        if (r) {
            out = r.g;
            ids.push(r.id);
        }
    }
    return ids.length ? { g: out, ids } : null;
}

/**
 * Runs an action that takes the selection (construction geometry, a relation) on the selected pieces: each is split
 * out first and selected in its place, the action runs, and the split and the action are one undo step. When the
 * action changes nothing, the sketch is put back as it was (unless the action keeps the pieces picked, as a relation
 * tool waiting for more picks does: then the split stays, as a step of its own). Null when no piece is selected.
 */
export function withPieces<T>(run: () => T): { result: T } | null {
    const picked = usePieces.getState().picked;
    if (!picked.length) {
        return null;
    }
    const s = useSketcher.getState();
    const split = splitOutPieces(s.geometry, picked);
    if (!split) {
        return null;
    }
    const base = s.geometry;
    usePieces.setState({ picked: [], hover: null });
    const extra = split.ids.filter((id) => !s.selection.some((x) => x.id === id)).map((id) => ({ type: 'curve' as const, id }));
    quietly(() => useSketcher.setState({ geometry: split.g, selection: [...s.selection, ...extra] }));
    const result = run();
    const now = useSketcher.getState();
    if (now.geometry === split.g) {
        if (split.g !== base && now.picks.some((p) => split.ids.includes(p.id))) {
            useSketcher.setState({ undo: [...now.undo.slice(-80), base], redo: [] });
        } else {
            quietly(() => useSketcher.setState({ geometry: base, selection: s.selection }));
            usePieces.setState({ picked });
        }
    } else {
        const i = now.undo.lastIndexOf(split.g);
        if (i >= 0) {
            useSketcher.setState({ undo: now.undo.map((g, k) => (k === i ? base : g)) });
        }
    }
    return { result };
}

/**
 * Delete with pieces selected: each piece is trimmed away as Trim to closest does, and whatever else is selected goes
 * with them, in one undo step. False when no piece is selected.
 */
export function deletePieces(): boolean {
    const picked = usePieces.getState().picked;
    if (!picked.length) {
        return false;
    }
    const s = useSketcher.getState();
    const base = s.geometry;
    let g = base;
    for (const p of picked) {
        const id = curveOfPiece(g, p);
        const plan = id ? trimAt(g, id, p.at) : null;
        if (plan) {
            g = plan.g;
        }
    }
    usePieces.setState({ picked: [], hover: null });
    if (g === base) {
        useSketcher.setState({ message: 'Nothing to delete there.' });
        return true;
    }
    if (!s.selection.length) {
        if (!commitGeometry(g)) {
            usePieces.setState({ picked });
        }
        return true;
    }
    quietly(() => useSketcher.setState({ geometry: g }));
    deleteSelected();
    const now = useSketcher.getState();
    if (now.geometry === g) {
        // The rest could not go (the commit refused it): neither do the pieces.
        quietly(() => useSketcher.setState({ geometry: base }));
        usePieces.setState({ picked });
    } else {
        const i = now.undo.lastIndexOf(g);
        if (i >= 0) {
            useSketcher.setState({ undo: now.undo.map((x, k) => (k === i ? base : x)) });
        }
    }
    return true;
}
