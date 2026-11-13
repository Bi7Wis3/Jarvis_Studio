import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Canvas, events as pointerEvents, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
    CameraControls, CameraControlsImpl, ContactShadows, Environment, GizmoHelper, GizmoViewport, Grid, Lightformer, Line,
} from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import {
    Box3, BufferAttribute, BufferGeometry, DoubleSide, EdgesGeometry, MathUtils, Mesh, Plane, Raycaster, Sphere, Triangle, Vector2, Vector3, type Group, type PerspectiveCamera,
} from 'three';
import { explodeOffsets, shapeHalfExtents, type Part, type Project, type Vec3 } from '@jarvis/core';
import { buildGeometry, instanceTransforms } from '@jarvis/core/geometry';
import { layoutLabels } from './Labels';
import { useKernelMesh, type KernelMesh } from './meshes';
import { edgeSegments, faceSoup, nearestEdge, pixelSize, type P3, type PickedEntity } from './picking';
import { clearPicked, pickEntity, select, setWorkspace, useStudio } from './state';
import { chooseFace, useSketcher } from './sketcher';
import { planePickerSize, SketchLayer, SketchSteps, sketchView } from './SketchLayer';
import { PartDecals } from './Decals';

/** Animated values shared between the scene and the label overlay. */
export const anim = { explode: 0, settleAt: 0 };

const FIT_MS = 1800;
const DEFAULT_AZIMUTH = 28;
const DEFAULT_ELEVATION = 16;
const SELECT_COLOR = '#c48bff';
const CLICK_SLOP_PX = 4;
/** A pointer this close (screen pixels) to an edge picks the edge rather than the face under it. */
const EDGE_PICK_PX = 6;

// ---- Viewport pointer input --------------------------------------------------------------------------
// Every pointer event on the model goes through here, so other interaction modes (sketching) can take
// over in one place. `hover` is the surface point under the cursor, read by the cursor tracker.

const hover = { point: null as Vector3 | null, partId: null as string | null, normal: null as Vector3 | null };

/** World-space normal of the face under a pointer event. */
/** Triangles that use each vertex, per geometry (built on first use). */
const vertexTriangles = new WeakMap<object, Map<number, number[]>>();

function trianglesOf(geometry: Mesh['geometry']): Map<number, number[]> {
    let map = vertexTriangles.get(geometry);
    if (!map) {
        map = new Map();
        const index = geometry.getIndex();
        const count = index ? index.count : geometry.getAttribute('position').count;
        for (let t = 0; t < count / 3; t++) {
            for (let k = 0; k < 3; k++) {
                const v = index ? index.getX(t * 3 + k) : t * 3 + k;
                const list = map.get(v);
                if (list) {
                    list.push(t);
                } else {
                    map.set(v, [t]);
                }
            }
        }
        vertexTriangles.set(geometry, map);
    }
    return map;
}

/**
 * The surface under a pointer event, in the hit object's (part's) frame: point, the flat triangle normal and the
 * smooth (interpolated vertex) normal. `curved` when the triangles around the hit (the kernel shares vertices only
 * within one B-rep face) are not coplanar: a cylinder, sphere or freeform face rather than a planar one.
 */
function surfaceAt(event: ThreeEvent<PointerEvent | MouseEvent>): { point: Vector3; flat: Vector3; smooth: Vector3; curved: boolean } | null {
    const face = event.face;
    if (!face) {
        return null;
    }
    const point = event.object.worldToLocal(event.point.clone());
    const flat = face.normal.clone().normalize();
    const geometry = (event.object as Mesh).geometry;
    const positions = geometry?.getAttribute?.('position');
    const normals = geometry?.getAttribute?.('normal');
    if (!positions) {
        return { point, flat, smooth: flat.clone(), curved: false };
    }
    const at = (attr: typeof positions, i: number) => new Vector3().fromBufferAttribute(attr, i);
    const index = geometry.getIndex();
    const vertex = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const triangle = new Triangle();
    const n = new Vector3();
    let curved = false;
    const map = trianglesOf(geometry);
    for (const v of [face.a, face.b, face.c]) {
        for (const t of map.get(v) ?? []) {
            triangle.set(at(positions, vertex(t, 0)), at(positions, vertex(t, 1)), at(positions, vertex(t, 2))).getNormal(n);
            if (n.dot(flat) < Math.cos(MathUtils.degToRad(0.5))) {
                curved = true;
            }
        }
    }
    const smooth = flat.clone();
    if (curved && normals) {
        const [na, nb, nc] = [face.a, face.b, face.c].map((i) => at(normals, i).normalize());
        Triangle.getInterpolation(point, at(positions, face.a), at(positions, face.b), at(positions, face.c), na, nb, nc, smooth);
        smooth.normalize();
        // Vertex normals may face either way on double-sided meshes; keep the smooth normal on the outside.
        if (smooth.dot(flat) < 0) {
            smooth.negate();
        }
    }
    return { point, flat, smooth, curved };
}

