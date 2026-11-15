// Drag handles for the open tool form (see toolHandles.ts): arrows for distances, a triad for Move, rings for
// Rotate, an arc for Revolve. They are drawn over the model at a constant size on screen. Pointer input is taken
// at the window, in the capture phase, before the part picking, the sketch catcher and the camera controls see it,
// so a press on a handle drags the handle and nothing else.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { Color, DoubleSide, MathUtils, Quaternion, Raycaster, Vector2, Vector3, type Camera, type Group, type Mesh, type PerspectiveCamera } from 'three';
import type { Vec3 } from '@jarvis/core';
import type { CameraControlsImpl } from '@react-three/drei';
import { pixelSizeAt, rayFromCamera } from './viewProjection';
import { anim } from './Scene';
import { useRegionPick } from './regionPick';
import { openSketchRegions, usePlaneFaces } from './sketchModelContours';
import { useSketcher } from './sketcher';
import { useStudio } from './state';
import { useToolSession } from './toolSession';
import {
    AXIS_COLORS, beginDrag, dragLabel, dragValues, gimbalAxes, gripId, gripShapes, handlesFor, pickGrip, PX, rotateAbout, tipOf,
    type Drag, type Handle, type HandleEnv, type Ray,
} from './toolHandles';
import type { Values } from './toolDefs';

const DISTANCE_COLOR = '#35e0ff';
const ORDER = 40;
const ZERO: Vec3 = [0, 0, 0];
const UP = new Vector3(0, 1, 0);
/** A press that moves less than this is a click, which changes nothing. */
const DRAG_SLOP_PX = 3;

const brighter = (color: string) => `#${new Color(color).lerp(new Color('#ffffff'), 0.55).getHexString()}`;

/** World units per pixel at `p`. */
function perPixel(camera: Camera, height: number, p: Vector3): number {
    const c = camera as PerspectiveCamera;
    if (c.isPerspectiveCamera) {
        return pixelSizeAt(c, p, height);
    }
    const o = camera as unknown as { top: number; bottom: number; zoom: number };
    return (o.top - o.bottom) / o.zoom / Math.max(1, height);
}

/** The point a handle is sized at. */
function anchorOf(h: Handle): Vec3 {
    return h.kind === 'distance' ? h.origin : h.kind === 'angle' ? h.origin : h.position;
}

/** Scales its children so one unit is one pixel on screen, wherever it is. */
function PixelGroup({ position, children }: { position: Vec3; children: ReactNode }) {
    const group = useRef<Group>(null);
    const size = useThree((s) => s.size);
    const at = useMemo(() => new Vector3(), []);
    useFrame(({ camera }) => {
        if (group.current) {
            group.current.getWorldPosition(at);
            group.current.scale.setScalar(perPixel(camera, size.height, at));
        }
    });
    return <group ref={group} position={position}>{children}</group>;
}

function material(color: string, opacity = 1) {
    return <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} toneMapped={false} />;
}

/** An arrow head (cone, pixel-sized) at `at`, pointing along `dir`. */
function Head({ at, dir, color }: { at: Vec3; dir: Vec3; color: string }) {
    const mesh = useRef<Mesh>(null);
    const size = useThree((s) => s.size);
    const q = useMemo(() => new Quaternion().setFromUnitVectors(UP, new Vector3(...dir).normalize()), [dir.join()]);
    const world = useMemo(() => new Vector3(), []);
    useFrame(({ camera }) => {
        const m = mesh.current;
        if (!m?.parent) {
            return;
        }
        world.set(...at);
        m.parent.localToWorld(world);
        const s = perPixel(camera, size.height, world);
        m.scale.set(PX.arrowHeadRadius * s, PX.arrowHead * s, PX.arrowHeadRadius * s);
        // The cone is centred on its origin: push it out so its base sits on the tip.
        m.position.set(at[0] + (dir[0] * PX.arrowHead * s) / 2, at[1] + (dir[1] * PX.arrowHead * s) / 2, at[2] + (dir[2] * PX.arrowHead * s) / 2);
    });
    return (
        <mesh ref={mesh} quaternion={q} renderOrder={ORDER + 1} raycast={() => null}>
            <coneGeometry args={[1, 1, 20]} />
            {material(color)}
        </mesh>
    );
}

