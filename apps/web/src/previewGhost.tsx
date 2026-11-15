// The open tool form's preview, drawn over the untouched model as a see-through ghost. As in SolidWorks only the
// feature's own material is highlighted: the volume a boss adds or a cut removes, the faces a fillet, chamfer or shell
// makes (the server's change mesh, see apps/server/src/cad/change.ts). A new or moved part is shown whole.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { DoubleSide, GreaterDepth, MathUtils, type Group } from 'three';
import type { Part, Vec3 } from '@jarvis/core';
import { buildGeometry, instanceTransforms } from '@jarvis/core/geometry';
import { anim } from './anim';
import { useMeshByKey } from './meshes';
import { useStudio } from './state';

/** Colour of the ghost that shows what an open tool form would make. */
export const GHOST_COLOR = '#ffd34d';

const noRaycast = () => null;

/** How a ghost is drawn where it is in front of the model and where the model hides it (see-through, fainter). */
export const GHOST_LOOK = {
    face: 0.34,
    hiddenFace: 0.14,
    edge: 0.95,
    hiddenEdge: 0.4,
} as const;

/**
 * Which mesh a preview shows for a part: `change` (from the preview's changes) is only what changes, null nothing;
 * when the part is not listed there (undefined) the whole part as it would be.
 */
export function ghostMeshKey(change: string | null | undefined, whole: string | null): { key: string | null; whole: boolean } {
    return change !== undefined ? { key: change, whole: false } : { key: whole, whole: true };
}

/**
 * What an open tool form would make of a part. A change is drawn in front of the model (it lies on or in the model)
 * and, fainter, where the model hides it, so a cut's removed volume shows inside the part. A whole part is pushed a
 * hair back instead, so where it matches the model the model shows, untinted. Never clickable.
 */
export function GhostPart({ part, offset }: { part: Part; offset: Vec3 }) {
    const group = useRef<Group>(null);
    const committed = useStudio((s) => s.meshes.keys[part.id] ?? null);
    const change = useStudio((s) => s.preview?.changes?.[part.id]);
    const built = useStudio((s) => s.preview?.keys[part.id] ?? null);
    const { key, whole } = ghostMeshKey(change, built ?? committed);
    const kernel = useMeshByKey(key);
    const placeholder = useMemo(() => (whole ? buildGeometry(part.shape) : null), [whole, JSON.stringify(part.shape)]);
    const instances = useMemo(() => instanceTransforms(part), [JSON.stringify(part.repeat)]);
    useEffect(() => () => placeholder?.dispose(), [placeholder]);
    useFrame(() => {
        group.current?.position.set(offset[0] * anim.explode, offset[1] * anim.explode, offset[2] * anim.explode);
    });
    if (!whole && !key) {
        return null;
    }
    const surface = kernel?.surface ?? placeholder;
    const rotation = part.rotation.map(MathUtils.degToRad) as Vec3;
    // In front: pulled towards the eye so faces it shares with the model win; whole: pushed back.
    const offsetFactor = whole ? 1 : -1;
    const offsetUnits = whole ? 2 : -4;
    return (
        <group ref={group}>
            {instances.map((matrix, i) => (
                <group key={i} matrix={matrix} matrixAutoUpdate={false}>
                    <group position={part.position} rotation={rotation}>
                        {surface && (
                            <mesh geometry={surface} raycast={noRaycast} renderOrder={3}>
                                <meshBasicMaterial
                                    color={GHOST_COLOR}
                                    transparent
                                    opacity={GHOST_LOOK.face}
                                    depthWrite={false}
                                    side={DoubleSide}
                                    polygonOffset
                                    polygonOffsetFactor={offsetFactor}
                                    polygonOffsetUnits={offsetUnits}
                                    toneMapped={false}
                                />
                            </mesh>
                        )}
                        {surface && !whole && (
                            <mesh geometry={surface} raycast={noRaycast} renderOrder={3}>
                                <meshBasicMaterial
                                    color={GHOST_COLOR}
                                    transparent
                                    opacity={GHOST_LOOK.hiddenFace}
                                    depthWrite={false}
                                    depthFunc={GreaterDepth}
                                    side={DoubleSide}
                                    polygonOffset
                                    polygonOffsetFactor={offsetFactor}
                                    polygonOffsetUnits={offsetUnits}
                                    toneMapped={false}
                                />
                            </mesh>
                        )}
                        {kernel && (
                            <lineSegments geometry={kernel.edges} raycast={noRaycast} renderOrder={4}>
                                {whole
                                    ? <lineBasicMaterial color={GHOST_COLOR} transparent opacity={0.6} depthTest={false} toneMapped={false} />
                                    : <lineBasicMaterial color={GHOST_COLOR} transparent opacity={GHOST_LOOK.edge} depthWrite={false} toneMapped={false} />}
                            </lineSegments>
                        )}
                        {kernel && !whole && (
                            <lineSegments geometry={kernel.edges} raycast={noRaycast} renderOrder={4}>
                                <lineBasicMaterial color={GHOST_COLOR} transparent opacity={GHOST_LOOK.hiddenEdge} depthWrite={false}
                                    depthFunc={GreaterDepth} toneMapped={false} />
                            </lineSegments>
                        )}
                    </group>
                </group>
            ))}
        </group>
    );
}