/** World-space normal of the surface under a pointer event (interpolated on curved surfaces). */
function worldNormal(event: ThreeEvent<PointerEvent | MouseEvent>): Vector3 | null {
    const surface = surfaceAt(event);
    return surface ? surface.smooth.transformDirection(event.object.matrixWorld) : null;
}

const r1 = (v: number) => Math.round(v * 10) / 10 + 0;

function setCursor(point: Vector3 | null, onPart: boolean): void {
    const current = useStudio.getState().cursor;
    if (!point) {
        if (current) {
            useStudio.setState({ cursor: null });
        }
        return;
    }
    const rounded: [number, number, number] = [point.x, point.y, point.z].map((v) => Math.round(v * 10) / 10 + 0) as Vec3;
    if (current && current.onPart === onPart && current.point.every((v, i) => v === rounded[i])) {
        return;
    }
    const n = onPart ? hover.normal : null;
    useStudio.setState({
        cursor: {
            point: rounded,
            onPart,
            ...(onPart && hover.partId ? { partId: hover.partId } : {}),
            ...(n ? { normal: [r1(n.x * 100) / 100, r1(n.y * 100) / 100, r1(n.z * 100) / 100] as Vec3 } : {}),
        },
    });
}

type PartPointer = 'move' | 'out' | 'click' | 'dblclick';

/** Routes a pointer event on a part by interaction mode. Returns whether the part should show its hover glow. */
function onPartPointer(kind: PartPointer, part: Part, event: ThreeEvent<PointerEvent | MouseEvent>): boolean {
    const { mode, workspace } = useStudio.getState();
    if (mode === 'sketch') {
        const sketch = useSketcher.getState();
        // Picking the sketch plane: any face of the part being sketched on (a new part: of any part, in world terms).
        const own = part.id === sketch.partId;
        if (sketch.stage !== 'plane' || !event.face || (!own && sketch.partId !== null)) {
            return false;
        }
        if (kind === 'click' && event.delta <= CLICK_SLOP_PX) {
            event.stopPropagation();
            const surface = surfaceAt(event)!;
            let point = surface.point;
            let normal = surface.smooth;
            if (!own) {
                // A new part sits at the world origin, so its frame is the world.
                point = event.point.clone();
                normal = normal.clone().transformDirection(event.object.matrixWorld);
            }
            chooseFace([normal.x, normal.y, normal.z], [point.x, point.y, point.z], surface.curved);
        }
        if (kind === 'move') {
            event.stopPropagation();
        }
        return kind === 'move';
    }
    if (kind === 'dblclick') {
        event.stopPropagation();
        if (workspace === 'assembly') {
            setWorkspace('part', part.id);
        }
        return false;
    }
    if (kind === 'move') {
        event.stopPropagation();
        hover.point = event.point.clone();
        hover.partId = part.id;
        hover.normal = worldNormal(event);
    } else if (kind === 'out') {
        hover.point = null;
        hover.partId = null;
        hover.normal = null;
    } else if (kind === 'click') {
        event.stopPropagation();
        // A drag that orbits the camera is not a click.
        if (event.delta <= CLICK_SLOP_PX) {
            const normal = worldNormal(event);
            if (useStudio.getState().placingDecal && normal) {
                // Placing a decal: report the hit to the decal tools instead of selecting.
                const p = event.point;
                useStudio.setState({ decalHit: { partId: part.id, point: [p.x, p.y, p.z], normal: [normal.x, normal.y, normal.z] } });
            } else {
                select(part.id);
            }
        }
    }
    return kind === 'move';
}

/** Corner taken by the axis triad, whose clicks turn the camera and must not clear the selection. */
const TRIAD_PX = 124;

function onEmptyClick(event: MouseEvent): void {
    const canvas = event.target as HTMLElement;
    const onTriad = event.offsetX < TRIAD_PX && event.offsetY > canvas.clientHeight - TRIAD_PX;
    if (useStudio.getState().mode === 'select' && event.button === 0 && !onTriad) {
        select(null);
        clearPicked();
    }
}

type Entity = Pick<PickedEntity, 'kind' | 'index'>;

/**
 * The face or edge of a kernel mesh under a pointer event: the edge nearest the hit point if it is within
 * EDGE_PICK_PX on screen, else the face of the hit triangle.
 */
