// The sketch grid with the document's Grid/Snap options (SolidWorks: Display grid, Dash, Automatic scaling, Major grid
// spacing, Minor-lines per major; the snap step is the minor spacing over Snap points per minor), the sketch axes,
// and the sketch plane itself when Display plane when shaded is on.

import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Grid, Line } from '@react-three/drei';
import { DoubleSide, MeshBasicMaterial, Vector3, type Group, type Material, type Mesh, type PerspectiveCamera } from 'three';
import type { Part } from '@jarvis/core';
import { useSketcher } from './sketcher';
import { pixelSizeAt } from './viewProjection';
import { Label, sketchPlaneAt } from './SketchDrawing';
import { planePickerSize } from './SketchLayer';
import { gridScale, gridSegments } from './sketchGrid';
import { LineBatch, type BatchLine } from './sketchBatch';

type V3 = [number, number, number];

/** The sketch plane's tint (Display plane when shaded), kept from one sketch to the next with its shader. */
const PLANE = new MeshBasicMaterial({ color: '#35e0ff', transparent: true, opacity: 0.07, depthWrite: false, side: DoubleSide, forceSinglePass: true });

/** A dashed grid draws lines over a window this many screens wide around the middle of the view. */
const WINDOW = 1.3;

function DashedGrid({ minor, major, frame }: { minor: number; major: number; frame: RefObject<Group | null> }) {
    const gl = useThree((s) => s.gl);
    const camera = useThree((s) => s.camera) as PerspectiveCamera;
    const [view, setView] = useState<{ u: number; v: number; half: number } | null>(null);
    useFrame(() => {
        const group = frame.current;
        if (!group) {
            return;
        }
        const rect = gl.domElement.getBoundingClientRect();
        const hit = sketchPlaneAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const centre = hit ? group.worldToLocal(hit.clone()) : new Vector3();
        const perPx = pixelSizeAt(camera, hit ?? group.getWorldPosition(new Vector3()), rect.height);
        const half = Math.max(rect.width, rect.height) * perPx * WINDOW;
        // Only a change by a major cell or more redraws the lines.
        const snap = (n: number) => Math.round(n / major) * major;
        const next = { u: snap(centre.x), v: snap(centre.y), half: Math.max(major, snap(half)) };
        if (!view || next.u !== view.u || next.v !== view.v || next.half !== view.half) {
            setView(next);
        }
    });
    const lines = useMemo(() => {
        if (!view) {
            return null;
        }
        const [u0, u1, v0, v1] = [view.u - view.half, view.u + view.half, view.v - view.half, view.v + view.half];
        const cap = (step: number) => (2 * view.half) / step <= 600;
        return {
            minor: cap(minor) ? gridSegments(minor, u0, u1, v0, v1) : [],
            major: cap(major) ? gridSegments(major, u0, u1, v0, v1) : [],
        };
    }, [view, minor, major]);
    if (!lines) {
        return null;
    }
    return (
        <>
            {lines.minor.length > 0 && (
                <Line points={lines.minor} segments color="#243247" lineWidth={0.6} dashed dashSize={minor / 4} gapSize={minor / 4} depthTest={false} renderOrder={11} />
            )}
            {lines.major.length > 0 && (
                <Line points={lines.major} segments color="#3b5277" lineWidth={1} dashed dashSize={major / 20} gapSize={major / 20} depthTest={false} renderOrder={11} />
            )}
        </>
    );
}

/** The sketch grid in the plane, the sketch axes through the origin, and the plane when Display plane when shaded is on. */
export function SketchGridView({ part, frame }: { part: Part | null; frame: RefObject<Group | null> }) {
    const settings = useSketcher((s) => s.settings);
    const camera = useThree((s) => s.camera) as PerspectiveCamera;
    const height = useThree((s) => s.size.height);
    const grid = useRef<Mesh>(null);
    const [scale, setScale] = useState(1);
    const minor0 = settings.gridMajor / Math.max(1, settings.gridMinorPerMajor);
    // Automatic scaling: zoomed out, the grid thins by tens so it stays readable.
    useFrame(() => {
        const group = frame.current;
        const perPx = group ? pixelSizeAt(camera, group.getWorldPosition(new Vector3()), height) : 0;
        const next = settings.gridAutoScale && perPx > 0 ? gridScale(minor0, perPx) : 1;
        if (next !== scale) {
            setScale(next);
        }
    });
    // Drawn over the parts, like the rest of the sketch; one pass (a flat grid looks the same from either side).
    useLayoutEffect(() => {
        const material = grid.current?.material as Material | undefined;
        if (material) {
            material.depthTest = false;
            material.depthWrite = false;
            material.forceSinglePass = true;
        }
    });
    const minor = minor0 * scale;
    const major = settings.gridMajor * scale;
    const plane = planePickerSize(part);
    // The plane's outline, the sketch axes, and the plane's own axes (small, at its origin: u red, v green, normal blue).
    const lines = useMemo((): BatchLine[] => [
        ...(settings.displayPlane ? [{
            points: [[-plane / 2, -plane / 2, 0], [plane / 2, -plane / 2, 0], [plane / 2, plane / 2, 0], [-plane / 2, plane / 2, 0], [-plane / 2, -plane / 2, 0]] as V3[],
            color: '#35e0ff', width: 1, opacity: 0.45, renderOrder: 11,
        }] : []),
        { points: [[-1e4, 0, 0], [1e4, 0, 0]], color: '#ff6b78', width: 1, opacity: 0.45, renderOrder: 0 },
        { points: [[0, -1e4, 0], [0, 1e4, 0]], color: '#4fe08f', width: 1, opacity: 0.45, renderOrder: 0 },
        { points: [[0, 0, 0], [8, 0, 0]], color: '#ff6b78', width: 2.5, renderOrder: 22 },
        { points: [[0, 0, 0], [0, 8, 0]], color: '#4fe08f', width: 2.5, renderOrder: 22 },
        { points: [[0, 0, 0], [0, 0, 8]], color: '#4d8dff', width: 2.5, renderOrder: 22 },
    ], [settings.displayPlane, plane]);
    return (
        <>
            {settings.displayPlane && (
                <mesh renderOrder={10} raycast={() => null} material={PLANE}>
                    <planeGeometry args={[plane, plane]} />
                </mesh>
            )}
            {settings.gridDisplay && !settings.gridDash && (
                // Not disposed when the sketch closes: its shader then stays compiled for the next sketch.
                <Grid
                    ref={grid}
                    dispose={null}
                    rotation={[Math.PI / 2, 0, 0]}
                    infiniteGrid
                    cellSize={minor}
                    sectionSize={major}
                    cellThickness={0.5}
                    sectionThickness={1}
                    cellColor="#243247"
                    sectionColor="#3b5277"
                    fadeDistance={1400 * Math.max(1, scale)}
                    fadeStrength={1.4}
                    side={DoubleSide}
                    renderOrder={11}
                />
            )}
            {settings.gridDisplay && settings.gridDash && <DashedGrid minor={minor} major={major} frame={frame} />}
            <LineBatch lines={lines} />
            <Label at={[9.5, 0]} className="axis u">u</Label>
            <Label at={[0, 9.5]} className="axis v">v</Label>
        </>
    );
}

