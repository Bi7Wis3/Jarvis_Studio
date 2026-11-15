// The open sketch's own geometry: its curves coloured by state, the helper polygons of style splines and conics, its
// points and the origin, the sketch axes and line midpoints when picked. Drawn in batches (sketchBatch.tsx) and kept
// apart from what follows the pointer, so a pointer move that changes none of this redraws none of it.

import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AXIS_U, AXIS_V, isDimension } from './solver';
import { broughtIn, constraintRefs, geometryEntities } from './sketchGeometry';
import { definedEntities } from './sketchStatus';
import { curveHelpers } from './sketchConics';
import { midMarkers } from './sketchDimDraw';
import { blockLook, ownedCurves, ownedPoints } from './sketchItems';
import { entityPoints, type Entity, type NewEntity, type Pt } from './sketchMath';
import { isEditTool, useSketcher } from './sketcher';
import { LineBatch, PointBatch, type BatchLine, type BatchPoint } from './sketchBatch';

export const FREE = '#5aa9ff';
export const FIXED = '#f2f5f9';
export const CONSTRUCTION = '#ffb347';
export const SELECTED = '#c48bff';
export const PICKED = '#ffd166';
export const CONFLICT = '#ff5d6c';
/** Over defined: geometry a redundant relation refers to (SolidWorks shows it yellow). */
export const OVER = '#f0e14a';
const HELPER = '#8a96a8';
const ORIGIN_DOT = '#ffd166';

const at3 = ([u, v]: Pt): [number, number, number] => [u, v, 0];

/** The polyline of an entity, as EntityLine draws it. */
export function entityLine(entity: NewEntity, color: string, width: number, dashed = false): BatchLine {
    return { points: entityPoints(entity as Entity).map(at3), color, width, dashed, dashSize: 2, gapSize: 1.5, renderOrder: 20 };
}

/** A sketch point as the DOM dots drew it: picked and selected ones half as big again, locked ones square. */
function dot(p: Pt, state: string, done: boolean): BatchPoint {
    if (state === 'picked') {
        return { at: at3(p), color: PICKED, size: 7.5 };
    }
    if (state === 'selected') {
        return { at: at3(p), color: SELECTED, size: 7.5 };
    }
    if (state === 'fixed') {
        return { at: at3(p), color: FIXED, size: 7, square: true };
    }
    return { at: at3(p), color: done ? FIXED : FREE, size: 5 };
}

