// Reference planes, axes and points of the active part drawn in the 3D view: planes as translucent bordered
// rectangles, axes as dash-dot lines, points as small crosses, each with its name. Hidden with the history tree's eye
// (or the right-click menu), like sketches. A click picks the step: as the sketch plane while one is being chosen, else into
// the open form's active reference box (or see refPickPatch). While the Plane, Axis or Point form is open, the base
// planes are drawn too, to click, with a see-through preview of what the form makes and marks on its picks (vertices,
// typed points, cylinder axes). While Revolve or the Axis tool is open, the lines of its sketch are drawn, to click.

import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { DoubleSide, Matrix4, Vector3, type Group } from 'three';
import type { Feature, Part, Vec3 } from '@jarvis/core';
import { resolveAxis, resolvePlane, sketchFrameOf } from '@jarvis/core/reference';
import { anim } from './Scene';
import { Label, v3 } from './SketchDrawing';
import { partMatrix, planePickerSize } from './SketchLayer';
import { choosePlane, useSketcher } from './sketcher';
import { useStudio } from './state';
import { offerTarget } from './viewMenu';
import { useToolSession } from './toolSession';
import { usePickSession, type PickItem } from './pickField';
import {
    axisDefinition, linePickTarget, planeCount, planeDefinition, pointSteps, refItem, refPickPatch, stepItem, type RefValues,
} from './referenceDefs';
import { useTreePicks, viewPick } from './treeSelection';
import { HelixCurves } from './HelixCurves';

/** Sends a clicked reference to the open form's active box, if that box takes references; true when it did. */
function pickIntoBox(partId: string, item: PickItem | null): boolean {
    const picks = usePickSession.getState();
    const box = picks.boxes.find((b) => b.key === picks.active);
    if (!item || item.kind !== 'ref' || !picks.pick || picks.partId !== partId || !box?.entities.includes('ref')) {
        return false;
    }
    picks.pick(item, (i) => i.kind === 'ref' && i.ref === item.ref);
    return true;
}

const COLOR = '#7fb2ff';
const HOVER = '#c48bff';
const CHOSEN = '#35e0ff';
const CLICK_SLOP_PX = 4;

