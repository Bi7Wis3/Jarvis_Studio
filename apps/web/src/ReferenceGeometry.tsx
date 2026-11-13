// Reference planes, axes and points of the active part drawn in the 3D view: planes as translucent bordered
// rectangles, axes as dash-dot lines, points as small crosses, each with its name. Hidden with the history tree's eye
// (or a right-click), like sketches. A click picks the step: as the sketch plane while one is being chosen, else for
// the open tool form (see refPickPatch). While Revolve or the Axis tool is open, the lines of its sketch are drawn
// too, to click as the axis.

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
import { setSketchHidden, useStudio } from './state';
import { useToolSession } from './toolSession';
import { axisDefinition, linePickTarget, planeDefinition, refPickPatch, type RefValues } from './referenceDefs';

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
            const session = useToolSession.getState();
            const patch = session.set ? refPickPatch(session.toolId, session.values as RefValues, step.op, step.id) : null;
            if (patch) {
                e.stopPropagation();
                session.set!(patch);
            }
        },
        onContextMenu: (e: { stopPropagation: () => void; nativeEvent: MouseEvent }) => {
            e.stopPropagation();
            e.nativeEvent.preventDefault();
            setSketchHidden(part.id, step.id, true);
        },
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
    // The Plane or Axis form's plane or axis as it stands, drawn as a live preview.
    const draft = useMemo((): Feature | null => {
        try {
            if (toolId === 'plane') {
                return { id: DRAFT, name: 'Preview', op: 'plane', definition: planeDefinition(values as RefValues) };
            }
            if (toolId === 'axis') {
                return { id: DRAFT, name: 'Preview', op: 'axis', definition: axisDefinition(values as RefValues) };
            }
        } catch {
            return null;
        }
        return null;
    }, [toolId, values]);
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
    return (
        <group ref={outer}>
            <group matrixAutoUpdate={false} matrix={matrix}>
                {features.map((f, i) => {
                    // A plane or axis being edited is drawn as the form's preview instead.
                    if (f.suppressed || (f.id === editing && f.op !== 'point') || hiddenSet.has(`${part.id}/${f.id}`)) {
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
                {draft && (() => {
                    const at = editing ? features.findIndex((f) => f.id === editing) : -1;
                    const before = (at >= 0 ? features.slice(0, at) : features).filter((f) => !f.suppressed);
                    return draft.op === 'plane'
                        ? <PlaneItem part={part} step={draft} before={before} size={size} chosen />
                        : <AxisItem part={part} step={draft} before={before} size={size} chosen />;
                })()}
                <SketchLinePicker part={part} />
            </group>
        </group>
    );
}
