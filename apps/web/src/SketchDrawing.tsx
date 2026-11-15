// The constrained sketch on its plane: curves coloured by constraint state, points, constraint glyphs,
// driving dimensions with leaders and editable values, the entity in progress, and pointer input.

import { modelPlaneClick } from './sketchModelPick';
import { useSketchModel } from './sketchModel';
import { memo, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useShallow } from 'zustand/react/shallow';
import { DoubleSide, Plane, Raycaster, Vector2, Vector3, type Camera, type Group, type PerspectiveCamera } from 'three';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { CameraControlsImpl } from '@react-three/drei';
import { AXIS_U, AXIS_V, curveOf, isDimension, measure, pointOf } from './solver';
import { arcMiddle, broughtIn, constraintRefs, geometryEntities, rectCorners3, tangentArcThrough, tangentAt } from './sketchGeometry';
import { pixelSizeAt, rayFromCamera } from './viewProjection';
import { angleText, shownText } from './numberText';
import { drawPreview } from './sketchDrawVariants';
import { circleThrough, dist, entityPoints, regularPolygon, type Entity, type NewEntity, type Pt } from './sketchMath';
import { conicDraftEntity, conicDraftText, conicGuides, isConicTool } from './sketchConics';
import { moreDimensionLines, moreDimensionText } from './sketchDimDraw';


import {
    applyDimension, cancelDimension, dimensionAnchor, editDimension, endChain, isEditTool, moveLabel, openDimensionForm,
    selectConstraint, setDimText, sketchClick, sketchDown, sketchMove, sketchUp, useSketcher,
} from './sketcher';
import { useSketchMore } from './sketchMoreTools';
import { zonedPreview } from './sketchTangentZones';
import { MoreDrawing } from './sketchMoreDrawing';
import { ItemsDrawing } from './sketchItemsDrawing';
import { PathDrawing } from './sketchPathDrawing';
import { ModifyDragDrawing } from './sketchModifyDrawing';
import { Instant2dDrawing } from './sketchInstant2dDrawing';
import { viewPress } from './sketchViewPress';
import { contourAltClick } from './sketchContours';
import { pieceClick, pieceHover } from './sketchPieces';
import { PieceDrawing } from './sketchPiecesDrawing';
import { partFaceHit, rapidClick } from './sketchRapid';
import { DimExtrasDrawing, DrivenChoice } from './sketchDimExtrasDrawing';
import { smartDimension } from './sketchDimTools';
import { DimensionValue } from './sketchDimTolerance';
import { LineBatch, type BatchLine } from './sketchBatch';
import { CONFLICT, entityLine, OVER, SELECTED, SketchShapes } from './sketchShapes';
import { SplineOverlays } from './sketchSplineDrawing';
import { FullyDefineGhosts } from './sketchFullyDefineGhosts';

const DRIVEN = '#8d96a3';
const DRAFT = '#35e0ff';
const SNAP_PX = 10;
const CLICK_SLOP_PX = 4;
const ORIGIN_3D = new Vector3();

/** Screen position to sketch coordinates, mm per pixel there and the point in the scene; set by the Catcher while a sketch is open. */
let planePoint: (clientX: number, clientY: number) => { p: Pt; perPx: number; world: Vector3 } | null = () => null;

/** The point of the open sketch's plane under a screen position, in the scene (what the view turns about there). */
export const sketchPlaneAt = (clientX: number, clientY: number): Vector3 | null => planePoint(clientX, clientY)?.world ?? null;

/** A screen point in the open sketch and the pick distance there, as a click uses them (for the right-click menu). */
export function sketchPointAt(clientX: number, clientY: number): { p: Pt; tolerance: number } | null {
    const hit = planePoint(clientX, clientY);
    return hit ? { p: hit.p, tolerance: SNAP_PX * hit.perPx } : null;
}

export const v3 = ([u, v]: Pt, z = 0): [number, number, number] => [u, v, z];

function fmt(n: number): string {
    return shownText(n);
}

export function Label({ at, children, className = '' }: { at: Pt; children: ReactNode; className?: string }) {
    return (
        <Html position={v3(at)} center zIndexRange={[30, 0]} className={`sk-label ${className}`}>
            {children}
        </Html>
    );
}

export function EntityLine({ entity, color, dashed, width = 1.6 }: { entity: NewEntity; color: string; dashed?: boolean; width?: number }) {
    // A batch of one: its material outlives changes of the entity (see sketchBatch.tsx).
    const lines = useMemo(() => [entityLine(entity, color, width, !!dashed)], [JSON.stringify(entity), color, width, dashed]);
    return <LineBatch lines={lines} />;
}

