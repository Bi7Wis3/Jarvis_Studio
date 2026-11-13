// The constrained sketch on its plane: curves coloured by constraint state, points, constraint glyphs,
// driving dimensions with leaders and editable values, the entity in progress, and pointer input.

import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { DoubleSide, MathUtils, Plane, Raycaster, Vector2, Vector3, type Group, type PerspectiveCamera } from 'three';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import type { CameraControlsImpl } from '@react-three/drei';
import { AXIS_U, AXIS_V, curveOf, isDimension, measure, pointOf } from './solver';
import { arcMiddle, dimensionFromPicks, geometryEntities } from './sketchGeometry';
import { circleThrough, dist, entityPoints, regularPolygon, type Entity, type NewEntity, type Pt } from './sketchMath';
import {
    applyDimension, cancelDimension, dimensionAnchor, editDimension, endChain, isEditTool, moveLabel, selectConstraint, setDimText, sketchClick,
    sketchDown, sketchMove, sketchUp, useSketcher,
} from './sketcher';

const FREE = '#5aa9ff';
const FIXED = '#f2f5f9';
const CONSTRUCTION = '#ffb347';
const SELECTED = '#c48bff';
const PICKED = '#ffd166';
const CONFLICT = '#ff5d6c';
const DRAFT = '#35e0ff';
const SNAP_PX = 10;
const CLICK_SLOP_PX = 4;

/** Screen position to sketch coordinates and mm per pixel there; set by the Catcher while a sketch is open. */
let planePoint: (clientX: number, clientY: number) => { p: Pt; perPx: number } | null = () => null;

export const v3 = ([u, v]: Pt, z = 0): [number, number, number] => [u, v, z];

function fmt(n: number): string {
    return String(Math.round(n * 100) / 100);
}

export function Label({ at, children, className = '' }: { at: Pt; children: ReactNode; className?: string }) {
    return (
        <Html position={v3(at)} center zIndexRange={[30, 0]} className={`sk-label ${className}`}>
            {children}
        </Html>
    );
}

export function EntityLine({ entity, color, dashed, width = 1.6 }: { entity: NewEntity; color: string; dashed?: boolean; width?: number }) {
    const points = useMemo(() => entityPoints(entity as Entity).map((p) => v3(p)), [JSON.stringify(entity)]);
    if (points.length < 2) {
        return null;
    }
    return (
        <Line points={points} color={color} lineWidth={width} dashed={dashed} dashSize={2} gapSize={1.5} depthTest={false} renderOrder={20} />
    );
}

