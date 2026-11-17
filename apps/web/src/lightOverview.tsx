// The overview on Options > Lighting: a small 3D view of the model with its lights. Directional lights sit on a dome
// round the model with an arrow to it, the environment's light panels on a wider dome, point and spot lights where
// they stand, and the main view's camera as a frustum. It is drawn with the lighting being edited; a light is dragged
// to move it (lightMath.ts) and a click on one picks its row in the list. It turns, pans and zooms as the main view.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { CameraControls, CameraControlsImpl, Grid, Line } from '@react-three/drei';
import {
    Box3, BufferGeometry, DoubleSide, Float32BufferAttribute, MathUtils, Object3D, Quaternion, Raycaster, Sphere, Vector2, Vector3, type Group,
    type PerspectiveCamera,
} from 'three';
import { explodeOffsets, type Part, type Project } from '@jarvis/core';
import { buildGeometry, instanceTransforms } from '@jarvis/core/geometry';
import type { LightingSettings } from '@jarvis/core/settings';
import { directionalWorld, dragLighting, lightKey, panelWorld, pointWorld, targetWorld, type Grab, type V3 } from './lightMath';
import { ErrorBoundary } from './ErrorBoundary';
import { useKernelMesh } from './meshes';
import { niceStep } from './numberText';
import { partLook } from './partView';
import { useStudio } from './state';
import { viewCamera, ViewLights } from './viewLights';

const SELECT_COLOR = '#c48bff';
const CAMERA_COLOR = '#d7e1ee';
const AXIS_COLORS = ['#ff4d5e', '#3ddc84', '#4d8dff'];
/** The directional lights' dome and the panels' dome, in model radii. */
const LIGHT_DOME = 1.6;
const PANEL_DOME = 2.1;
/** The view camera is drawn at most this many model radii from the model (it can stand much farther off). */
const CAMERA_REACH = 6;
const DRAG_SLOP_PX = 3;

/** A bounding sphere. */
interface Bounds {
    centre: V3;
    radius: number;
}

/** The model's bounding sphere, as the overview last saw it (new point and spot lights are placed by it). */
export const overviewModel: Bounds = { centre: [0, 0, 0], radius: 50 };

interface Snapshot {
    position: Vector3;
    quaternion: Quaternion;
    target: Vector3;
    fov: number;
    aspect: number;
}

const snapshot = (): Snapshot => ({
    position: viewCamera.position.clone(),
    quaternion: viewCamera.quaternion.clone(),
    target: viewCamera.target.clone(),
    fov: viewCamera.fov,
    aspect: viewCamera.aspect,
});

/** The main view's camera, followed while the page is open (it can turn on its own: Auto rotate). */
function useViewCamera(): Snapshot {
    const [shot, setShot] = useState(snapshot);
    useEffect(() => {
        let seen = viewCamera.version;
        const timer = setInterval(() => {
            if (viewCamera.version !== seen) {
                seen = viewCamera.version;
                setShot(snapshot());
            }
        }, 250);
        return () => clearInterval(timer);
    }, []);
    return shot;
}

export interface OverviewProps {
    lighting: LightingSettings;
    background: string;
    /** The light picked (lightKey), or null. */
    selected: string | null;
    onSelect: (key: string) => void;
    onChange: (lighting: LightingSettings) => void;
}

interface Latest extends OverviewProps {
    centre: V3;
    view: Quaternion;
}

export function LightOverview(props: OverviewProps) {
    // The canvas is made once the page is on screen (never while the page is drawn as text, as in the tests).
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);
    const fit = useRef<(() => void) | null>(null);
    return (
        <div className="op-overview">
            <div className="op-overview-view">
                {ready && (
                    // Without WebGL (or after an error in it) only the overview stops, not the whole page.
                    <ErrorBoundary>
                        <Canvas frameloop="demand" shadows dpr={[1, 2]} camera={{ fov: 40, near: 0.1, far: 100000, position: [300, 250, 300] }}>
                            <OverviewScene {...props} fit={fit} />
                        </Canvas>
                    </ErrorBoundary>
                )}
                <button type="button" className="sk-small op-overview-fit" onClick={() => fit.current?.()} title="Zoom to fit the model, the lights and the camera">
                    Fit
                </button>
            </div>
            <p className="op-overview-help">
                Drag a light to move it; click one to pick its row. Turn, pan and zoom as in the main view. The frustum is the view's
                camera: lights that are not locked to the model turn with it, and show where they are for the view as it is now.
            </p>
        </div>
    );
}

