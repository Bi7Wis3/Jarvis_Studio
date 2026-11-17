// What the Mate form and the assembly tree share with the 3D view: the form's selection boxes and options, the mates
// selected in the tree (highlighted in the view), and the exact geometry of what was picked (asked of the kernel).

import { create } from 'zustand';
import type { Part, Vec3 } from '@jarvis/core';
import {
    defaultMateType, refGeometry, refLabel, validMateTypes, type DistanceEnd, type Mate, type MateGeom, type MatePick, type MateRef,
    type MateType,
} from '@jarvis/core/mates';
import type { ModelPick } from '../pickRefs';
import { useStudio } from '../state';

/** The selection boxes: Entities to Mate, or in multiple mate mode the common reference and the component references. */
export type MateBox = 'entities' | 'common' | 'components';

/** One entry of a selection box: what was picked, and its geometry (estimated from the mesh until the kernel answers). */
export interface MateItem {
    ref: MateRef;
    box: MateBox;
    /** The kernel's geometry has arrived (faces, edges and vertices), or it needs none (planes, origins). */
    exact: boolean;
}

export interface MateFormState {
    open: boolean;
    /** The mate being edited (Edit mate), or null for new mates. */
    editing: string | null;
    name: string;
    items: MateItem[];
    active: MateBox;
    /** The row under the pointer (index into items), highlighted in the view. */
    hover: number | null;
    /** The type chosen; null: the one the selection suggests. */
    type: MateType | null;
    /** null: as the components stand. */
    alignment: 'aligned' | 'antiAligned' | null;
    /** The value typed (mm or degrees); null: as the components stand. */
    value: string | null;
    flip: boolean | null;
    lockRotation: boolean;
    alignAxes: boolean;
    ends: [DistanceEnd, DistanceEnd];
    multiple: boolean;
    multiFolder: boolean;
    newFolder: boolean;
    positionOnly: boolean;
    /** Why a click was not taken. */
    note: string | null;
}

const CLOSED: MateFormState = {
    open: false, editing: null, name: '', items: [], active: 'entities', hover: null, type: null, alignment: null, value: null,
    flip: null, lockRotation: false, alignAxes: false, ends: ['centre', 'centre'], multiple: false, multiFolder: false,
    newFolder: false, positionOnly: false, note: null,
};

export const useMateForm = create<MateFormState>(() => CLOSED);

export function resetMateForm(): void {
    useMateForm.setState(CLOSED, true);
}

/** Mates selected in the tree (their entities are highlighted in the view). */
export const useMateSelection = create<{ selected: string[] }>(() => ({ selected: [] }));

/** The copy of a patterned part the last click in the view was on (Scene sets it before passing the click on). */
let clickedCopy = 0;
export function setMatePickCopy(copy: unknown): void {
    clickedCopy = typeof copy === 'number' ? copy : 0;
}
export const matePickCopy = (): number => clickedCopy;

const near = (a: Vec3, b: Vec3, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

/** Whether two references name the same entity. */
export function sameRef(a: MateRef, b: MateRef, tolerance = 1e-3): boolean {
    if ((a.part ?? null) !== (b.part ?? null) || (a.copy ?? 0) !== (b.copy ?? 0) || a.pick.kind !== b.pick.kind) {
        return false;
    }
    const p = a.pick;
    const q = b.pick;
    if ('at' in p && 'at' in q) {
        return near(p.at, q.at, tolerance);
    }
    return JSON.stringify(p) === JSON.stringify(q);
}

/** The geometry of an item as known now. */
export function itemGeom(item: MateItem, parts: readonly Part[]): MateGeom | null {
    return refGeometry(item.ref, parts);
}

/** Box labels: Face<1>@Plate, counted per kind across the boxes, as SolidWorks numbers them. */
export function itemLabels(items: readonly MateItem[], parts: readonly Part[]): string[] {
    const counts = new Map<string, number>();
    return items.map((item) => {
        const kind = item.ref.pick.kind;
        const n = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, n);
        return refLabel(item.ref, parts, n);
    });
}

/** The mate geometry the mesh suggests for a picked face, edge or vertex, until the kernel's exact answer comes. */
export function estimateGeom(model: ModelPick | null | undefined, normal?: Vec3): MateGeom | null {
    const g = model?.geom;
    if (!g) {
        return null;
    }
    switch (g.type) {
        case 'plane':
            return { type: 'plane', origin: g.origin, normal: g.normal };
        case 'cylinder': {
            let inside = false;
            if (normal) {
                const rel: Vec3 = [model!.click[0] - g.point[0], model!.click[1] - g.point[1], model!.click[2] - g.point[2]];
                const along = rel[0] * g.direction[0] + rel[1] * g.direction[1] + rel[2] * g.direction[2];
                const radial: Vec3 = [rel[0] - along * g.direction[0], rel[1] - along * g.direction[1], rel[2] - along * g.direction[2]];
                inside = radial[0] * normal[0] + radial[1] * normal[1] + radial[2] * normal[2] < 0;
            }
            return { type: 'cylinder', point: g.point, direction: g.direction, radius: g.radius, inside };
        }
        case 'line': {
            const d: Vec3 = [g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]];
            const l = Math.hypot(...d) || 1;
            return { type: 'line', point: g.a, direction: [d[0] / l, d[1] / l, d[2] / l] };
        }
        case 'circle':
            return { type: 'circle', centre: g.centre, normal: g.normal, radius: g.radius };
        case 'vertex':
            return { type: 'point', point: g.at };
        case 'surface':
            return { type: 'surface' };
        case 'curve':
            return { type: 'curve' };
        default:
            // A cone's apex and angle come with the kernel's answer.
            return null;
    }
}