/** What the entity in progress would be with the cursor as its next point (`sweep`: a centre arc's turn so far). */
function draftEntity(tool: string, draft: Pt[], cursor: Pt, sides: number, sweep: number): NewEntity | null {
    const [a, b] = draft;
    switch (tool) {
        case 'line':
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
        case 'slot': {
            if (draft.length === 1) {
                return { kind: 'line', a, b: cursor };
            }
            const length = dist(a, b);
            const r = length ? Math.abs((b[0] - a[0]) * (a[1] - cursor[1]) - (a[0] - cursor[0]) * (b[1] - a[1])) / length : 0;
            return { kind: 'slot', a, b, r: Math.max(r, 0.1) };
        }
    }
    return null;
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
            if (!curve || curve.kind === 'line') {
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
            const a0 = toward(p1, p2);
            let a1 = toward(p3, p4);
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
    switch (c.kind) {
        case 'angle':
            return `${fmt(c.value)}°`;
        case 'diameter':
            return `Ø${fmt(c.value)}`;
        case 'radius':
            return `R${fmt(c.value)}`;
        default:
            return fmt(c.value);
    }
}

/** Driving dimensions: leaders and arrows, and their values (drag to move, click to select, double-click to edit). */
function Dimensions({ size }: { size: number }) {
    const { geometry: g, labels, selection, conflicting, dimDraft } = useSketcher();
    // The label being dragged: where it was grabbed, relative to its centre.
    const grab = useRef<{ id: string; du: number; dv: number; x: number; y: number; moved: boolean } | null>(null);
    return (
        <>
            {g.constraints.filter(isDimension).map((c) => {
                if (dimDraft?.editing === c.id) {
                    return null;
                }
                const at = labels[c.id] ?? dimensionAnchor(g, c);
                const selected = selection.some((s) => s.id === c.id);
                const bad = conflicting.includes(c.id);
                const color = bad ? CONFLICT : selected ? SELECTED : '#d6dde8';
                return (
                    <group key={c.id}>
                        {dimensionLines(g, c, at, size).map((points, i) => (
                            <Line key={i} points={points} color={color} lineWidth={1} transparent opacity={0.85} depthTest={false} renderOrder={21} />
                        ))}
                        <Html position={v3(at)} center zIndexRange={[32, 0]} className="sk-label">
                            <button
                                type="button"
                                className={`sk-dim ${selected ? 'selected' : ''} ${bad ? 'bad' : ''}`}
                                title="Drag to move · double-click to edit"
                                onPointerDown={(e) => {
                                    e.stopPropagation();
                                    const hit = e.button === 0 ? planePoint(e.clientX, e.clientY) : null;
                                    if (hit) {
                                        e.currentTarget.setPointerCapture(e.pointerId);
                                        grab.current = { id: c.id, du: at[0] - hit.p[0], dv: at[1] - hit.p[1], x: e.clientX, y: e.clientY, moved: false };
                                    }
                                }}
                                onPointerMove={(e) => {
                                    const held = grab.current;
                                    if (held?.id !== c.id || (!held.moved && Math.hypot(e.clientX - held.x, e.clientY - held.y) <= CLICK_SLOP_PX)) {
                                        return;
                                    }
                                    held.moved = true;
                                    const hit = planePoint(e.clientX, e.clientY);
                                    if (hit) {
                                        moveLabel(c.id, [hit.p[0] + held.du, hit.p[1] + held.dv]);
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
                                    selectConstraint(c.id, e.shiftKey);
                                }}
                                onDoubleClick={() => editDimension(c.id)}
                            >
                                {dimensionText(c)}
                            </button>
                        </Html>
                    </group>
                );
            })}
        </>
    );
}

/** Dimension tool: the dimension the picks would make, following the cursor until it is placed. */
function DimensionPreview({ size }: { size: number }) {
    const { geometry: g, tool, picks, hover, dimDrag, dimDraft, cursor } = useSketcher();
    if (tool !== 'dimension' || dimDraft || !cursor) {
        return null;
    }
    // Over something else that a click would pick, the click is a pick, not a placement.
    const placing = dimDrag ? dist(cursor, dimDrag.from) > dimDrag.slop
        : picks.length > 0 && (!hover || (picks.length === 1 && hover.id === picks[0].id) || (picks.length >= 2 && hover.id.startsWith('axis-')));
    const constraint = placing ? dimensionFromPicks(g, dimDrag?.picks ?? picks, cursor) : null;
    if (!constraint) {
        return null;
    }
    const shown = { ...constraint, id: 'draft' } as Extract<SketchConstraint, { value: number }>;
    const value = measure(g, shown) ?? 0;
    return (
        <>
            {dimensionLines(g, shown, cursor, size).map((points, i) => (
                <Line key={i} points={points} color={DRAFT} lineWidth={1} depthTest={false} renderOrder={21} />
            ))}
            <Label at={cursor} className="dim">{dimensionText({ ...shown, value })}</Label>
        </>
    );
}

/** The value input of a dimension being placed or edited. */
function DimensionInput({ size }: { size: number }) {
    const draft = useSketcher((s) => s.dimDraft);
    const g = useSketcher((s) => s.geometry);
    if (!draft) {
        return null;
    }
    const preview = dimensionLines(g, { ...draft.constraint, id: 'draft', value: 0 } as SketchConstraint, draft.at, size);
    return (
        <>
            {preview.map((points, i) => (
                <Line key={i} points={points} color={DRAFT} lineWidth={1} depthTest={false} renderOrder={21} />
            ))}
            <Html position={v3(draft.at)} center zIndexRange={[40, 0]} className="sk-label">
                <form
                    className={`sk-dim-input ${draft.error ? 'bad' : ''}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onSubmit={(e) => {
                        e.preventDefault();
                        applyDimension();
                    }}
                >
                    <span>{draft.constraint.kind === 'angle' ? '∠' : draft.constraint.kind === 'diameter' ? 'Ø' : draft.constraint.kind === 'radius' ? 'R' : '↔'}</span>
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
                    <em>{draft.constraint.kind === 'angle' ? 'deg' : 'mm'}</em>
                    {draft.error && <small>{draft.error}</small>}
                </form>
            </Html>
        </>
    );
}

// ---- Constraint glyphs --------------------------------------------------------------------------------

const GLYPHS: Partial<Record<SketchConstraint['kind'], string>> = {
    horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', equal: '=', tangent: 'T', coincident: '●',
    pointOnCurve: '⊙', midpoint: 'M', symmetric: '⇋', fix: '🔒',
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
            return [curveMid(c.a), curveMid(c.b)].filter(Boolean) as Pt[];
        case 'coincident':
            return [near(c.a)];
        case 'pointOnCurve':
        case 'midpoint':
            return [near(c.point)];
        case 'fix':
            return [near(c.point)];
        case 'symmetric':
            return [curveMid(c.about) ?? near(c.a)];
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
};

/**
 * Relation markers (H, V, ∥ ...). They are out of the way while drawing: only the select, dimension and relation
 * tools show them, plus any that is selected or in conflict.
 */
function Glyphs({ offset }: { offset: number }) {
    const { geometry: g, selection, conflicting, tool } = useSketcher();
    const all = tool === 'select' || tool === 'dimension' || tool.startsWith('c:');
    const shown = (c: SketchConstraint) => !isDimension(c) && (all || conflicting.includes(c.id) || selection.some((s) => s.id === c.id));
    return (
        <>
            {g.constraints.filter(shown).flatMap((c) => glyphSpots(g, c, offset).map((at, i) => (
                <Html key={`${c.id}-${i}`} position={v3(at)} center zIndexRange={[31, 0]} className="sk-label">
                    <button
                        type="button"
                        className={`sk-glyph ${selection.some((s) => s.id === c.id) ? 'selected' : ''} ${conflicting.includes(c.id) ? 'bad' : ''}`}
                        title={`${GLYPH_MEANING[c.kind] ?? c.kind} · click to select, Delete removes it`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => selectConstraint(c.id, e.shiftKey)}
                    >
                        {GLYPHS[c.kind] ?? '•'}
                    </button>
                </Html>
            )))}
        </>
    );
}

// ---- Geometry -----------------------------------------------------------------------------------------

/** Curves, points, the entity in progress, snapping cues, constraints and dimensions. */
export function Drawing() {
    const {
        geometry: g, draft, cursor, tool, selection, picks, hover, dimDrag, sides, typed, snapKind, snapGuides, snapHints, dof, conflicting,
        arcSweep, editPreview, editText,
    } = useSketcher();
    const camera = useThree((s) => s.camera) as PerspectiveCamera;
    const size = useThree((s) => s.size);
    // A size that reads about 9 px on screen, for arrows and glyph offsets.
    const unit = Math.max(0.2, (2 * camera.position.length() * Math.tan(MathUtils.degToRad(camera.fov) / 2) / size.height) * 9);
    const entities = useMemo(() => geometryEntities(g), [g]);
    const curveColor = dof === 0 ? FIXED : FREE;
    const selected = new Set(selection.map((s) => s.id));
    const picked = new Set((dimDrag?.picks ?? picks).map((p) => p.id));
    const picking = tool === 'dimension' || tool.startsWith('c:') || isEditTool(tool);
    const hovered = picking && hover ? hover.id : null;
    const conflictRefs = new Set(g.constraints.filter((c) => conflicting.includes(c.id)).flatMap((c) => Object.values(c).filter((v) => typeof v === 'string')));
    const at = draft.map((d) => d.at);
    const preview = cursor && draft.length && !['select', 'dimension'].includes(tool) && !tool.startsWith('c:') && !isEditTool(tool)
        ? draftEntity(tool, at, cursor, sides, arcSweep) : null;
    const previewText = preview && draftText(preview);
    const last = at[at.length - 1];
    return (
        <>
            {entities.map((e) => {
                const lit = picked.has(e.id) || hovered === e.id;
                const color = selected.has(e.id) ? SELECTED : lit ? PICKED : conflictRefs.has(e.id) ? CONFLICT
                    : e.construction ? CONSTRUCTION : curveColor;
                return (
                    <EntityLine key={e.id} entity={e} color={color} dashed={e.construction} width={selected.has(e.id) || lit ? 3.8 : e.construction ? 1.8 : 2.8} />
                );
            })}
            {g.points.map((p) => {
                const state = selected.has(p.id) ? 'selected' : picked.has(p.id) || hovered === p.id ? 'picked' : p.fixed ? 'fixed' : '';
                return (
                    <Label key={p.id} at={[p.u, p.v]} className={`pt ${state} ${dof === 0 ? 'done' : ''}`}>
                        <span />
                    </Label>
                );
            })}
            {(picked.has(AXIS_U) || hovered === AXIS_U) && <Line points={[[-1e4, 0, 0], [1e4, 0, 0]]} color={PICKED} lineWidth={2} depthTest={false} />}
            {(picked.has(AXIS_V) || hovered === AXIS_V) && <Line points={[[0, -1e4, 0], [0, 1e4, 0]]} color={PICKED} lineWidth={2} depthTest={false} />}
            <Label at={[0, 0]} className={`pt origin ${picked.has('origin') || hovered === 'origin' ? 'picked' : ''}`}>
                <span />
            </Label>
            <Glyphs offset={unit * 0.9} />
            <Dimensions size={unit} />
            <DimensionPreview size={unit} />
            <DimensionInput size={unit} />
            {preview && <EntityLine entity={preview} color={DRAFT} dashed width={2.4} />}
            {tool === 'centerArc' && draft.length === 2 && <EntityLine entity={{ kind: 'line', a: at[0], b: at[1] }} color={DRAFT} dashed />}
            {/* Trim: the piece that goes, in red; extend and offset: what gets added. */}
            {isEditTool(tool) && editPreview.map((e, i) => (
                <EntityLine key={`edit-${i}`} entity={e} color={tool === 'trim' ? CONFLICT : DRAFT} dashed={tool !== 'trim'} width={tool === 'trim' ? 4.2 : 2.4} />
            ))}
            {tool === 'slot' && draft.length === 2 && <EntityLine entity={{ kind: 'line', a: at[0], b: at[1] }} color={DRAFT} />}
            {tool === 'arc' && draft.length === 2 && cursor && !circleThrough(at[0], cursor, at[1]) && (
                <EntityLine entity={{ kind: 'line', a: at[0], b: at[1] }} color={DRAFT} dashed />
            )}
            {cursor && tool !== 'select' && snapGuides.map((q, i) => (
                <Line key={i} points={[v3(q), v3(cursor)]} color="#ffd166" lineWidth={1} dashed dashSize={unit * 0.4} gapSize={unit * 0.4} depthTest={false} renderOrder={21} />
            ))}
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
        planePoint = (clientX, clientY) => {
            if (!frame.current) {
                return null;
            }
            const rect = gl.domElement.getBoundingClientRect();
            raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
            const matrix = frame.current.matrixWorld;
            plane.setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1).transformDirection(matrix), new Vector3().setFromMatrixPosition(matrix));
            const hit = raycaster.ray.intersectPlane(plane, new Vector3());
            if (!hit) {
                return null;
            }
            const local = frame.current.worldToLocal(hit.clone());
            return { p: [local.x, local.y], perPx: (2 * camera.position.distanceTo(hit) * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / rect.height };
        };
        const down = (event: PointerEvent) => {
            // Presses on a dimension value or its input belong to that, not to the geometry behind it.
            if (event.button !== 0 || (event.target as Element | null)?.closest?.('.sk-dim, .sk-dim-input')) {
                return;
            }
            const hit = planePoint(event.clientX, event.clientY);
            if (hit && sketchDown(hit.p, SNAP_PX * hit.perPx) && controls) {
                controls.enabled = false;
            }
        };
        const up = () => {
            sketchUp();
            if (controls && !controls.enabled) {
                controls.enabled = true;
            }
        };
        element.addEventListener('pointerdown', down, { capture: true });
        window.addEventListener('pointerup', up);
        return () => {
            element.removeEventListener('pointerdown', down, { capture: true });
            window.removeEventListener('pointerup', up);
            planePoint = () => null;
        };
    }, [controls, gl, connected, camera, frame]);
    const toSketch = (e: ThreeEvent<PointerEvent | MouseEvent>): { p: Pt; tolerance: number } | null => {
        if (!frame.current) {
            return null;
        }
        const local = frame.current.worldToLocal(e.point.clone());
        const camera = e.camera as PerspectiveCamera;
        const perPx = (2 * camera.position.distanceTo(e.point) * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / size.height;
        return { p: [local.x, local.y], tolerance: SNAP_PX * perPx };
    };
    return (
        <mesh
            onPointerMove={(e) => {
                const hit = toSketch(e);
                if (hit) {
                    sketchMove(hit.p, hit.tolerance);
                }
            }}
            onClick={(e) => {
                const hit = toSketch(e);
                if (hit && e.delta <= CLICK_SLOP_PX) {
                    e.stopPropagation();
                    sketchClick(hit.p, hit.tolerance, e.shiftKey);
                }
            }}
            onDoubleClick={() => endChain()}
        >
            <planeGeometry args={[100000, 100000]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} side={DoubleSide} />
        </mesh>
    );
}
