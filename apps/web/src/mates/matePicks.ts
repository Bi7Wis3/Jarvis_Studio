// The view side of the Mate form for one part (as pickView.ts is for a part's own forms): while the form is open in
// the assembly, a click on any component's face, edge or vertex goes to the form's active box, and the boxes' entries
// and the row under the pointer are highlighted on the part's mesh.

import { useMemo } from 'react';
import type { MateRef } from '@jarvis/core/mates';
import type { KernelMesh } from '../meshes';
import { entityOf, itemFor, pickTolerance, type PickMesh } from '../pickField';
import type { P3 } from '../picking';
import { modelPick, vertexAtClick } from '../pickRefs';
import { useStudio } from '../state';
import { estimateGeom, matePickCopy, pickMateItem, useMateForm, useMateSelection } from './mateState';

type Entity = { kind: 'edge' | 'face'; index: number };

function meshOf(kernel: KernelMesh): { mesh: PickMesh; tolerance: number } {
    const surface = kernel.surface;
    if (!surface.boundingSphere) {
        surface.computeBoundingSphere();
    }
    return {
        mesh: {
            positions: surface.getAttribute('position').array,
            normals: surface.getAttribute('normal').array,
            indices: surface.getIndex()!.array,
            triFace: kernel.triFace,
            edges: kernel.edges.getAttribute('position').array,
            segEdge: kernel.segEdge,
        },
        tolerance: pickTolerance(2 * (surface.boundingSphere?.radius ?? 10)),
    };
}

/** The entity of the mesh a reference names, when it is a face or edge of this part. */
function entityOfRef(ref: MateRef, partId: string, view: { mesh: PickMesh; tolerance: number }): Entity | null {
    const pick = ref.pick;
    if (ref.part !== partId || (pick.kind !== 'face' && pick.kind !== 'edge')) {
        return null;
    }
    return entityOf(view.mesh, pick.kind === 'face' ? { kind: 'face', at: pick.at, normal: pick.normal } : { kind: 'edge', at: pick.at }, view.tolerance);
}

/** A face, edge or vertex picked on a part, as a mate reference with the geometry the mesh suggests. */
export function refFromClick(partId: string, view: { mesh: PickMesh; tolerance: number }, entity: Entity, point: P3, hitNormal?: P3, reach?: number): MateRef | null {
    const copy = matePickCopy();
    const base = { part: partId, ...(copy ? { copy } : {}) };
    const { edges, segEdge } = view.mesh;
    const corner = entity.kind === 'edge' ? vertexAtClick(edges, segEdge, entity.index, point, 2 * (reach ?? view.tolerance)) : null;
    if (corner) {
        const model = modelPick(view.mesh, { kind: 'vertex', at: corner }, point);
        return { ...base, pick: { kind: 'vertex', at: corner, ...(model?.faces?.length ? { faces: model.faces } : {}) }, found: { type: 'point', point: corner } };
    }
    const item = itemFor(view.mesh, entity, hitNormal);
    const model = modelPick(view.mesh, entity, point);
    if (!item) {
        return null;
    }
    const found = estimateGeom(model, item.kind === 'face' ? item.normal : undefined) ?? undefined;
    if (item.kind === 'face') {
        return { ...base, pick: { kind: 'face', at: item.at, ...(item.normal ? { normal: item.normal } : {}) }, ...(found ? { found } : {}) };
    }
    return { ...base, pick: { kind: 'edge', at: item.at, ...(model?.faces?.length ? { faces: model.faces } : {}) }, ...(found ? { found } : {}) };
}

/**
 * The Mate form's picking on this part, or null when the form is not open in the assembly. Shaped as usePartPicks'
 * answer, so the part draws and routes it the same way.
 */
export function useMatePicks(partId: string, kernel: KernelMesh | null) {
    const open = useMateForm((s) => s.open);
    const items = useMateForm((s) => s.items);
    const hover = useMateForm((s) => s.hover);
    const selected = useMateSelection((s) => s.selected);
    const assembly = useStudio((s) => s.workspace === 'assembly');
    const mates = useStudio((s) => s.history?.assembly?.mates);
    const view = useMemo(() => (kernel ? meshOf(kernel) : null), [kernel]);
    const found = useMemo(() => {
        if (!view) {
            return null;
        }
        const refs = open ? items.map((i) => i.ref) : (mates ?? []).filter((m) => selected.includes(m.id)).flatMap((m) => m.refs);
        const faces: number[] = [];
        const edges: number[] = [];
        for (const ref of refs) {
            const e = entityOfRef(ref, partId, view);
            if (e) {
                (e.kind === 'face' ? faces : edges).push(e.index);
            }
        }
        const row = open && hover !== null ? items[hover] : undefined;
        return { faces, edges, hover: row ? entityOfRef(row.ref, partId, view) : null };
    }, [open, items, hover, selected, mates, view, partId]);
    if (!assembly || !view || !found || (!open && !found.faces.length && !found.edges.length)) {
        return null;
    }
    const click = (entity: Entity, point: P3, hitNormal?: P3, reach?: number) => {
        const ref = refFromClick(partId, view, entity, point, hitNormal, reach);
        if (ref) {
            pickMateItem(ref);
        }
    };
    return { allow: open ? ['edge', 'face'] as string[] : [], lists: true, click, ...found };
}