function OverviewScene(props: OverviewProps & { fit: MutableRefObject<(() => void) | null> }) {
    const { lighting, background, selected, fit } = props;
    const project = useStudio((s) => s.project);
    const camera = useViewCamera();
    const invalidate = useThree((s) => s.invalidate);
    const [model, setModel] = useState<Bounds>({ centre: [0, 0, 0], radius: 50 });
    const onBounds = useCallback((b: Bounds) => setModel((m) => (m.radius === b.radius && m.centre.every((v, i) => v === b.centre[i]) ? m : b)), []);
    const R = model.radius * LIGHT_DOME;
    const latest = useRef<Latest>({ ...props, centre: model.centre, view: camera.quaternion });
    latest.current = { ...props, centre: model.centre, view: camera.quaternion };
    const handles = useRef<Group>(null);
    useEffect(() => {
        overviewModel.centre = model.centre;
        overviewModel.radius = model.radius;
    }, [model]);
    useEffect(() => invalidate(), [lighting, camera, model, selected, background, invalidate]);
    return (
        <>
            <color attach="background" args={[background]} />
            <ViewLights lighting={lighting} view={camera.quaternion} />
            <Model project={project} onBounds={onBounds} />
            <Guides centre={model.centre} radius={R} />
            <group ref={handles}>
                <Markers lighting={lighting} selected={selected} centre={model.centre} radius={model.radius} view={camera.quaternion} />
            </group>
            <CameraIcon camera={camera} centre={model.centre} radius={model.radius} />
            <CameraControls makeDefault dollyToCursor smoothTime={0.15} draggingSmoothTime={0.06} />
            <Framer model={model} lighting={lighting} camera={camera} fit={fit} />
            <Dragger handles={handles} latest={latest} />
        </>
    );
}

// ---- The model ------------------------------------------------------------------------------------------------------

function Model({ project, onBounds }: { project: Project | null; onBounds: (b: Bounds) => void }) {
    const group = useRef<Group>(null);
    const [version, setVersion] = useState(0);
    const workspace = useStudio((s) => s.workspace);
    const activePart = useStudio((s) => s.activePart);
    const partView = useStudio((s) => s.partView);
    // The parts the main view shows (the part workspace may show the edited part alone).
    const all = project?.parts ?? [];
    const active = all.some((p) => p.id === activePart) ? activePart : null;
    const parts = all.filter((p) => partLook(p.id, { workspace, activePart: active, partView, focus: project?.view.focus ?? null }) !== 'hidden');
    const offsets = useMemo(() => (project ? explodeOffsets(project) : {}), [project]);
    const explode = project?.view.explode ?? 0;
    useEffect(() => {
        const g = group.current;
        if (!g) {
            return;
        }
        g.updateWorldMatrix(true, true);
        const box = new Box3().setFromObject(g);
        if (box.isEmpty()) {
            onBounds({ centre: [0, 0, 0], radius: 50 });
            return;
        }
        const sphere = box.getBoundingSphere(new Sphere());
        onBounds({ centre: sphere.center.toArray(), radius: Math.max(sphere.radius, 1) });
    }, [version, project, workspace, activePart, partView]);
    return (
        <group ref={group}>
            {parts.map((part) => (
                <OverviewPart key={part.id} part={part} explode={explode} offset={offsets[part.id] ?? [0, 0, 0]} onMesh={() => setVersion((v) => v + 1)} />
            ))}
            {parts.length === 0 && (
                // Nothing to show: a plain ball on the ground, to see the light on.
                <mesh position={[0, 40, 0]} castShadow receiveShadow>
                    <sphereGeometry args={[40, 48, 32]} />
                    <meshPhysicalMaterial color="#9aa3b2" metalness={0.1} roughness={0.45} />
                </mesh>
            )}
        </group>
    );
}