/** What the entity in progress would be with the cursor as its next point (`sweep`: a centre arc's turn so far). */
function draftEntity(tool: string, draft: Pt[], cursor: Pt, sides: number, sweep: number): NewEntity | null {
    const [a, b] = draft;
    switch (tool) {
        case 'line':
        case 'centerline':
            return { kind: 'line', a: draft[draft.length - 1], b: cursor };
        case 'rect':
            return { kind: 'rect', a, b: cursor };
        case 'centerRect':
            return { kind: 'rect', a: [2 * a[0] - cursor[0], 2 * a[1] - cursor[1]], b: cursor };
        case 'centerArc': {
            if (draft.length === 1) {
                return { kind: 'line', a, b: cursor };
            }
            const r = dist(a, b);
            const from = Math.atan2(b[1] - a[1], b[0] - a[0]);
            const at = (t: number): Pt => [a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)];
            return Math.abs(sweep) < 1e-3 ? { kind: 'line', a, b } : { kind: 'arc', a: b, b: at(from + sweep), m: at(from + sweep / 2) };
        }
        case 'circle':
            return { kind: 'circle', c: a, r: dist(a, cursor) };
        case 'polygon':
            return dist(a, cursor) > 0 ? { kind: 'polygon', points: regularPolygon(a, cursor, sides) } : null;
        case 'arc':
            return draft.length === 1 ? { kind: 'line', a, b: cursor } : { kind: 'arc', a, b, m: cursor };
        case 'perimeterCircle': {
            const c = draft.length === 2 ? circleThrough(a, b, cursor) : null;
            return c ? { kind: 'circle', c: c.c, r: c.r } : { kind: 'line', a: draft[draft.length - 1], b: cursor };
        }
        case 'rect3': {
            const corners = draft.length === 2 ? rectCorners3(a, b, cursor) : null;
            return corners ? { kind: 'polygon', points: corners } : { kind: 'line', a: draft[draft.length - 1], b: cursor };
        }
        case 'slot': {
            if (draft.length === 1) {
                return { kind: 'line', a, b: cursor };
            }
            const length = dist(a, b);
            const r = length ? Math.abs((b[0] - a[0]) * (a[1] - cursor[1]) - (a[0] - cursor[0]) * (b[1] - a[1])) / length : 0;
            return { kind: 'slot', a, b, r: Math.max(r, 0.1) };
        }
        default:
            return isConicTool(tool) ? conicDraftEntity(tool, draft, cursor, sweep) : null;
    }
    return null;
}

/** A tangent arc from the end of the curve at `start` to the cursor. */
function tangentPreview(g: SketchGeometry, start: string | undefined, from: Pt, cursor: Pt): NewEntity | null {
    const t = start ? tangentAt(g, start) : null;
    const arc = t && tangentArcThrough(from, t.dir, cursor);
    if (!arc) {
        return { kind: 'line', a: from, b: cursor };
    }
    return arc.ccw ? { kind: 'arc', a: from, b: cursor, m: arc.m } : { kind: 'arc', a: cursor, b: from, m: arc.m };
}

/** Live size of the entity in progress. */
function draftText(e: NewEntity): string | null {
    switch (e.kind) {
        case 'line':
            return fmt(dist(e.a, e.b));
        case 'rect':
            return `${fmt(Math.abs(e.b[0] - e.a[0]))} × ${fmt(Math.abs(e.b[1] - e.a[1]))}`;
        case 'circle':
            return `Ø${fmt(e.r * 2)}`;
        case 'arc': {
            const c = circleThrough(e.a, e.m, e.b);
            return c ? `R${fmt(c.r)}` : null;
        }
        case 'slot':
            return `${fmt(dist(e.a, e.b))} · W${fmt(e.r * 2)}`;
        case 'polygon':
            return `${e.points.length} sides`;
        default:
            return null;
    }
}

// ---- Dimensions ---------------------------------------------------------------------------------------

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** Small arrowhead at `tip` pointing along `dir` (unit). */
function arrow(tip: Pt, dir: Pt, size: number): [number, number, number][][] {
    const back: Pt = [tip[0] - dir[0] * size, tip[1] - dir[1] * size];
    const n: Pt = [-dir[1] * size * 0.35, dir[0] * size * 0.35];
    return [[v3([back[0] + n[0], back[1] + n[1]]), v3(tip), v3([back[0] - n[0], back[1] - n[1]])]];
}

