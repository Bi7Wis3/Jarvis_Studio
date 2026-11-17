// Solid bodies in the view (SolidWorks: the Solid Bodies folder): the rows the feature tree lists, hiding a body or
// making it see-through, the body picked in the tree highlighted, and the marks of cosmetic (hidden) threads.
//
// A hidden or see-through body's triangles are collapsed to a point in the part's surface instead of being left out,
// so triangle numbers still name the same faces for picking (picking.ts); the see-through ones are drawn again by a
// second, transparent mesh that the pointer passes through (as SolidWorks selects through transparent bodies).

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { BufferAttribute, BufferGeometry } from 'three';
import type { Feature, Part, ViewState } from '@jarvis/core';
import { bodyKey, type BodyInfo } from '@jarvis/core/visibility';
import { featureName } from './historyText';
import type { KernelMesh } from './meshes';
import { useStudio } from './state';

/** The part whose design (steps and bodies) this part shows: an instance shows its source's. */
export const designId = (part: Pick<Part, 'id' | 'instanceOf'>): string => part.instanceOf ?? part.id;

/** SolidWorks names a body after the step that changed it last, numbered when that step changed several. */
export function bodyName(body: BodyInfo, features: readonly Feature[]): string {
    const step = body.by ? features.find((f) => f.id === body.by) : undefined;
    const base = step ? featureName(step) : body.by || 'Base body';
    return body.n ? `${base}[${body.n}]` : base;
}

export interface BodyRow {
    key: string;
    index: number;
    name: string;
    hidden: boolean;
    seeThrough: boolean;
}

type BodyLists = Pick<ViewState, 'hiddenBodies' | 'seeThroughBodies'>;

/** The rows of the Solid Bodies folder, in the kernel's order. */
export function bodyRows(bodies: readonly BodyInfo[], features: readonly Feature[], partId: string, view: BodyLists): BodyRow[] {
    const hidden = new Set(view.hiddenBodies ?? []);
    const seeThrough = new Set(view.seeThroughBodies ?? []);
    return bodies.map((b, index) => ({
        key: b.key,
        index,
        name: bodyName(b, features),
        hidden: hidden.has(bodyKey(partId, b.key)),
        seeThrough: seeThrough.has(bodyKey(partId, b.key)),
    }));
}

/** The folder's name, with the number of bodies as SolidWorks shows it: "Solid Bodies(2)". */
export const bodiesLabel = (count: number): string => `Solid Bodies(${count})`;

/** How each body is drawn: 0 as it is, 1 see-through, 2 not at all. */
export type BodyLook = 0 | 1 | 2;

export function bodyLooks(bodies: readonly BodyInfo[], partId: string, view: BodyLists): BodyLook[] {
    return bodyRows(bodies, [], partId, view).map((r) => (r.hidden ? 2 : r.seeThrough ? 1 : 0));
}

const lookOfBody = (looks: readonly BodyLook[], body: number | undefined): BodyLook => looks[body ?? 0] ?? 0;

/** The look of every triangle, from its face's body. */
export function triangleLooks(triFace: ArrayLike<number>, faceBody: ArrayLike<number>, looks: readonly BodyLook[]): Uint8Array {
    const out = new Uint8Array(triFace.length);
    for (let t = 0; t < triFace.length; t++) {
        out[t] = lookOfBody(looks, faceBody[triFace[t]]);
    }
    return out;
}

/** The index with every triangle not drawn with `look` collapsed onto its first corner (nothing to draw or hit). */
export function maskedIndex(index: ArrayLike<number>, looks: Uint8Array, look: BodyLook): Uint32Array {
    const out = Uint32Array.from(index);
    for (let t = 0; t < looks.length; t++) {
        if (looks[t] !== look) {
            out[t * 3 + 1] = out[t * 3 + 2] = out[t * 3];
        }
    }
    return out;
}

/** Edge segments with those of hidden bodies collapsed to a point (segment numbers still name the same edges). */
export function maskedEdges(edges: ArrayLike<number>, segEdge: ArrayLike<number>, edgeBody: ArrayLike<number>, looks: readonly BodyLook[]): Float32Array {
    const out = Float32Array.from(edges);
    for (let s = 0; s < segEdge.length; s++) {
        if (lookOfBody(looks, edgeBody[segEdge[s]]) === 2) {
            out.copyWithin(s * 6 + 3, s * 6, s * 6 + 3);
        }
    }
    return out;
}

/** Cosmetic thread marks of the bodies that are shown. */
export function shownMarks(lines: Float32Array, body: ArrayLike<number>, looks: readonly BodyLook[]): Float32Array {
    if (!looks.includes(2)) {
        return lines;
    }
    const out: number[] = [];
    for (let s = 0; s < lines.length / 6; s++) {
        if (lookOfBody(looks, body[s]) !== 2) {
            for (let k = 0; k < 6; k++) {
                out.push(lines[s * 6 + k]);
            }
        }
    }
    return Float32Array.from(out);
}

/** The body picked in the feature tree, highlighted in the view. */
export const useBodyPick = create<{ partId: string | null; key: string | null }>(() => ({ partId: null, key: null }));

export function pickBody(partId: string | null, key: string | null): void {
    const s = useBodyPick.getState();
    if (s.partId !== partId || s.key !== key) {
        useBodyPick.setState({ partId, key });
    }
}