function entityAt(event: ThreeEvent<PointerEvent | MouseEvent>, kernel: KernelMesh, viewportHeight: number): Entity | null {
    if (event.faceIndex === undefined || event.faceIndex === null) {
        return null;
    }
    const camera = event.camera as typeof event.camera & { isPerspectiveCamera?: boolean; isOrthographicCamera?: boolean;
        fov: number; zoom: number; top: number; bottom: number };
    const depth = -event.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const pixel = camera.isOrthographicCamera
        ? pixelSize({ kind: 'orthographic', top: camera.top, bottom: camera.bottom, zoom: camera.zoom }, depth, viewportHeight)
        : pixelSize({ kind: 'perspective', fov: camera.fov, zoom: camera.zoom }, depth, viewportHeight);
    // Edges are in the mesh's own frame; the part transform is rigid, but divide out any scale to be safe.
    const tolerance = (EDGE_PICK_PX * pixel) / (event.object.matrixWorld.getMaxScaleOnAxis() || 1);
    const local = event.object.worldToLocal(event.point.clone());
    const edge = nearestEdge(kernel.edges.getAttribute('position').array, kernel.segEdge, [local.x, local.y, local.z], tolerance);
    if (edge !== null) {
        return { kind: 'edge', index: edge };
    }
    const face = kernel.triFace[event.faceIndex];
    return face === undefined ? null : { kind: 'face', index: face };
}

/** Overlay geometry of some faces (unindexed triangles), or null when there are none. */
function facesGeometry(kernel: KernelMesh, faces: number[]): BufferGeometry | null {
    if (faces.length === 0) {
        return null;
    }
    const positions = kernel.surface.getAttribute('position').array;
    const index = kernel.surface.getIndex()!.array;
    const parts = faces.map((f) => faceSoup(positions, index, kernel.triFace, f));
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        all.set(p, at);
        at += p.length;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(all, 3));
    return geometry;
}

/** Segment end points of some edges for drei's Line (in `segments` mode), or null when there are none. */
function edgesPoints(kernel: KernelMesh, edges: number[]): P3[] | null {
    const points: P3[] = [];
    const lines = kernel.edges.getAttribute('position').array;
    for (const e of edges) {
        const segments = edgeSegments(lines, kernel.segEdge, e);
        for (let i = 0; i < segments.length; i += 3) {
            points.push([segments[i], segments[i + 1], segments[i + 2]]);
        }
    }
    return points.length ? points : null;
}

/** Highlight of picked or hovered faces and edges, drawn over the part in its own frame. */
function PickOverlay({ faces, edges, strong }: { faces: BufferGeometry | null; edges: P3[] | null; strong: boolean }) {
    return (
        <>
            {faces && (
                <mesh geometry={faces} raycast={noRaycast} renderOrder={3}>
                    <meshBasicMaterial
                        color={SELECT_COLOR}
                        transparent
                        opacity={strong ? 0.45 : 0.22}
                        depthWrite={false}
                        side={DoubleSide}
                        polygonOffset
                        polygonOffsetFactor={-2}
                        polygonOffsetUnits={-2}
                        toneMapped={false}
                    />
                </mesh>
            )}
            {edges && (
                <Line
                    points={edges}
                    segments
                    color={SELECT_COLOR}
                    lineWidth={strong ? 4 : 3}
                    transparent={!strong}
                    opacity={strong ? 1 : 0.75}
                    polygonOffset
                    polygonOffsetFactor={-4}
                    polygonOffsetUnits={-4}
                    raycast={noRaycast}
                    renderOrder={4}
                />
            )}
        </>
    );
}

/** Keeps the cursor readout up to date: the hovered surface, else the ground plane under the pointer. */
function CursorTracker() {
    const ground = useMemo(() => new Plane(new Vector3(0, 1, 0), 0), []);
    const hit = useMemo(() => new Vector3(), []);
    useFrame(({ raycaster, pointer, camera }) => {
        if (hover.point) {
            setCursor(hover.point, true);
            return;
        }
        raycaster.setFromCamera(pointer, camera);
        setCursor(raycaster.ray.intersectPlane(ground, hit), false);
    });
    return null;
}

const noRaycast = () => null;

