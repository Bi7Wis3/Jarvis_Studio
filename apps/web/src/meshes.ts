// Real part geometry from the server's CAD kernel, fetched once per mesh key and shared between parts.

import { useEffect, useState } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import { useStudio } from './state';

export interface KernelMesh {
    surface: BufferGeometry;
    /** Line segments along the solid's real edges, for CAD-style outlines. */
    edges: BufferGeometry;
    /** Per triangle of `surface`: the ordinal of its B-rep face (see picking.ts). */
    triFace: Uint32Array;
    /** Per segment of `edges`: the ordinal of its B-rep edge. */
    segEdge: Uint32Array;
}

const cache = new Map<string, Promise<KernelMesh | null>>();
const MAX_CACHED = 400;

/**
 * Wire format of /api/mesh2/:key: uint32 counts [positions, indices, edges], then positions, normals, indices, edges,
 * triFace (indices / 3 entries) and segEdge (edges / 6 entries).
 */
function decode(buffer: ArrayBuffer): KernelMesh {
    const [positions, indices, edges] = new Uint32Array(buffer, 0, 3);
    let at = 12;
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
    return { surface, edges: lines, triFace, segEdge };
}

function load(key: string): Promise<KernelMesh | null> {
    let entry = cache.get(key);
    if (!entry) {
        entry = fetch(`/api/mesh2/${key}`)
            .then((response) => (response.ok ? response.arrayBuffer() : null))
            .then((buffer) => (buffer ? decode(buffer) : null))
            .catch(() => null);
        cache.set(key, entry);
        // A failed load (the server restarting, say) must not stick: the next ask tries again.
        void entry.then((mesh) => {
            if (!mesh && cache.get(key) === entry) {
                cache.delete(key);
            }
        });
        if (cache.size > MAX_CACHED) {
            cache.delete(cache.keys().next().value!);
        }
    }
    return entry;
}

/** The kernel mesh for a part, or null while it is building (or when the kernel failed). */
export function useKernelMesh(partId: string): KernelMesh | null {
    const key = useStudio((s) => s.meshes.keys[partId] ?? null);
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
                } else if (attempt < 5) {
                    retry = setTimeout(() => fetchMesh(attempt + 1), 800 * (attempt + 1));
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
