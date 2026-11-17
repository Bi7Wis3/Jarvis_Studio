// The geometry of a mate reference in its part's frame. Faces, edges and vertices are the kernel's (MateRef.found,
// kept up to date by the server); planes, axes, origins, point steps and sketch entities come from the part's own
// history, as the sketcher and the kernel resolve them (reference.ts).

import { effectivePart, type Feature, type Part, type Vec3 } from '../index';
import { resolveAxis, resolvePlane, resolvePoint, sketchFrameOf } from '../reference';
import { add, cross, scale, unit } from './math';
import type { MateGeom, MatePick, MateRef } from './types';

const FRAME: MateGeom = { type: 'frame', origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** A base plane (top, front, right), a plane step, an axis, the origin or a point step of a history, as geometry. */
function referenceGeom(pick: MatePick, features: Feature[]): MateGeom | null {
    switch (pick.kind) {
        case 'plane': {
            const plane = resolvePlane(typeof pick.plane === 'string' ? pick.plane : { planeRef: pick.plane.step }, features, 'mate plane');
            return { type: 'plane', origin: plane.origin, normal: unit(plane.normal) };
        }
        case 'axis': {
            const axis = resolveAxis(typeof pick.axis === 'string' ? pick.axis : { axisRef: pick.axis.step }, features, 'mate axis');
            return { type: 'line', point: axis.point, direction: unit(axis.direction) };
        }
        case 'point':
            return pick.point === 'origin' ? FRAME
                : { type: 'point', point: resolvePoint({ pointRef: pick.point.step }, features, 'mate point') };
        case 'sketch':
            return sketchGeom(pick.step, pick.item, features);
        default:
            return null;
    }
}

/** A sketch's point, line, circle or arc in the part frame. */
function sketchGeom(stepId: string, item: string, features: Feature[]): MateGeom | null {
    const index = features.findIndex((f) => f.id === stepId);
    const step = features[index];
    if (!step || step.op !== 'sketch' || !step.sketch.geometry) {
        return null;
    }
    const geometry = step.sketch.geometry;
    const frame = sketchFrameOf(step.sketch, features.slice(0, index));
    const at = (u: number, v: number): Vec3 => add(frame.origin, add(scale(frame.u, u), scale(frame.v, v)));
    const point = (id: string): Vec3 | null => {
        if (id === 'origin') {
            return frame.origin;
        }
        const p = geometry.points.find((q) => q.id === id);
        return p ? at(p.u, p.v) : null;
    };
    const own = point(item);
    if (own && item !== 'origin') {
        return { type: 'point', point: own };
    }
    const curve = geometry.curves.find((c) => c.id === item);
    if (!curve) {
        return item === 'origin' && own ? { type: 'point', point: own } : null;
    }
    if (curve.kind === 'line') {
        const a = point(curve.a);
        const b = point(curve.b);
        return a && b ? { type: 'line', point: a, direction: unit(add(b, scale(a, -1))) } : null;
    }
    if (curve.kind === 'circle' || curve.kind === 'arc') {
        const centre = point(curve.center);
        if (!centre) {
            return null;
        }
        let r: number;
        if (curve.kind === 'circle') {
            r = curve.radius;
        } else {
            const s = geometry.points.find((q) => q.id === curve.start);
            const c = geometry.points.find((q) => q.id === curve.center);
            if (!s || !c) {
                return null;
            }
            r = Math.hypot(s.u - c.u, s.v - c.v);
        }
        return { type: 'circle', centre, normal: unit(cross(frame.u, frame.v)), radius: r };
    }
    return { type: 'curve' };
}

/**
 * The geometry of a reference in its part's frame (the world, for the assembly's own planes and origin), or null when
 * it is not known (a face not yet found by the kernel) or no longer resolves.
 */
export function refGeometry(ref: MateRef, parts: readonly Part[]): MateGeom | null {
    const pick = ref.pick;
    if (pick.kind === 'face' || pick.kind === 'edge' || pick.kind === 'vertex') {
        return ref.found ?? null;
    }
    if (pick.kind === 'component') {
        return null;
    }
    let features: Feature[] = [];
    if (ref.part) {
        const part = parts.find((p) => p.id === ref.part);
        if (!part) {
            return null;
        }
        features = effectivePart(part, parts as Part[]).features ?? [];
    } else if (pick.kind === 'sketch') {
        return null;
    }
    try {
        return referenceGeom(pick, features);
    } catch {
        return null;
    }
}

/** What a reference is called in lists: Face<1>@Plate, Top plane@Pin, Origin (the assembly's own). */
export function refLabel(ref: MateRef, parts: readonly Part[], index = 1): string {
    const pick = ref.pick;
    const part = ref.part ? parts.find((p) => p.id === ref.part) : undefined;
    const owner = ref.part ? `@${part?.name ?? ref.part}${ref.copy ? ` (copy ${ref.copy + 1})` : ''}` : '';
    const steps = part ? effectivePart(part, parts as Part[]).features ?? [] : [];
    const stepName = (id: string) => steps.find((f) => f.id === id)?.name ?? id;
    const planeName = (p: string) => `${p[0].toUpperCase()}${p.slice(1)} plane`;
    switch (pick.kind) {
        case 'face':
            return `Face<${index}>${owner}`;
        case 'edge':
            return `Edge<${index}>${owner}`;
        case 'vertex':
            return `Vertex<${index}>${owner}`;
        case 'plane':
            return `${typeof pick.plane === 'string' ? planeName(pick.plane) : stepName(pick.plane.step)}${owner}`;
        case 'axis':
            return `${typeof pick.axis === 'string' ? `${pick.axis.toUpperCase()} axis` : stepName(pick.axis.step)}${owner}`;
        case 'point':
            return `${pick.point === 'origin' ? 'Origin' : stepName(pick.point.step)}${owner}`;
        case 'sketch':
            return `${pick.item}@${stepName(pick.step)}${owner}`;
        case 'component':
            return part?.name ?? ref.part ?? 'Assembly';
    }
}
