// A sketch step drawn as thin curves on its plane, all of its curves in one batch (one draw call). The pointer reaches
// it only when told so: while a sketch is open, the sketcher picks other sketches' curves itself (by distance, in
// sketch coordinates), so a step is not hit-tested on every pointer move then.
//
// Materials are kept, one per look, never disposed: a disposed material would make three.js throw its compiled shader
// away and compile it again for the next sketch step shown (each time a sketch is opened or closed).

import { useEffect, useMemo } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

type V3 = [number, number, number];

const looks = new Map<string, LineMaterial>();

function lookOf(color: string, width: number, opacity: number): LineMaterial {
    const key = `${color}|${width}|${opacity}`;
    let m = looks.get(key);
    if (!m) {
        // As drei's Line draws a sketch step: over everything, transparent.
        m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false });
        looks.set(key, m);
    }
    return m;
}

const noRaycast = () => undefined;

export interface StepLineEvents {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => void;
    onPointerOut: (e: ThreeEvent<PointerEvent>) => void;
    onClick: (e: ThreeEvent<MouseEvent>) => void;
    onContextMenu: (e: ThreeEvent<MouseEvent>) => void;
}

/** The polylines `lines` of one step in one look; `events` null: the pointer passes through them. */
export function StepLines({ lines, color, width, opacity, renderOrder, events }: {
    lines: V3[][]; color: string; width: number; opacity: number; renderOrder: number; events: StepLineEvents | null;
}) {
    const size = useThree((s) => s.size);
    const invalidate = useThree((s) => s.invalidate);
    const object = useMemo(() => new LineSegments2(), []);
    const geometry = useMemo(() => {
        const positions: number[] = [];
        for (const l of lines) {
            for (let i = 1; i < l.length; i++) {
                positions.push(...l[i - 1], ...l[i]);
            }
        }
        if (!positions.length) {
            return null;
        }
        const g = new LineSegmentsGeometry();
        g.setPositions(positions);
        return g;
    }, [lines]);
    useEffect(() => () => geometry?.dispose(), [geometry]);
    const material = lookOf(color, width, opacity);
    material.resolution.set(size.width, size.height);
    object.raycast = events ? LineSegments2.prototype.raycast : noRaycast;
    useEffect(() => invalidate(), [material, geometry, invalidate]);
    if (!geometry) {
        return null;
    }
    return <primitive object={object} geometry={geometry} material={material} renderOrder={renderOrder} {...(events ?? {})} />;
}
