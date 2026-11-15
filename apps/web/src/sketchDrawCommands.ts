// The sketcher actions of Select Chain, Reverse Endpoint Tangent, Infinite length, Align Grid/Origin, Make Path and
// Belt/Chain, and their right-click entries. The forms are in sketchDrawCommandForms.tsx.

import type { SketchBelt, SketchGeometry } from '@jarvis/core';
import type { MenuEntry } from './menus';
import { curveOf } from './solver';
import { addConstraint, type Pick } from './sketchGeometry';
import { commitGeometry, recordFrame, useSketcher, type Selected } from './sketcher';
import { reverseEndpointTangent, selectChains } from './sketchChainTools';
import { alignFrame, relocatedGeometry, toFrame, type AlignOptions } from './sketchAlignGrid';
import { frameLocked, mapLabels, movedPlane } from './sketchModifySketch';
import { isEndless, makeEndless } from './sketchInfinite';
import { pathOf } from './sketchPathModel';
import { buildBelt, makePath, pathLength, removePath } from './sketchPaths';
import { slotAmong } from './sketchSlotParams';
import { CURVE_NOUN } from './sketchCurves';

const sk = () => useSketcher.getState();
const say = (message: string | null) => useSketcher.setState({ message });
const curvesSelected = () => sk().selection.filter((x) => x.type === 'curve').map((x) => x.id).filter((id) => !!curveOf(sk().geometry, id));
const asCurves = (ids: string[]): Selected[] => ids.map((id) => ({ type: 'curve', id }));

/** Opens a tool's form in the left panel (as the toolbar does). */
export function openForm(id: string): void {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id })), 0);
    }
}

// ---- Select chain, reverse endpoint tangent, infinite length ---------------------------------------------------

/** Select Chain: the selected entities' chains (construction too) become the selection. */
export function selectChainSelected(): string | null {
    const ids = curvesSelected();
    if (!ids.length) {
        return 'Select an entity of the chain first (right-click it, Select chain).';
    }
    const chain = selectChains(sk().geometry, ids);
    useSketcher.setState({ selection: asCurves(chain), message: `Selected ${chain.length} entit${chain.length === 1 ? 'y' : 'ies'} of the chain.` });
    return null;
}

/** Reverse Endpoint Tangent on the selected arc(s). */
export function reverseTangentSelected(): string | null {
    const arcs = curvesSelected().filter((id) => curveOf(sk().geometry, id)?.kind === 'arc');
    if (!arcs.length) {
        return 'Select an arc first.';
    }
    let g = sk().geometry;
    for (const id of arcs) {
        const r = reverseEndpointTangent(g, id);
        if ('error' in r) {
            return r.error;
        }
        g = r;
    }
    return commitGeometry(g) ? null : sk().message ?? 'The arc cannot flip there.';
}

/** Line Properties > Infinite length on the selected line(s). */
export function makeEndlessSelected(): string | null {
    const lines = curvesSelected().filter((id) => curveOf(sk().geometry, id)?.kind === 'line');
    if (!lines.length) {
        return 'Select a line first.';
    }
    let g = sk().geometry;
    for (const id of lines) {
        const r = makeEndless(g, id);
        if ('error' in r) {
            return r.error;
        }
        g = r;
    }
    return commitGeometry(g) ? null : sk().message ?? 'Not applied.';
}

// ---- Align grid / origin ---------------------------------------------------------------------------------------

/** Align Grid/Origin: the origin and axes go where the options say, the sketch with them or staying put. */
export function applyAlignGrid(o: AlignOptions): string | null {
    const s = sk();
    const locked = frameLocked(s.plane);
    if (locked) {
        return locked.replace('moving or turning it', 'moving its origin');
    }
    const f = alignFrame(s.geometry, o);
    if ('error' in f) {
        return f.error;
    }
    if (Math.hypot(f.at[0], f.at[1]) < 1e-12 && Math.abs(f.angle) < 1e-12) {
        return 'The origin and axes are there already.';
    }
    const plane = movedPlane(s.plane, s.offset, s.context, f.at, [0, 0], (f.angle * 180) / Math.PI);
    if (o.mode === 'all') {
        // The entities keep their coordinates: the sketch moves with its origin (one undo step, as Modify Sketch).
        recordFrame(s.geometry, { plane: s.plane, offset: s.offset });
        useSketcher.setState({
            plane, offset: 0, look: s.look + 1, fitToSketch: true, message: 'Moved the sketch with its origin.',
            geometry: { ...s.geometry }, undo: [...s.undo.slice(-80), s.geometry], redo: [],
        });
        return null;
    }
    const next = relocatedGeometry(s.geometry, f.at, f.angle);
    if ('error' in next) {
        return next.error;
    }
    if (!commitGeometry(next)) {
        return sk().message ?? 'The sketch does not solve in the new frame.';
    }
    const t = sk();
    // The plane moves in the same undo step.
    recordFrame(t.undo[t.undo.length - 1], { plane: s.plane, offset: s.offset });
    useSketcher.setState({
        plane, offset: 0, look: t.look + 1, fitToSketch: true, labels: mapLabels(t.labels, toFrame(f.at, f.angle)),
        message: 'Moved the origin and axes; the sketch stays where it was.',
    });
    return null;
}

// ---- Paths -----------------------------------------------------------------------------------------------------

/**
 * Make Path, or the path's curves changed (`id`): with its path length dimension (driving or not) as asked.
 * Returns the path id, or an error.
 */