/**
 * The kernel surface with another index. Its attributes wrap the same arrays but are objects of their own: disposing
 * of a geometry frees its attributes' GPU buffers, which must not take the kernel mesh's (shared by every part showing it).
 */
function withIndex(kernel: KernelMesh, index: Uint32Array): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(kernel.surface.getAttribute('position').array, 3));
    g.setAttribute('normal', new BufferAttribute(kernel.surface.getAttribute('normal').array, 3));
    g.setIndex(new BufferAttribute(index, 1));
    g.boundingSphere = kernel.surface.boundingSphere?.clone() ?? null;
    return g;
}

export interface BodyDisplay {
    /** The part's surface to draw instead of the kernel's (null: draw it as it is). */
    surface: BufferGeometry | null;
    /** The see-through bodies, for a transparent mesh of their own. */
    seeThrough: BufferGeometry | null;
    /** The edge lines to draw instead of the kernel's. */
    edges: BufferGeometry | null;
    /** The faces of the body picked in the tree. */
    highlight: BufferGeometry | null;
    /** Cosmetic thread marks of the shown bodies. */
    marks: BufferGeometry | null;
}

const NOTHING: string[] = [];

/** What the view draws of a part's bodies (see the top of this file). */
export function useBodyDisplay(part: Pick<Part, 'id' | 'instanceOf'>, kernel: KernelMesh | null): BodyDisplay {
    const id = designId(part);
    const hiddenBodies = useStudio((s) => s.history?.view.hiddenBodies ?? NOTHING);
    const seeThroughBodies = useStudio((s) => s.history?.view.seeThroughBodies ?? NOTHING);
    const picked = useBodyPick((s) => (s.partId === id ? s.key : null));
    const display = useMemo((): BodyDisplay => {
        const none: BodyDisplay = { surface: null, seeThrough: null, edges: null, highlight: null, marks: null };
        if (!kernel || !kernel.bodies.length) {
            return none;
        }
        const looks = bodyLooks(kernel.bodies, id, { hiddenBodies, seeThroughBodies });
        const index = kernel.surface.getIndex()?.array;
        const out = { ...none };
        if (index && looks.some((l) => l !== 0)) {
            const tri = triangleLooks(kernel.triFace, kernel.faceBody, looks);
            out.surface = withIndex(kernel, maskedIndex(index, tri, 0));
            out.seeThrough = looks.includes(1) ? withIndex(kernel, maskedIndex(index, tri, 1)) : null;
            if (looks.includes(2)) {
                out.edges = new BufferGeometry();
                out.edges.setAttribute('position', new BufferAttribute(maskedEdges(kernel.edges.getAttribute('position').array,
                    kernel.segEdge, kernel.edgeBody, looks), 3));
            }
        }
        if (kernel.cosmetic.length) {
            const lines = shownMarks(kernel.cosmetic, kernel.cosmeticBody, looks);
            if (lines.length) {
                out.marks = new BufferGeometry();
                out.marks.setAttribute('position', new BufferAttribute(lines, 3));
            }
        }
        return out;
    }, [kernel, id, hiddenBodies, seeThroughBodies]);
    // A hidden body shows too while it is picked (SolidWorks previews it when it is selected in the tree).
    const highlight = useMemo(() => {
        const index = kernel?.surface.getIndex()?.array;
        const body = picked === null || !kernel ? -1 : kernel.bodies.findIndex((b) => b.key === picked);
        if (!kernel || !index || body < 0) {
            return null;
        }
        const own = new Uint8Array(kernel.triFace.length);
        for (let t = 0; t < own.length; t++) {
            own[t] = (kernel.faceBody[kernel.triFace[t]] ?? 0) === body ? 1 : 0;
        }
        return withIndex(kernel, maskedIndex(index, own, 1));
    }, [kernel, picked]);
    useEffect(() => () => {
        display.surface?.dispose();
        display.seeThrough?.dispose();
        display.edges?.dispose();
        display.marks?.dispose();
    }, [display]);
    useEffect(() => () => highlight?.dispose(), [highlight]);
    return useMemo(() => ({ ...display, highlight }), [display, highlight]);
}

/**
 * Where cosmetic threads run: a helix on the hole's or shaft's surface, hidden behind the model like its edges, in a
 * colour that stands out from the part's own (near black on a light part, near white on a dark one).
 */
export function CosmeticMarks({ geometry, dimmed, color }: { geometry: BufferGeometry | null; dimmed: boolean; color: string }) {
    if (!geometry || dimmed) {
        return null;
    }
    return (
        <lineSegments geometry={geometry} raycast={noRaycast}>
            <lineBasicMaterial color={markColor(color)} />
        </lineSegments>
    );
}

/** A mark colour that stands out from a part of colour `surface` (#rrggbb): dark on light parts, light on dark ones. */
export function markColor(surface: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(surface.trim());
    if (!m) {
        return MARK_DARK;
    }
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? MARK_DARK : MARK_LIGHT;
}

const MARK_DARK = '#141414';
const MARK_LIGHT = '#f0f0f0';
/** Opacity of a see-through body (SolidWorks makes a transparent body about three quarters clear). */
export const SEE_THROUGH = 0.28;
const noRaycast = () => null;