/** Leader, extension lines and arrows of a dimension, given where its label sits. */
function dimensionLines(g: SketchGeometry, c: SketchConstraint, at: Pt, size: number): [number, number, number][][] {
    const more = moreDimensionLines(g, c, at, size);
    if (more) {
        return more;
    }
    const linear = (a: Pt, b: Pt, axis?: 'u' | 'v'): [number, number, number][][] => {
        let p: Pt;
        let q: Pt;
        if (axis === 'u') {
            p = [a[0], at[1]];
            q = [b[0], at[1]];
        } else if (axis === 'v') {
            p = [at[0], a[1]];
            q = [at[0], b[1]];
        } else {
            const l = dist(a, b) || 1;
            const n: Pt = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
            const d = (at[0] - a[0]) * n[0] + (at[1] - a[1]) * n[1];
            p = [a[0] + n[0] * d, a[1] + n[1] * d];
            q = [b[0] + n[0] * d, b[1] + n[1] * d];
        }
        const l = dist(p, q) || 1;
        const dir: Pt = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
        return [[v3(a), v3(p)], [v3(b), v3(q)], [v3(p), v3(q)], ...arrow(q, dir, size), ...arrow(p, [-dir[0], -dir[1]], size)];
    };
    switch (c.kind) {
        case 'length': {
            const line = curveOf(g, c.line);
            return line?.kind === 'line' ? linear(P(g, line.a), P(g, line.b)) : [];
        }
        case 'distance': {
            const a = P(g, c.a);
            if (pointOf(g, c.b)) {
                return linear(a, P(g, c.b), c.axis);
            }
            // Point to line: the perpendicular foot.
            let foot: Pt;
            if (c.b === AXIS_U) {
                foot = [a[0], 0];
            } else if (c.b === AXIS_V) {
                foot = [0, a[1]];
            } else {
                const line = curveOf(g, c.b);
                if (line?.kind !== 'line') {
                    return [];
                }
                const p = P(g, line.a);
                const q = P(g, line.b);
                const l2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 || 1;
                const t = ((a[0] - p[0]) * (q[0] - p[0]) + (a[1] - p[1]) * (q[1] - p[1])) / l2;
                foot = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
            }
            return linear(a, foot);
        }
        case 'radius':
        case 'diameter': {
            const curve = curveOf(g, c.curve);
            if (!curve || (curve.kind !== 'circle' && curve.kind !== 'arc')) {
                return [];
            }
            const centre = P(g, curve.center);
            const r = curve.kind === 'circle' ? curve.radius : dist(centre, P(g, curve.start));
            const d = dist(centre, at) || 1;
            const dir: Pt = [(at[0] - centre[0]) / d, (at[1] - centre[1]) / d];
            const edge: Pt = [centre[0] + dir[0] * r, centre[1] + dir[1] * r];
            const start: Pt = c.kind === 'diameter' ? [centre[0] - dir[0] * r, centre[1] - dir[1] * r] : centre;
            const out: [number, number, number][][] = [[v3(start), v3(d > r ? at : edge)], ...arrow(edge, dir, size)];
            if (c.kind === 'diameter') {
                out.push(...arrow(start, [-dir[0], -dir[1]], size));
            }
            return out;
        }
        case 'angle': {
            const ends = (id: string): [Pt, Pt] | null => {
                if (id === AXIS_U) {
                    return [[0, 0], [1, 0]];
                }
                if (id === AXIS_V) {
                    return [[0, 0], [0, 1]];
                }
                const line = curveOf(g, id);
                return line?.kind === 'line' ? [P(g, line.a), P(g, line.b)] : null;
            };
            const la = ends(c.a);
            const lb = ends(c.b);
            if (!la || !lb) {
                return [];
            }
            const [p1, p2] = la;
            const [p3, p4] = lb;
            const den = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
            if (Math.abs(den) < 1e-9) {
                return [];
            }
            const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / den;
            const o: Pt = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
            const radius = Math.max(dist(o, at), size * 2);
            const toward = (p: Pt, q: Pt): number => {
                const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
                const label = Math.atan2(at[1] - o[1], at[0] - o[0]);
                // Pick the line direction on the label's side.
                return Math.cos(a - label) >= 0 ? a : a + Math.PI;
            };
            // A dimension that knows which way along each line it measures draws that angle; older ones the label's side.
            const along = (p: Pt, q: Pt, reverse: boolean) => Math.atan2(q[1] - p[1], q[0] - p[0]) + (reverse ? Math.PI : 0);
            const known = c.reverseA !== undefined || c.reverseB !== undefined;
            const a0 = known ? along(p1, p2, !!c.reverseA) : toward(p1, p2);
            let a1 = known ? along(p3, p4, !!c.reverseB) : toward(p3, p4);
            while (a1 - a0 > Math.PI) {
                a1 -= 2 * Math.PI;
            }
            while (a0 - a1 > Math.PI) {
                a1 += 2 * Math.PI;
            }
            const arc: [number, number, number][] = [];
            for (let i = 0; i <= 24; i++) {
                const a = a0 + ((a1 - a0) * i) / 24;
                arc.push(v3([o[0] + radius * Math.cos(a), o[1] + radius * Math.sin(a)]));
            }
            const ray = (a: number): [number, number, number][] => [v3(o), v3([o[0] + (radius + size) * Math.cos(a), o[1] + (radius + size) * Math.sin(a)])];
            return [arc, ray(a0), ray(a1)];
        }
        default:
            return [];
    }
}

function dimensionText(c: Extract<SketchConstraint, { value: number }>): string {
    const more = moreDimensionText(c);
    if (more) {
        return more;
    }
    switch (c.kind) {
        case 'angle':
            return angleText(c.value);
        case 'diameter':
            return `Ø${fmt(c.value)}`;
        case 'radius':
            return `R${fmt(c.value)}`;
        default:
            return fmt(c.value);
    }
}

type Grab = { id: string; du: number; dv: number; x: number; y: number; moved: boolean } | null;

