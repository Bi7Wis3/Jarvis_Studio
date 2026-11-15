// The view side of the property manager's selection boxes (pickField.ts) for one part: which entities a click may
// pick, what a click does, and which faces and edges of the shown mesh the boxes' items are.

import { useEffect, useMemo } from 'react';
import type { KernelMesh } from './meshes';
import { activeEntities, entityOf, itemFor, pickTolerance, usePickSession, type PickItem, type PickMesh } from './pickField';
import { facePlane, type P3 } from './picking';
import { modelPick, positionFromPick, vertexAtClick } from './pickRefs';
import { clearPicked, useStudio } from './state';

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

const sameEntity = (a: Entity | null, b: Entity): boolean => !!a && a.kind === b.kind && a.index === b.index;

/**
 * The open form's selection boxes as they apply to this part's mesh, or null when no form with boxes is open for it.
 * `allow`: the kinds a click may pick; `click` sends a click to the active box; `faces` / `edges` are the boxes'
 * items in this mesh, `hover` the item of the row under the pointer.
 */
export function usePartPicks(partId: string, kernel: KernelMesh | null) {
    const session = usePickSession((s) => (s.partId === partId && s.owner ? s : null));
    const view = useMemo(() => (kernel ? meshOf(kernel) : null), [kernel]);
    const owner = session?.owner ?? null;

    // Entities picked before the form opened go into its first box (SolidWorks preselection).
    useEffect(() => {
        const s = usePickSession.getState();
        if (!owner || !view || !s.pick || !s.boxes.some((b) => !b.position)) {
            return;
        }
        const before = useStudio.getState().picked.filter((p) => p.partId === partId);
        if (before.length === 0) {
            return;
        }
        const refs = s.boxes.find((b) => b.key === s.active)?.entities.includes('ref');
        for (const p of before) {
            const item = itemFor(view.mesh, p);
            const model = refs && item ? modelPick(view.mesh, p, item.at) : null;
            if (item && model) {
                item.model = model;
            }
            if (item) {
                s.pick(item, (i) => sameEntity(entityOf(view.mesh, i, view.tolerance), p));
            }
        }
        clearPicked();
    }, [owner, !!view]);

    const found = useMemo(() => {
        if (!session || !view) {
            return null;
        }
        const faces: number[] = [];
        const edges: number[] = [];
        for (const items of Object.values(session.items)) {
            for (const item of items) {
                const e = entityOf(view.mesh, item, view.tolerance);
                if (e) {
                    (e.kind === 'face' ? faces : edges).push(e.index);
                }
            }
        }
        const row = session.hover ? session.items[session.hover.key]?.[session.hover.index] : undefined;
        const hover = row ? entityOf(view.mesh, row, view.tolerance) : null;
        return { faces, edges, hover };
    }, [session?.items, session?.hover, view]);

    if (!session || !view || !found) {
        return null;
    }
    const allow = activeEntities(session);
    /**
     * `point`: the clicked spot and `hitNormal` the face normal there, both in the part's frame; `near`: how far
     * (part units) the pointer picks an edge, for a vertex at the end of the edge.
     */
    const click = (entity: Entity, point: P3, hitNormal?: P3, near?: number) => {
        const s = usePickSession.getState();
        const box = s.boxes.find((b) => b.key === s.active);
        if (box?.position && s.place) {
            const { edges, segEdge } = view.mesh;
            // Near an edge's end: the vertex there.
            const corner = entity.kind === 'edge' ? vertexAtClick(edges, segEdge, entity.index, point, 2 * (near ?? view.tolerance)) : null;
            if (corner) {
                s.place(corner);
                return;
            }
            const at = entity.kind === 'edge'
                ? positionFromPick('edge', { edges, segEdge, edge: entity.index, point })
                : positionFromPick('face', { point, normal: hitNormal });
            s.place(at.position);
            return;
        }
        if (!box || !s.pick || !box.entities.includes(entity.kind)) {
            return;
        }
        if (box.flat && entity.kind === 'face'
            && !facePlane(view.mesh.positions, view.mesh.indices, view.mesh.triFace, entity.index).planar) {
            usePickSession.setState({ note: 'Pick a flat face.' });
            return;
        }
        if (box.entities.includes('ref')) {
            // A reference box keeps the geometry by value; a click at an edge's end picks the vertex there.
            const { edges, segEdge } = view.mesh;
            const corner = box.entities.includes('vertex') && entity.kind === 'edge'
                ? vertexAtClick(edges, segEdge, entity.index, point, 2 * (near ?? view.tolerance)) : null;
            if (corner) {
                const model = modelPick(view.mesh, { kind: 'vertex', at: corner }, point);
                const tie = view.tolerance * 1e-3;
                s.pick({ kind: 'vertex', at: corner, ...(model ? { model } : {}) },
                    (i) => i.kind === 'vertex' && Math.hypot(i.at[0] - corner[0], i.at[1] - corner[1], i.at[2] - corner[2]) <= tie);
                return;
            }
            const item = itemFor(view.mesh, entity, hitNormal);
            const model = modelPick(view.mesh, entity, point);
            if (item && model) {
                s.pick({ ...item, model }, (i) => sameEntity(entityOf(view.mesh, i, view.tolerance), entity));
            }
            return;
        }
        const item: PickItem | null = itemFor(view.mesh, entity, hitNormal);
        if (item) {
            s.pick(item, (i) => sameEntity(entityOf(view.mesh, i, view.tolerance), entity));
        }
    };
    // Whether the form has selection boxes (their items replace the plain picks in the view).
    const lists = session.boxes.some((b) => !b.position);
    return { allow, lists, click, ...found };
}
