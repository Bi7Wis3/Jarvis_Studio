// The primitives pulldown next to Sketch (part toolbar): each primitive's form in the left panel and the step it makes.
// The logic is in primitiveFeature.ts; this file turns it into toolbar tools, their editors and their drag handles.

import { Matrix4, Vector3 } from 'three';
import type { Feature, Material, Vec3 } from '@jarvis/core';
import { resolvePlane } from '@jarvis/core/reference';
import { nextNumberedName } from './featureNames';
import { stepAtBar } from './historyOps';
import { pickItems, type PickItem } from './pickField';
import {
    halfAxis, pickedPlacement, placementValues, primitiveAxis, primitiveKindOf, primitivePlacement, primitiveShape, primitiveSizeValues,
    primitiveStep, reanchor, tidy, PRIMITIVE_KINDS, PRIMITIVE_LABELS, SIZE_DEFAULTS, SIZE_FIELDS, type PickedPlace, type PrimitiveKind,
} from './primitiveFeature';
import { asPlane, itemClass, refKind, stepsBefore } from './referenceDefs';
import { runTool, select, setWorkspace, useStudio } from './state';
import { attempt, fullPart, saveFeature, type Ctx, type Field, type Result, type ToolDef, type Values } from './toolDefs';
import { DEFAULT_STEP, partMatrix, TOOL_HANDLES, type Handle } from './toolHandles';

const GREY: Material = { color: '#b8bcc4', metalness: 0, roughness: 0.7 };
/** Steps made here get ids starting with this, so their editor is this form even for a box cut (not Cut pocket). */
const ID_PREFIX = 'prim-';

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

const clean = (p: Vec3): Vec3 => p.map(tidy) as Vec3;

/** The point and outward direction a pick in the Place on box gives, or null for what cannot carry a primitive. */
export function placeOfPick(item: PickItem, steps: Feature[]): PickedPlace | null {
    const place = pickPlace(item, steps);
    return place && { point: clean(place.point), normal: clean(place.normal) };
}

function pickPlace(item: PickItem, steps: Feature[]): PickedPlace | null {
    if (item.kind === 'ref') {
        if (refKind(item.ref) !== 'plane') {
            return null;
        }
        const plane = resolvePlane(asPlane(item), steps);
        return { point: plane.origin, normal: plane.normal };
    }
    const g = item.model?.geom;
    if (g?.type === 'plane') {
        // The clicked spot, put exactly on the plane (the mesh's float noise off).
        const click = (item.model?.click ?? g.origin) as Vec3;
        return { point: sub(click, scale(g.normal as Vec3, dot(sub(click, g.origin as Vec3), g.normal as Vec3))), normal: [...g.normal] as Vec3 };
    }
    if (g?.type === 'circle') {
        // A circle's axis has no side of its own: take the side of the flat face it bounds, when there is one.
        const n = [...g.normal] as Vec3;
        const face = item.model?.faces?.find((f) => f.normal && Math.abs(dot(f.normal as Vec3, n)) > 0.99);
        return { point: [...g.centre] as Vec3, normal: face?.normal && dot(face.normal as Vec3, n) < 0 ? scale(n, -1) : n };
    }
    return null;
}

const acceptPlace = (item: PickItem): string | null => {
    const c = itemClass(item);
    return c === 'plane' || c === 'circle' ? null : 'Pick a flat face, a plane or a circular edge.';
};

function sizeFields(kind: PrimitiveKind): Field[] {
    return SIZE_FIELDS[kind].map((f): Field => (f.kind === 'check'
        ? { key: f.key, label: f.label, kind: 'check', section: 'Sizes' }
        : {
            key: f.key, label: f.label, kind: 'number', unit: 'mm', min: 0, section: 'Sizes',
            ...(f.zero ? { step: 0.5 } : {}), ...(f.when ? { show: (v: Values) => !!v[f.when!] } : {}),
        }));
}