/** One dimension's value: drag to move, click to select, double-click to edit. Redrawn only when its own look changes. */
const DimensionLabel = memo(function DimensionLabel({ c, u, v, className, title, grab }: {
    c: Extract<SketchConstraint, { value: number }>; u: number; v: number; className: string; title: string; grab: { current: Grab };
}) {
    const id = c.id;
    return (
        <Html position={[u, v, 0]} center zIndexRange={[32, 0]} className="sk-label">
            <button
                type="button"
                className={className}
                title={title}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    const hit = e.button === 0 ? planePoint(e.clientX, e.clientY) : null;
                    if (hit) {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        grab.current = { id, du: u - hit.p[0], dv: v - hit.p[1], x: e.clientX, y: e.clientY, moved: false };
                    }
                }}
                onPointerMove={(e) => {
                    const held = grab.current;
                    if (held?.id !== id || (!held.moved && Math.hypot(e.clientX - held.x, e.clientY - held.y) <= CLICK_SLOP_PX)) {
                        return;
                    }
                    held.moved = true;
                    const hit = planePoint(e.clientX, e.clientY);
                    if (hit) {
                        moveLabel(id, [hit.p[0] + held.du, hit.p[1] + held.dv]);
                    }
                }}
                onPointerUp={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                    // A drag is not a click: keep the flag for the click that follows, then drop it.
                    if (!grab.current?.moved) {
                        grab.current = null;
                    }
                }}
                onPointerCancel={() => {
                    grab.current = null;
                }}
                onClick={(e) => {
                    if (grab.current?.moved) {
                        grab.current = null;
                        return;
                    }
                    selectConstraint(id, e.shiftKey);
                    if (!e.shiftKey) {
                        openDimensionForm(id);
                    }
                }}
                onDoubleClick={() => editDimension(id)}
            >
                <DimensionValue c={c} text={dimensionText(c)} />
            </button>
        </Html>
    );
});

/** Driving dimensions: leaders and arrows (one batch), and their values. */
const Dimensions = memo(function Dimensions({ size }: { size: number }) {
    const { geometry: g, labels, selection, conflicting, redundant, editing } = useSketcher(useShallow((s) => ({
        geometry: s.geometry, labels: s.labels, selection: s.selection, conflicting: s.conflicting, redundant: s.redundant,
        editing: s.dimDraft?.editing ?? null,
    })));
    // The label being dragged: where it was grabbed, relative to its centre.
    const grab = useRef<Grab>(null);
    const shown = useMemo(() => {
        const lines: BatchLine[] = [];
        const values = g.constraints.filter(isDimension).flatMap((c) => {
            if (editing === c.id) {
                return [];
            }
            const at = labels[c.id] ?? dimensionAnchor(g, c);
            const selected = selection.some((s) => s.id === c.id);
            const bad = conflicting.includes(c.id);
            const over = !bad && redundant.includes(c.id);
            // Driven (reference) dimensions are grey, as in SolidWorks.
            const color = bad ? CONFLICT : selected ? SELECTED : over ? OVER : c.driven ? DRIVEN : '#d6dde8';
            for (const points of dimensionLines(g, c, at, size)) {
                lines.push({ points, color, width: 1, opacity: 0.85, renderOrder: 21 });
            }
            return [{
                c, u: at[0], v: at[1],
                className: `sk-dim ${selected ? 'selected' : ''} ${bad ? 'bad' : over ? 'over' : ''} ${c.driven ? 'driven' : ''} ${c.suppressed ? 'suppressed' : ''}`,
                title: c.driven ? 'Driven: follows the geometry · drag to move' : 'Drag to move · double-click to edit',
            }];
        });
        return { lines, values };
    }, [g, labels, selection, conflicting, redundant, editing, size]);
    return (
        <>
            <LineBatch lines={shown.lines} />
            {shown.values.map((d) => <DimensionLabel key={d.c.id} {...d} grab={grab} />)}
        </>
    );
});

/** Dimension tool: the dimension the picks would make, following the cursor until it is placed. */
const DimensionPreview = memo(function DimensionPreview({ size }: { size: number }) {
    // Follows the pointer only while the dimension tool is on.
    const shown = useSketcher(useShallow((s) => (s.tool === 'dimension' && !s.dimDraft && s.cursor && !s.dimSpecial
        ? { g: s.geometry, picks: s.picks, hover: s.hover, dimDrag: s.dimDrag, cursor: s.cursor } : null)));
    if (!shown) {
        return null;
    }
    const { g, picks, hover, dimDrag, cursor } = shown;
    // Over something else that a click would pick, the click is a pick, not a placement.
    const placing = dimDrag ? dist(cursor, dimDrag.from) > dimDrag.slop
        : picks.length > 0 && (!hover || (picks.length === 1 && hover.id === picks[0].id) || (picks.length >= 2 && hover.id.startsWith('axis-')));
    const constraint = placing ? smartDimension(g, dimDrag?.picks ?? picks, cursor, useSketcher.getState().dimLock) : null;
    if (!constraint) {
        return null;
    }
    const made = { ...constraint, id: 'draft' } as Extract<SketchConstraint, { value: number }>;
    const value = measure(g, made) ?? 0;
    return (
        <>
            <LineBatch lines={draftLines(dimensionLines(g, made, cursor, size))} />
            <Label at={cursor} className="dim">{dimensionText({ ...made, value })}</Label>
        </>
    );
});

/** The leaders of a dimension being placed, in the draft colour. */
const draftLines = (lines: [number, number, number][][]): BatchLine[] => lines.map((points) => ({ points, color: DRAFT, width: 1, renderOrder: 21 }));