function PartMesh({ part, offset, dimmed }: { part: Part; offset: Vec3; dimmed: boolean }) {
    const sketching = useStudio((s) => s.mode === 'sketch');
    const placingDecal = useStudio((s) => !!s.placingDecal);
    const group = useRef<Group>(null);
    const preview = useMemo(() => buildGeometry(part.shape), [JSON.stringify(part.shape)]);
    const kernel = useKernelMesh(part.id);
    const geometry = kernel?.surface ?? preview;
    const instances = useMemo(() => instanceTransforms(part), [JSON.stringify(part.repeat)]);
    // The part workspace shows only the part being edited at full strength, so it needs no selection glow.
    const selected = useStudio((s) => s.selected === part.id && s.workspace !== 'part');
    const showEdges = useStudio((s) => s.edges);
    const [hovered, setHovered] = useState(false);
    // Face and edge picking: the active part in the part workspace, in plain select mode (sketching and decal
    // placement use clicks on the part themselves). Hover stays local so a mouse move re-renders only this part.
    const pickable = useStudio((s) => s.workspace === 'part' && s.mode === 'select' && s.activePart === part.id && !s.placingDecal)
        && !dimmed && !!kernel;
    const viewportHeight = useThree((s) => s.size.height);
    const allPicked = useStudio((s) => s.picked);
    const [hoverPick, setHoverPick] = useState<Entity | null>(null);
    const hoverRef = useRef<Entity | null>(null);
    const setHover = (entity: Entity | null) => {
        const current = hoverRef.current;
        if (current?.kind !== entity?.kind || current?.index !== entity?.index) {
            hoverRef.current = entity;
            setHoverPick(entity);
        }
    };
    const shownKernel = useRef(kernel);
    useEffect(() => {
        // Ordinals belong to one mesh: a new mesh of this part invalidates its picks.
        if (shownKernel.current && shownKernel.current !== kernel) {
            const { picked } = useStudio.getState();
            if (picked.some((p) => p.partId === part.id)) {
                useStudio.setState({ picked: picked.filter((p) => p.partId !== part.id) });
            }
        }
        shownKernel.current = kernel;
        setHover(null);
    }, [kernel]);
    useEffect(() => {
        if (!pickable) {
            setHover(null);
        }
    }, [pickable]);
    const hoverOverlay = useMemo(() => {
        if (!kernel || !hoverPick) {
            return { faces: null, edges: null };
        }
        return hoverPick.kind === 'face'
            ? { faces: facesGeometry(kernel, [hoverPick.index]), edges: null }
            : { faces: null, edges: edgesPoints(kernel, [hoverPick.index]) };
    }, [kernel, hoverPick]);
    const pickedOverlay = useMemo(() => {
        const mine = allPicked.filter((p) => p.partId === part.id);
        if (!kernel || mine.length === 0) {
            return { faces: null, edges: null };
        }
        return {
            faces: facesGeometry(kernel, mine.filter((p) => p.kind === 'face').map((p) => p.index)),
            edges: edgesPoints(kernel, mine.filter((p) => p.kind === 'edge').map((p) => p.index)),
        };
    }, [kernel, allPicked, part.id]);
    useEffect(() => () => hoverOverlay.faces?.dispose(), [hoverOverlay]);
    useEffect(() => () => pickedOverlay.faces?.dispose(), [pickedOverlay]);
    // Outline for the selection highlight while the kernel mesh (with its real edges) is still building.
    const previewEdges = useMemo(() => (selected && !kernel ? new EdgesGeometry(preview, 30) : null), [selected, kernel, preview]);
    const edges = kernel?.edges ?? previewEdges;
    useEffect(() => () => preview.dispose(), [preview]);
    useEffect(() => () => previewEdges?.dispose(), [previewEdges]);
    useEffect(() => {
        if (kernel && (part.shape.kind === 'empty' || part.shape.kind === 'sketch')) {
            kernel.surface.computeBoundingBox();
            kernelBounds.set(part.id, kernel.surface.boundingBox!.clone());
            useBoundsVersion.setState((s) => ({ n: s.n + 1 }));
        }
    }, [kernel]);
    useEffect(() => () => {
        hover.point = null;
    }, []);
    useEffect(() => {
        if (!hovered) {
            return;
        }
        document.body.style.cursor = useStudio.getState().placingDecal ? 'crosshair' : 'pointer';
        return () => {
            document.body.style.cursor = '';
        };
    }, [hovered]);

    useFrame(() => {
        group.current?.position.set(offset[0] * anim.explode, offset[1] * anim.explode, offset[2] * anim.explode);
    });

    const m = part.material;
    // While sketching every part turns see-through, so a sketch on the ground or inside a part stays visible.
    const opacity = dimmed ? 0.08 : sketching ? Math.min(m.opacity ?? 1, 0.25) : m.opacity ?? 1;
    const plain = dimmed || sketching;
    const rotation = part.rotation.map(MathUtils.degToRad) as Vec3;
    // While picking faces and edges the overlay shows what is under the pointer instead of a whole-part glow.
    const highlight = selected ? 0.16 : hovered && !dimmed && !pickable ? 0.07 : 0;
    const handlers = dimmed && !placingDecal ? { raycast: noRaycast } : {
        raycast: Mesh.prototype.raycast,
        onPointerMove: (e: ThreeEvent<PointerEvent>) => {
            setHovered(onPartPointer('move', part, e));
            if (pickable && kernel) {
                setHover(entityAt(e, kernel, viewportHeight));
            }
        },
        onPointerOut: (e: ThreeEvent<PointerEvent>) => {
            onPartPointer('out', part, e);
            setHovered(false);
            setHover(null);
        },
        onClick: (e: ThreeEvent<MouseEvent>) => {
            onPartPointer('click', part, e);
            if (pickable && kernel && e.delta <= CLICK_SLOP_PX) {
                const entity = entityAt(e, kernel, viewportHeight);
                if (entity) {
                    pickEntity({ partId: part.id, ...entity }, e.shiftKey);
                }
            }
        },
        onDoubleClick: (e: ThreeEvent<MouseEvent>) => onPartPointer('dblclick', part, e),
    };
    return (
        <group ref={group}>
            {instances.map((matrix, i) => (
                <group key={i} matrix={matrix} matrixAutoUpdate={false}>
                    <mesh
                        geometry={geometry}
                        position={part.position}
                        rotation={rotation}
                        castShadow={!sketching}
                        receiveShadow
                        userData={{ partId: part.id }}
                        {...handlers}
                    >
                        <PartDecals part={part} />
                        <meshPhysicalMaterial
                            color={m.color}
                            metalness={m.metalness}
                            roughness={m.roughness}
                            emissive={highlight ? SELECT_COLOR : m.emissive ?? '#000000'}
                            emissiveIntensity={plain ? 0 : highlight || (m.emissiveIntensity ?? 1)}
                            transparent={opacity < 1}
                            opacity={opacity}
                            depthWrite={opacity >= 1}
                            side={DoubleSide}
                            clearcoat={plain ? 0 : m.clearcoat ?? (m.metalness > 0.5 ? 0.3 : 0)}
                            clearcoatRoughness={0.15}
                            transmission={plain ? 0 : m.transmission ?? 0}
                            thickness={m.transmission ? 2 : 0}
                        />
                    </mesh>
                    {edges && !dimmed && (selected || (kernel && (showEdges || sketching))) && (
                        <lineSegments geometry={edges} position={part.position} rotation={rotation} raycast={noRaycast}>
                            <lineBasicMaterial
                                color={selected ? SELECT_COLOR : sketching ? '#9fb4d0' : '#000000'}
                                transparent
                                opacity={selected ? 1 : sketching ? 0.45 : 0.35}
                                depthWrite={!sketching}
                            />
                        </lineSegments>
                    )}
                    {pickable && (
                        <group position={part.position} rotation={rotation}>
                            <PickOverlay faces={pickedOverlay.faces} edges={pickedOverlay.edges} strong />
                            <PickOverlay faces={hoverOverlay.faces} edges={hoverOverlay.edges} strong={false} />
                        </group>
                    )}
                    {edges && selected && (
                        // Hidden edges of the selection, faint, as CAD programs show them.
                        <lineSegments
                            geometry={edges}
                            position={part.position}
                            rotation={rotation}
                            raycast={noRaycast}
                            renderOrder={2}
                        >
                            <lineBasicMaterial color={SELECT_COLOR} transparent opacity={0.22} depthTest={false} />
                        </lineSegments>
                    )}
                </group>
            ))}
        </group>
    );
}

