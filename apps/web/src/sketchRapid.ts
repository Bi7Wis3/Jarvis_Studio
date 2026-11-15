// Rapid Sketch (SolidWorks: with Rapid Sketch on and a sketch tool active, placing the pointer on a planar face or
// plane and starting to sketch opens a sketch there; moving on to another face opens the next one; the tool can change
// midstream). Here: with a draw tool waiting for its first click, a click on a face of the part away from the sketch
// plane saves the sketch (a plain sketch) and opens a new one on that face, the click placing the tool's first point.

import type { Intersection } from 'three';
import { setTool, sketchClick, startSketch, chooseFace, useSketcher, isEditTool, type SketchTool } from './sketcher';
import { sketchToggle } from './sketchToggles';
import { useStudio } from './state';
import type { Pt } from './sketchMath';

type V3 = [number, number, number];

/** A draw tool waiting for its first click (the tool Rapid Sketch carries on to the next face). */
export function idleDrawTool(s: ReturnType<typeof useSketcher.getState>): SketchTool | null {
    const t = s.tool;
    if (t === 'select' || t === 'dimension' || t === 'xform' || t.startsWith('c:') || t.startsWith('m:') || isEditTool(t) || s.draft.length) {
        return null;
    }
    return t;
}

/** Whether the sketch can be saved on its own without asking (a plain sketch, new or a sketch step). */
function plainSketch(s: ReturnType<typeof useSketcher.getState>): boolean {
    if (s.intent !== 'sketch' && !s.edit) {
        return false;
    }
    if (!s.edit?.featureId) {
        return !s.edit;
    }
    const part = useStudio.getState().history?.parts.find((p) => p.id === s.edit!.partId);
    return part?.features?.find((f) => f.id === s.edit!.featureId)?.op === 'sketch';
}

/** The tool and click to replay once the next sketch is open. */
let carry: { tool: SketchTool; tolerance: number } | null = null;

function openOn(partId: string, normal: V3, point: V3, tool: SketchTool, tolerance: number): void {
    startSketch(partId, 'sketch');
    carry = { tool, tolerance };
    chooseFace(normal, point);
}

/**
 * A click in the open sketch that went through the sketch plane to a face of the part at `faceDistance` along the ray
 * (the plane at `planeDistance`): with Rapid Sketch on and a draw tool waiting, a face away from the plane opens the
 * next sketch on it. `normal` and `point` are in the part frame. True when the click was taken.
 */
export function rapidClick(face: { normal: V3; point: V3; distance: number } | null, planeDistance: number, tolerance: number): boolean {
    const s = useSketcher.getState();
    const tool = idleDrawTool(s);
    const partId = s.edit?.partId ?? s.partId;
    if (!sketchToggle('rapidSketch') || !face || !tool || !partId || s.stage !== 'draw') {
        return false;
    }
    // On the sketch plane itself (the face the sketch is on): an ordinary click.
    if (Math.abs(face.distance - planeDistance) <= Math.max(1e-3, planeDistance * 1e-5)) {
        return false;
    }
    if (!plainSketch(s)) {
        useSketcher.setState({ message: 'Rapid sketch moves on from a plain sketch only: leave this one first (it makes a feature).' });
        return true;
    }
    if (!s.geometry.curves.length) {
        openOn(partId, face.normal, face.point, tool, tolerance);
        return true;
    }
    // Saved first, as Exit sketch saves it; the next sketch opens once it is.
    const stop = useSketcher.subscribe((now) => {
        if (!now.active) {
            stop();
            clearTimeout(timer);
            openOn(partId, face.normal, face.point, tool, tolerance);
        }
    });
    const timer = setTimeout(stop, 15000);
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'sk-finish' }));
    }
    return true;
}

/** The first face of the sketched part along a click's ray, in the part frame, from the view's intersections. */
export function partFaceHit(intersections: Intersection[]): { normal: V3; point: V3; distance: number } | null {
    const s = useSketcher.getState();
    const partId = s.edit?.partId ?? s.partId;
    const h = intersections.find((x) => x.face && x.object.userData?.partId === partId);
    if (!h?.face) {
        return null;
    }
    const local = h.object.worldToLocal(h.point.clone());
    const n = h.face.normal;
    return { normal: [n.x, n.y, n.z], point: [local.x, local.y, local.z], distance: h.distance };
}

let watching = false;

/**
 * Once a sketch opens on a face by Rapid Sketch (or with it on, by clicking a face to start a sketch), the tool carries
 * on and the click that picked the face places its first point.
 */
export function watchRapid(): void {
    if (watching) {
        return;
    }
    watching = true;
    useSketcher.subscribe((s, prev) => {
        if (prev.stage !== 'plane' || s.stage !== 'draw' || !s.active) {
            return;
        }
        const next = carry;
        carry = null;
        if (!next && !sketchToggle('rapidSketch')) {
            return;
        }
        const anchor: Pt = s.anchor;
        // A base plane picked from the plane picker has no click spot to start from.
        if (!next && anchor[0] === 0 && anchor[1] === 0) {
            return;
        }
        setTimeout(() => {
            setTool(next?.tool ?? useSketcher.getState().tool);
            sketchClick(anchor, next?.tolerance ?? 0.5);
        }, 0);
    });
}