/** The value input of a dimension being placed or edited. */
const DimensionInput = memo(function DimensionInput({ size }: { size: number }) {
    const draft = useSketcher((s) => s.dimDraft);
    const g = useSketcher((s) => s.geometry);
    if (!draft) {
        return null;
    }
    const preview = dimensionLines(g, { ...draft.constraint, id: 'draft', value: 0 } as SketchConstraint, draft.at, size);
    const lines = <LineBatch lines={draftLines(preview)} />;
    if (draft.overDefining) {
        // SolidWorks' Make Dimension Driven? choice, at the dimension.
        return (
            <>
                {lines}
                <Html position={v3(draft.at)} center zIndexRange={[40, 0]} className="sk-label">
                    <DrivenChoice />
                </Html>
            </>
        );
    }
    const kind = draft.constraint.kind;
    const symbol = kind === 'angle' || kind === 'pointAngle' ? '∠' : kind === 'diameter' || (kind === 'distance' && draft.constraint.doubled) ? 'Ø'
        : kind === 'radius' ? 'R' : kind === 'arcLength' ? '⌒' : kind === 'rho' ? 'Rho' : '↔';
    return (
        <>
            {lines}
            <Html position={v3(draft.at)} center zIndexRange={[40, 0]} className="sk-label">
                <form
                    className={`sk-dim-input ${draft.error ? 'bad' : ''}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onSubmit={(e) => {
                        e.preventDefault();
                        applyDimension();
                    }}
                >
                    <span>{symbol}</span>
                    <input
                        autoFocus
                        value={draft.text}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setDimText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                cancelDimension();
                            }
                        }}
                        aria-label="Dimension value"
                    />
                    <em>{kind === 'angle' || kind === 'pointAngle' ? 'deg' : kind === 'rho' ? '' : 'mm'}</em>
                    {draft.error && <small>{draft.error}</small>}
                </form>
            </Html>
        </>
    );
});

// ---- Constraint glyphs --------------------------------------------------------------------------------

const GLYPHS: Partial<Record<SketchConstraint['kind'], string>> = {
    horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', equal: '=', tangent: 'T', coincident: '●',
    pointOnCurve: '⊙', midpoint: 'M', symmetric: '⇋', fix: '🔒', fixRadius: '🔒', horizontalPoints: 'H', verticalPoints: 'V',
    concentric: '◎', coradial: '◎=', collinear: '⋯', intersection: '✕',
    pathTangent: 'T', equalSweep: '=',
};

/** Where to draw a constraint's glyph(s). */
function glyphSpots(g: SketchGeometry, c: SketchConstraint, offset: number): Pt[] {
    const curveMid = (id: string): Pt | null => {
        const curve = curveOf(g, id);
        if (!curve) {
            return null;
        }
        if (curve.kind === 'line') {
            const a = P(g, curve.a);
            const b = P(g, curve.b);
            const l = dist(a, b) || 1;
            return [(a[0] + b[0]) / 2 + (-(b[1] - a[1]) / l) * offset, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / l) * offset];
        }
        if (curve.kind === 'circle') {
            const centre = P(g, curve.center);
            return [centre[0] + curve.radius * 0.71 + offset, centre[1] - curve.radius * 0.71 - offset];
        }
        if (curve.kind !== 'arc') {
            const pts = geometryEntities({ ...g, curves: [curve] }).flatMap((e) => entityPoints(e));
            const m = pts[Math.floor(pts.length / 2)] ?? [0, 0];
            return [m[0] + offset, m[1] + offset];
        }
        const m = arcMiddle(P(g, curve.center), P(g, curve.start), P(g, curve.end));
        return [m[0] + offset, m[1] + offset];
    };
    const near = (id: string): Pt => {
        const p = P(g, id);
        return [p[0] + offset * 0.8, p[1] - offset * 0.8];
    };
    switch (c.kind) {
        case 'horizontal':
        case 'vertical':
            return [curveMid(c.line)].filter(Boolean) as Pt[];
        case 'parallel':
        case 'perpendicular':
        case 'equal':
        case 'tangent':
        case 'collinear':
        case 'concentric':
        case 'coradial':
            return [c.a, c.b].map((id) => (curveOf(g, id) ? curveMid(id) : near(id))).filter(Boolean) as Pt[];
        case 'horizontalPoints':
        case 'verticalPoints':
            return [near(c.a), near(c.b)];
        case 'fixRadius':
            return [curveMid(c.curve)].filter(Boolean) as Pt[];
        case 'coincident':
            return [near(c.a)];
        case 'pointOnCurve':
        case 'midpoint':
        case 'intersection':
            return [near(c.point)];
        case 'fix':
            return [near(c.point)];
        case 'symmetric':
            return [curveMid(c.about) ?? near(c.a)];
        case 'pathTangent':
            return [curveMid(c.curve)].filter(Boolean) as Pt[];
        case 'equalSweep':
            return [c.a, c.b].map((id) => curveMid(id)).filter(Boolean) as Pt[];
        default:
            return [];
    }
}

/** What each relation keeps true, for its tooltip. */
const GLYPH_MEANING: Partial<Record<SketchConstraint['kind'], string>> = {
    horizontal: 'Horizontal: this line stays level',
    vertical: 'Vertical: this line stays upright',
    parallel: 'Parallel: these lines keep the same direction',
    perpendicular: 'Perpendicular: these lines stay at 90°',
    equal: 'Equal: these keep the same size',
    tangent: 'Tangent: these touch smoothly',
    coincident: 'Coincident: these points stay together',
    pointOnCurve: 'On curve: this point stays on the curve',
    midpoint: 'Midpoint: this point stays in the middle of the line',
    symmetric: 'Symmetric: these mirror each other',
    fix: 'Locked: this point cannot move (the Lock tool unlocks it)',
    fixRadius: 'Locked: this circle keeps its radius (the Lock tool unlocks it)',
    horizontalPoints: 'Horizontal: these points stay level',
    verticalPoints: 'Vertical: these points stay one above the other',
    concentric: 'Concentric: these share a centre',
    coradial: 'Coradial: these share a centre and radius',
    collinear: 'Collinear: these lines stay on one line',
    intersection: 'Intersection: this point stays where the two lines cross',
    pathTangent: 'Tangent to path: this stays touching whichever entity of the path it meets',
    equalSweep: 'Equal angle: these arcs sweep the same angle',
};

/** One relation marker; redrawn only when its own place or look changes. */
const GlyphLabel = memo(function GlyphLabel({ id, u, v, glyph, className, title }: {
    id: string; u: number; v: number; glyph: string; className: string; title: string;
}) {
    return (
        <Html position={[u, v, 0]} center zIndexRange={[31, 0]} className="sk-label">
            <button
                type="button"
                className={className}
                title={title}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => selectConstraint(id, e.shiftKey)}
            >
                {glyph}
            </button>
        </Html>
    );
});

/**
 * Relation markers (H, V, ∥ ...). They are out of the way while drawing: only the select, dimension and relation
 * tools show them, plus any that is selected or in conflict.
 */
const Glyphs = memo(function Glyphs({ offset }: { offset: number }) {
    const { geometry: g, selection, conflicting, redundant, tool, settings } = useSketcher(useShallow((s) => ({
        geometry: s.geometry, selection: s.selection, conflicting: s.conflicting, redundant: s.redundant, tool: s.tool, settings: s.settings,
    })));
    const marks = useMemo(() => {
        // Show relations off: only those of the selected entities (and problems) are shown, as in SolidWorks.
        const all = settings.showRelations && (tool === 'select' || tool === 'dimension' || tool.startsWith('c:'));
        const picked = new Set(selection.map((s) => s.id));
        // The locks on what was copied in from the model or another sketch only show while it is selected.
        const brought = broughtIn(g);
        const ofPicked = (c: SketchConstraint) => brought.locks.has(c.id) && c.kind === 'fix' && !brought.handles.has(c.point)
            && (brought.on.get(c.point) ?? []).some((id) => picked.has(id));
        const shown = (c: SketchConstraint) => !isDimension(c)
            && ((all && !brought.locks.has(c.id)) || conflicting.includes(c.id) || redundant.includes(c.id) || picked.has(c.id)
                || constraintRefs(c).some((r) => picked.has(r)) || ofPicked(c));
        return g.constraints.filter(shown).flatMap((c) => glyphSpots(g, c, offset).map((at, i) => ({
            key: `${c.id}-${i}`, id: c.id, u: at[0], v: at[1], glyph: GLYPHS[c.kind] ?? '•',
            className: `sk-glyph ${picked.has(c.id) ? 'selected' : ''} ${conflicting.includes(c.id) ? 'bad' : redundant.includes(c.id) ? 'over' : ''} ${c.suppressed ? 'suppressed' : ''}`,
            title: `${GLYPH_MEANING[c.kind] ?? c.kind} · click to select, Delete removes it`,
        })));
    }, [g, selection, conflicting, redundant, tool, settings.showRelations, offset]);
    return (
        <>
            {marks.map(({ key, ...m }) => <GlyphLabel key={key} {...m} />)}
        </>
    );
});

// ---- Geometry -----------------------------------------------------------------------------------------

/**
 * The sketch (SketchShapes, the relation markers and dimensions, each redrawn only when what it shows changes) and
 * what follows the pointer: the entity in progress, snapping cues and live sizes.
 */
export function Drawing() {
    const {
        geometry: g, draft, cursor, tool, sides, typed, snapKind, snapGuides, snapHints, arcSweep, editPreview, editText, xform,
        drawOptions, chainStart, lineArc,
    } = useSketcher();
    const zone = useSketchMore((m) => m.zone);
    const camera = useThree((s) => s.camera) as PerspectiveCamera;
    const size = useThree((s) => s.size);
    // A size that reads about 9 px on screen, for arrows and glyph offsets.
    const unit = Math.max(0.2, pixelSizeAt(camera, ORIGIN_3D, size.height) * 9);
    const picking = tool === 'dimension' || tool.startsWith('c:') || isEditTool(tool);
    const xformFrom = tool === 'xform' && xform?.picks.length === 1 && (xform.kind === 'move' || xform.kind === 'copy' || xform.kind === 'stretch') ? xform.picks[0] : null;
    const at = draft.map((d) => d.at);
    // The draw tool variants and options preview what their click would build.
    const variant = cursor && draft.length
        ? drawPreview({ tool, g, draft, cursor, options: drawOptions, sides, sweep: arcSweep, chainStart, lineArc: lineArc.arc }) : null;
    const preview = !variant && cursor && draft.length && !['select', 'dimension'].includes(tool) && !tool.startsWith('c:') && !isEditTool(tool)
        ? tool === 'tangentArc' ? zonedPreview(g, draft[0].point, at[0], cursor, zone.intent) ?? tangentPreview(g, draft[0].point, at[0], cursor)
            : draftEntity(tool, at, cursor, sides, arcSweep) : null;
    const shownPreview = preview || (variant?.length === 1 ? variant[0] : null);
    const previewText = shownPreview && ((isConicTool(tool) && cursor ? conicDraftText(tool, at, cursor) : null) ?? draftText(shownPreview));
    const guides: BatchLine[] = cursor && tool !== 'select' ? snapGuides.map((q) => ({
        points: [v3(q), v3(cursor)], color: '#ffd166', width: 1, dashed: true, dashSize: unit * 0.4, gapSize: unit * 0.4, renderOrder: 21,
    })) : [];
    return (
        <>
            <SketchShapes />
            <Glyphs offset={unit * 0.9} />
            <Dimensions size={unit} />
            <DimensionPreview size={unit} />
            <DimensionInput size={unit} />
            <DimExtrasDrawing unit={unit} />
            <MoreDrawing unit={unit} />
            <ModifyDragDrawing unit={unit} />
            <Instant2dDrawing unit={unit} />
            <ItemsDrawing />
            <PathDrawing />
            <SplineOverlays unit={unit} />
            <PieceDrawing />
            <FullyDefineGhosts unit={unit} lines={dimensionLines} text={dimensionText} spots={glyphSpots} glyphs={GLYPHS} />
            {preview && <EntityLine entity={preview} color={DRAFT} dashed width={2.4} />}
            {variant?.map((e, i) => <EntityLine key={`draw-${i}`} entity={e} color={DRAFT} dashed width={2.4} />)}
            {tool === 'centerArc' && draft.length === 2 && <EntityLine entity={{ kind: 'line', a: at[0], b: at[1] }} color={DRAFT} dashed />}
            {isConicTool(tool) && cursor && conicGuides(tool, at, cursor).map((e, i) => (
                <EntityLine key={`guide-${i}`} entity={e} color={DRAFT} dashed width={1.2} />
            ))}
            {/* Trim: the piece that goes, in red; extend and offset: what gets added. */}
            {(isEditTool(tool) || tool === 'xform' || tool === 'select') && editPreview.map((e, i) => (
                <EntityLine key={`edit-${i}`} entity={e} color={tool === 'trim' ? CONFLICT : DRAFT} dashed={tool !== 'trim'} width={tool === 'trim' ? 4.2 : 2.4} />
            ))}
            {xformFrom && cursor && <EntityLine entity={{ kind: 'line', a: xformFrom, b: cursor }} color={DRAFT} dashed width={1.4} />}
            {tool === 'slot' && draft.length === 2 && <EntityLine entity={{ kind: 'line', a: at[0], b: at[1] }} color={DRAFT} />}
            {tool === 'arc' && draft.length === 2 && cursor && !circleThrough(at[0], cursor, at[1]) && (
                <EntityLine entity={{ kind: 'line', a: at[0], b: at[1] }} color={DRAFT} dashed />
            )}
            <LineBatch lines={guides} />
            {cursor && tool !== 'select' && !picking && snapHints.filter((m) => dist(m, cursor) > 1e-6).map((m, i) => (
                <Label key={i} at={m} className="snap mid hint">
                    <span />
                </Label>
            ))}
            {cursor && tool !== 'select' && !picking && (
                <Label at={cursor} className={`snap ${snapKind ?? ''}`}>
                    <span />
                </Label>
            )}
            {cursor && (previewText || typed || (isEditTool(tool) && editText)) && (
                <Label at={cursor} className="live">
                    {typed ? <b>{typed}<i>▌</i></b> : previewText || editText}
                </Label>
            )}
        </>
    );
}

/** Invisible plane that turns pointer events into sketch coordinates. */
export function Catcher({ frame }: { frame: RefObject<Group | null> }) {
    const size = useThree((s) => s.size);
    const controls = useThree((s) => s.controls) as CameraControlsImpl | null;
    const gl = useThree((s) => s.gl);
    const connected = useThree((s) => s.events.connected) as HTMLElement | undefined;
    const camera = useThree((s) => s.camera) as PerspectiveCamera;
    useEffect(() => {
        // The element camera-controls listens on (the canvas wrapper), so this capture listener runs first.
        const element = connected ?? gl.domElement;
        const raycaster = new Raycaster();
        const plane = new Plane();
        // Capture phase, before camera-controls sees the press: a press on sketch geometry drags it, not the view.
        /** Where the ray of `view` through a screen position meets the sketch plane, in the scene. */
        const worldAt = (view: Camera, clientX: number, clientY: number): Vector3 | null => {
            if (!frame.current) {
                return null;
            }
            const rect = gl.domElement.getBoundingClientRect();
            rayFromCamera(raycaster, new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), view);
            const matrix = frame.current.matrixWorld;
            plane.setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1).transformDirection(matrix), new Vector3().setFromMatrixPosition(matrix));
            return raycaster.ray.intersectPlane(plane, new Vector3());
        };
        planePoint = (clientX, clientY) => {
            const hit = worldAt(camera, clientX, clientY);
            if (!hit || !frame.current) {
                return null;
            }
            const local = frame.current.worldToLocal(hit.clone());
            return { p: [local.x, local.y], perPx: pixelSizeAt(camera, hit, gl.domElement.getBoundingClientRect().height), world: hit };
        };
        // A left drag in an open sketch never turns the view (the middle button does). On sketch geometry it drags that;
        // elsewhere it slides the view along the sketch plane, the grabbed spot staying under the pointer.
        let slide: { x: number; y: number; grab: Vector3; view: Camera; eye: Vector3; look: Vector3; moving: boolean } | null = null;
        let trucking = false;
        const down = (event: PointerEvent) => {
            // Presses on a dimension value or its input belong to that, not to the geometry behind it.
            if ((event.target as Element | null)?.closest?.('.sk-dim, .sk-dim-input, .sk-context-bar')) {
                return;
            }
            // Modify Sketch's drags, Instant2D's handles and shaded contours take their presses first.
            if (viewPress(event)) {
                if (controls) {
                    controls.enabled = false;
                }
                return;
            }
            if (event.button !== 0) {
                return;
            }
            const hit = planePoint(event.clientX, event.clientY);
            if (!hit) {
                return;
            }
            if (sketchDown(hit.p, SNAP_PX * hit.perPx, event.clientX)) {
                if (controls) {
                    controls.enabled = false;
                }
                return;
            }
            if (!controls || useSketcher.getState().stage !== 'draw') {
                return;
            }
            if (Math.abs(camera.getWorldDirection(new Vector3()).dot(plane.normal)) < 0.2) {
                // Seen almost edge on, the plane cannot be grabbed: the drag pans across the screen instead.
                controls.mouseButtons.left = CameraControlsImpl.ACTION.TRUCK;
                trucking = true;
                return;
            }
            controls.enabled = false;
            slide = {
                x: event.clientX, y: event.clientY, grab: hit.world, view: camera.clone(), moving: false,
                eye: controls.getPosition(new Vector3()), look: controls.getTarget(new Vector3()),
            };
        };
        const move = (event: PointerEvent) => {
            if (!slide || !controls || (!slide.moving && Math.hypot(event.clientX - slide.x, event.clientY - slide.y) <= CLICK_SLOP_PX)) {
                return;
            }
            slide.moving = true;
            // Measured with the view as it was at the press, so each move is exact and nothing builds up.
            const now = worldAt(slide.view, event.clientX, event.clientY);
            if (now) {
                const by = slide.grab.clone().sub(now);
                const [eye, look] = [slide.eye.clone().add(by), slide.look.clone().add(by)];
                void controls.setLookAt(eye.x, eye.y, eye.z, look.x, look.y, look.z, false);
            }
        };
        const up = (event: PointerEvent) => {
            sketchUp({ shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey });
            slide = null;
            if (controls && trucking) {
                controls.mouseButtons.left = CameraControlsImpl.ACTION.ROTATE;
            }
            trucking = false;
            if (controls && !controls.enabled) {
                controls.enabled = true;
            }
        };
        element.addEventListener('pointerdown', down, { capture: true });
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return () => {
            element.removeEventListener('pointerdown', down, { capture: true });
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (controls && trucking) {
                controls.mouseButtons.left = CameraControlsImpl.ACTION.ROTATE;
            }
            planePoint = () => null;
        };
    }, [controls, gl, connected, camera, frame]);
    const toSketch = (e: ThreeEvent<PointerEvent | MouseEvent>): { p: Pt; tolerance: number } | null => {
        if (!frame.current) {
            return null;
        }
        const local = frame.current.worldToLocal(e.point.clone());
        return { p: [local.x, local.y], tolerance: SNAP_PX * pixelSizeAt(e.camera as PerspectiveCamera, e.point, size.height) };
    };
    return (
        <mesh
            onPointerMove={(e) => {
                const hit = toSketch(e);
                if (hit) {
                    sketchMove(hit.p, hit.tolerance, e.nativeEvent.clientX, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
                    pieceHover(hit.p, hit.tolerance, e.altKey);
                }
            }}
            onClick={(e) => {
                const hit = toSketch(e);
                // Alt + click on a curve: the piece of it between crossings (sketchPieces.ts).
                if (hit && e.delta <= CLICK_SLOP_PX && pieceClick(hit.p, hit.tolerance, e.altKey, e.shiftKey)) {
                    e.stopPropagation();
                    return;
                }
                // Alt + click on a shaded contour: its context toolbar.
                if (hit && e.delta <= CLICK_SLOP_PX && e.altKey && contourAltClick(hit.p)) {
                    e.stopPropagation();
                    return;
                }
                // Rapid Sketch: a click through the plane onto another face of the part opens the next sketch there.
                if (hit && e.delta <= CLICK_SLOP_PX && rapidClick(partFaceHit(e.intersections), e.distance, hit.tolerance)) {
                    e.stopPropagation();
                    return;
                }
                if (hit && e.delta <= CLICK_SLOP_PX) {
                    // A form collecting model picks: the click picks a curve of another sketch, or goes on to the model.
                    if (useSketchModel.getState().picking) {
                        if (modelPlaneClick(hit.p, hit.tolerance)) {
                            e.stopPropagation();
                        }
                        return;
                    }
                    e.stopPropagation();
                    sketchClick(hit.p, hit.tolerance, e.shiftKey, e.ctrlKey || e.metaKey);
                }
            }}
            onDoubleClick={() => endChain()}
        >
            <planeGeometry args={[100000, 100000]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} side={DoubleSide} forceSinglePass />
        </mesh>
    );
}