/** Kernel mesh bounds (part frame) of parts whose shape alone does not tell their size: empty and sketch bodies. */
const kernelBounds = new Map<string, Box3>();
const useBoundsVersion = create<{ n: number }>(() => ({ n: 0 }));

/** Bounding sphere of the model, or of the focused part, at the given explode factor. */
function boundsAt(project: Project, offsets: Record<string, Vec3>, focus: string | null): Sphere | null {
    const { explode } = project.view;
    const parts = project.parts.filter((p) => !focus || p.id === focus);
    if (parts.length === 0) {
        return null;
    }
    const box = new Box3();
    const half = new Vector3();
    for (const part of parts) {
        const offset = offsets[part.id];
        // Bodies built from sketch steps have no useful shape extents: use the kernel mesh once it is there.
        const real = kernelBounds.get(part.id);
        const centre = new Vector3();
        if (real) {
            real.getSize(half).multiplyScalar(0.5);
            real.getCenter(centre);
        } else {
            half.set(...shapeHalfExtents(part.shape));
        }
        const shift = new Vector3(offset[0], offset[1], offset[2]).multiplyScalar(explode);
        for (const instance of instanceTransforms(part)) {
            const at = new Vector3(...part.position).add(centre).applyMatrix4(instance).add(shift);
            box.expandByPoint(at.clone().add(half)).expandByPoint(at.clone().sub(half));
        }
    }
    return box.getBoundingSphere(new Sphere());
}

/** World centre of a part as drawn now (with the explode offset). */
function partCentre(part: Part, offset: Vec3 | undefined): Vector3 {
    const at = new Vector3(...part.position);
    if (offset) {
        at.add(new Vector3(...offset).multiplyScalar(anim.explode));
    }
    return at;
}