const PLACEMENT: Field[] = [
    { key: 'on', label: 'Place on', kind: 'pick', entities: ['face', 'edge', 'ref'], multi: false, flat: true, accept: acceptPlace, section: 'Placement' },
    { key: 'pos', label: 'Position', kind: 'vec', unit: 'mm', section: 'Placement' },
    { key: 'anchor', label: 'Position is the', kind: 'select', options: opts(['base', 'Centre of the base'], ['centre', 'Centre']), section: 'Placement' },
    { key: 'dir', label: 'Axis direction', kind: 'vec', section: 'Placement' },
    { key: 'flip', label: 'Reverse direction', kind: 'check', section: 'Placement' },
    { key: 'spin', label: 'Rotation about the axis', kind: 'number', unit: 'deg', step: 15, section: 'Placement' },
];

const RESULTS = opts(['add', 'Join'], ['cut', 'Cut'], ['new', 'New body']);

function defaults(kind: PrimitiveKind, ctx: Ctx): Values {
    const f = ctx.edit?.feature;
    if (f && (f.op === 'add' || f.op === 'cut')) {
        return {
            ...SIZE_DEFAULTS[kind], ...(primitiveSizeValues(f.shape) ?? {}),
            ...placementValues(f.shape, f.position, f.rotation, kind === 'sphere' ? 'centre' : 'base'),
            on: [], result: f.op,
        };
    }
    return {
        ...SIZE_DEFAULTS[kind], on: [], pos0: '0', pos1: '0', pos2: '0', anchor: kind === 'sphere' ? 'centre' : 'base',
        dir0: '0', dir1: '1', dir2: '0', flip: false, spin: '0', result: ctx.part ? 'add' : 'new',
    };
}

function onChange(kind: PrimitiveKind, key: string, v: Values, ctx: Ctx): Values | void {
    if (key === 'on') {
        const [item] = pickItems(v.on);
        const place = item ? placeOfPick(item, stepsBefore(ctx)) : null;
        if (place) {
            const picked = pickedPlacement(place, v.result === 'cut');
            // A sphere keeps its centre on the spot unless the base was asked for.
            return v.anchor === 'centre' ? { ...picked, anchor: 'centre' } : picked;
        }
        return;
    }
    if (key === 'result') {
        // A cut goes into the face it stands on, a join out of it.
        return { flip: v.result === 'cut' };
    }
    if (key === 'anchor') {
        return reanchor(v, kind, v.anchor === 'centre' ? 'centre' : 'base');
    }
}

/** Adds a new part placed like `owner` whose history starts with the step, and goes on to edit it. */
async function newBody(ctx: Ctx, step: Record<string, unknown>): Promise<Result> {
    const owner = ctx.part;
    const count = useStudio.getState().history?.parts.length ?? 0;
    const result = await runTool('parts_add', {
        parts: [{
            name: owner ? `${owner.name} body` : `Part ${count + 1}`,
            shape: { kind: 'empty' },
            position: owner?.position ?? [0, 0, 0],
            rotation: owner?.rotation ?? [0, 0, 0],
            material: owner?.material ?? GREY,
            features: [step],
        }],
    });
    const id = /Added \d+ part\(s\): ([^,]+?)\.$/.exec(result.text)?.[1];
    if (!result.isError && id) {
        select(id);
        setWorkspace('part', id);
    }
    return result;
}

function apply(kind: PrimitiveKind, v: Values, ctx: Ctx): Promise<Result> {
    const label = PRIMITIVE_LABELS[kind];
    const { op, shape, position, rotation } = primitiveStep(kind, v);
    const edited = ctx.edit?.feature;
    if (edited) {
        // The step keeps its op (join or cut) and its repeat; the rest is written back.
        return saveFeature(ctx, { op: edited.op, shape, position, rotation });
    }
    if (v.result === 'new' || !ctx.part) {
        return newBody(ctx, { id: `${ID_PREFIX}${kind}`, op: 'add', name: `${label}1`, shape, position, rotation });
    }
    const part = ctx.part;
    const all = fullPart(part.id)?.features ?? part.features;
    const name = nextNumberedName(all, op === 'cut' ? `Cut-${label}` : label);
    // While the part is rolled back the step goes in at the bar, as every new step does.
    const before = stepAtBar(useStudio.getState().history, part.id);
    return runTool('features_add', {
        partId: part.id, features: [{ id: `${ID_PREFIX}${kind}`, op, name, shape, position, rotation }], ...(before ? { before } : {}),
    });
}

