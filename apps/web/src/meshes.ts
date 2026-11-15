// Real part geometry from the server's CAD kernel, fetched once per mesh key and shared between parts.

import { useEffect, useState } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import type { BodyInfo } from '@jarvis/core/visibility';
import { useStudio } from './state';

export interface KernelMesh {
    surface: BufferGeometry;
    /** Line segments along the solid's real edges, for CAD-style outlines. */
    edges: BufferGeometry;
    /** Per triangle of `surface`: the ordinal of its B-rep face (see picking.ts). */
    triFace: Uint32Array;
    /** Per segment of `edges`: the ordinal of its B-rep edge. */
    segEdge: Uint32Array;
    /** The solid bodies (Solid Bodies folder), and per face and per edge ordinal its body (past the end: body 0). */
    bodies: BodyInfo[];
    faceBody: Uint32Array;
    edgeBody: Uint32Array;
    /** Line segments marking cosmetic (hidden) threads, in the part frame, and per segment its body. */
    cosmetic: Float32Array;
    cosmeticBody: Uint32Array;
}

const cache = new Map<string, Promise<KernelMesh | null>>();
const MAX_CACHED = 400;

/**
 * Wire format of /api/mesh3/:key (encodeMesh3 in the server's meshes.ts): uint32 counts [positions, indices, edges,
 * faces, edge ordinals, cosmetic, json bytes], then positions, normals, indices, edges, triFace (indices / 3 entries),
 * segEdge (edges / 6 entries), faceBody, edgeBody, cosmetic, cosmeticBody (cosmetic / 6) and JSON { bodies }.
 */
export function decode(buffer: ArrayBuffer): KernelMesh {
    const [positions, indices, edges, faces, edgeCount, cosmeticCount, jsonBytes] = new Uint32Array(buffer, 0, 7);
    let at = 28;
    const take = <T>(make: (b: ArrayBuffer, o: number, n: number) => T, n: number): T => {
        const out = make(buffer, at, n);
        at += n * 4;
        return out;
    };
    const surface = new BufferGeometry();
    surface.setAttribute('position', new BufferAttribute(take((b, o, n) => new Float32Array(b, o, n), positions), 3));
    surface.setAttribute('normal', new BufferAttribute(take((b, o, n) => new Float32Array(b, o, n), positions), 3));
    surface.setIndex(new BufferAttribute(take((b, o, n) => new Uint32Array(b, o, n), indices), 1));
    surface.computeBoundingSphere();
    const lines = new BufferGeometry();
    lines.setAttribute('position', new BufferAttribute(take((b, o, n) => new Float32Array(b, o, n), edges), 3));
    const triFace = take((b, o, n) => new Uint32Array(b, o, n), indices / 3);
    const segEdge = take((b, o, n) => new Uint32Array(b, o, n), edges / 6);
    const faceBody = take((b, o, n) => new Uint32Array(b, o, n), faces);
    const edgeBody = take((b, o, n) => new Uint32Array(b, o, n), edgeCount);
    const cosmetic = take((b, o, n) => new Float32Array(b, o, n), cosmeticCount);
    const cosmeticBody = take((b, o, n) => new Uint32Array(b, o, n), cosmeticCount / 6);
    let bodies: BodyInfo[] = [];
    try {
        bodies = (JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, at, jsonBytes))) as { bodies?: BodyInfo[] }).bodies ?? [];
    } catch {
        bodies = [];
    }
    return { surface, edges: lines, triFace, segEdge, bodies, faceBody, edgeBody, cosmetic, cosmeticBody };
}

function load(key: string): Promise<KernelMesh | null> {
    let entry = cache.get(key);
    if (!entry) {
        entry = fetch(`/api/mesh3/${key}`)
            .then((response) => (response.ok ? response.arrayBuffer() : null))
            .then((buffer) => (buffer ? decode(buffer) : null))
            .catch(() => null);
        cache.set(key, entry);
        // A failed load (the server restarting, say) must not stick: the next ask tries again.
        void entry.then((mesh) => {
            if (!mesh && cache.get(key) === entry) {
                cache.delete(key);
            }
            if (mesh) {
                remember(key, mesh);
            }
        });
        if (cache.size > MAX_CACHED) {
            cache.delete(cache.keys().next().value!);
        }
    }
    return entry;
}

/**
 * The kernel mesh for a part, or null while it is building (or when the kernel failed). `withPreview`: the open
 * tool form's preview mesh when it has one (the 3D view only; readouts show the real part).
 */
export function useKernelMesh(partId: string, withPreview = false): KernelMesh | null {
    const key = useStudio((s) => (withPreview ? s.preview?.keys[partId] : undefined) ?? s.meshes.keys[partId] ?? null);
    const [mesh, setMesh] = useState<{ key: string; mesh: KernelMesh | null } | null>(null);
    useEffect(() => {
        if (!key) {
            return;
        }
        let live = true;
        let retry: ReturnType<typeof setTimeout> | undefined;
        const fetchMesh = (attempt: number) => {
            void load(key).then((result) => {
                if (!live) {
                    return;
                }
                if (result) {
                    setMesh({ key, mesh: result });
                } else if (attempt < 40) {
                    // The server said this mesh exists, so a failed load is a server that is restarting: keep asking
                    // (for a couple of minutes), or the part stays invisible until the page is reloaded.
                    retry = setTimeout(() => fetchMesh(attempt + 1), Math.min(800 * (attempt + 1), 4000));
                }
            });
        };
        fetchMesh(0);
        return () => {
            live = false;
            clearTimeout(retry);
        };
    }, [key]);
    // Keep showing the previous mesh while a changed part rebuilds, so it does not flicker.
    return mesh?.mesh ?? null;
}

/** The mesh with this key, loaded once and shared (null when it cannot be loaded). */
export function meshByKey(key: string): Promise<KernelMesh | null> {
    return load(key);
}

const boxes = new Map<string, [[number, number, number], [number, number, number]]>();

/**
 * The bounding box of a part's current kernel mesh in its own frame, when that mesh has been loaded already (the
 * part workspace loads the active part's); null otherwise. Sketch-built parts have no size of their own.
 */
export function loadedMeshBounds(partId: string): [[number, number, number], [number, number, number]] | null {
    const key = useStudio.getState().meshes.keys[partId];
    if (!key) {
        return null;
    }
    if (!boxes.has(key)) {
        void load(key);
    }
    return boxes.get(key) ?? null;
}

function remember(key: string, mesh: KernelMesh): void {
    mesh.surface.computeBoundingBox();
    const box = mesh.surface.boundingBox;
    if (box && !box.isEmpty()) {
        boxes.set(key, [box.min.toArray(), box.max.toArray()]);
        if (boxes.size > MAX_CACHED) {
            boxes.delete(boxes.keys().next().value!);
        }
    }
}

/** The mesh with this key, or null while it loads; for drawing something that is not a committed part (a preview). */
export function useMeshByKey(key: string | null): KernelMesh | null {
    const [mesh, setMesh] = useState<{ key: string; mesh: KernelMesh } | null>(null);
    useEffect(() => {
        if (!key) {
            return;
        }
        let live = true;
        void load(key).then((result) => live && result && setMesh({ key, mesh: result }));
        return () => {
            live = false;
        };
    }, [key]);
    // The last one stays up while the next loads, so a ghost does not blink between values.
    return key ? mesh?.mesh ?? null : null;
}