function OverviewPart({ part, offset, explode, onMesh }: { part: Part; offset: V3; explode: number; onMesh: () => void }) {
    const kernel = useKernelMesh(part.id);
    const preview = useMemo(() => buildGeometry(part.shape), [JSON.stringify(part.shape)]);
    const geometry = kernel?.surface ?? preview;
    const instances = useMemo(() => instanceTransforms(part), [JSON.stringify(part.repeat)]);
    useEffect(() => () => preview.dispose(), [preview]);
    useEffect(onMesh, [geometry]);
    const m = part.material;
    const rotation = part.rotation.map(MathUtils.degToRad) as V3;
    const opacity = m.opacity ?? 1;
    return (
        <group position={[offset[0] * explode, offset[1] * explode, offset[2] * explode]}>
            {instances.map((matrix, i) => (
                <group key={i} matrix={matrix} matrixAutoUpdate={false}>
                    {/* The mesh is shared with the main view: never disposed here. */}
                    <mesh geometry={geometry} position={part.position} rotation={rotation} castShadow receiveShadow dispose={null}>
                        <meshPhysicalMaterial
                            color={m.color}
                            metalness={m.metalness}
                            roughness={m.roughness}
                            emissive={m.emissive ?? '#000000'}
                            emissiveIntensity={m.emissiveIntensity ?? 1}
                            transparent={opacity < 1}
                            opacity={opacity}
                            side={DoubleSide}
                            clearcoat={m.clearcoat ?? (m.metalness > 0.5 ? 0.3 : 0)}
                            clearcoatRoughness={0.15}
                        />
                    </mesh>
                </group>
            ))}
        </group>
    );
}

// ---- Ground, axes and the dome ----------------------------------------------------------------------------------------

/** Rings of latitude every 30 degrees and meridians every 30 degrees, as line segments on a sphere. */
function domeLines(radius: number, equator: boolean): BufferGeometry {
    const out: number[] = [];
    const push = (a: V3, b: V3) => out.push(...a, ...b);
    const at = (lon: number, lat: number): V3 => {
        const o = MathUtils.degToRad(lon);
        const a = MathUtils.degToRad(lat);
        return [radius * Math.sin(o) * Math.cos(a), radius * Math.sin(a), radius * Math.cos(o) * Math.cos(a)];
    };
    const step = 6;
    for (const lat of equator ? [0] : [-60, -30, 30, 60]) {
        for (let lon = 0; lon < 360; lon += step) {
            push(at(lon, lat), at(lon + step, lat));
        }
    }
    if (!equator) {
        for (let lon = 0; lon < 360; lon += 30) {
            for (let lat = -90; lat < 90; lat += step) {
                push(at(lon, lat), at(lon, lat + step));
            }
        }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(out, 3));
    return geometry;
}

const noRaycast = () => null;

function Guides({ centre, radius }: { centre: V3; radius: number }) {
    const lines = useMemo(() => domeLines(radius, false), [radius]);
    const equator = useMemo(() => domeLines(radius, true), [radius]);
    useEffect(() => () => lines.dispose(), [lines]);
    useEffect(() => () => equator.dispose(), [equator]);
    const cell = niceStep(radius / 4);
    const axis = radius * 0.45;
    return (
        <>
            <Grid
                position={[0, -0.01 * cell, 0]}
                infiniteGrid
                cellSize={cell}
                sectionSize={cell * 5}
                cellThickness={0.6}
                sectionThickness={1}
                cellColor="#1c2533"
                sectionColor="#2c3a52"
                fadeDistance={radius * 10}
                fadeStrength={1.6}
                side={DoubleSide}
            />
            {[[axis, 0, 0], [0, axis, 0], [0, 0, axis]].map((end, i) => (
                <Line key={i} points={[[0, 0, 0], end as V3]} color={AXIS_COLORS[i]} lineWidth={2} raycast={noRaycast} />
            ))}
            <group position={centre}>
                <lineSegments geometry={lines} raycast={noRaycast}>
                    <lineBasicMaterial color="#3a4a63" transparent opacity={0.45} depthWrite={false} />
                </lineSegments>
                <lineSegments geometry={equator} raycast={noRaycast}>
                    <lineBasicMaterial color="#5f7698" transparent opacity={0.8} depthWrite={false} />
                </lineSegments>
            </group>
        </>
    );
}

// ---- Lights -----------------------------------------------------------------------------------------------------------

const UP = new Vector3(0, 1, 0);
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** What a drag on a marker takes: its light, whether it is a spot's target, the dome it is on, where it is. */
interface Handle {
    key: string;
    target: boolean;
    radius: number;
    world: V3;
}