export const SketchShapes = memo(function SketchShapes() {
    const { g, selection, picks, hoverId, hovered, highlight, dof, conflicting, redundant } = useSketcher(useShallow((s) => {
        const picking = s.tool === 'dimension' || s.tool.startsWith('c:') || isEditTool(s.tool);
        return {
            g: s.geometry, selection: s.selection, picks: s.dimDrag?.picks ?? s.picks, hoverId: s.hover?.id ?? null,
            hovered: picking && s.hover ? s.hover.id : null, highlight: s.highlight, dof: s.dof, conflicting: s.conflicting, redundant: s.redundant,
        };
    }));
    const entities = useMemo(() => geometryEntities(g), [g]);
    // Style spline control polygons, spline tangency handles and conic tangent lines.
    // Text, equation curves and blocks: their points and control polygons are not drawn (they are fixed, built by the item).
    const owned = useMemo(() => ({ points: ownedPoints(g), curves: ownedCurves(g) }), [g]);
    // Hidden block instances are not drawn; a block's own colour replaces the defined/under-defined colour.
    const blocksLook = useMemo(() => blockLook(g), [g]);
    // Curves copied in from the model or another sketch: their control polygon shows only while they are selected or
    // pointed at, and their control vertices never (they are locked; see broughtIn).
    const brought = broughtIn(g);
    const open = new Set([...selection.map((s) => s.id), ...picks.map((p) => p.id), ...highlight, ...(hoverId ? [hoverId] : [])]);
    const quiet = [...brought.curves].filter((id) => !open.has(id)).join(' ');
    const helpers = useMemo(() => {
        const skip = new Set([...owned.curves, ...quiet.split(' ')]);
        return curveHelpers({ ...g, curves: g.curves.filter((c) => !skip.has(c.id)) });
    }, [g, owned, quiet]);
    // Each entity's own state: probed again only when the relations change, not while something is dragged.
    // Driven dimensions change value as the geometry moves without changing what is defined.
    const structure = useMemo(() => JSON.stringify([g.curves.map(({ id, kind }) => [id, kind]),
        g.constraints.map((c) => (isDimension(c) && c.driven ? { ...c, value: 0 } : c)), g.points.map((p) => [p.id, p.fixed])]), [g]);
    const defined = useMemo(() => (dof > 0 ? definedEntities(g) : null), [structure, dof > 0]);
    const drawn = useMemo(() => {
        const isDefined = (id: string) => dof === 0 || !!defined?.has(id);
        const overRefs = new Set(g.constraints.filter((c) => redundant.includes(c.id)).flatMap((c) => constraintRefs(c)));
        const selected = new Set(selection.map((s) => s.id));
        const picked = new Set(picks.map((p) => p.id));
        // Lit from the relations or repair list.
        const lit = new Set(highlight);
        const conflictRefs = new Set(g.constraints.filter((c) => conflicting.includes(c.id)).flatMap((c) => Object.values(c).filter((v) => typeof v === 'string')));
        const lines: BatchLine[] = entities.filter((e) => !blocksLook.hidden.has(e.id)).map((e) => {
            const on = picked.has(e.id) || hovered === e.id || lit.has(e.id);
            const color = lit.has(e.id) ? PICKED : selected.has(e.id) ? SELECTED : on ? PICKED : conflictRefs.has(e.id) ? CONFLICT
                : overRefs.has(e.id) ? OVER : blocksLook.colour.get(e.id) ?? (e.construction ? CONSTRUCTION : isDefined(e.id) ? FIXED : FREE);
            return entityLine(e, color, selected.has(e.id) || on ? 3.8 : e.construction ? 1.8 : 2.8, !!e.construction);
        });
        lines.push(...helpers.map((e) => entityLine(e, HELPER, 1, true)));
        for (const axis of [AXIS_U, AXIS_V]) {
            if (picked.has(axis) || hovered === axis || lit.has(axis)) {
                const ends: [number, number, number][] = axis === AXIS_U ? [[-1e4, 0, 0], [1e4, 0, 0]] : [[0, -1e4, 0], [0, 1e4, 0]];
                lines.push({ points: ends, color: PICKED, width: 2, renderOrder: 0 });
            }
        }
        // The origin first: a sketch point on it is drawn over it.
        const originPicked = picked.has('origin') || hovered === 'origin' || lit.has('origin');
        const points: BatchPoint[] = [{ at: [0, 0, 0], color: ORIGIN_DOT, size: originPicked ? 10.5 : 7, square: true }];
        for (const p of g.points.filter((q) => !owned.points.has(q.id) && !brought.handles.has(q.id) && !blocksLook.hidden.has(q.id))) {
            const state = lit.has(p.id) ? 'picked' : selected.has(p.id) ? 'selected' : picked.has(p.id) || hovered === p.id ? 'picked' : p.fixed ? 'fixed' : '';
            points.push(dot([p.u, p.v], state, isDefined(p.id)));
        }
        // Line midpoints picked or hovered by the dimension tool.
        points.push(...midMarkers(g, [...picked, ...(hovered ? [hovered] : [])]).map((m) => dot(m, 'picked', false)));
        return { lines, points };
    }, [g, entities, helpers, owned, blocksLook, brought, defined, dof, selection, picks, hovered, highlight, conflicting, redundant]);
    return (
        <>
            <LineBatch lines={drawn.lines} />
            <PointBatch points={drawn.points} />
        </>
    );
});
