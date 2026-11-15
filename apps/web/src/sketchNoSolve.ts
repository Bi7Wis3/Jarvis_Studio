// No Solve Move (SolidWorks: Tools > Sketch Settings > No Solve Move): dragging moves the entities without solving
// the sketch. When that breaks dimensions or relations to the rest, a question follows: Yes deletes them and keeps the
// move, No leaves them and copies the dragged entities to the new place instead.

import { create } from 'zustand';
import type { SketchGeometry } from '@jarvis/core';
import { commitGeometry, useSketcher } from './sketcher';
import { unmetConstraints } from './sketchCheck';
import { curvePointIds } from './sketchCurves';
import { transformEntities } from './sketchEdit';
import type { Pt } from './sketchMath';

interface Pending {
    /** The sketch before the move, and as moved. */
    from: SketchGeometry;
    moved: SketchGeometry;
    /** The relations and dimensions the move breaks. */
    broken: string[];
    /** What was dragged (curves, or points), and by how much. */
    ids: string[];
    by: Pt;
    /** Where the question is shown. */
    at: Pt;
}

export const useNoSolve = create<{ pending: Pending | null }>(() => ({ pending: null }));

const get = () => useSketcher.getState();

/** The points that move: the dragged ones, with the rest of each arc whose centre or end moves (an arc stays an arc). */
function movingPoints(g: SketchGeometry, dragged: string[]): Set<string> {
    const out = new Set(dragged);
    for (const c of g.curves) {
        if (c.kind === 'arc' && [c.center, c.start, c.end].some((id) => out.has(id))) {
            [c.center, c.start, c.end].forEach((id) => out.add(id));
        }
    }
    return out;
}

/** The pointer moved while dragging with No solve move on: the dragged points follow it, nothing is solved. */
export function noSolveDrag(raw: Pt): void {
    const s = get();
    const drag = s.drag;
    const start = s.dragFrom ?? s.geometry;
    if (!drag) {
        return;
    }
    const by: Pt = [raw[0] - drag.grab[0], raw[1] - drag.grab[1]];
    const moving = movingPoints(s.geometry, drag.points.map((p) => p.id));
    // Each moving point from where it was when the drag began.
    const was = new Map<string, Pt>(start.points.map((p) => [p.id, [p.u, p.v]]));
    drag.points.forEach((p) => was.set(p.id, p.from));
    const geometry: SketchGeometry = {
        ...s.geometry,
        points: s.geometry.points.map((p) => {
            const at = moving.has(p.id) && !p.fixed ? was.get(p.id) : undefined;
            return at ? { ...p, u: at[0] + by[0], v: at[1] + by[1] } : p;
        }),
    };
    useSketcher.setState({ geometry, cursor: raw, ...(drag.moved ? {} : { drag: { ...drag, moved: true } }) });
}

/** The drag ended with No solve move on: kept as it is, or the question when it breaks relations. True when handled. */
export function noSolveDrop(): boolean {
    const s = get();
    const drag = s.drag;
    const from = s.dragFrom;
    if (!drag || !from) {
        return false;
    }
    if (!drag.moved || from === s.geometry) {
        useSketcher.setState({ drag: null, dragFrom: null, geometry: from });
        return true;
    }
    const arcs = new Set(from.curves.map((c) => c.id));
    const before = new Set(unmetConstraints(from));
    const broken = unmetConstraints(s.geometry).filter((id) => !before.has(id) && !arcs.has(id));
    if (!broken.length) {
        useSketcher.setState({ drag: null, dragFrom: null, undo: [...s.undo.slice(-80), from], redo: [] });
        return true;
    }
    const moving = movingPoints(from, drag.points.map((p) => p.id));
    const curves = from.curves.filter((c) => curvePointIds(c).every((id) => moving.has(id))).map((c) => c.id);
    const first = from.points.find((p) => p.id === drag.points[0].id);
    const now = s.geometry.points.find((p) => p.id === drag.points[0].id);
    const by: Pt = first && now ? [now.u - first.u, now.v - first.v] : [0, 0];
    useNoSolve.setState({ pending: { from, moved: s.geometry, broken, ids: curves.length ? curves : [...moving], by, at: s.cursor ?? [0, 0] } });
    // Until it is answered the sketch stays as it was; the move shows as a preview.
    useSketcher.setState({ drag: null, dragFrom: null, geometry: from });
    return true;
}

/**
 * The answer: 'delete' (Yes: the broken relations and dimensions go, the move stays), 'copy' (No: they stay, the
 * dragged entities are copied to the new place), or 'cancel'.
 */
export function answerNoSolve(answer: 'delete' | 'copy' | 'cancel'): string | null {
    const pending = useNoSolve.getState().pending;
    useNoSolve.setState({ pending: null });
    if (!pending || answer === 'cancel' || get().geometry !== pending.from) {
        return null;
    }
    if (answer === 'delete') {
        const gone = new Set(pending.broken);
        const next = { ...pending.moved, constraints: pending.moved.constraints.filter((c) => !gone.has(c.id)) };
        return commitGeometry(next) ? null : get().message ?? 'Not applied.';
    }
    const r = transformEntities(pending.from, pending.ids, { kind: 'move', by: pending.by }, true);
    if ('error' in r) {
        return r.error;
    }
    return commitGeometry(r.g) ? null : get().message ?? 'Not applied.';
}
