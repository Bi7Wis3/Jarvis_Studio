// The sketcher in the 3D view: plane picking, the sketch grid, entities, the entity in progress with live
// dimensions and shaded closed profiles (the finish panel's solid is previewed by the server, like other tools).

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid, Line } from '@react-three/drei';
import {
    DoubleSide, Euler, MathUtils, Matrix4, Path, Quaternion, Shape, ShapeGeometry, Vector2,
    Vector3, type Group, type Material, type Mesh, type PerspectiveCamera,
} from 'three';
import {
    shapeHalfExtents, type Feature, type Part, type Sketch, type SketchPlane, type SketchPlaneName, type SketchRegion, type Vec3,
} from '@jarvis/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { resolveRevolveAxis } from '@jarvis/core/reference';
import { anim } from './Scene';
import { latheProfile, revolveSpan } from './revolveAxis';
import {
    circleThrough, dist, entitiesToProfiles, entityPoints, nestProfiles, planeFrame, profilePoints, rectCorners, regularPolygon, type Entity,
    type NewEntity, type Pt,
} from './sketchMath';
import { choosePlane, pickSketch, useSketcher } from './sketcher';
import { Catcher, Drawing, Label, v3 } from './SketchDrawing';
import { sketchToEntities } from './sketchMath';
import { useStudio } from './state';
import { offerTarget } from './viewMenu';
import { pickedRegions, toggleRegion, useRegionPick } from './regionPick';
import { ModelPreview } from './sketchModelView';
import { ShadedContours } from './sketchContoursDrawing';
import { openSketchRegions, usePlaneFaces } from './sketchModelContours';
import { resolvedSketch } from '@jarvis/core/derived';
import { SketchGridView } from './sketchGridView';
import { StepLines } from './sketchStepLines';
import { useSketchView } from './sketchViewMode';
import { LineBatch } from './sketchBatch';

export { regionsOf, useRegionPick } from './regionPick';

const LINE = '#e9eef6';
const SELECTED = '#c48bff';
const DRAFT = '#35e0ff';
const SNAP_PX = 10;
const CLICK_SLOP_PX = 4;

/** World matrix of a part frame (without explode). */
export function partMatrix(part: Part | null): Matrix4 {
    if (!part) {
        return new Matrix4();
    }
    const rotation = new Euler(...(part.rotation.map(MathUtils.degToRad) as Vec3), 'XYZ');
    return new Matrix4().compose(new Vector3(...part.position), new Quaternion().setFromEuler(rotation), new Vector3(1, 1, 1));
}

/** Part-frame matrix of a sketch plane: x = u, y = v, z = normal, origin on the plane. */
export function planeMatrix(plane: SketchPlane, offset: number, features: Feature[] = []): Matrix4 {
    const { origin, u, v, n } = planeFrame(plane, offset, features);
    return new Matrix4()
        .makeBasis(new Vector3(...u), new Vector3(...v), new Vector3(...n))
        .setPosition(new Vector3(...origin));
}


function shapesFor(profiles: ReturnType<typeof nestProfiles>): Shape[] {
    return profiles.map(({ outer, holes }) => {
        const shape = new Shape(outer.map(([u, v]) => new Vector2(u, v)));
        shape.holes = holes.map((h) => new Path(h.map(([u, v]) => new Vector2(u, v))));
        return shape;
    });
}

/** Regions as outlines with holes, the shape nestProfiles gives. */
function regionOutlines(regions: SketchRegion[]): ReturnType<typeof nestProfiles> {
    return regions.map((r) => ({ outer: profilePoints(r.loops[0]), holes: r.loops.slice(1).map(profilePoints) }));
}

/**
 * Each region of a sketch as its own translucent fill: hover highlights it, a click (not a camera drag) toggles it.
 * Lifted a hair off the plane towards the camera, so it is hit before the sketch catcher or a part face in the plane.
 */
