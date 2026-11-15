// Shaded Sketch Contours in the view: each closed area of the sketch (contours and the sub-contours they make) as
// its own translucent fill, the one under the pointer lit up, and the context toolbar of an Alt-clicked area.

import { useEffect, useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import { DoubleSide, MeshBasicMaterial, Path, Shape, ShapeGeometry, Vector2 } from 'three';
import type { SketchRegion } from '@jarvis/core';
import { useSketcher } from './sketcher';
import { closeContourBar, extrudeContour, useContourBar } from './sketchContours';
import { useShadedRegions } from './sketchContourRegions';
import { regionAt } from './regionPick';
import { useSketchToggles } from './sketchToggles';
import { profilePoints } from './sketchMath';
import { v3 } from './SketchDrawing';
import { Icon } from './icons';
import './sketchWhole.css';

function regionShape(r: SketchRegion): Shape {
    const [outer, ...holes] = r.loops.map((l) => profilePoints(l).map(([u, v]) => new Vector2(u, v)));
    const shape = new Shape(outer);
    shape.holes = holes.map((h) => new Path(h));
    return shape;
}

/** The context toolbar of a shaded area, in the toolbar's compact style: Extruded Boss/Base. */
function ContourBar() {
    const at = useContourBar((b) => b.at);
    const g = useSketcher((s) => s.geometry);
    const bar = useRef<HTMLDivElement>(null);
    const first = useRef(g);
    useEffect(() => {
        first.current = g;
    }, [at]);
    // A change to the sketch, Esc, or a press elsewhere closes it.
    useEffect(() => {
        if (at && g !== first.current) {
            closeContourBar();
        }
    }, [g]);
    useEffect(() => {
        if (!at) {
            return;
        }
        const key = (e: KeyboardEvent) => e.key === 'Escape' && closeContourBar();
        const press = (e: PointerEvent) => {
            if (!bar.current?.contains(e.target as Node)) {
                closeContourBar();
            }
        };
        window.addEventListener('keydown', key);
        window.addEventListener('pointerdown', press, { capture: true });
        return () => {
            window.removeEventListener('keydown', key);
            window.removeEventListener('pointerdown', press, { capture: true });
        };
    }, [at]);
    if (!at) {
        return null;
    }
    return (
        <Html position={v3(at)} zIndexRange={[40, 0]}>
            <div ref={bar} className="sk-context-bar" role="toolbar" aria-label="Shaded contour">
                <button type="button" title="Extruded boss/base: extrude this area" aria-label="Extruded boss/base" onClick={() => extrudeContour(at)}>
                    <Icon name="extrude" />
                </button>
            </div>
        </Html>
    );
}

/**
 * A fill per region; a region that is still there (the same object, see sketchRegions.ts) keeps its fill, so a drag
 * rebuilds only the fills of the areas it changes.
 */
function useFills(regions: SketchRegion[]): ShapeGeometry[] {
    const kept = useRef(new Map<SketchRegion, ShapeGeometry>());
    const fills = useMemo(() => {
        const next = new Map<SketchRegion, ShapeGeometry>();
        for (const r of regions) {
            next.set(r, next.get(r) ?? kept.current.get(r) ?? new ShapeGeometry(regionShape(r), 24));
        }
        return next;
    }, [regions]);
    useEffect(() => {
        for (const [r, f] of kept.current) {
            if (fills.get(r) !== f) {
                f.dispose();
            }
        }
        kept.current = fills;
    }, [fills]);
    useEffect(() => () => kept.current.forEach((f) => f.dispose()), []);
    return useMemo(() => regions.map((r) => fills.get(r)!), [fills]);
}

const noRaycast = () => null;

// The fills' two looks, shared by all fills and never disposed, so their shader stays compiled from one sketch to the
// next. One pass each (forceSinglePass): a flat fill looks the same from either side, and three.js would otherwise
// draw each transparent two-sided fill twice and look its shader up again twice a frame.
const fillLook = (opacity: number) => new MeshBasicMaterial({
    color: '#b46bff', transparent: true, opacity, depthTest: false, depthWrite: false, side: DoubleSide, forceSinglePass: true,
});
const FILL = fillLook(0.2);
const FILL_LIT = fillLook(0.32);

/** The fills, while the sketch is drawn (the leaving panel draws its own, to pick areas). */
export function ShadedContours() {
    const on = useSketchToggles((t) => t.shadedContours);
    const geometry = useSketcher((s) => s.geometry);
    // Exact, except during a drag, when they may catch up a little later (sketchContourRegions.ts).
    const regions = useShadedRegions(on, geometry);
    // The area a press of the select tool would drag: redrawn when that area changes, not on every pointer move.
    const hover = useSketcher((s) => (on && s.tool === 'select' && s.cursor ? regionAt(regions, s.cursor) : -1));
    const fills = useFills(regions);
    if (!on) {
        return null;
    }
    return (
        <>
            {fills.map((geometry, i) => (
                <mesh key={i} geometry={geometry} material={hover === i ? FILL_LIT : FILL} renderOrder={15} raycast={noRaycast} />
            ))}
            <ContourBar />
        </>
    );
}