export function applyPath(curves: string[], id: string | null, length: { show: boolean; driving: boolean; value?: number }): { id: string } | { error: string } {
    const s = sk();
    const made = makePath(s.geometry, curves, id ?? undefined);
    if ('error' in made) {
        return made;
    }
    let g = made.g;
    const path = g.paths!.find((p) => p.id === made.id)!;
    // Its path length dimension: the one over exactly its curves.
    const same = (list: string[]) => list.length === path.curves.length && list.every((c) => path.curves.includes(c));
    const old = g.constraints.find((k) => k.kind === 'pathLength' && (same(k.curves) || (id && s.geometry.paths?.find((p) => p.id === id)?.curves.join() === k.curves.join())));
    g = { ...g, constraints: g.constraints.filter((k) => k !== old) };
    if (length.show) {
        const now = pathLength(g, path);
        const value = length.driving && length.value !== undefined ? length.value : now;
        if (!(value > 0)) {
            return { error: 'The path length must be above zero.' };
        }
        g = addConstraint(g, { kind: 'pathLength', curves: [...path.curves], value, ...(length.driving ? {} : { driven: true }), ...(old && 'at' in old && old.at ? { at: old.at } : {}) }).g;
    }
    if (!commitGeometry(g)) {
        return { error: sk().message ?? 'The path does not solve.' };
    }
    useSketcher.setState({ selection: asCurves(path.curves) });
    return { id: made.id };
}

export function deletePath(id: string): string | null {
    return commitGeometry(removePath(sk().geometry, id)) ? null : sk().message;
}

/** Belt/Chain: the belt built (or built again, `id`) round its pulleys. */
export function applyBelt(belt: SketchBelt, id: string | null): { id: string } | { error: string } {
    const r = buildBelt(sk().geometry, belt, id ?? undefined);
    if ('error' in r) {
        return r;
    }
    if (!commitGeometry(r.g)) {
        return { error: sk().message ?? 'The belt does not solve.' };
    }
    const path = sk().geometry.paths?.find((p) => p.id === r.id);
    useSketcher.setState({ selection: asCurves(path?.curves ?? []), message: belt.length !== undefined ? 'Belt made; its length drives the layout.' : 'Belt made.' });
    return { id: r.id };
}

/** Which form a curve's click opens beyond the curve forms: a belt's, a path's or a slot's. */
export function formForCurve(g: SketchGeometry, id: string): string | null {
    const path = pathOf(g, id);
    if (path) {
        return path.belt ? 'sk-belt' : 'sk-pm-path';
    }
    return slotAmong(g, [id]) ? 'sk-pm-slot' : null;
}

// ---- Right-click entries -----------------------------------------------------------------------------------------

export interface DrawCommandActions {
    openTool(id: string): void;
}

/**
 * The open sketch's right-click entries of these commands for the selection: Select chain, Select other (one entity of
 * a path), Reverse endpoint tangent, Infinite length, Make path, path and belt properties.
 */
export function drawCommandEntries(g: SketchGeometry, picks: Pick[], a: DrawCommandActions): MenuEntry[] {
    const curves = picks.filter((p) => p.type === 'curve').map((p) => curveOf(g, p.id)).filter((c) => !!c);
    if (!curves.length) {
        return [];
    }
    const out: MenuEntry[] = [];
    const path = curves.length === picks.length ? pathOf(g, curves[0]!.id) : null;
    const onePath = path && curves.every((c) => path.curves.includes(c!.id));
    if (onePath) {
        out.push(
            { label: path.belt ? 'Edit belt' : 'Path properties', icon: path.belt ? 'belt' : 'make-path', onSelect: () => a.openTool(path.belt ? 'sk-belt' : 'sk-pm-path') },
            {
                label: 'Select other', icon: 'select', title: 'Selects one entity of the path',
                items: path.curves.map((id) => ({
                    label: `${CURVE_NOUN[curveOf(g, id)!.kind]} ${id}`, onSelect: () => useSketcher.setState({ selection: [{ type: 'curve', id }] }),
                })),
            },
        );
    } else {
        out.push({ label: 'Select chain', icon: 'select-chain', title: 'Selects the entities joined end to end with it, up to a branch', onSelect: () => a.openTool('sk-select-chain') });
        if (curves.every((c) => c!.kind === 'line' || c!.kind === 'arc')) {
            out.push({ label: 'Make path', icon: 'make-path', title: 'Makes the chain one path, for tangent relations that pass along it', onSelect: () => a.openTool('sk-make-path') });
        }
    }
    if (curves.length === 1 && curves[0]!.kind === 'arc') {
        out.push({ label: 'Reverse endpoint tangent', icon: 'reverse-tangent', title: 'The arc flips to the other side of its ends, still tangent there', onSelect: () => a.openTool('sk-reverse-tangent') });
    }
    if (curves.every((c) => c!.kind === 'line')) {
        const endless = curves.every((c) => isEndless(c));
        out.push(endless
            ? { label: 'Infinite length', checked: true, disabled: true, onSelect: () => undefined, title: 'An infinite line cannot be made finite: trim it instead.' }
            : { label: 'Infinite length', icon: 'infinite-line', title: 'The line runs on without end both ways', onSelect: () => a.openTool('sk-infinite-length') });
    }
    return out;
}

/** A message for the status line from an action's result. */
export function report(error: string | null): void {
    if (error) {
        say(error);
    }
}
