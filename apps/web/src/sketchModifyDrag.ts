// Modify Sketch in the view (SolidWorks: with Modify Sketch open, the left button drags the whole sketch, the right
// button turns it about the black origin, whose centre can be dragged away as the centre of rotation; pointing at the
// end of one of its arms or at its centre and right-clicking flips the sketch along that axis, or both). While the
// pointer is down the sketch stays where it is and a ghost shows it moved; on release it moves (one undo step).

import { create } from 'zustand';
import type { SketchGeometry } from '@jarvis/core';
import { ORIGIN } from './solver';
import { geometryEntities } from './sketchGeometry';
import { dist, type NewEntity, type Pt } from './sketchMath';
import { useSketcher } from './sketcher';
import { flipWholeSketch, moveSketchFrame } from './sketchMoreTools';

/** The black origin's arms, in pixels (the pick distance is 10 px). */
export const ARM_PX = 46;

export type FlipAbout = 'x' | 'y' | 'both';

interface Drag {
    kind: 'move' | 'rotate' | 'centre' | 'flip';
    from: Pt;
    now: Pt;
    /** Rotate: the angle turned so far (degrees, counter-clockwise), unwrapped past half turns. */
    angle: number;
    /** The pick distance at the press (mm), for telling a click from a drag. */
    slop: number;
    moved: boolean;
    flip?: FlipAbout;
}

interface ModifyDragState {
    /** The Modify Sketch form is open. */
    open: boolean;
    /** The centre of rotation, in sketch coordinates. */
    centre: Pt;
    drag: Drag | null;
}

export const useModifyDrag = create<ModifyDragState>(() => ({ open: false, centre: [0, 0], drag: null }));

const md = () => useModifyDrag.getState();

export function startModifyDrag(): void {
    useModifyDrag.setState({ open: true, centre: [0, 0], drag: null });
}

export function stopModifyDrag(): void {
    useModifyDrag.setState({ open: false, drag: null });
}

export function setRotationCentre(centre: Pt): void {
    useModifyDrag.setState({ centre });
}

/** Which flip symbol of the black origin (at the sketch origin, arms `arm` mm long) is at `p`, if any. */
export function flipAt(p: Pt, arm: number, tolerance: number): FlipAbout | null {
    if (dist(p, [arm, 0]) <= tolerance) {
        return 'x';
    }
    if (dist(p, [0, arm]) <= tolerance) {
        return 'y';
    }
    return dist(p, [0, 0]) <= tolerance ? 'both' : null;
}

/** Whole degrees for a turn dragged in the view. */
export const draggedAngle = (angle: number): number => Math.round(angle) + 0;

/** The angle at `centre` from `a` to `b`, in degrees (-180 to 180). */
function turn(centre: Pt, a: Pt, b: Pt): number {
    const t = Math.atan2(b[1] - centre[1], b[0] - centre[0]) - Math.atan2(a[1] - centre[1], a[0] - centre[0]);
    return (Math.atan2(Math.sin(t), Math.cos(t)) * 180) / Math.PI;
}

/** The point moved by the drag: translated, or turned about the centre. */
export function dragMap(drag: Pick<Drag, 'kind' | 'from' | 'now' | 'angle'>, centre: Pt): (p: Pt) => Pt {
    if (drag.kind === 'move') {
        const by: Pt = [drag.now[0] - drag.from[0], drag.now[1] - drag.from[1]];
        return (p) => [p[0] + by[0], p[1] + by[1]];
    }
    if (drag.kind === 'rotate') {
        const a = (draggedAngle(drag.angle) * Math.PI) / 180;
        const [c, s] = [Math.cos(a), Math.sin(a)];
        return (p) => {
            const [x, y] = [p[0] - centre[0], p[1] - centre[1]];
            return [centre[0] + c * x - s * y, centre[1] + s * x + c * y];
        };
    }
    return (p) => p;
}

/** The sketch's curves moved rigidly by `f`, as ghost entities. */
export function movedEntities(g: SketchGeometry, f: (p: Pt) => Pt): NewEntity[] {
    const moved: SketchGeometry = {
        ...g,
        points: g.points.map((p) => {
            if (p.id === ORIGIN) {
                return p;
            }
            const [u, v] = f([p.u, p.v]);
            return { ...p, u, v };
        }),
    };
    return geometryEntities(moved).map(({ id: _id, construction: _c, ...e }) => e as NewEntity);
}

/**
 * A press in the view with Modify Sketch open: left drags the sketch (or the centre of rotation, when pressed on it);
 * right turns it about the centre, or flips it when pressed on a flip symbol. True when the press is taken.
 */
export function modifyDown(button: number, p: Pt, tolerance: number): boolean {
    const s = useSketcher.getState();
    if (!md().open || !s.active || s.stage !== 'draw' || (button !== 0 && button !== 2)) {
        return false;
    }
    const arm = (ARM_PX / 10) * tolerance;
    const centre = md().centre;
    const flip = button === 2 ? flipAt(p, arm, tolerance) : null;
    const kind: Drag['kind'] = button === 0 ? (dist(p, centre) <= tolerance ? 'centre' : 'move') : flip ? 'flip' : 'rotate';
    useModifyDrag.setState({ drag: { kind, from: p, now: p, angle: 0, slop: tolerance * 0.4, moved: false, ...(flip ? { flip } : {}) } });
    return true;
}

/** The pointer moved to `p` with a press taken. */
export function modifyMove(p: Pt): void {
    const drag = md().drag;
    if (!drag || (!drag.moved && dist(drag.from, p) <= drag.slop)) {
        return;
    }
    const centre = md().centre;
    if (drag.kind === 'centre') {
        useModifyDrag.setState({ centre: p, drag: { ...drag, now: p, moved: true } });
        return;
    }
    // Rotate: the angle follows the pointer round the centre, in whole degrees (a slow drag steps one degree at a
    // time, a fast one ten or more); the form's Rotate takes any value.
    const angle = drag.kind === 'rotate' ? drag.angle + turn(centre, drag.now, p) : 0;
    useModifyDrag.setState({ drag: { ...drag, now: p, angle, moved: true } });
}

/** The pointer was released: the sketch moves, turns or flips; a press without a drag does nothing (a click). */
export function modifyUp(): string | null {
    const drag = md().drag;
    useModifyDrag.setState({ drag: null });
    if (!drag) {
        return null;
    }
    if (drag.kind === 'flip') {
        return drag.moved ? null : flipWholeSketch(drag.flip!);
    }
    if (!drag.moved || drag.kind === 'centre') {
        return null;
    }
    const result = drag.kind === 'move'
        ? moveSketchFrame([drag.now[0] - drag.from[0], drag.now[1] - drag.from[1]], [0, 0], 0, true)
        : moveSketchFrame([0, 0], md().centre, draggedAngle(drag.angle), true);
    if (result) {
        useSketcher.setState({ message: result });
    }
    return result;
}