/** Part-frame matrix with x = u, y = v, z = normal at `origin`. */
function frameMatrix(origin: Vec3, u: Vec3, v: Vec3, n: Vec3): Matrix4 {
    return new Matrix4().makeBasis(new Vector3(...u), new Vector3(...v), new Vector3(...n)).setPosition(new Vector3(...origin));
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const DRAFT = '__draft';

/** Click, hover and right-click behaviour shared by the reference items (none for the form's live preview). */
function usePick(part: Part, step: Feature) {
    const [hover, setHover] = useState(false);
    if (step.id === DRAFT) {
        return { hover: false, handlers: { raycast: () => null } };
    }
    const handlers = {
        // Hover does not stop the event: faces behind a big plane still highlight.
        onPointerOver: () => setHover(true),
        onPointerOut: () => setHover(false),
        onClick: (e: { delta: number; stopPropagation: () => void }) => {
            if (e.delta > CLICK_SLOP_PX) {
                return;
            }
            const sketcher = useSketcher.getState();
            if (step.op === 'plane' && sketcher.active && sketcher.stage === 'plane' && sketcher.partId === part.id) {
                e.stopPropagation();
                choosePlane({ planeRef: step.id }, 0);
                return;
            }
            if (pickIntoBox(part.id, stepItem(step))) {
                e.stopPropagation();
                return;
            }
            const session = useToolSession.getState();
            const patch = session.set ? refPickPatch(session.toolId, session.values as RefValues, step.op, step.id) : null;
            if (patch) {
                e.stopPropagation();
                session.set!(patch);
            } else if (!session.set) {
                // No form open: select the step in the feature tree (treeSelection.ts).
                viewPick(part.instanceOf ?? part.id, step.id);
            }
        },
        // The view's right-click menu (viewMenu.tsx): Sketch, Normal to, Edit, Hide.
        onContextMenu: () => offerTarget({ kind: 'reference', partId: part.id, featureId: step.id }),
    };
    return { hover, handlers };
}

function PlaneItem({ part, step, before, size, chosen }: { part: Part; step: Feature; before: Feature[]; size: number; chosen: boolean }) {
    const { hover, handlers } = usePick(part, step);
    const matrix = useMemo(() => {
        try {
            const p = resolvePlane({ planeRef: step.id }, [...before, step]);
            return frameMatrix(p.origin, p.xDir, cross(p.normal, p.xDir), p.normal);
        } catch {
            return null;
        }
    }, [step, before]);
    if (!matrix) {
        return null;
    }
    const h = size / 2;
    const color = hover ? HOVER : chosen ? CHOSEN : COLOR;
    return (
        <group matrixAutoUpdate={false} matrix={matrix}>
            <mesh renderOrder={12} {...handlers}>
                <planeGeometry args={[size, size]} />
                <meshBasicMaterial color={color} transparent opacity={hover ? 0.28 : 0.12} depthWrite={false} side={DoubleSide} />
            </mesh>
            <Line
                points={[[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]]}
                color={color}
                lineWidth={hover || chosen ? 2 : 1}
                transparent
                opacity={0.85}
                renderOrder={13}
            />
            <Label at={[-h, h]} className="plane">{step.name ?? step.id}</Label>
        </group>
    );
}

/** A base plane, drawn faintly while a reference form is open, to click into its box. */
function BasePlane({ part, name, size, chosen }: { part: Part; name: 'top' | 'front' | 'right'; size: number; chosen: boolean }) {
    const [hover, setHover] = useState(false);
    const matrix = useMemo(() => {
        const p = resolvePlane(name, []);
        return frameMatrix(p.origin, p.xDir, cross(p.normal, p.xDir), p.normal);
    }, [name]);
    const h = size / 2;
    const color = hover ? HOVER : chosen ? CHOSEN : COLOR;
    const item = refItem(name);
    return (
        <group matrixAutoUpdate={false} matrix={matrix}>
            <mesh
                renderOrder={11}
                onPointerOver={() => setHover(true)}
                onPointerOut={() => setHover(false)}
                onClick={(e) => {
                    if (e.delta <= CLICK_SLOP_PX && pickIntoBox(part.id, item)) {
                        e.stopPropagation();
                    }
                }}
            >
                <planeGeometry args={[size, size]} />
                <meshBasicMaterial color={color} transparent opacity={hover ? 0.18 : chosen ? 0.12 : 0.04} depthWrite={false} side={DoubleSide} />
            </mesh>
            <Line points={[[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]]} color={color} lineWidth={1}
                transparent opacity={hover || chosen ? 0.8 : 0.3} renderOrder={12} />
            {(hover || chosen) && <Label at={[-h, h]} className="plane">{item.kind === 'ref' ? item.label : name}</Label>}
        </group>
    );
}

/** Marks on the open form's picks the model does not show: vertices and typed points as dots, cylinder axes as lines. */
function PickMarks({ items, size }: { items: { item: PickItem; at?: Vec3 }[]; size: number }) {
    const s = size / 60;
    return (
        <group>
            {items.map(({ item, at }, i) => {
                const g = item.kind === 'ref' ? null : item.model?.geom;
                const dot = at ?? (item.kind === 'vertex' ? item.at : g?.type === 'circle' ? g.centre : null);
                if (dot) {
                    return (
                        <mesh key={i} position={dot} raycast={() => null} renderOrder={20}>
                            <sphereGeometry args={[s * 0.8, 12, 8]} />
                            <meshBasicMaterial color={CHOSEN} depthTest={false} transparent opacity={0.95} />
                        </mesh>
                    );
                }
                if (g?.type === 'cylinder' || g?.type === 'cone') {
                    const half = size / 3;
                    const a = g.point.map((c, k) => c - g.direction[k] * half) as Vec3;
                    const b = g.point.map((c, k) => c + g.direction[k] * half) as Vec3;
                    return <Line key={i} points={[a, b]} color={CHOSEN} lineWidth={1.6} dashed dashSize={size / 30} gapSize={size / 80}
                        depthTest={false} renderOrder={20} />;
                }
                return null;
            })}
        </group>
    );
}

function AxisItem({ part, step, before, size, chosen }: { part: Part; step: Feature; before: Feature[]; size: number; chosen: boolean }) {
    const { hover, handlers } = usePick(part, step);
    const ends = useMemo(() => {
        try {
            const a = resolveAxis({ axisRef: step.id }, [...before, step]);
            // Centred where the axis passes closest to the part origin.
            const t = -(a.point[0] * a.direction[0] + a.point[1] * a.direction[1] + a.point[2] * a.direction[2]);
            const at = (k: number): Vec3 => [0, 1, 2].map((i) => a.point[i] + a.direction[i] * (t + k)) as Vec3;
            return [at(-size / 2), at(size / 2)] as [Vec3, Vec3];
        } catch {
            return null;
        }
    }, [step, before, size]);
    if (!ends) {
        return null;
    }
    const color = hover ? HOVER : chosen ? CHOSEN : COLOR;
    return (
        <group>
            <Line points={ends} color={color} lineWidth={hover || chosen ? 2.6 : 1.6} dashed dashSize={size / 30} gapSize={size / 80}
                renderOrder={13} {...handlers} />
            <group position={ends[1]}>
                <Label at={[0, 0]} className="plane">{step.name ?? step.id}</Label>
            </group>
        </group>
    );
}

function PointItem({ part, step, size, chosen }: { part: Part; step: Extract<Feature, { op: 'point' }>; size: number; chosen: boolean }) {
    const { hover, handlers } = usePick(part, step);
    const s = size / 60;
    const color = hover ? HOVER : chosen ? CHOSEN : COLOR;
    return (
        <group position={step.position}>
            <mesh {...handlers}>
                <sphereGeometry args={[s * 0.6, 12, 8]} />
                <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
            </mesh>
            <Line points={[[-s * 2, 0, 0], [s * 2, 0, 0]]} color={color} lineWidth={1} renderOrder={13} />
            <Line points={[[0, -s * 2, 0], [0, s * 2, 0]]} color={color} lineWidth={1} renderOrder={13} />
            <Line points={[[0, 0, -s * 2], [0, 0, s * 2]]} color={color} lineWidth={1} renderOrder={13} />
            <Label at={[s * 2, s * 2]} className="plane">{step.name ?? step.id}</Label>
        </group>
    );
}

/** The lines of the sketch step the open Revolve or Axis form uses, to click one as the axis. */
function SketchLinePicker({ part }: { part: Part }) {
    const toolId = useToolSession((s) => s.toolId);
    const values = useToolSession((s) => s.values) as RefValues;
    const set = useToolSession((s) => s.set);
    const target = linePickTarget(toolId, values);
    const features = part.features ?? [];
    const index = target ? features.findIndex((f) => f.id === target.sketch && f.op === 'sketch') : -1;
    const step = index >= 0 ? features[index] : null;
    const lift = useRef<Group>(null);
    const camera = useThree((s) => s.camera);
    const [hover, setHover] = useState<string | null>(null);
    const lines = useMemo(() => {
        if (!step || step.op !== 'sketch' || !step.sketch.geometry) {
            return null;
        }
        try {
            const f = sketchFrameOf(step.sketch, features.slice(0, index));
            const g = step.sketch.geometry;
            const at = (id: string): [number, number] | null => {
                if (id === 'origin') return [0, 0];
                const p = g.points.find((q) => q.id === id);
                return p ? [p.u, p.v] : null;
            };
            const list = g.curves.flatMap((c) => {
                const a = c.kind === 'line' ? at(c.a) : null;
                const b = c.kind === 'line' ? at(c.b) : null;
                return a && b ? [{ id: c.id, a, b, construction: !!c.construction }] : [];
            });
            return { matrix: frameMatrix(f.origin, f.u, f.v, f.normal), list };
        } catch {
            return null;
        }
    }, [step, index, features]);
    // Lifted a hair towards the camera, so a click hits these before the sketch's own curves.
    useFrame(() => {
        const group = lift.current;
        if (!group?.parent) {
            return;
        }
        const eye = group.parent.worldToLocal(camera.position.clone());
        group.position.z = Math.sign(eye.z || 1) * Math.max(2e-3, Math.abs(eye.z) * 2e-4);
    });
    if (!target || !lines || !set) {
        return null;
    }
    const chosen = values[target.key];
    return (
        <group matrixAutoUpdate={false} matrix={lines.matrix}>
            <group ref={lift}>
                {lines.list.map((l) => {
                    const on = chosen === `${target.prefix}${l.id}`;
                    return (
                        <Line
                            key={l.id}
                            points={[v3(l.a), v3(l.b)]}
                            color={hover === l.id ? HOVER : on ? CHOSEN : '#e9eef6'}
                            lineWidth={on || hover === l.id ? 3.2 : 2}
                            dashed={l.construction}
                            dashSize={2}
                            gapSize={1}
                            depthTest={false}
                            renderOrder={19}
                            onPointerOver={(e) => {
                                e.stopPropagation();
                                setHover(l.id);
                            }}
                            onPointerOut={() => setHover((h) => (h === l.id ? null : h))}
                            onClick={(e) => {
                                if (e.delta <= CLICK_SLOP_PX) {
                                    e.stopPropagation();
                                    set({ [target.key]: `${target.prefix}${l.id}` });
                                }
                            }}
                        />
                    );
                })}
            </group>
        </group>
    );
}

/** The active part's reference planes, axes and points (part workspace). */
export function ReferenceGeometry({ part, offset }: { part: Part | null; offset: Vec3 }) {
    const workspace = useStudio((s) => s.workspace);
    const hidden = useStudio((s) => s.history?.view.hiddenSketches);
    const values = useToolSession((s) => s.values);
    const toolId = useToolSession((s) => s.toolId);
    const editing = useToolSession((s) => s.ctx?.edit?.feature?.id ?? null);
    const treePicks = useTreePicks((t) => (part && t.partId === (part.instanceOf ?? part.id) ? t.steps : null));
    // The Plane, Axis or Point form's planes, axis or points as they stand, drawn as a live preview.
    const drafts = useMemo((): Feature[] => {
        try {
            const v = values as RefValues;
            if (toolId === 'plane') {
                const count = editing ? 1 : Math.max(1, Math.min(50, planeCount(v)));
                return Array.from({ length: count }, (_, i): Feature => ({
                    id: DRAFT, name: count > 1 ? `Preview ${i + 1}` : 'Preview', op: 'plane', definition: planeDefinition(v, i + 1),
                }));
            }
            if (toolId === 'axis') {
                return [{ id: DRAFT, name: 'Preview', op: 'axis', definition: axisDefinition(v) }];
            }
            if (toolId === 'point') {
                return pointSteps(v, !!editing).map(({ position }): Feature => ({ id: DRAFT, name: 'Preview', op: 'point', position }));
            }
        } catch {
            return [];
        }
        return [];
    }, [toolId, values, editing]);
    // What the open form's boxes hold: steps to highlight, picks to mark.
    const boxItems = useMemo(() => Object.entries(values).flatMap(([key, value]) => (Array.isArray(value)
        ? (value as unknown[]).flatMap((item) => (typeof item === 'object' && item !== null && 'kind' in item ? [{ key, item: item as PickItem }] : []))
        : [])), [values]);
    const outer = useRef<Group>(null);
    const matrix = useMemo(() => partMatrix(part), [part?.position.join(), part?.rotation.join()]);
    useFrame(() => {
        outer.current?.position.set(offset[0] * anim.explode, offset[1] * anim.explode, offset[2] * anim.explode);
    });
    if (!part || workspace !== 'part') {
        return null;
    }
    const features = part.features ?? [];
    const hiddenSet = new Set(hidden ?? []);
    const size = planePickerSize(part) * 0.6;
    // Steps the open form refers to are drawn highlighted.
    const chosen = new Set(Object.values(values).flatMap((v) => (typeof v === 'string' ? [v, v.replace(/^axis:/, '')] : [])));
    for (const { item } of boxItems) {
        if (item.kind === 'ref') {
            chosen.add(item.ref.replace(/^(plane|axis|point):/, ''));
        }
    }
    // Steps selected in the feature tree (a folder selects all of its own).
    treePicks?.forEach((id) => chosen.add(id));
    const referenceForm = toolId === 'plane' || toolId === 'axis' || toolId === 'point';
    const marks = boxItems.flatMap(({ key, item }): { item: PickItem; at?: Vec3 }[] => {
        if (item.kind === 'ref' && item.ref === 'xyz') {
            const at = [0, 1, 2].map((i) => Number(values[`${key}p${i}`])) as Vec3;
            return at.every(Number.isFinite) ? [{ item, at }] : [];
        }
        return item.kind === 'ref' ? [] : [{ item }];
    });
    return (
        <group ref={outer}>
            <group matrixAutoUpdate={false} matrix={matrix}>
                {features.map((f, i) => {
                    // A plane, axis or point being edited is drawn as the form's preview instead.
                    if (f.suppressed || f.id === editing || hiddenSet.has(`${part.id}/${f.id}`)) {
                        return null;
                    }
                    const before = features.slice(0, i);
                    const on = chosen.has(f.id);
                    switch (f.op) {
                        case 'plane':
                            return <PlaneItem key={f.id} part={part} step={f} before={before} size={size} chosen={on} />;
                        case 'axis':
                            return <AxisItem key={f.id} part={part} step={f} before={before} size={size} chosen={on} />;
                        case 'point':
                            return <PointItem key={f.id} part={part} step={f} size={size} chosen={on} />;
                        default:
                            return null;
                    }
                })}
                {drafts.length > 0 && (() => {
                    const at = editing ? features.findIndex((f) => f.id === editing) : -1;
                    const before = (at >= 0 ? features.slice(0, at) : features).filter((f) => !f.suppressed);
                    return drafts.map((draft, i) => (draft.op === 'plane'
                        ? <PlaneItem key={i} part={part} step={draft} before={before} size={size} chosen />
                        : draft.op === 'axis'
                            ? <AxisItem key={i} part={part} step={draft} before={before} size={size} chosen />
                            : draft.op === 'point' ? <PointItem key={i} part={part} step={draft} size={size} chosen /> : null));
                })()}
                {referenceForm && (['top', 'front', 'right'] as const).map((name) => (
                    <BasePlane key={name} part={part} name={name} size={size} chosen={chosen.has(name)} />
                ))}
                {referenceForm && <PickMarks items={marks} size={size} />}
                <SketchLinePicker part={part} />
                <HelixCurves part={part} hidden={hiddenSet} chosen={chosen} editing={editing} />
            </group>
        </group>
    );
}