function RegionFills({ regions, picked, onToggle }: { regions: SketchRegion[]; picked: number[]; onToggle: (at: Pt) => void }) {
    const [hover, setHover] = useState(-1);
    const lift = useRef<Group>(null);
    const camera = useThree((s) => s.camera);
    const geometries = useMemo(() => shapesFor(regionOutlines(regions)).map((shape) => new ShapeGeometry(shape, 24)), [regions]);
    useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries]);
    useEffect(() => setHover(-1), [regions]);
    useFrame(() => {
        const group = lift.current;
        if (!group?.parent) {
            return;
        }
        const eye = group.parent.worldToLocal(camera.position.clone());
        group.position.z = Math.sign(eye.z || 1) * Math.max(1e-3, Math.abs(eye.z) * 1e-4);
    });
    const any = picked.length > 0;
    return (
        <group ref={lift}>
            {geometries.map((geometry, i) => {
                const on = picked.includes(i);
                const opacity = (on ? 0.45 : any ? 0.1 : 0.2) + (hover === i ? 0.15 : 0);
                return (
                    <mesh
                        key={i}
                        geometry={geometry}
                        renderOrder={on ? 16 : 15}
                        onPointerOver={(e) => {
                            e.stopPropagation();
                            setHover(i);
                        }}
                        onPointerOut={() => setHover((h) => (h === i ? -1 : h))}
                        onClick={(e) => {
                            if (e.delta <= CLICK_SLOP_PX) {
                                e.stopPropagation();
                                onToggle(regions[i].at);
                            }
                        }}
                    >
                        <meshBasicMaterial
                            color={on ? '#35e0ff' : '#b46bff'}
                            transparent
                            opacity={opacity}
                            depthTest={false}
                            depthWrite={false}
                            side={DoubleSide}
                        />
                    </mesh>
                );
            })}
        </group>
    );
}

/**
 * Shaded closed profiles. While finishing, each region can be clicked to pick it; the solid the panel would make
 * is the server's preview (a ghost over the model, as for Extrude), so every option shows as it will be built.
 */
function Profiles() {
    const geometry = useSketcher((s) => s.geometry);
    const finishing = useSketcher((s) => s.finishing);
    const plane = useSketcher((s) => s.plane);
    const offset = useSketcher((s) => s.offset);
    const context = useSketcher((s) => s.context);
    const ownPicks = useRegionPick((s) => s.sketchKey === null);
    const picks = useRegionPick((s) => s.picked);
    const open = !!finishing;
    // With the model's faces in the sketch plane loaded, the areas their edges close count too.
    const faces = usePlaneFaces((f) => f.known);
    const regions = useMemo(() => (open ? openSketchRegions(geometry) : []), [open, geometry, faces]);
    const picked = useMemo(() => (ownPicks ? pickedRegions(regions, picks) : []), [ownPicks, regions, picks]);
    // While drawing, the closed areas are shaded when Shaded sketch contours is on.
    return open ? (
        <RegionFills regions={regions} picked={picked} onToggle={(at) => toggleRegion(at, regions)} />
    ) : (
        <ShadedContours />
    );
}

const PLANES: SketchPlaneName[] = ['top', 'front', 'right'];

/** The three principal planes of the part, to click on to start sketching. */
/** Edge length of the three planes offered when a sketch starts. */
export function planePickerSize(part: Part | null): number {
    return part ? Math.max(40, ...shapeHalfExtents(part.shape).map((h) => h * 2.4)) : 120;
}