function primitiveTool(kind: PrimitiveKind): ToolDef {
    const label = PRIMITIVE_LABELS[kind];
    return {
        id: `${ID_PREFIX}${kind}`,
        label,
        icon: kind,
        hint: 'a solid joined to the part, cut from it, or a new body; place it on a face or a plane',
        preview: true,
        panel: true,
        width: 310,
        fields: (ctx) => [
            ...sizeFields(kind),
            ...(ctx.part || ctx.edit ? PLACEMENT : PLACEMENT.filter((f) => f.key !== 'on')),
            ...(!ctx.edit && ctx.part ? [{ key: 'result', label: 'Result', kind: 'select' as const, options: RESULTS, section: 'Result' }] : []),
        ],
        defaults: (ctx) => defaults(kind, ctx),
        onChange: (key, v, ctx) => onChange(kind, key, v, ctx),
        top: (_, ctx) => {
            const f = ctx.edit?.feature;
            if (f && (f.op === 'add' || f.op === 'cut')) {
                const kept = f.repeat && f.repeat.count > 1 ? ` Its ${f.repeat.count} copies (${f.repeat.kind}) are kept.` : '';
                return <p className="tb-note">{f.op === 'cut' ? 'Cut from the part.' : 'Joined to the part.'}{kept}</p>;
            }
            return ctx.part ? null : <p className="tb-note">There is no part yet: this makes a new one.</p>;
        },
        apply: (v, ctx) => attempt(() => apply(kind, v, ctx)),
    };
}

export const primitiveFeatureTools: ToolDef[] = PRIMITIVE_KINDS.map(primitiveTool);

/**
 * The primitive form that edits an add or cut step, or null to leave it to the others: box and cylinder cuts not
 * made here are Cut pocket steps, and shapes the form does not make (outlines, lathes, fasteners, scripts) have none.
 */
export function primitiveEditor(feature: Feature | null): ToolDef | null {
    if (!feature || (feature.op !== 'add' && feature.op !== 'cut')) {
        return null;
    }
    const kind = primitiveKindOf(feature.shape);
    if (!kind || (feature.op === 'cut' && !feature.id.startsWith(ID_PREFIX) && (kind === 'box' || kind === 'cylinder'))) {
        return null;
    }
    return primitiveFeatureTools[PRIMITIVE_KINDS.indexOf(kind)];
}

// ---- Drag handles: the position, and the height along the axis ---------------------------------------------

/** The size each primitive's arrow drags, along its axis from its base. */
const AXIS_SIZE: Partial<Record<PrimitiveKind, string>> = { box: 'h', cylinder: 'h', cone: 'h', tube: 'h', wedge: 'h', sphere: 'dia' };

const world = (m: Matrix4, p: Vec3): Vec3 => new Vector3(...p).applyMatrix4(m).toArray() as Vec3;
const worldDir = (m: Matrix4, d: Vec3): Vec3 => new Vector3(...d).transformDirection(m).toArray() as Vec3;

export function primitiveHandles(kind: PrimitiveKind, v: Values, ctx: Ctx): Handle[] {
    const shape = primitiveShape(kind, v);
    const { position } = primitivePlacement(v, shape);
    const axis = primitiveAxis(v);
    const part = ctx.edit ? fullPart(ctx.edit.partId) ?? ctx.part : ctx.part;
    const m = partMatrix(part ?? null);
    const point = [0, 1, 2].map((i) => Number(v[`pos${i}`])) as Vec3;
    const handles: Handle[] = [{ kind: 'translate', keys: ['pos0', 'pos1', 'pos2'], position: world(m, point), step: DEFAULT_STEP.position }];
    const key = AXIS_SIZE[kind];
    if (key) {
        const base = sub(position, scale(axis, halfAxis(shape)));
        handles.push({
            kind: 'distance', key, origin: world(m, base), direction: worldDir(m, axis), value: Number(v[key]), min: 0,
            step: DEFAULT_STEP.length, label: SIZE_FIELDS[kind].find((f) => f.key === key)!.label,
        });
    }
    return handles;
}

for (const kind of PRIMITIVE_KINDS) {
    // Handles are looked up by tool id (toolHandles.ts); these tools register theirs here.
    TOOL_HANDLES[`${ID_PREFIX}${kind}`] = (v, ctx) => primitiveHandles(kind, v, ctx);
}