/**
 * Drives the explode animation and frames the camera when the view is asked for: a project opening, Fit or a view
 * button, a zoom to a part, exploding, or parts appearing in the assembly. Switching between a part and the
 * assembly, editing a part, hiding parts and resizing the window leave the camera where the user put it.
 * Camera moves are camera-controls transitions; they also clear any orbit pivot offset, so the fitted
 * object ends up centred.
 */
function Rig({ project, offsets }: { project: Project; offsets: Record<string, Vec3> }) {
    const camera = useThree((s) => s.camera) as PerspectiveCamera;
    const controls = useThree((s) => s.controls) as CameraControlsImpl | null;
    const size = useThree((s) => s.size);
    const fit = useRef({ angles: '', first: true, refit: 0, asked: '', ids: '', settleUntil: 0 });
    const refit = useStudio((s) => s.refit);
    const workspace = useStudio((s) => s.workspace);
    const activePart = useStudio((s) => s.activePart);
    const look = useSketcher((s) => s.look);
    const boundsVersion = useBoundsVersion((s) => s.n);
    const { view } = project;
    // The part workspace frames the part being edited; the assembly frames the focus or everything.
    const focus = workspace === 'part' && activePart && project.parts.some((p) => p.id === activePart) ? activePart : view.focus;
    // What asks for a new framing. Hidden parts are still counted, so hiding one does not move the camera.
    const asked = JSON.stringify([refit, project.name, view.focus, view.explode, view.explodeSpacing, view.azimuth, view.elevation, view.labels]);
    const ids = useStudio((s) => (s.history?.parts ?? []).map((p) => p.id).join());

    const moveTo = (position: Vector3, target: Vector3, smooth: boolean) => {
        if (!controls) {
            return;
        }
        void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, smooth);
        void controls.setFocalOffset(0, 0, 0, smooth);
        anim.settleAt = performance.now() + FIT_MS;
    };

    useEffect(() => {
        const sphere = boundsAt(project, offsets, focus);
        if (!controls || !sphere) {
            return;
        }
        const state = fit.current;
        // Parts added or removed reframe the assembly, but not the part being edited.
        const partsChanged = ids !== state.ids && workspace === 'assembly';
        // Real sizes of sketch-built parts arrive after the first framing: follow them for a moment.
        const settling = performance.now() < state.settleUntil;
        const wanted = state.first || asked !== state.asked || partsChanged || settling;
        state.ids = ids;
        if (!wanted) {
            return;
        }
        if (!settling || state.first || asked !== state.asked || partsChanged) {
            state.settleUntil = performance.now() + 4000;
        }
        state.asked = asked;
        if (refit !== state.refit) {
            // An explicit Fit or view button: apply the stored angles again even if they did not change.
            state.refit = refit;
            state.angles = '';
        }
        const verticalFov = MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const margin = view.labels ? 1.3 : 1.15;
        const distance = (Math.max(sphere.radius, 5) / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * margin;

        const angles = `${view.azimuth},${view.elevation}`;
        const direction = new Vector3();
        const target = controls.getTarget(new Vector3());
        if (state.first || (angles !== state.angles && (view.azimuth !== null || view.elevation !== null))) {
            const current = new Vector3().subVectors(camera.position, target).normalize();
            const azimuth = MathUtils.degToRad(
                view.azimuth ?? (state.first ? DEFAULT_AZIMUTH : MathUtils.radToDeg(Math.atan2(current.x, current.z))),
            );
            const elevation = MathUtils.degToRad(
                view.elevation ?? (state.first ? DEFAULT_ELEVATION : MathUtils.radToDeg(Math.asin(current.y))),
            );
            direction.set(
                Math.sin(azimuth) * Math.cos(elevation),
                Math.sin(elevation),
                Math.cos(azimuth) * Math.cos(elevation),
            );
        } else {
            camera.getWorldDirection(direction).negate();
        }
        state.angles = angles;
        const position = sphere.center.clone().addScaledVector(direction, distance);
        moveTo(position, sphere.center, !state.first);
        state.first = false;
    }, [asked, ids, boundsVersion, controls]);

    // Choosing a sketch plane: the three planes must be on screen and big enough to click. The camera only moves
    // when they are not (off to the side, tiny, or filling the view), and keeps its direction.
    const choosingPlane = useSketcher((s) => s.active && s.stage === 'plane');
    const sketchPartId = useSketcher((s) => s.partId);
    useEffect(() => {
        if (!controls || !choosingPlane) {
            return;
        }
        const part = project.parts.find((p) => p.id === sketchPartId) ?? null;
        const centre = part ? partCentre(part, offsets[part.id]) : new Vector3();
        const radius = planePickerSize(part) * 0.75;
        const distance = camera.position.distanceTo(centre);
        const onScreen = centre.clone().project(camera);
        const apparent = radius / (distance * Math.tan(MathUtils.degToRad(camera.fov) / 2));
        const visible = onScreen.z < 1 && Math.abs(onScreen.x) < 0.7 && Math.abs(onScreen.y) < 0.7 && apparent > 0.15 && apparent < 0.9;
        if (!visible) {
            const direction = camera.getWorldDirection(new Vector3()).negate();
            const fitted = (radius / Math.sin(MathUtils.degToRad(camera.fov) / 2)) * 1.6;
            moveTo(centre.clone().addScaledVector(direction, fitted), centre, true);
        }
    }, [choosingPlane, sketchPartId, controls]);

    // Sketching: turn to look straight at the sketch plane.
    useEffect(() => {
        const sketch = useSketcher.getState();
        if (!controls || !look || !sketch.active || sketch.stage !== 'draw') {
            return;
        }
        const part = project.parts.find((p) => p.id === sketch.partId) ?? null;
        const { centre, normal, radius } = sketchView(part);
        // Straight down (or up) has no azimuth: tilt a hair toward +Z so screen up is -Z, i.e. sketch +v.
        if (Math.abs(normal.y) > 0.999) {
            normal.set(0, Math.sign(normal.y), 0.002).normalize();
        }
        const distance = (radius * 1.8) / Math.sin(MathUtils.degToRad(camera.fov) / 2);
        moveTo(centre.clone().addScaledVector(normal, distance), centre, true);
    }, [look, controls]);

    useFrame((_, delta) => {
        anim.explode = MathUtils.damp(anim.explode, view.explode, 3.5, delta);
        if (controls && view.autoRotate && !controls.active) {
            // The same turntable speed OrbitControls had at autoRotateSpeed 1.4.
            void controls.rotate((2 * Math.PI / 60) * 1.4 * delta, 0, false);
        }
    });
    return null;
}