/** An arrow from the origin of its group along `dir`, `length` long. */
function Arrow({ dir, length, size, color, opacity }: { dir: V3; length: number; size: number; color: string; opacity: number }) {
    const q = useMemo(() => new Quaternion().setFromUnitVectors(UP, new Vector3(...dir).normalize()), [dir[0], dir[1], dir[2]]);
    const shaft = length * 0.68;
    return (
        <group quaternion={q}>
            <mesh position={[0, shaft / 2, 0]}>
                <cylinderGeometry args={[size * 0.16, size * 0.16, shaft, 10]} />
                <meshBasicMaterial color={color} transparent opacity={opacity} />
            </mesh>
            <mesh position={[0, shaft + (length - shaft) / 2, 0]}>
                <coneGeometry args={[size * 0.42, length - shaft, 14]} />
                <meshBasicMaterial color={color} transparent opacity={opacity} />
            </mesh>
        </group>
    );
}

function Ball({ size, color, opacity, selected }: { size: number; color: string; opacity: number; selected: boolean }) {
    return (
        <>
            <mesh>
                <sphereGeometry args={[size, 20, 14]} />
                <meshBasicMaterial color={color} transparent opacity={opacity} />
            </mesh>
            {selected && (
                <mesh raycast={noRaycast}>
                    <sphereGeometry args={[size * 1.7, 16, 10]} />
                    <meshBasicMaterial color={SELECT_COLOR} wireframe transparent opacity={0.9} />
                </mesh>
            )}
        </>
    );
}

/** A dashed line from a point down (or up) to the ground, to read its height. */
function Drop({ p, color }: { p: V3; color: string }) {
    return Math.abs(p[1]) > 1e-6
        ? <Line points={[p, [p[0], 0, p[2]]]} color={color} lineWidth={1} dashed dashSize={Math.abs(p[1]) / 12} gapSize={Math.abs(p[1]) / 18} transparent opacity={0.5} raycast={noRaycast} />
        : null;
}

/** The cone of a spot light: its rim round the target and lines to it from the light. */
function coneLines(p: V3, t: V3, angle: number): BufferGeometry {
    const axis = new Vector3(...t).sub(new Vector3(...p));
    const length = axis.length();
    const out: number[] = [];
    if (length > 0) {
        axis.normalize();
        const u = new Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? UP : new Vector3(1, 0, 0)).normalize();
        const v = new Vector3().crossVectors(axis, u);
        // A cone opened to 90 degrees has no rim: draw it out to five times its length.
        const r = length * Math.min(Math.tan(MathUtils.degToRad(Math.min(angle, 89.9))), 5);
        const rim = (k: number): V3 => {
            const a = (k / 48) * Math.PI * 2;
            return add(t, [u.x * Math.cos(a) + v.x * Math.sin(a), u.y * Math.cos(a) + v.y * Math.sin(a), u.z * Math.cos(a) + v.z * Math.sin(a)], r);
        };
        for (let k = 0; k < 48; k++) {
            out.push(...rim(k), ...rim(k + 1));
            if (k % 6 === 0) {
                out.push(...p, ...rim(k));
            }
        }
        out.push(...p, ...t);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(out, 3));
    return geometry;
}

