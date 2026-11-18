// What the dimension and setting additions draw in the open sketch (see sketchDimTools.ts, sketchNoSolve.ts): the zero
// dimension of each ordinate row and angular running set (drag it to move the row, drop it on another point or line
// to measure from that), the ghost of a dragged entity, the No solve move question, the preview dimensions of a
// selected entity, and the context toolbar of a selection (relations that fit, Auto insert dimension).

import { memo, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Html } from '@react-three/drei';
import { LineBatch, type BatchLine } from './sketchBatch';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { measure, pointOf } from './solver';
import { cancelDimension, chooseDimensionDriven, selectConstraint, useSketcher } from './sketcher';
import { geometryEntities, type NewConstraint } from './sketchGeometry';
import { entityPoints, type Pt } from './sketchMath';
import { shownText } from './numberText';
import { linearLines } from './sketchDimDraw';
import {
    autoInsertDimension, dropZero, moveZero, previewDimensions, rememberDrivenChoice, selectionDimension, sketchZeros, startDimension,
} from './sketchDimTools';
import type { GroupZero } from './sketchDimGroups';
import { answerNoSolve, useNoSolve } from './sketchNoSolve';
import { fittingRelationTools } from './constraintTools';
import { sketchPointAt } from './SketchDrawing';
import { Icon } from './icons';
import type { Pick } from './sketchGeometry';
import { useContourBar } from './sketchContours';
import './sketchDimExtras.css';

type V3 = [number, number, number];
const v3 = ([u, v]: Pt): V3 => [u, v, 0];
const GHOST = '#8d96a3';
const PREVIEW = '#35e0ff';
const CLICK_SLOP_PX = 4;

/** Every entity of `g` as polylines. */
function polylines(g: SketchGeometry): V3[][] {
    return geometryEntities(g).map((e) => entityPoints(e).map(v3)).filter((p) => p.length > 1);
}

/** The zero dimensions: "0" of an ordinate row, "0°" of a running set, with the zero's leader. */
function ZeroLabels() {
    const g = useSketcher((s) => s.geometry);
    useSketcher((s) => s.labels);
    const grab = useRef<{ key: string; du: number; dv: number; x: number; y: number; moved: boolean } | null>(null);
    const zeros = sketchZeros();
    const drop = (zero: GroupZero, e: ReactPointerEvent) => {
        const held = grab.current;
        const hit = sketchPointAt(e.clientX, e.clientY);
        if (held?.moved && hit) {
            dropZero(zero, hit.p, hit.tolerance);
        }
        grab.current = null;
    };
    const leaders: BatchLine[] = zeros.map((zero) => ({ points: [v3(zero.from), v3(zero.at)], color: '#d6dde8', width: 1, opacity: 0.7, renderOrder: 21 }));
    return (
        <>
            <LineBatch lines={leaders} />
            {zeros.map((zero) => (
                <group key={`${zero.kind}:${zero.key}`}>
                    <Html position={v3(zero.at)} center zIndexRange={[32, 0]} className="sk-label">
                        <button
                            type="button"
                            className="sk-dim sk-dim-zero"
                            title={zero.kind === 'ordinate'
                                ? 'The zero of this row: drag to move the row; drop it on another point or line to measure from that'
                                : 'The zero of these angles: drag to move their ring'}
                            onPointerDown={(e) => {
                                e.stopPropagation();
                                const hit = e.button === 0 ? sketchPointAt(e.clientX, e.clientY) : null;
                                if (hit) {
                                    e.currentTarget.setPointerCapture(e.pointerId);
                                    grab.current = { key: zero.key, du: zero.at[0] - hit.p[0], dv: zero.at[1] - hit.p[1], x: e.clientX, y: e.clientY, moved: false };
                                }
                            }}
                            onPointerMove={(e) => {
                                const held = grab.current;
                                if (held?.key !== zero.key || (!held.moved && Math.hypot(e.clientX - held.x, e.clientY - held.y) <= CLICK_SLOP_PX)) {
                                    return;
                                }
                                held.moved = true;
                                const hit = sketchPointAt(e.clientX, e.clientY);
                                if (hit) {
                                    moveZero(zero, [hit.p[0] + held.du, hit.p[1] + held.dv]);
                                }
                            }}
                            onPointerUp={(e) => {
                                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                                    e.currentTarget.releasePointerCapture(e.pointerId);
                                }
                                drop(zero, e);
                            }}
                            onPointerCancel={() => {
                                grab.current = null;
                            }}
                            onClick={(e) => selectConstraint(zero.members[0], e.shiftKey)}
                        >
                            {zero.kind === 'ordinate' ? '0' : '0°'}
                        </button>
                    </Html>
                </group>
            ))}
        </>
    );
}