/**
 * CAD-style orbit pivot: a left drag turns around the selected part's centre, else around the point under the
 * pointer (a part surface, or the ground). setOrbitPoint keeps the camera exactly where it is, so nothing jumps.
 */
function Pivot({ project, offsets }: { project: Project; offsets: Record<string, Vec3> }) {
    const controls = useThree((s) => s.controls) as CameraControlsImpl | null;
    const gl = useThree((s) => s.gl);
    const camera = useThree((s) => s.camera);
    const scene = useThree((s) => s.scene);
    const connected = useThree((s) => s.events.connected) as HTMLElement | undefined;
    const latest = useRef({ project, offsets });
    latest.current = { project, offsets };

    useEffect(() => {
        if (!controls) {
            return;
        }
        // Listen where camera-controls does (the canvas wrapper), in the capture phase, so the pivot is set first.
        const element = connected ?? gl.domElement;
        const raycaster = new Raycaster();
        const ground = new Plane(new Vector3(0, 1, 0), 0);
        const down = (event: PointerEvent) => {
            if (event.button !== 0) {
                return;
            }
            const { project: p, offsets: o } = latest.current;
            const { selected, workspace, activePart } = useStudio.getState();
            const pivotPart = p.parts.find((part) => part.id === (workspace === 'part' ? activePart : selected));
            let point: Vector3 | null = pivotPart ? partCentre(pivotPart, o[pivotPart.id]) : null;
            if (!point) {
                const rect = gl.domElement.getBoundingClientRect();
                const ndc = new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
                raycaster.setFromCamera(ndc, camera);
                const hit = raycaster.intersectObjects(scene.children, true).find((h) => h.object.userData.partId);
                point = hit?.point ?? raycaster.ray.intersectPlane(ground, new Vector3());
                // A ground point at the horizon would be a useless pivot: keep the current one.
                if (point && !hit && point.distanceTo(camera.position) > 4 * controls.distance) {
                    point = null;
                }
            }
            if (point) {
                controls.setOrbitPoint(point.x, point.y, point.z);
            }
        };
        // Capture phase: set the pivot before camera-controls starts the drag.
        element.addEventListener('pointerdown', down, { capture: true });
        return () => element.removeEventListener('pointerdown', down, { capture: true });
    }, [controls, gl, connected, camera, scene]);
    return null;
}

function LabelDriver({ project, offsets }: { project: Project; offsets: Record<string, Vec3> }) {
    useFrame(({ camera, size }) => layoutLabels(project, offsets, anim.explode, camera, size.width, size.height));
    return null;
}