function PlanePicker({ part }: { part: Part | null }) {
    const [hover, setHover] = useState<SketchPlaneName | null>(null);
    const size = planePickerSize(part);
    return (
        <>
            {PLANES.map((plane) => (
                <group key={plane} matrixAutoUpdate={false} matrix={planeMatrix(plane, 0)}>
                    <mesh
                        renderOrder={12}
                        // Kept (with its shader) for the next sketch; one pass, as for any flat fill (sketchContoursDrawing.tsx).
                        dispose={null}
                        onPointerOver={(e) => {
                            e.stopPropagation();
                            setHover(plane);
                        }}
                        onPointerOut={() => setHover(null)}
                        onClick={(e) => {
                            if (e.delta <= CLICK_SLOP_PX) {
                                e.stopPropagation();
                                choosePlane(plane, 0);
                            }
                        }}
                    >
                        <planeGeometry args={[size, size]} />
                        <meshBasicMaterial
                            color={hover === plane ? '#b46bff' : '#35e0ff'}
                            transparent
                            opacity={hover === plane ? 0.3 : 0.1}
                            depthWrite={false}
                            depthTest={false}
                            side={DoubleSide}
                            forceSinglePass
                        />
                    </mesh>
                    <LineBatch lines={[{
                        points: rectCorners([-size / 2, -size / 2], [size / 2, size / 2]).concat([[-size / 2, -size / 2]]).map((p) => v3(p)),
                        color: hover === plane ? '#c48bff' : '#35e0ff', width: 1, opacity: 0.7, renderOrder: 0,
                    }]} />
                    <Label at={[-size / 2, size / 2]} className="plane">{plane[0].toUpperCase() + plane.slice(1)}</Label>
                </group>
            ))}
        </>
    );
}

/** Everything the sketcher draws, in the frame of `part` (null: the world, for a new part). */
export function SketchLayer({ part, offset }: { part: Part | null; offset: Vec3 }) {
    const active = useSketcher((s) => s.active);
    const stage = useSketcher((s) => s.stage);
    const plane = useSketcher((s) => s.plane);
    const planeOffset = useSketcher((s) => s.offset);
    const outer = useRef<Group>(null);
    const frame = useRef<Group>(null);
    const matrix = useMemo(() => partMatrix(part), [part?.position.join(), part?.rotation.join()]);
    const context = useSketcher((s) => s.context);
    const onPlane = useMemo(() => matrix.clone().multiply(planeMatrix(plane, planeOffset, context)), [matrix, plane, planeOffset, context]);

    useFrame(() => {
        outer.current?.position.set(offset[0] * anim.explode, offset[1] * anim.explode, offset[2] * anim.explode);
    });

    if (!active) {
        return null;
    }
    return (
        <group ref={outer}>
            {stage === 'plane' ? (
                <group matrixAutoUpdate={false} matrix={matrix}>
                    <PlanePicker part={part} />
                </group>
            ) : (
                <group ref={frame} matrixAutoUpdate={false} matrix={onPlane}>
                    <SketchGridView part={part} frame={frame} />
                    <Catcher frame={frame} />
                    <Profiles />
                    <Drawing />
                    <ModelPreview />
                </group>
            )}
        </group>
    );
}

/** Sketch origin and normal in world space, for the camera to face the plane. */
export function sketchView(part: Part | null): { centre: Vector3; normal: Vector3; radius: number } {
    const { plane, offset, geometry, fitToSketch, anchor } = useSketcher.getState();
    const matrix = partMatrix(part).multiply(planeMatrix(plane, offset, useSketcher.getState().context));
    const normal = new Vector3(0, 0, 1).transformDirection(matrix);
    // Fit (F) while sketching frames the sketch itself; otherwise the part.
    if (fitToSketch && geometry.points.length) {
        const us = geometry.points.map((p) => p.u);
        const vs = geometry.points.map((p) => p.v);
        const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
        const centre = new Vector3((u0 + u1) / 2, (v0 + v1) / 2, 0).applyMatrix4(matrix);
        return { centre, normal, radius: Math.max(10, Math.hypot(u1 - u0, v1 - v0) / 2 * 1.25) };
    }
    // Centred where the plane was picked (the clicked face point), else on the plane origin.
    const centre = new Vector3(anchor[0], anchor[1], 0).applyMatrix4(matrix);
    const radius = part ? Math.max(30, ...shapeHalfExtents(part.shape)) : 80;
    return { centre, normal, radius };
}

/**
 * One sketch step drawn as thin curves on its plane; click to pick it for Extrude, Cut, Revolve or Loft. While its
 * regions are being picked (useRegionPick), they are drawn as fills to click.
 */
