// In the assembly, a sketch snaps to the sketches the other parts show there (SketchSteps draws them in each part's
// placement): their steps, with the move from each part's frame into the frame of the part being sketched.

import { effectivePart, explodeOffsets, type Part, type Project, type Vec3 } from '@jarvis/core';
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { PartSketches } from './sketchOthers';
import { designId } from './bodyView';

/** Where a part's frame sits in the world, with the assembly's explode applied as the view applies it. */
function frameMatrix(part: Part, offset: Vec3, explode: number): Matrix4 {
    const rotation = new Euler(...(part.rotation.map(MathUtils.degToRad) as Vec3), 'XYZ');
    const position = new Vector3(...part.position).addScaledVector(new Vector3(...offset), explode);
    return new Matrix4().compose(position, new Quaternion().setFromEuler(rotation), new Vector3(1, 1, 1));
}

/**
 * The other shown parts' sketch steps as the part `partId` sees them. `project` holds the parts shown, `all` every
 * part (an instance's source may be hidden), `hidden` the steps left out ("designId/stepId").
 */
export function assemblySketches(project: Project, all: readonly Part[], partId: string, hidden: ReadonlySet<string>): PartSketches[] {
    const self = project.parts.find((p) => p.id === partId);
    if (!self) {
        return [];
    }
    const offsets = explodeOffsets(project);
    const explode = project.view.explode ?? 0;
    const toSelf = frameMatrix(self, offsets[self.id] ?? [0, 0, 0], explode).invert();
    return project.parts.filter((p) => p.id !== partId).flatMap((p): PartSketches[] => {
        const features = effectivePart(p, [...all]).features ?? [];
        if (!features.some((f) => f.op === 'sketch')) {
            return [];
        }
        const move = toSelf.clone().multiply(frameMatrix(p, offsets[p.id] ?? [0, 0, 0], explode));
        const design = designId(p);
        const at = new Vector3();
        return [{
            prefix: `${p.id}:`,
            features,
            place: (q) => at.set(q[0], q[1], q[2]).applyMatrix4(move).toArray() as Vec3,
            skip: (id) => hidden.has(`${design}/${id}`),
        }];
    });
}
