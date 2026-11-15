// Selection boxes of the property manager (SolidWorks style): a form field that lists edges and faces picked in the
// view. The items are stored references (pickRefs.ts), in the part's own frame, so they survive a new mesh; the view
// finds them again in whatever mesh it shows. One box is active at a time; clicks on the part go to it.

import { create } from 'zustand';
import type { FacePickRef } from '@jarvis/core';
import { edgeOfPick, edgePick, faceOfPick, facePick, type ModelPick } from './pickRefs';
import type { P3 } from './picking';

/** `ref`: the box also takes reference planes, axes and points (steps and base planes) clicked in the view. */
export type PickEntity = 'edge' | 'face' | 'vertex' | 'ref';

/**
 * One picked entity. An edge is a point on it (`side`: the normal of the face it was clicked next to, which a chamfer
 * measures its first distance on); a face is a point inside it with its outward normal.
 */
export type PickItem =
    | { kind: 'edge'; at: P3; side?: P3; model?: ModelPick }
    | { kind: 'face'; at: P3; normal?: P3; model?: ModelPick }
    /** A vertex (the end of an edge), only in boxes that take vertices. */
    | { kind: 'vertex'; at: P3; model?: ModelPick }
    /** A reference plane, axis or point (see referenceDefs.ts), only in boxes that take `ref`. */
    | { kind: 'ref'; ref: string; label: string };

/** `model`: in boxes that take `ref`, the geometry of a picked face, edge or vertex, by value (pickRefs.modelPick). */

/** A selection box as the view needs it. */
export interface PickBox {
    key: string;
    label: string;
    entities: PickEntity[];
    multi: boolean;
    /** Only flat faces (a neutral plane). */
    flat?: boolean;
    /** A position field (vec) filled from a click: a circle's centre, a line's midpoint, a point on a face. */
    position?: boolean;
    /** Why a picked item is refused (shown under the box), or null to take it. */
    accept?: (item: PickItem) => string | null;
}

/** The arrays of a kernel mesh that picking reads (see meshes.ts and picking.ts). */
export interface PickMesh {
    positions: ArrayLike<number>;
    normals: ArrayLike<number>;
    indices: ArrayLike<number>;
    triFace: ArrayLike<number>;
    edges: ArrayLike<number>;
    segEdge: ArrayLike<number>;
}

/** "Edge<1>", "Face<2>": numbered per kind in list order, as SolidWorks names box entries; references by name. */
export function itemLabel(items: readonly PickItem[], index: number): string {
    const item = items[index];
    if (item.kind === 'ref') {
        return item.label;
    }
    const n = items.slice(0, index + 1).filter((i) => i.kind === item.kind).length;
    return `${item.kind === 'edge' ? 'Edge' : item.kind === 'face' ? 'Face' : 'Vertex'}<${n}>`;
}

/**
 * The box's list after a click on `item`: an entry for the same entity (`same`) is removed; else a multi box adds it
 * and a single box replaces its entry. `advance`: a single box was filled, so the next box becomes active.
 */
export function togglePickItem(items: readonly PickItem[], item: PickItem, same: (i: PickItem) => boolean, multi: boolean):
    { items: PickItem[]; advance: boolean } {
    if (items.some(same)) {
        return { items: items.filter((i) => !same(i)), advance: false };
    }
    return multi ? { items: [...items, item], advance: false } : { items: [item], advance: true };
}

/** The box after `key` in form order, or null for the last one. */
export function nextBox(boxes: readonly PickBox[], key: string | null): string | null {
    const at = boxes.findIndex((b) => b.key === key);
    return at >= 0 && at + 1 < boxes.length ? boxes[at + 1].key : null;
}

export const isPickList = (value: unknown): value is PickItem[] => Array.isArray(value)
    && value.every((v) => typeof v === 'object' && v !== null && 'kind' in v && ('at' in v || 'ref' in v));

/** The items of a form value (anything else: none). */
export const pickItems = (value: unknown): PickItem[] => (isPickList(value) ? value : []);

/** Edge items as the points features store in `at`. */
export const edgePoints = (items: readonly PickItem[]): P3[] => items.filter((i) => i.kind === 'edge').map((i) => [...i.at] as P3);

/** Face items as the references features store in `faces`, `remove` or `picked`. */
export const faceRefs = (items: readonly PickItem[]): FacePickRef[] => items.flatMap((i) => (i.kind === 'face'
    ? [i.normal ? { at: [...i.at] as P3, normal: [...i.normal] as P3 } : { at: [...i.at] as P3 }] : []));

