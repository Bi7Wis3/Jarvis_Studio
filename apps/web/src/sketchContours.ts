// Shaded Sketch Contours (SolidWorks: with the setting on, closed contours and the sub-contours they make are
// shaded; a shaded area can be dragged, which moves the whole sketch entity it belongs to; Alt + click on one shows
// Extruded Boss/Base on the context toolbar, which extrudes that area). The fills themselves are drawn by
// sketchContoursDrawing.tsx.

import { create } from 'zustand';
import type { SketchGeometry, SketchRegion } from '@jarvis/core';
import { ORIGIN, pointOf } from './solver';
import { pickAt } from './sketchGeometry';
import { curveEndIds } from './sketchCurves';
import { curvePoints } from './sketchEdit';
import { useStudio } from './state';
import { area, profilePoints, type Pt } from './sketchMath';
import { regionAt, regionsOf, useRegionPick } from './regionPick';
import { useSketcher } from './sketcher';
import { sketchToggle } from './sketchToggles';
import { useToolSession, presetToolValues } from './toolSession';
import { useModifyDrag } from './sketchModifyDrag';

/** The connected sketch entities (curves joined at their ends, or by coincident relations), not construction. */
export function connectedSets(g: SketchGeometry): string[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
        while (parent.has(x) && parent.get(x) !== x) {
            x = parent.get(x)!;
        }
        return x;
    };
    const join = (a: string, b: string) => {
        const [ra, rb] = [find(a), find(b)];
        if (ra !== rb) {
            parent.set(rb, ra);
        }
    };
    const curves = g.curves.filter((c) => !c.construction);
    for (const c of curves) {
        for (const p of curveEndIds(c)) {
            join(`c:${c.id}`, `p:${p}`);
        }
    }
    for (const k of g.constraints) {
        if (k.kind === 'coincident' && !k.suppressed) {
            join(`p:${k.a}`, `p:${k.b}`);
        }
    }
    const sets = new Map<string, string[]>();
    for (const c of curves) {
        const root = find(`c:${c.id}`);
        sets.set(root, [...(sets.get(root) ?? []), c.id]);
    }
    return [...sets.values()];
}

/**
 * The sketch entity whose shaded area contains `p`: the curves of the innermost connected set of curves with a
 * closed area around `p`, or null when `p` is in no closed area.
 */
export function contourAt(g: SketchGeometry, p: Pt): string[] | null {
    let best: { ids: string[]; size: number } | null = null;
    for (const ids of connectedSets(g)) {
        const own = new Set(ids);
        const part: SketchGeometry = { ...g, curves: g.curves.filter((c) => own.has(c.id)) };
        const regions = regionsOf(part);
        const i = regionAt(regions, p);
        if (i < 0) {
            continue;
        }
        const size = Math.abs(area(profilePoints(regions[i].loops[0])));
        if (!best || size < best.size) {
            best = { ids, size };
        }
    }
    return best?.ids ?? null;
}

/** The regions the fills show: every closed area of the sketch (contours and the sub-contours they make). */
export function shadedRegions(g: SketchGeometry): SketchRegion[] {
    return regionsOf(g);
}

/**
 * A press of the select tool at `p` (`tolerance`: the pick distance) on a shaded area, away from any entity: drags the
 * sketch entity it belongs to. True when taken.
 */
export function contourDown(p: Pt, tolerance: number, alt = false): boolean {
    const s = useSketcher.getState();
    if (!sketchToggle('shadedContours') || alt || !s.active || s.stage !== 'draw' || s.tool !== 'select' || s.finishing
        || useModifyDrag.getState().open || pickAt(s.geometry, p, tolerance)) {
        return false;
    }
    const ids = contourAt(s.geometry, p);
    if (!ids) {
        return false;
    }
    const curves = new Set(ids);
    const points = [...new Set(s.geometry.curves.filter((c) => curves.has(c.id)).flatMap(curvePoints))].flatMap((id) => {
        const q = pointOf(s.geometry, id);
        return q && !q.fixed && id !== ORIGIN ? [{ id, from: [q.u, q.v] as Pt }] : [];
    });
    if (!points.length) {
        return false;
    }
    // The sketcher's own drag: it solves as the pointer moves and makes the whole drag one undo step.
    useSketcher.setState({ drag: { points, grab: p, slop: tolerance * 0.4 }, dragFrom: s.geometry, selection: ids.map((id) => ({ type: 'curve' as const, id })) });
    return true;
}

// ---- Alt + click: the context toolbar ------------------------------------------------------------------------

interface ContextBarState {
    /** Where the shaded area was Alt-clicked (sketch coordinates): the bar shows there, and it picks the area. */
    at: Pt | null;
}

export const useContourBar = create<ContextBarState>(() => ({ at: null }));

/** Alt + click at `p`: on a shaded area the context toolbar comes up there. True when taken. */
export function contourAltClick(p: Pt): boolean {
    const s = useSketcher.getState();
    if (!sketchToggle('shadedContours') || !s.active || s.stage !== 'draw' || s.finishing || regionAt(shadedRegions(s.geometry), p) < 0) {
        return false;
    }
    useContourBar.setState({ at: p });
    return true;
}

export function closeContourBar(): void {
    useContourBar.setState({ at: null });
}

/** Once the form `toolId` has opened, picks the area at `at` in it (its region session has started by then). */
function pickWhenOpen(toolId: string, at: Pt, then?: () => void): void {
    const stop = useToolSession.subscribe((t) => {
        if (t.toolId === toolId) {
            stop();
            clearTimeout(timer);
            useRegionPick.setState({ picked: [[at[0], at[1]]] });
            then?.();
        }
    });
    const timer = setTimeout(stop, 15000);
}

const openTool = (id: string) => {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id }));
    }
};

/**
 * Extruded Boss/Base on the context toolbar: extrudes the area at `at`. A new sketch (or a feature's own sketch) opens
 * the leaving panel as Extrude with that area picked; a sketch step is saved first, then Extrude opens on it with the
 * area picked.
 */
export function extrudeContour(at: Pt): void {
    closeContourBar();
    const s = useSketcher.getState();
    const edit = s.edit;
    const step = edit?.featureId ? edit.featureId : null;
    const part = edit?.partId ?? s.partId;
    const owner = useStudio.getState().history?.parts.find((x) => x.id === part);
    const editingStep = !!step && owner?.features?.find((f) => f.id === step)?.op === 'sketch';
    if (!editingStep) {
        const intent = s.intent;
        if (!edit && intent === 'sketch') {
            // The leaving panel offers the feature only when the sketch was started for one.
            useSketcher.setState({ intent: 'extrude' });
            const restore = useToolSession.subscribe((t, prev) => {
                if (prev.toolId === 'sk-finish' && t.toolId !== 'sk-finish') {
                    restore();
                    if (useSketcher.getState().active) {
                        useSketcher.setState({ intent });
                    }
                }
            });
        }
        pickWhenOpen('sk-finish', at);
        openTool('sk-finish');
        return;
    }
    // Leaving a sketch step saves it as it is; Extrude then opens on it.
    const stop = useSketcher.subscribe((now) => {
        if (!now.active) {
            stop();
            presetToolValues('extrude', { sketch: step! });
            pickWhenOpen('extrude', at);
            setTimeout(() => openTool('extrude'), 0);
        }
    });
    setTimeout(stop, 15000);
    openTool('sk-finish');
}
