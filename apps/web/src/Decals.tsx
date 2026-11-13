// Pictures projected onto part surfaces. Rendered as children of a part's mesh, so decal coordinates (part frame)
// are the mesh's local frame.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Mesh, SRGBColorSpace, TextureLoader, type BufferGeometry, type Group, type Texture } from 'three';
import type { Decal, Part } from '@jarvis/core';
import { buildDecalGeometry } from './decalMath';

const textures = new Map<string, Texture>();
const pending = new Map<string, Promise<Texture>>();
const loader = new TextureLoader();

export function assetUrl(id: string): string {
    return `/api/assets/${encodeURIComponent(id)}`;
}

/** Loads (once) and caches the texture of an asset; null until it has loaded. */
function useAssetTexture(id: string): Texture | null {
    const [texture, setTexture] = useState<Texture | null>(() => textures.get(id) ?? null);
    useEffect(() => {
        const cached = textures.get(id);
        if (cached) {
            setTexture(cached);
            return;
        }
        let live = true;
        let load = pending.get(id);
        if (!load) {
            load = loader.loadAsync(assetUrl(id)).then((t) => {
                t.colorSpace = SRGBColorSpace;
                t.anisotropy = 8;
                textures.set(id, t);
                return t;
            });
            pending.set(id, load);
            load.catch(() => pending.delete(id));
        }
        load.then((t) => live && setTexture(t)).catch(() => undefined);
        return () => {
            live = false;
        };
    }, [id]);
    return texture;
}

const noRaycast = () => null;

/** The geometry each part is drawn with (part frame), for placing and sizing decals outside the scene. */
const partGeometries = new Map<string, BufferGeometry>();

export function partGeometry(partId: string): BufferGeometry | null {
    return partGeometries.get(partId) ?? null;
}

function OneDecal({ decal, surface }: { decal: Decal; surface: BufferGeometry }) {
    const texture = useAssetTexture(decal.image);
    const geometry = useMemo(
        () => buildDecalGeometry(surface, decal),
        [surface, decal.position.join(), decal.normal.join(), decal.size.join(), decal.rotation, decal.depth, decal.mode],
    );
    useEffect(() => () => geometry?.dispose(), [geometry]);
    if (!texture || !geometry) {
        return null;
    }
    return (
        <mesh geometry={geometry} raycast={noRaycast} renderOrder={1}>
            <meshStandardMaterial
                map={texture}
                transparent
                opacity={decal.opacity ?? 1}
                depthWrite={false}
                polygonOffset
                polygonOffsetFactor={-4}
                polygonOffsetUnits={-4}
                roughness={0.55}
                metalness={0}
            />
        </mesh>
    );
}

/** One projected picture per decal of `part`; must be a child of the part's mesh (its local frame is the part frame). */
export function PartDecals({ part }: { part: Part }) {
    // The projection is computed from the parent mesh's geometry: rebuild whenever that geometry is swapped
    // (preview shape, then the kernel's mesh).
    const probe = useRef<Group>(null);
    const [surface, setSurface] = useState<BufferGeometry | null>(null);
    useFrame(() => {
        const parent = probe.current?.parent;
        const next = parent instanceof Mesh ? parent.geometry as BufferGeometry : null;
        if (next && partGeometries.get(part.id) !== next) {
            partGeometries.set(part.id, next);
        }
        if (next !== surface) {
            setSurface(next);
        }
    });
    return (
        <>
            <group ref={probe} />
            {surface && part.decals?.map((decal) => (
                <OneDecal key={`${decal.id}:${decal.image}`} decal={decal} surface={surface} />
            ))}
        </>
    );
}