/** A stored feature's picks as box items: edges first, then faces. */
export function itemsOf(at: readonly P3[] | undefined, faces: readonly FacePickRef[] | undefined): PickItem[] {
    return [
        ...(at ?? []).map((p): PickItem => ({ kind: 'edge', at: [...p] as P3 })),
        ...(faces ?? []).map((f): PickItem => (f.normal
            ? { kind: 'face', at: [...f.at] as P3, normal: [...f.normal] as P3 } : { kind: 'face', at: [...f.at] as P3 })),
    ];
}

/** The box item for an entity of the mesh (`hitNormal`: of the face clicked, for an edge's side), or null. */
export function itemFor(mesh: PickMesh, entity: { kind: 'edge' | 'face'; index: number }, hitNormal?: P3):
    Extract<PickItem, { kind: 'edge' | 'face' }> | null {
    if (entity.kind === 'edge') {
        const at = edgePick(mesh.edges, mesh.segEdge, entity.index);
        return at ? (hitNormal ? { kind: 'edge', at, side: hitNormal } : { kind: 'edge', at }) : null;
    }
    const ref = facePick(mesh.positions, mesh.normals, mesh.indices, mesh.triFace, entity.index);
    return ref ? { kind: 'face', at: ref.at, ...(ref.normal ? { normal: ref.normal } : {}) } : null;
}

/** How far (mm) a stored pick may lie from the entity it means: as the kernel, 0.5 mm, at most 5% of the size. */
export const pickTolerance = (diagonal: number): number => Math.max(1e-3, Math.min(0.5, diagonal * 0.05));

/** The entity of the mesh an item refers to, or null when it is not in this mesh. */
export function entityOf(mesh: PickMesh, item: PickItem, tolerance: number): { kind: 'edge' | 'face'; index: number } | null {
    if (item.kind === 'vertex' || item.kind === 'ref') {
        return null;
    }
    if (item.kind === 'edge') {
        const index = edgeOfPick(mesh.edges, mesh.segEdge, item.at, tolerance);
        return index === null ? null : { kind: 'edge', index };
    }
    const index = faceOfPick(mesh.positions, mesh.indices, mesh.triFace, item, tolerance);
    return index === null ? null : { kind: 'face', index };
}

/**
 * The side a chamfer's first distance lies on: the face next to the first picked edge that has one, else the first
 * picked face, else `fallback`; reversed by `flip`.
 */
export function chamferSide(items: readonly PickItem[], fallback: P3 | null, flip: boolean): P3 | null {
    const edge = items.find((i): i is Extract<PickItem, { kind: 'edge' }> => i.kind === 'edge' && !!i.side);
    const face = items.find((i): i is Extract<PickItem, { kind: 'face' }> => i.kind === 'face' && !!i.normal);
    const side = edge?.side ?? face?.normal ?? fallback;
    return side ? (flip ? side.map((c) => -c + 0) as P3 : [...side] as P3) : null;
}

// ---- Session: the open form's boxes, for the view ---------------------------------------------------------

export interface PickSession {
    owner: symbol | null;
    /** The part whose entities the boxes take. */
    partId: string | null;
    boxes: PickBox[];
    active: string | null;
    /** Items per box key. */
    items: Record<string, PickItem[]>;
    /** The row under the pointer, highlighted in the view. */
    hover: { key: string; index: number } | null;
    /** Why the last click was not taken (e.g. a curved face for a neutral plane). */
    note: string | null;
    /** Handles a click on an entity: `same` tells whether a box entry is that entity. */
    pick: ((item: PickItem, same: (i: PickItem) => boolean) => void) | null;
    /** Sets the active position field (part frame). */
    place: ((position: P3) => void) | null;
}

const EMPTY: PickSession = {
    owner: null, partId: null, boxes: [], active: null, items: {}, hover: null, note: null, pick: null, place: null,
};

export const usePickSession = create<PickSession>(() => EMPTY);

export function clearPickSession(owner: symbol): void {
    if (usePickSession.getState().owner === owner) {
        usePickSession.setState(EMPTY, true);
    }
}

/** The kinds a click may pick for the active box (none when no box is active). */
export function activeEntities(session: PickSession): PickEntity[] {
    return session.boxes.find((b) => b.key === session.active)?.entities ?? [];
}