function Cone({ p, t, angle, color, opacity }: { p: V3; t: V3; angle: number; color: string; opacity: number }) {
    const geometry = useMemo(() => coneLines(p, t, angle), [...p, ...t, angle]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    return (
        <lineSegments geometry={geometry} raycast={noRaycast}>
            <lineBasicMaterial color={color} transparent opacity={opacity * 0.7} />
        </lineSegments>
    );
}

/** A light panel: its shape at its angular size, facing the model. */
function Panel({ form, width, height, color, opacity, selected }: { form: string; width: number; height: number; color: string; opacity: number; selected: boolean }) {
    const shape = form === 'rect' ? <planeGeometry args={[width, height]} />
        : form === 'ring' ? <ringGeometry args={[width * 0.25, width * 0.5, 48]} /> : <ringGeometry args={[0, width * 0.5, 48]} />;
    return (
        <>
            <mesh>
                {shape}
                <meshBasicMaterial color={color} side={DoubleSide} transparent opacity={opacity} depthWrite={false} />
            </mesh>
            {selected && (
                <mesh raycast={noRaycast}>
                    {shape}
                    <meshBasicMaterial color={SELECT_COLOR} wireframe side={DoubleSide} transparent opacity={0.9} />
                </mesh>
            )}
        </>
    );
}

function facing(from: V3, to: V3): Quaternion {
    const o = new Object3D();
    o.position.set(...from);
    o.lookAt(new Vector3(...to));
    return o.quaternion.clone();
}

function Markers(props: { lighting: LightingSettings; selected: string | null; centre: V3; radius: number; view: Quaternion }) {
    const { lighting, selected, centre, radius, view } = props;
    const R = radius * LIGHT_DOME;
    const panelR = radius * PANEL_DOME;
    const size = R * 0.045;
    const fade = (on: boolean) => (on ? 1 : 0.3);
    const grip = (h: Handle) => ({ grab: h });
    return (
        <>
            {lighting.directional.map((l) => {
                const key = lightKey('directional', l.id);
                const d = directionalWorld(l, view);
                const p = add(centre, d, R);
                return (
                    <group key={key} position={p} userData={grip({ key, target: false, radius: R, world: p })}>
                        <Ball size={size} color={l.color} opacity={fade(l.on)} selected={selected === key} />
                        <group position={[-d[0] * size * 1.3, -d[1] * size * 1.3, -d[2] * size * 1.3]}>
                            <Arrow dir={[-d[0], -d[1], -d[2]]} length={R * 0.28} size={size} color={l.color} opacity={fade(l.on)} />
                        </group>
                    </group>
                );
            })}
            {lighting.environment.formers.map((f) => {
                const key = lightKey('panel', f.id);
                const p = add(centre, panelWorld(f), panelR);
                const s = panelR / f.distance;
                const on = f.on && lighting.environment.on;
                return (
                    <group key={key} position={p} quaternion={facing(p, centre)} userData={grip({ key, target: false, radius: panelR, world: p })}>
                        <Panel form={f.form} width={f.width * s} height={f.height * s} color={f.color} opacity={on ? 0.5 : 0.15} selected={selected === key} />
                    </group>
                );
            })}
            {lighting.point.map((l) => {
                const key = lightKey('point', l.id);
                const p = pointWorld(l, view);
                return (
                    <group key={key}>
                        <group position={p} userData={grip({ key, target: false, radius: 0, world: p })}>
                            <Ball size={size * 1.1} color={l.color} opacity={fade(l.on)} selected={selected === key} />
                            <mesh raycast={noRaycast}>
                                <sphereGeometry args={[size * 2, 16, 10]} />
                                <meshBasicMaterial color={l.color} transparent opacity={l.on ? 0.15 : 0.05} depthWrite={false} />
                            </mesh>
                        </group>
                        <Drop p={p} color={l.color} />
                    </group>
                );
            })}
            {lighting.spot.map((l) => {
                const key = lightKey('spot', l.id);
                const p = pointWorld(l, view);
                const t = targetWorld(l, view);
                return (
                    <group key={key}>
                        <group position={p} userData={grip({ key, target: false, radius: 0, world: p })}>
                            <Ball size={size * 1.1} color={l.color} opacity={fade(l.on)} selected={selected === key} />
                        </group>
                        <group position={t} userData={grip({ key, target: true, radius: 0, world: t })}>
                            <mesh>
                                <octahedronGeometry args={[size * 0.85]} />
                                <meshBasicMaterial color={selected === key ? SELECT_COLOR : l.color} transparent opacity={fade(l.on)} wireframe />
                            </mesh>
                        </group>
                        <Cone p={p} t={t} angle={l.coneAngle} color={l.color} opacity={fade(l.on)} />
                        <Drop p={p} color={l.color} />
                    </group>
                );
            })}
        </>
    );
}

// ---- The view's camera ------------------------------------------------------------------------------------------------

/** Where the view camera is drawn: where it stands, or nearer along the same line when it stands far off. */
function cameraPlace(camera: Snapshot, centre: V3, radius: number): Vector3 {
    const c = new Vector3(...centre);
    const offset = camera.position.clone().sub(c);
    const reach = radius * CAMERA_REACH;
    return offset.length() > reach ? c.add(offset.setLength(reach)) : camera.position.clone();
}

function frustumLines(camera: Snapshot, at: Vector3, depth: number): BufferGeometry {
    const h = depth * Math.tan(MathUtils.degToRad(camera.fov) / 2);
    const w = h * camera.aspect;
    const local: V3[] = [[-w, -h, -depth], [w, -h, -depth], [w, h, -depth], [-w, h, -depth]];
    const corner = (v: V3): V3 => new Vector3(...v).applyQuaternion(camera.quaternion).add(at).toArray();
    const c = local.map(corner);
    const apex = at.toArray();
    const top: V3[] = [[-w * 0.4, h * 1.12, -depth], [0, h * 1.5, -depth], [w * 0.4, h * 1.12, -depth]].map((v) => corner(v as V3));
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
        out.push(...apex, ...c[i], ...c[i], ...c[(i + 1) % 4]);
    }
    out.push(...top[0], ...top[1], ...top[1], ...top[2], ...top[2], ...top[0]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(out, 3));
    return geometry;
}