function SketchStep({ partId, id, sketch, used, before }: { partId: string; id: string; sketch: Sketch; used: boolean; before: Feature[] }) {
    const picked = useSketcher((s) => s.picked?.id === id);
    const [hover, setHover] = useState(false);
    const lines = useMemo(() => sketchToEntities(sketch).map((e) => entityPoints(e).map((p) => v3(p))), [sketch]);
    const matrix = useMemo(() => planeMatrix(sketch.plane, sketch.offset ?? 0, before), [sketch.plane, sketch.offset, before]);
    const color = picked || hover ? '#c48bff' : used ? '#5d6b80' : '#35e0ff';
    // Picking regions of this step (Extrude, Cut, Revolve on part of a sketch): its regions become clickable fills.
    const picking = useRegionPick((s) => s.active && s.sketchKey === `${partId}/${id}`);
    const picks = useRegionPick((s) => s.picked);
    const regions = sketch.regions;
    const chosen = useMemo(() => (picking && regions ? pickedRegions(regions, picks) : []), [picking, regions, picks]);
    // In an open sketch the pointer goes on to it: its tools pick this sketch's entities themselves (sketchModelPick.ts).
    const sketching = useSketchView();
    useEffect(() => {
        if (sketching) {
            setHover(false);
        }
    }, [sketching]);
    return (
        <group matrixAutoUpdate={false} matrix={matrix}>
            {picking && regions && <RegionFills regions={regions} picked={chosen} onToggle={(at) => toggleRegion(at, regions)} />}
            <StepLines
                lines={lines}
                color={color}
                width={picked || hover ? 2.4 : 1.3}
                opacity={used && !picked && !hover ? 0.55 : 1}
                renderOrder={18}
                events={sketching ? null : {
                    onPointerOver: (e) => {
                        e.stopPropagation();
                        setHover(true);
                    },
                    onPointerOut: () => setHover(false),
                    onClick: (e) => {
                        if (e.delta <= CLICK_SLOP_PX) {
                            e.stopPropagation();
                            pickSketch(id);
                        }
                    },
                    // The view's right-click menu (viewMenu.tsx); a sketch curve wins over the faces it lies on.
                    onContextMenu: () => offerTarget({ kind: 'sketch', partId, featureId: id }, 2),
                }}
            />
        </group>
    );
}

/** The active part's sketch steps (part workspace, "Show sketches"), dimmed when a later step uses them. */
export function SketchSteps({ part, offset }: { part: Part | null; offset: Vec3 }) {
    const show = useSketcher((s) => s.showSketches);
    const editing = useSketcher((s) => (s.active ? s.edit?.featureId ?? '' : null));
    const workspace = useStudio((s) => s.workspace);
    const hidden = useStudio((s) => s.history?.view.hiddenSketches);
    const outer = useRef<Group>(null);
    const matrix = useMemo(() => partMatrix(part), [part?.position.join(), part?.rotation.join()]);
    useFrame(() => {
        outer.current?.position.set(offset[0] * anim.explode, offset[1] * anim.explode, offset[2] * anim.explode);
    });
    if (!part || !show || workspace !== 'part') {
        return null;
    }
    const features = part.features ?? [];
    const hiddenSet = new Set(hidden ?? []);
    const steps = features.filter((f) => f.op === 'sketch' && !f.suppressed && f.id !== editing && !hiddenSet.has(`${part.id}/${f.id}`));
    if (!steps.length) {
        return null;
    }
    const usedBy = new Set(features.flatMap((f) => (f.op === 'extrude' || f.op === 'revolve') && f.sketchRef ? [f.sketchRef]
        : f.op === 'loft' ? f.sections.flatMap((s) => (s.sketchRef ? [s.sketchRef] : [])) : []));
    return (
        <group ref={outer}>
            <group matrixAutoUpdate={false} matrix={matrix}>
                {steps.map((f) => f.op === 'sketch' && <SketchStep key={f.id} partId={part.id} id={f.id} sketch={resolvedSketch(features, features.indexOf(f)) ?? f.sketch} used={usedBy.has(f.id)} before={features.slice(0, features.indexOf(f))} />)}
            </group>
        </group>
    );
}