/** Ghost image on drag: the sketch as it was when the drag began, faint under what is dragged. */
function DragGhost() {
    const from = useSketcher((s) => (s.settings.ghostOnDrag && s.drag?.moved ? s.dragFrom : null));
    const lines = useMemo((): BatchLine[] => (from ? polylines(from).map((points) => ({
        points, color: GHOST, width: 1.4, opacity: 0.45, dashed: true, dashSize: 1.5, gapSize: 1, renderOrder: 19,
    })) : []), [from]);
    return <LineBatch lines={lines} />;
}

/** The No solve move as a preview, made once per question. */
function MovedPreview({ moved }: { moved: SketchGeometry }) {
    const lines = useMemo(() => polylines(moved).map((points): BatchLine => ({
        points, color: PREVIEW, width: 2, dashed: true, dashSize: 2, gapSize: 1.5, renderOrder: 21,
    })), [moved]);
    return <LineBatch lines={lines} />;
}

/** No solve move: the move as a preview, and the question what to do with what it breaks. */
function NoSolveQuestion() {
    const pending = useNoSolve((s) => s.pending);
    const describe = useSketcher((s) => s.geometry);
    if (!pending) {
        return null;
    }
    const names = [...new Set(pending.broken.map((id) => describe.constraints.find((c) => c.id === id)?.kind).filter(Boolean))];
    return (
        <>
            <MovedPreview moved={pending.moved} />
            <Html position={v3(pending.at)} center zIndexRange={[40, 0]} className="sk-label">
                <div className="sk-dim-input sk-dim-choice" onPointerDown={(e) => e.stopPropagation()}>
                    <small>
                        This move breaks {pending.broken.length} relation{pending.broken.length === 1 ? '' : 's'} or dimension{pending.broken.length === 1 ? '' : 's'}
                        {names.length ? ` (${names.join(', ')})` : ''} to the rest of the sketch.
                    </small>
                    <button type="button" autoFocus onClick={() => answerNoSolve('delete')}>Delete them and move</button>
                    <button type="button" onClick={() => answerNoSolve('copy')}>Keep them: copy to the new place</button>
                    <button type="button" onClick={() => answerNoSolve('cancel')}>Cancel</button>
                </div>
            </Html>
        </>
    );
}

/** The leader lines of a preview dimension (a length, radius or diameter). */
function previewLines(g: SketchGeometry, c: NewConstraint, at: Pt, size: number): V3[][] {
    if (c.kind === 'length') {
        const line = g.curves.find((k) => k.id === c.line);
        const [a, b] = line?.kind === 'line' ? [pointOf(g, line.a), pointOf(g, line.b)] : [];
        return a && b ? linearLines([a.u, a.v], [b.u, b.v], at, size) : [];
    }
    if (c.kind === 'radius' || c.kind === 'diameter') {
        const curve = g.curves.find((k) => k.id === c.curve);
        const centre = curve && 'center' in curve ? pointOf(g, curve.center) : undefined;
        return centre ? [[v3([centre.u, centre.v]), v3(at)]] : [];
    }
    return [];
}

/** Preview sketch dimension when selected: each selected line, circle or arc shows its size; a click dimensions it. */
function PreviewDims({ size }: { size: number }) {
    const on = useSketcher((s) => s.settings.previewDims && s.tool === 'select' && !s.dimDraft && !s.drag);
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    if (!on) {
        return null;
    }
    return (
        <>
            {/* About 30 px beside the line at any zoom (`size` reads 9 px), not a fixed few mm: a short line keeps it close. */}
            {previewDimensions(g, selection, size * 3.5).map(({ c, at, key }) => {
                const value = measure(g, { ...c, id: 'preview' } as SketchConstraint) ?? 0;
                const text = c.kind === 'diameter' ? `Ø${shownText(value)}` : c.kind === 'radius' ? `R${shownText(value)}` : shownText(value);
                return (
                    <group key={key}>
                        <LineBatch lines={previewLines(g, c, at, size).map((points) => ({
                            points, color: PREVIEW, width: 1, dashed: true, dashSize: size * 0.5, gapSize: size * 0.4, renderOrder: 21,
                        }))} />
                        <Html position={v3(at)} center zIndexRange={[32, 0]} className="sk-label">
                            <button
                                type="button"
                                className="sk-dim sk-dim-preview"
                                title="Preview: click to add this dimension and set its value"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => startDimension(c, at)}
                            >
                                {text}
                            </button>
                        </Html>
                    </group>
                );
            })}
        </>
    );
}