function CameraIcon({ camera, centre, radius }: { camera: Snapshot; centre: V3; radius: number }) {
    const at = useMemo(() => cameraPlace(camera, centre, radius), [camera, centre, radius]);
    const geometry = useMemo(() => frustumLines(camera, at, radius * 0.5), [camera, at, radius]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    const target = camera.target.distanceTo(camera.position) > 1e-6 ? camera.target.toArray() : null;
    return (
        <>
            <lineSegments geometry={geometry} raycast={noRaycast}>
                <lineBasicMaterial color={CAMERA_COLOR} />
            </lineSegments>
            <mesh position={at} raycast={noRaycast}>
                <boxGeometry args={[radius * 0.12, radius * 0.12, radius * 0.12]} />
                <meshBasicMaterial color={CAMERA_COLOR} />
            </mesh>
            {target && (
                <Line points={[at.toArray(), target]} color={CAMERA_COLOR} lineWidth={1} dashed dashSize={radius * 0.08} gapSize={radius * 0.06} transparent opacity={0.5} raycast={noRaycast} />
            )}
        </>
    );
}

// ---- Framing and dragging -------------------------------------------------------------------------------------------

/** Zooms the overview to the model, the domes, the point and spot lights and the camera; again with Fit. */
function Framer({ model, lighting, camera, fit }: {
    model: Bounds; lighting: LightingSettings; camera: Snapshot; fit: MutableRefObject<(() => void) | null>;
}) {
    const controls = useThree((s) => s.controls) as CameraControlsImpl | null;
    const own = useThree((s) => s.camera) as PerspectiveCamera;
    const invalidate = useThree((s) => s.invalidate);
    const moved = useRef(false);
    const latest = useRef({ model, lighting, camera });
    latest.current = { model, lighting, camera };
    useEffect(() => {
        if (!controls) {
            return;
        }
        const frame = () => {
            const { model: m, lighting: l, camera: cam } = latest.current;
            const c = new Vector3(...m.centre);
            let reach = m.radius * PANEL_DOME * 1.2;
            const far = (p: V3) => {
                reach = Math.max(reach, new Vector3(...p).distanceTo(c));
            };
            l.point.forEach((x) => far(pointWorld(x, cam.quaternion)));
            l.spot.forEach((x) => {
                far(pointWorld(x, cam.quaternion));
                far(targetWorld(x, cam.quaternion));
            });
            far(cameraPlace(cam, m.centre, m.radius).toArray());
            const distance = (reach * 1.1) / Math.sin(MathUtils.degToRad(own.fov) / 2);
            // From the side of the view camera, a little above, so the camera and what it looks at both show.
            const from = cam.position.clone().sub(c);
            const azimuth = Math.atan2(from.x, from.z) + MathUtils.degToRad(70);
            const elevation = MathUtils.degToRad(32);
            const eye = new Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation))
                .multiplyScalar(distance).add(c);
            own.near = Math.max(distance / 5000, 0.001);
            own.far = distance * 50;
            own.updateProjectionMatrix();
            controls.minDistance = m.radius * 0.05;
            controls.maxDistance = distance * 20;
            void controls.setLookAt(eye.x, eye.y, eye.z, c.x, c.y, c.z, false);
            invalidate();
        };
        fit.current = () => {
            moved.current = false;
            frame();
        };
        const onStart = () => {
            moved.current = true;
        };
        controls.addEventListener('controlstart', onStart);
        return () => {
            controls.removeEventListener('controlstart', onStart);
            fit.current = null;
        };
    }, [controls, own, invalidate]);
    // Framed again as the model's meshes arrive, until the overview is turned or zoomed by hand.
    useEffect(() => {
        if (controls && !moved.current) {
            fit.current?.();
        }
    }, [controls, model]);
    return null;
}