function DistanceArrow({ h, hover }: { h: Extract<Handle, { kind: 'distance' }>; hover: (sign: 1 | -1) => boolean }) {
    const signs: (1 | -1)[] = h.symmetric ? [1, -1] : [1];
    return (
        <>
            {signs.map((sign) => {
                const tip = tipOf(h, sign);
                const dir = h.direction.map((c) => c * sign) as Vec3;
                const color = hover(sign) ? brighter(DISTANCE_COLOR) : DISTANCE_COLOR;
                return (
                    <group key={sign}>
                        <Line points={[h.origin, tip]} color={color} lineWidth={hover(sign) ? 3.5 : 2.5} depthTest={false} transparent
                            renderOrder={ORDER} />
                        <Head at={tip} dir={dir} color={color} />
                    </group>
                );
            })}
            <PixelGroup position={h.origin}>
                <mesh renderOrder={ORDER} raycast={() => null}>
                    <sphereGeometry args={[3, 16, 12]} />
                    {material(DISTANCE_COLOR, 0.9)}
                </mesh>
            </PixelGroup>
        </>
    );
}

const AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function Triad({ h, hovered }: { h: Extract<Handle, { kind: 'translate' }>; hovered: (id: string) => boolean }) {
    const [s0, s1] = PX.square.map((f) => f * PX.triad);
    return (
        <PixelGroup position={h.position}>
            {AXES.map((a, i) => {
                const on = hovered(`axis${i}`);
                const color = on ? brighter(AXIS_COLORS[i]) : AXIS_COLORS[i];
                const end = a.map((c) => c * PX.triad) as Vec3;
                return (
                    <group key={i}>
                        <Line points={[a.map((c) => c * PX.triadGap) as Vec3, end]} color={color} lineWidth={on ? 3.5 : 2.5}
                            depthTest={false} transparent renderOrder={ORDER} />
                        <mesh position={end.map((c, k) => c + (a[k] * PX.arrowHead) / 2) as Vec3}
                            quaternion={new Quaternion().setFromUnitVectors(UP, new Vector3(...a))} renderOrder={ORDER + 1} raycast={() => null}>
                            <coneGeometry args={[PX.arrowHeadRadius, PX.arrowHead, 20]} />
                            {material(color)}
                        </mesh>
                    </group>
                );
            })}
            {AXES.map((_, normal) => {
                const [i, j] = [(normal + 1) % 3, (normal + 2) % 3];
                const centre = [0, 0, 0] as Vec3;
                centre[i] = (s0 + s1) / 2;
                centre[j] = (s0 + s1) / 2;
                const on = hovered(`plane${normal}`);
                return (
                    <mesh key={normal} position={centre} renderOrder={ORDER} raycast={() => null}
                        quaternion={new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...AXES[normal]))}>
                        <planeGeometry args={[s1 - s0, s1 - s0]} />
                        <meshBasicMaterial color={on ? brighter(AXIS_COLORS[normal]) : AXIS_COLORS[normal]} transparent opacity={on ? 0.6 : 0.28}
                            depthTest={false} depthWrite={false} toneMapped={false} side={DoubleSide} />
                    </mesh>
                );
            })}
            <mesh renderOrder={ORDER} raycast={() => null}>
                <sphereGeometry args={[3.5, 16, 12]} />
                {material('#e6ebf3', 0.9)}
            </mesh>
        </PixelGroup>
    );
}