const exactCache = new Map<string, Promise<(MateGeom | { error: string })[] | null>>();

/** The kernel's geometry of picks on a part as it is now (cached by the part's mesh key). */
export function exactGeometry(partId: string, picks: MatePick[]): Promise<(MateGeom | { error: string })[] | null> {
    const key = `${useStudio.getState().meshes.keys[partId] ?? ''} ${partId} ${JSON.stringify(picks)}`;
    let hit = exactCache.get(key);
    if (!hit) {
        hit = fetch('/api/mate-geometry', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ partId, picks }),
        }).then((r) => (r.ok ? r.json() : null)).then((j: { answers?: (MateGeom | { error: string })[] } | null) => j?.answers ?? null)
            .catch(() => null);
        exactCache.set(key, hit);
        if (exactCache.size > 300) {
            exactCache.delete(exactCache.keys().next().value!);
        }
    }
    return hit;
}

/** Puts a picked entity in the active box (or takes it out when it is there already). */
export function pickMateItem(ref: MateRef): void {
    const form = useMateForm.getState();
    if (!form.open) {
        return;
    }
    const box = form.multiple ? form.active : 'entities';
    const inBox = form.items.filter((i) => i.box === box);
    const same = inBox.findIndex((i) => sameRef(i.ref, ref));
    if (same >= 0) {
        const target = inBox[same];
        useMateForm.setState({ items: form.items.filter((i) => i !== target), note: null });
        return;
    }
    const model = ref.pick.kind === 'face' || ref.pick.kind === 'edge' || ref.pick.kind === 'vertex';
    const item: MateItem = { ref, box, exact: !model };
    // A standard mate takes two entities; a third replaces the second. The common reference takes one.
    let items = form.items;
    const limit = box === 'entities' ? 2 : box === 'common' ? 1 : Infinity;
    if (inBox.length >= limit) {
        const drop = inBox[inBox.length - 1];
        items = items.filter((i) => i !== drop);
    }
    items = [...items, item];
    const next: Partial<MateFormState> = { items, note: null };
    if (box === 'common') {
        next.active = 'components';
    }
    useMateForm.setState(next);
    if (model && ref.part) {
        void exactGeometry(ref.part, [ref.pick]).then((answers) => {
            const answer = answers?.[0];
            const now = useMateForm.getState().items;
            if (!answer || !now.includes(item)) {
                return;
            }
            const exact: MateItem = 'error' in answer ? { ...item, exact: true } : { ...item, ref: { ...item.ref, found: answer }, exact: true };
            useMateForm.setState({ items: now.map((i) => (i === item ? exact : i)) });
        });
    }
}

/** The pairs of references the form would mate: the two entities, or the common reference with each component's. */
export function formPairs(form: Pick<MateFormState, 'items' | 'multiple'>): [MateItem, MateItem][] {
    if (!form.multiple) {
        const [a, b] = form.items.filter((i) => i.box === 'entities');
        return a && b ? [[a, b]] : [];
    }
    const common = form.items.find((i) => i.box === 'common');
    return common ? form.items.filter((i) => i.box === 'components').map((c) => [common, c] as [MateItem, MateItem]) : [];
}

/** The mate types the form's selection takes (all pairs must take them), and the one it suggests. */
export function formTypes(form: Pick<MateFormState, 'items' | 'multiple'>, parts: readonly Part[]): { valid: MateType[]; suggested: MateType | null } {
    const pairs = formPairs(form);
    if (!pairs.length) {
        return { valid: [], suggested: null };
    }
    let valid: MateType[] | null = null;
    let suggested: MateType | null = null;
    for (const [a, b] of pairs) {
        const ga = itemGeom(a, parts);
        const gb = itemGeom(b, parts);
        const same = (a.ref.part ?? null) === (b.ref.part ?? null) && (a.ref.copy ?? 0) === (b.ref.copy ?? 0);
        const types = ga && gb ? validMateTypes(ga, gb, same) : same ? [] : ['lock' as MateType];
        valid = valid ? valid.filter((t) => types.includes(t)) : types;
        suggested ??= ga && gb && !same ? defaultMateType(ga, gb) : null;
    }
    const list = valid ?? [];
    return { valid: list, suggested: suggested && list.includes(suggested) ? suggested : list.find((t) => t !== 'lock') ?? list[0] ?? null };
}

/** The references of a stored mate as form items. */
export function itemsOfMate(mate: Mate): MateItem[] {
    return mate.refs.map((ref) => ({ ref: { ...ref }, box: 'entities', exact: true }));
}