/** Drags of the markers, and the middle button as the main view has it (turn; with Ctrl pan, with Shift zoom). */
function Dragger({ handles, latest }: { handles: MutableRefObject<Group | null>; latest: MutableRefObject<Latest> }) {
    const gl = useThree((s) => s.gl);
    const camera = useThree((s) => s.camera);
    const controls = useThree((s) => s.controls) as CameraControlsImpl | null;
    useEffect(() => {
        const canvas = gl.domElement;
        const raycaster = new Raycaster();
        const rayAt = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            raycaster.setFromCamera(new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
            return raycaster.ray;
        };
        const handleAt = (e: PointerEvent): Handle | null => {
            if (!handles.current) {
                return null;
            }
            rayAt(e);
            for (const hit of raycaster.intersectObjects(handles.current.children, true)) {
                for (let o: Object3D | null = hit.object; o; o = o.parent) {
                    if (o.userData.grab) {
                        return o.userData.grab as Handle;
                    }
                }
            }
            return null;
        };
        let drag: { grab: Grab; pointerId: number; at: [number, number]; moved: boolean } | null = null;
        let pending: ReturnType<typeof rayAt> | null = null;
        let frame = 0;
        const flush = () => {
            frame = 0;
            if (drag && pending) {
                const { lighting, onChange, centre, view } = latest.current;
                const next = dragLighting(lighting, drag.grab, pending, centre, view);
                if (next !== lighting) {
                    onChange(next);
                }
            }
            pending = null;
        };
        const end = () => {
            if (drag) {
                try {
                    canvas.releasePointerCapture(drag.pointerId);
                } catch {
                    // Already released.
                }
            }
            drag = null;
            if (controls) {
                controls.enabled = true;
            }
            canvas.style.cursor = '';
        };
        const down = (e: PointerEvent) => {
            if (e.target !== canvas) {
                return;
            }
            if (e.button === 1 && controls) {
                const { ACTION } = CameraControlsImpl;
                controls.mouseButtons.middle = e.ctrlKey || e.metaKey ? ACTION.TRUCK : e.shiftKey ? ACTION.DOLLY : ACTION.ROTATE;
                return;
            }
            const handle = e.button === 0 ? handleAt(e) : null;
            if (!handle) {
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            latest.current.onSelect(handle.key);
            const centre = new Vector3(...latest.current.centre);
            const back = new Vector3(...handle.world).sub(centre).dot(camera.position.clone().sub(centre)) < 0;
            const normal = camera.getWorldDirection(new Vector3()).toArray();
            drag = {
                grab: { key: handle.key, target: handle.target, radius: handle.radius, back, point: handle.world, normal },
                pointerId: e.pointerId,
                at: [e.clientX, e.clientY],
                moved: false,
            };
            if (controls) {
                controls.enabled = false;
            }
            try {
                canvas.setPointerCapture(e.pointerId);
            } catch {
                // Not capturable: the window listeners still follow it.
            }
            canvas.style.cursor = 'grabbing';
        };
        const move = (e: PointerEvent) => {
            if (drag) {
                if (e.pointerId !== drag.pointerId) {
                    return;
                }
                e.stopPropagation();
                if (!drag.moved && Math.hypot(e.clientX - drag.at[0], e.clientY - drag.at[1]) < DRAG_SLOP_PX) {
                    return;
                }
                drag.moved = true;
                pending = rayAt(e).clone();
                if (!frame) {
                    frame = requestAnimationFrame(flush);
                }
                return;
            }
            if (e.buttons === 0 && e.target === canvas) {
                canvas.style.cursor = handleAt(e) ? 'grab' : '';
            }
        };
        const up = (e: PointerEvent) => {
            if (drag && e.pointerId === drag.pointerId) {
                e.stopPropagation();
                if (frame) {
                    cancelAnimationFrame(frame);
                    flush();
                }
                end();
            }
        };
        // The middle button belongs to the view: no auto-scroll.
        const noScroll = (e: MouseEvent) => {
            if (e.button === 1 && e.target === canvas) {
                e.preventDefault();
            }
        };
        window.addEventListener('pointerdown', down, true);
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        canvas.addEventListener('mousedown', noScroll);
        return () => {
            cancelAnimationFrame(frame);
            end();
            window.removeEventListener('pointerdown', down, true);
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
            canvas.removeEventListener('mousedown', noScroll);
        };
    }, [gl, camera, controls]);
    return null;
}