/** Ring points in pixel units about the group origin. */
function ring(axis: Vec3, radius: number, from = 0, to = 360, n = 72): Vec3[] {
    const a = new Vector3(...axis);
    const helper = Math.abs(a.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const e1 = helper.sub(a.clone().multiplyScalar(helper.dot(a))).normalize();
    const e2 = a.clone().cross(e1);
    return Array.from({ length: n + 1 }, (_, k) => {
        const t = MathUtils.degToRad(from + ((to - from) * k) / n);
        return e1.clone().multiplyScalar(radius * Math.cos(t)).addScaledVector(e2, radius * Math.sin(t)).toArray() as Vec3;
    });
}

function Rings({ h, hovered }: { h: Extract<Handle, { kind: 'rotate' }>; hovered: (id: string) => boolean }) {
    const axes = gimbalAxes(h.rotation);
    return (
        <PixelGroup position={h.position}>
            {axes.map((axis, i) => {
                const on = hovered(`ring${i}`);
                return (
                    <Line key={i} points={ring(axis, PX.ring * (1 - i * 0.04))} color={on ? brighter(AXIS_COLORS[i]) : AXIS_COLORS[i]}
                        lineWidth={on ? 4 : 2.5} depthTest={false} transparent opacity={on ? 1 : 0.85} renderOrder={ORDER} />
                );
            })}
            <mesh renderOrder={ORDER} raycast={() => null}>
                <sphereGeometry args={[3.5, 16, 12]} />
                {material('#e6ebf3', 0.9)}
            </mesh>
        </PixelGroup>
    );
}

function AngleArc({ h, on }: { h: Extract<Handle, { kind: 'angle' }>; on: boolean }) {
    const n = Math.max(2, Math.ceil(Math.abs(h.value) / 4));
    const from = h.start.map((c) => c * PX.ring) as Vec3;
    const points = Array.from({ length: n + 1 }, (_, k) => rotateAbout(from, h.axis, (h.value * k) / n));
    const color = on ? brighter(DISTANCE_COLOR) : DISTANCE_COLOR;
    const axis = h.axis.map((c) => c * PX.triad * 0.7) as Vec3;
    return (
        <PixelGroup position={h.origin}>
            <Line points={[axis.map((c) => -c) as Vec3, axis]} color="#e6ebf3" lineWidth={1} dashed dashSize={4} gapSize={4}
                depthTest={false} transparent opacity={0.5} renderOrder={ORDER} />
            <Line points={ring(h.axis, PX.ring)} color={DISTANCE_COLOR} lineWidth={1} depthTest={false} transparent opacity={0.25}
                renderOrder={ORDER} />
            <Line points={points} color={color} lineWidth={on ? 4 : 3} depthTest={false} transparent renderOrder={ORDER} />
            <mesh position={points[points.length - 1]} renderOrder={ORDER + 1} raycast={() => null}>
                <sphereGeometry args={[PX.knob, 16, 12]} />
                {material(color)}
            </mesh>
        </PixelGroup>
    );
}

/** Where the value label of a drag sits: at the arrow tip, else at the handle centre. */
function labelAt(drag: Drag, handles: Handle[], index: number): Vec3 {
    const live = handles[index] ?? drag.handle;
    if (live.kind === 'distance' && drag.grip.kind === 'tip') {
        return tipOf(live, drag.grip.sign);
    }
    return anchorOf(live);
}

interface Active {
    index: number;
    grip: string;
    drag: Drag;
    pointerId: number;
    at: [number, number];
    moved: boolean;
    /** Values of the keys the drag may write, as they were before it: Esc puts them back. */
    before: Values;
    controlsWere: boolean | null;
}

export function Manipulators({ offsets }: { offsets: Record<string, Vec3> }) {
    const toolId = useToolSession((s) => s.toolId);
    const values = useToolSession((s) => s.values);
    const ctx = useToolSession((s) => s.ctx);
    const picks = useRegionPick((s) => s.picked);
    const pickKey = useRegionPick((s) => s.sketchKey);
    // The open sketch, field by field (the whole sketcher state changes on every pointer move).
    const drawing = useSketcher((s) => s.active && s.stage === 'draw');
    const plane = useSketcher((s) => s.plane);
    const planeOffset = useSketcher((s) => s.offset);
    const context = useSketcher((s) => s.context);
    const geometry = useSketcher((s) => s.geometry);
    const sketchPart = useSketcher((s) => s.partId);
    const parts = useStudio((s) => s.history?.parts);
    const finishing = toolId === 'sk-finish' && drawing;
    const faces = usePlaneFaces((f) => f.known);
    const regions = useMemo(() => (finishing ? openSketchRegions(geometry) : []), [finishing, geometry, faces]);
    const env = useMemo<HandleEnv>(() => ({
        picks,
        pickKey,
        sketch: finishing ? {
            plane, offset: planeOffset, context, regions,
            points: geometry.points.filter((p) => p.id !== 'origin').map((p) => [p.u, p.v]),
            part: parts?.find((p) => p.id === sketchPart) ?? null, geometry,
        } : null,
    }), [picks, pickKey, finishing, plane, planeOffset, context, geometry, sketchPart, regions, parts]);
    const handles = useMemo(() => handlesFor(toolId, values, ctx, env), [toolId, values, ctx, env]);
    const partId = toolId === 'sk-finish' ? sketchPart : ctx?.part?.id;
    const offset = (partId && offsets[partId]) || ZERO;

    const camera = useThree((s) => s.camera);
    const gl = useThree((s) => s.gl);
    const size = useThree((s) => s.size);
    const viewControls = useThree((s) => s.controls) as CameraControlsImpl | null;

    // A depth arrow seen end-on is only a dot (the view is still square on to the sketch just drawn): tip the view
    // to a three-quarter angle so the arrow can be seen and pulled, as SolidWorks turns the view when a feature
    // starts from a sketch.
    const arrow = handles.find((h) => h.kind === 'distance');
    const arrowKey = arrow && arrow.kind === 'distance' ? `${toolId}:${arrow.direction.map((n) => Math.round(n * 100)).join()}` : null;
    useEffect(() => {
        if (!arrow || arrow.kind !== 'distance' || !viewControls) {
            return;
        }
        const view = camera.getWorldDirection(new Vector3());
        if (Math.abs(view.dot(new Vector3(...arrow.direction))) < 0.9) {
            return;
        }
        const polar = viewControls.polarAngle;
        const tipped = MathUtils.clamp(polar, MathUtils.degToRad(50), MathUtils.degToRad(65));
        void viewControls.rotate(MathUtils.degToRad(-35), tipped - polar, true);
    }, [arrowKey, viewControls]);
    const controls = useThree((s) => s.controls) as CameraControlsImpl | null;
    const shift = useRef<Group>(null);
    const [hover, setHover] = useState<string | null>(null);
    const [active, setActive] = useState<Active | null>(null);
    const latest = useRef({ handles, offset, camera, size, controls });
    latest.current = { handles, offset, camera, size, controls };

    useFrame(() => {
        shift.current?.position.set(offset[0] * anim.explode, offset[1] * anim.explode, offset[2] * anim.explode);
    });

    useEffect(() => {
        const canvas = gl.domElement;
        const raycaster = new Raycaster();
        let current: Active | null = null;
        let pending: Values | null = null;
        let frame = 0;
        let pressedAt = -Infinity;
        let hoverId: string | null = null;

        const shiftNow = (): Vec3 => latest.current.offset.map((c) => c * anim.explode) as Vec3;
        const pointerOf = (e: MouseEvent): [number, number] => {
            const rect = canvas.getBoundingClientRect();
            return [e.clientX - rect.left, e.clientY - rect.top];
        };
        const rayOf = (e: MouseEvent): Ray => {
            const rect = canvas.getBoundingClientRect();
            const { camera: cam } = latest.current;
            rayFromCamera(raycaster, new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), cam);
            const s = shiftNow();
            const o = raycaster.ray.origin;
            return { origin: [o.x - s[0], o.y - s[1], o.z - s[2]], direction: raycaster.ray.direction.toArray() as Vec3 };
        };
        /** The grip under the pointer, as (handle index, grip). */
        const hitAt = (e: MouseEvent) => {
            const { handles: hs, camera: cam } = latest.current;
            const rect = canvas.getBoundingClientRect();
            const s = shiftNow();
            const v = new Vector3();
            const project = (p: Vec3): [number, number] | null => {
                v.set(p[0] + s[0], p[1] + s[1], p[2] + s[2]).project(cam);
                return v.z > 1 ? null : [((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height];
            };
            const pointer = pointerOf(e);
            for (let index = 0; index < hs.length; index++) {
                const a = anchorOf(hs[index]);
                const perPx = perPixel(cam, rect.height, new Vector3(a[0] + s[0], a[1] + s[1], a[2] + s[2]));
                const shape = pickGrip(gripShapes(hs[index], perPx), project, pointer);
                if (shape) {
                    return { index, shape };
                }
            }
            return null;
        };
        const setHoverId = (id: string | null) => {
            if (id !== hoverId) {
                hoverId = id;
                setHover(id);
                canvas.style.cursor = id ? 'grab' : '';
            }
        };
        const write = (patch: Values) => {
            const session = useToolSession.getState();
            if (session.set && Object.entries(patch).some(([k, val]) => session.values[k] !== val)) {
                session.set(patch);
            }
        };
        const flush = () => {
            frame = 0;
            if (pending) {
                write(pending);
                pending = null;
            }
        };
        const end = (e?: PointerEvent) => {
            if (!current) {
                return;
            }
            cancelAnimationFrame(frame);
            flush();
            const { controls: c } = latest.current;
            if (c && current.controlsWere !== null) {
                c.enabled = current.controlsWere;
            }
            if (e && canvas.hasPointerCapture?.(current.pointerId)) {
                canvas.releasePointerCapture(current.pointerId);
            }
            current = null;
            setActive(null);
            canvas.style.cursor = hoverId ? 'grab' : '';
        };

        const down = (e: PointerEvent) => {
            if (e.button !== 0 || e.target !== canvas || current) {
                return;
            }
            const hit = hitAt(e);
            if (!hit) {
                return;
            }
            const handle = latest.current.handles[hit.index];
            const values = useToolSession.getState().values;
            const drag = beginDrag(handle, hit.shape.grip, rayOf(e), values);
            if (!drag) {
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            pressedAt = performance.now();
            const keys = handle.kind === 'translate' || handle.kind === 'rotate' ? handle.keys : [handle.key];
            const { controls: c } = latest.current;
            current = {
                index: hit.index, grip: gripId(hit.shape.grip), drag, pointerId: e.pointerId, at: pointerOf(e), moved: false,
                before: Object.fromEntries(keys.map((k) => [k, values[k]])), controlsWere: c ? c.enabled : null,
            };
            if (c) {
                c.enabled = false;
            }
            try {
                canvas.setPointerCapture(e.pointerId);
            } catch {
                // Not capturable (synthetic event): window listeners still follow it.
            }
            canvas.style.cursor = 'grabbing';
            setActive(current);
        };
        const move = (e: PointerEvent) => {
            if (current) {
                if (e.pointerId !== current.pointerId) {
                    return;
                }
                e.stopPropagation();
                const p = pointerOf(e);
                if (!current.moved && Math.hypot(p[0] - current.at[0], p[1] - current.at[1]) < DRAG_SLOP_PX) {
                    return;
                }
                current.moved = true;
                const { camera: cam } = latest.current;
                const a = anchorOf(current.drag.handle);
                const s = shiftNow();
                const perPx = perPixel(cam, canvas.getBoundingClientRect().height, new Vector3(a[0] + s[0], a[1] + s[1], a[2] + s[2]));
                const next = dragValues(current.drag, rayOf(e), { alt: e.altKey, shift: e.shiftKey, perPixel: perPx });
                if (next) {
                    pending = { ...pending, ...next };
                    if (!frame) {
                        frame = requestAnimationFrame(flush);
                    }
                }
                return;
            }
            // Hover only while no button is held (an orbit passing over a handle is not a hover).
            if (e.buttons === 0) {
                const hit = e.target === canvas ? hitAt(e) : null;
                setHoverId(hit ? `${hit.index}:${gripId(hit.shape.grip)}` : null);
            }
        };
        const up = (e: PointerEvent) => {
            if (current && e.pointerId === current.pointerId) {
                e.stopPropagation();
                end(e);
            }
        };
        // The click (and double click) that ends a press on a handle must not select or pick what is behind it.
        const click = (e: MouseEvent) => {
            if (performance.now() - pressedAt < (e.type === 'dblclick' ? 700 : 400) || current) {
                e.stopPropagation();
                if (e.type === 'click') {
                    pressedAt = e.detail > 1 ? pressedAt : -Infinity;
                }
            }
        };
        const key = (e: KeyboardEvent) => {
            if (current && e.key === 'Escape') {
                e.stopImmediatePropagation();
                e.preventDefault();
                cancelAnimationFrame(frame);
                frame = 0;
                pending = null;
                write(current.before);
                end();
            }
        };
        const leave = () => setHoverId(null);

        window.addEventListener('pointerdown', down, true);
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        window.addEventListener('click', click, true);
        window.addEventListener('dblclick', click, true);
        window.addEventListener('keydown', key, true);
        canvas.addEventListener('pointerleave', leave);
        return () => {
            end();
            cancelAnimationFrame(frame);
            window.removeEventListener('pointerdown', down, true);
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
            window.removeEventListener('click', click, true);
            window.removeEventListener('dblclick', click, true);
            window.removeEventListener('keydown', key, true);
            canvas.removeEventListener('pointerleave', leave);
            canvas.style.cursor = '';
        };
    }, [gl]);

    // Handles that went away (form closed, through-all ticked) end their hover.
    useEffect(() => {
        if (!handles.length && hover) {
            setHover(null);
            gl.domElement.style.cursor = '';
        }
    }, [handles.length]);

    if (!handles.length) {
        return null;
    }
    const lit = (index: number, id: string) => {
        const key = `${index}:${id}`;
        return active ? `${active.index}:${active.grip}` === key : hover === key;
    };
    return (
        <group ref={shift}>
            {handles.map((h, index) => {
                switch (h.kind) {
                    case 'distance':
                        return <DistanceArrow key={index} h={h} hover={(sign) => lit(index, `tip${sign}`)} />;
                    case 'translate':
                        return <Triad key={index} h={h} hovered={(id) => lit(index, id)} />;
                    case 'rotate':
                        return <Rings key={index} h={h} hovered={(id) => lit(index, id)} />;
                    case 'angle':
                        return <AngleArc key={index} h={h} on={lit(index, 'arc')} />;
                }
            })}
            {active?.moved && (
                <Html position={labelAt(active.drag, handles, active.index)} pointerEvents="none" zIndexRange={[30, 0]}>
                    <div className="mp-label">{dragLabel(active.drag, values)}</div>
                </Html>
            )}
        </group>
    );
}
