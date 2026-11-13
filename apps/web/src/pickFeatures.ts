// The features the fillet, chamfer, shell and draft forms save, from their values (selection boxes in pickField.ts).
// Edits send every pick list, also empty ones, and null for fields the chosen options no longer use, so what the form
// shows is what the feature becomes (features_update merges fields and removes those set to null).

import type { Feature, Vec3 } from '@jarvis/core';
import { chamferSide, edgePoints, faceRefs, pickItems } from './pickField';

type FormValues = Record<string, unknown>;

const round = (n: number): string => String(Math.round(n * 100) / 100);

function number(v: FormValues, key: string, label: string, max?: number): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    if (n <= 0) {
        throw new Error(`${label} must be greater than 0.`);
    }
    if (max !== undefined && n >= max) {
        throw new Error(`${label} must be less than ${max}.`);
    }
    return n;
}

export function filletFeature(v: FormValues): Record<string, unknown> {
    const radius = number(v, 'r', 'Radius');
    const items = pickItems(v.items);
    return {
        op: 'fillet', name: `Fillet ${round(radius)} mm`, radius, edges: v.edges,
        at: edgePoints(items), faces: faceRefs(items), tangent: !!v.tangent,
    };
}

/**
 * type equal: one distance; distance: two distances; angle: distance and angle. The first distance (or the angle's
 * distance) lies on the face next to the first picked edge where it was clicked (or the first picked face; or, for
 * an edge group, the top face); Flip direction puts it on the other face.
 */
export function chamferFeature(v: FormValues, editing: boolean): Record<string, unknown> {
    const size = number(v, 's', v.type === 'distance' ? 'Distance 1' : 'Distance');
    const items = pickItems(v.items);
    const extra: Record<string, unknown> = {};
    if (v.type === 'distance' || v.type === 'angle') {
        if (v.type === 'distance') {
            extra.distance2 = number(v, 'd2', 'Distance 2');
        } else {
            extra.angle = number(v, 'angle', 'Angle', 90);
        }
        const stored = typeof v.side === 'string' && v.side ? JSON.parse(v.side) as Vec3 : null;
        const side = chamferSide(items, stored ?? [0, 1, 0], !!v.flip);
        if (side) {
            extra.side = side;
        }
    }
    return {
        op: 'chamfer', name: `Chamfer ${round(size)} mm`, size, edges: v.edges,
        at: edgePoints(items), faces: faceRefs(items), tangent: !!v.tangent,
        ...(editing ? { distance2: null, angle: null, side: null } : {}),
        ...extra,
    };
}

/** Picked faces to remove replace the older choice of open sides. */
export function shellFeature(v: FormValues): Record<string, unknown> {
    const thickness = number(v, 't', 'Thickness');
    const remove = faceRefs(pickItems(v.remove));
    const open = remove.length ? [] : (v.open as string[] | undefined) ?? [];
    return {
        op: 'shell',
        name: `Shell ${round(thickness)} mm${open.length ? `, open ${open.join(' + ')}` : ', closed'}`,
        thickness,
        open,
        remove,
        outward: !!v.outward,
    };
}

/**
 * A neutral-plane draft of the picked faces about a picked flat face. `old`: the edited draft, whose neutral plane
 * reference or faces by side (set by Jarvis) still count when nothing is picked in their place.
 */
export function draftFeature(v: FormValues, old: Extract<Feature, { op: 'draft' }> | null): Record<string, unknown> {
    const angle = number(v, 'angle', 'Draft angle', 45);
    const neutral = faceRefs(pickItems(v.neutral))[0];
    const picked = faceRefs(pickItems(v.faces));
    if (!neutral && !old?.neutral) {
        throw new Error('Pick a flat face as the neutral plane.');
    }
    if (picked.length === 0 && !old?.faces?.length) {
        throw new Error('Pick the faces to draft.');
    }
    return {
        op: 'draft', name: `Draft ${round(angle)}°`, angle, picked, tangent: v.propagation === 'tangent', flip: !!v.flip,
        ...(neutral ? { neutralFace: neutral } : old ? { neutralFace: null } : {}),
    };
}