/** Ground grid in mm: 10 mm cells, 100 mm sections, fading out with distance. */
function GroundGrid() {
    const on = useStudio((s) => s.grid);
    if (!on) {
        return null;
    }
    return (
        <Grid
            position={[0, -0.3, 0]}
            infiniteGrid
            cellSize={10}
            sectionSize={100}
            cellThickness={0.6}
            sectionThickness={1}
            cellColor="#1c2533"
            sectionColor="#2c3a52"
            fadeDistance={2600}
            fadeStrength={1.6}
            side={DoubleSide}
            raycast={noRaycast}
        />
    );
}

export function Scene({ project }: { project: Project }) {
    const offsets = useMemo(() => explodeOffsets(project), [project]);
    const focus = project.view.focus;
    const workspace = useStudio((s) => s.workspace);
    const activePart = useStudio((s) => s.activePart);
    const showOthers = useSketcher((s) => s.showOthers);
    const sketchPart = useSketcher((s) => s.partId);
    const placingDecal = useStudio((s) => !!s.placingDecal);
    const activeShown = activePart !== null && project.parts.some((p) => p.id === activePart);
    return (
        <Canvas
            style={placingDecal ? { cursor: 'crosshair' } : undefined}
            onPointerMissed={onEmptyClick}
            // Pointer position from the canvas itself: the default reads it relative to whatever element is under
            // the cursor, so over an overlay (a dimension value, a label) it would jump to the top-left corner.
            events={(store) => ({
                ...pointerEvents(store),
                compute: (event, state) => {
                    const rect = state.gl.domElement.getBoundingClientRect();
                    state.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
                    state.raycaster.setFromCamera(state.pointer, state.camera);
                },
            })}
            shadows
            dpr={[1, 2]}
            camera={{ fov: 32, near: 1, far: 20000, position: [200, 150, 400] }}
            // The drawing buffer is kept so view_screenshot can read the canvas at any time.
            gl={{ antialias: true, preserveDrawingBuffer: true }}
        >
            <color attach="background" args={['#04060b']} />
            <ambientLight intensity={0.25} />
            <directionalLight position={[300, 600, 400]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} />
            <directionalLight position={[-400, 200, -300]} intensity={0.8} color="#6aa8ff" />
            <Environment resolution={256}>
                <Lightformer form="rect" intensity={5} position={[0, 8, 2]} rotation={[Math.PI / 2, 0, 0]} scale={[12, 6, 1]} />
                <Lightformer form="rect" intensity={2.5} position={[-8, 2, 3]} rotation={[0, Math.PI / 2, 0]} scale={[8, 5, 1]} color="#8fb8ff" />
                <Lightformer form="rect" intensity={2} position={[8, 3, -2]} rotation={[0, -Math.PI / 2, 0]} scale={[8, 5, 1]} color="#ffd9b0" />
                <Lightformer form="ring" intensity={1.5} position={[0, 1, 10]} scale={4} />
            </Environment>

            {project.parts.map((part) => {
                const other = workspace === 'part' && activeShown && part.id !== activePart;
                if (other && !showOthers) {
                    return null;
                }
                const dimmed = other || (workspace !== 'part' && focus !== null && focus !== part.id);
                return <PartMesh key={part.id} part={part} offset={offsets[part.id]} dimmed={dimmed} />;
            })}
            <SketchSteps
                part={(workspace === 'part' && project.parts.find((p) => p.id === activePart)) || null}
                offset={(activePart && offsets[activePart]) || [0, 0, 0]}
            />
            <SketchLayer
                part={project.parts.find((p) => p.id === sketchPart) ?? null}
                offset={(sketchPart && offsets[sketchPart]) || [0, 0, 0]}
            />

            <ContactShadows position={[0, -0.5, 0]} scale={900} far={400} blur={2.4} opacity={0.55} resolution={1024} />
            <CameraControls makeDefault dollyToCursor minDistance={1} maxDistance={20000} smoothTime={0.22} draggingSmoothTime={0.08} />
            <Pivot project={project} offsets={offsets} />
            <Rig project={project} offsets={offsets} />
            <LabelDriver project={project} offsets={offsets} />
            <CursorTracker />
            <GroundGrid />
            <EffectComposer>
                <Bloom mipmapBlur luminanceThreshold={1} intensity={0.8} radius={0.7} />
            </EffectComposer>
            {/* After the composer, so the triad is drawn on top of the post-processed frame. */}
            <GizmoHelper alignment="bottom-left" margin={[TRIAD_PX / 2, TRIAD_PX / 2 - 2]} renderPriority={2}>
                <GizmoViewport
                    axisColors={['#ff4d5e', '#3ddc84', '#4d8dff']}
                    labelColor="#04060b"
                    axisHeadScale={0.95}
                    font="600 17px Inter, Arial, sans-serif"
                    scale={36}
                />
            </GizmoHelper>
        </Canvas>
    );
}