/** Where the context toolbar goes: above the last entity selected. */
function toolbarSpot(g: SketchGeometry, picks: Pick[]): Pt | null {
    const last = picks[picks.length - 1];
    const curve = last ? g.curves.find((c) => c.id === last.id) : undefined;
    const ids = curve ? ('a' in curve && curve.kind === 'line' ? [curve.a, curve.b] : 'center' in curve ? [curve.center] : []) : last ? [last.id] : [];
    const pts = ids.map((id) => pointOf(g, id)).filter((p): p is NonNullable<typeof p> => !!p);
    if (!pts.length) {
        return null;
    }
    return [pts.reduce((t, p) => t + p.u, 0) / pts.length, pts.reduce((t, p) => t + p.v, 0) / pts.length];
}

/**
 * The context toolbar of a selection of two or more entities (SolidWorks: Ctrl-select, then Make Parallel or Auto
 * Insert Dimension on the context toolbar), in the app's compact icon style.
 */
function ContextToolbar() {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const idle = useSketcher((s) => s.tool === 'select' && !s.dimDraft && !s.drag && !s.draft.length);
    // One context toolbar at a time: an Alt-clicked shaded area's own bar takes the place of this one.
    const contourBar = useContourBar((b) => !!b.at);
    const picks = selection.filter((x): x is Pick & { type: 'point' | 'curve' } => x.type !== 'constraint');
    if (!idle || contourBar || picks.length < 2) {
        return null;
    }
    const at = toolbarSpot(g, picks);
    if (!at) {
        return null;
    }
    const relations = fittingRelationTools(g, picks);
    const dimension = selectionDimension();
    if (!relations.length && !dimension) {
        return null;
    }
    const open = (id: string) => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id }));
    return (
        <Html position={v3(at)} zIndexRange={[38, 0]} className="sk-label">
            <div className="sk-context-bar" onPointerDown={(e) => e.stopPropagation()}>
                {relations.map((r) => (
                    <button key={r.id} type="button" title={`${r.label}: ${r.hint}`} aria-label={r.label} onClick={() => open(`sk-c-${r.id}`)}>
                        <Icon name={`c-${r.id}`} size={16} />
                    </button>
                ))}
                {dimension && (
                    <button type="button" title="Auto insert dimension: a dimension between the selected entities" aria-label="Auto insert dimension" onClick={() => autoInsertDimension()}>
                        <Icon name="dimension" size={16} />
                    </button>
                )}
            </div>
        </Html>
    );
}

/**
 * The Make Dimension Driven? choice of a new dimension that over defines the sketch, with its default as the Over
 * defining dimensions options say, and Don't ask again (the answer given becomes the action from then on).
 */
export function DrivenChoice() {
    const fallback = useSketcher((s) => s.settings.overDefDriven);
    const never = useRef(false);
    const choose = (driven: boolean) => {
        if (never.current) {
            rememberDrivenChoice(driven);
        }
        chooseDimensionDriven(driven);
    };
    return (
        <div className="sk-dim-input sk-dim-choice" onPointerDown={(e) => e.stopPropagation()}>
            <small>Adding this dimension will over define the sketch.</small>
            <button type="button" autoFocus={fallback} onClick={() => choose(true)}>Make this dimension driven</button>
            <button type="button" autoFocus={!fallback} onClick={() => choose(false)}>Leave this dimension driving</button>
            <button type="button" onClick={() => cancelDimension()}>Cancel</button>
            <label>
                <input
                    type="checkbox"
                    onChange={(e) => {
                        never.current = e.target.checked;
                    }}
                />
                Don't ask again
            </label>
        </div>
    );
}

/**
 * Display/Delete Relations' option "Show PropertyManager when the sketch becomes over defined or unsolvable": the
 * relations list opens, with the problems shown, when a change over defines the sketch or does not solve.
 */
function useRelationsOnError(): void {
    useEffect(() => useSketcher.subscribe((s, before) => {
        const worse = (s.conflicting.length > 0 && s.conflicting !== before.conflicting && !before.conflicting.length)
            || s.redundant.length > before.redundant.length;
        if (s.settings.relationsOnError && s.active && worse && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'sk-relations' }));
        }
    }), []);
}

/** Everything above, in the sketch's plane (Drawing in SketchDrawing.tsx mounts it; it redraws on its own changes). */
export const DimExtrasDrawing = memo(function DimExtrasDrawing({ unit }: { unit: number }) {
    useRelationsOnError();
    return (
        <>
            <ZeroLabels />
            <DragGhost />
            <NoSolveQuestion />
            <PreviewDims size={unit} />
            <ContextToolbar />
        </>
    );
});
