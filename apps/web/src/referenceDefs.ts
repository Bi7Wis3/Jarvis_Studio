// Reference geometry forms (Plane, Axis, Point): form values <-> plane and axis definitions, SolidWorks style. Each
// reference is a selection box filled by a click in the view (a face, edge or vertex of the model, a reference plane,
// axis or point) or from a list; what it holds decides the constraints offered. A pick on the model is kept as the pick
// (where it was clicked, the faces that meet at an edge or vertex) with its geometry as found (pickRefs.modelPick): the
// kernel finds it again at every rebuild, so the reference follows the model (followedRefs.ts shows where). Older steps
// kept by value reopen as such. Pure, so it is tested without the UI.

import type {
    AxisDefinition, AxisRef, Feature, FixedCylinder, FixedPointRef, ModelEdgePick, ModelEdgeShape, ModelEntityPick, PlaneDefinition,
    PlaneRef, PointDefinition, PointRef, Vec3,
} from '@jarvis/core';
import { linesMeet, pointsAlong, resolveAxis, resolvePlane, resolvePoint } from '@jarvis/core/reference';
import { curveOf, pointsAlongCurve } from '@jarvis/core/curveRefs';
import { curveIdOf, curveItem, curveLabel, curveOptions, curvePointItem, curvePointOf, curvePointValue, isCurveItem, isCurvePointItem } from './curvePicks';
import { valueText } from './numberText';
import { pickItems, type PickItem } from './pickField';
import type { ModelPick } from './pickRefs';
import { revolveAxisKey } from './revolveAxis';

export type RefValues = Record<string, string | boolean | string[] | PickItem[]>;

const fmt = valueText;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));

function num(v: RefValues, key: string, label: string): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return n;
}

const vec = (v: RefValues, key: string, label: string): Vec3 =>
    [0, 1, 2].map((i) => num(v, `${key}${i}`, `${label} ${'XYZ'[i]}`)) as Vec3;

const vecValues = (key: string, p: Vec3): RefValues => Object.fromEntries(p.map((c, i) => [`${key}${i}`, fmt(c)]));

/** The u axis a plane taken from a face gets: the part's X across it, or -Z when the face looks along X (as core). */
function defaultXDir(normal: Vec3): Vec3 {
    const seed: Vec3 = Math.abs(normal[0]) > 0.9 ? [0, 0, -1] : [1, 0, 0];
    return unit(sub(seed, scale(normal, dot(seed, normal))));
}

/** The part's steps a new or edited reference step can use: those before it, not suppressed. */
export function stepsBefore(ctx: { part: { features?: Feature[] } | null; edit: { feature: Feature | null } | null } | null): Feature[] {
    const features = ctx?.part?.features ?? [];
    const editing = ctx?.edit?.feature;
    const at = editing ? features.findIndex((f) => f.id === editing.id) : -1;
    return (at >= 0 ? features.slice(0, at) : features).filter((f) => !f.suppressed);
}

// ---- References: list values, labels and box items ---------------------------------------------------------------

/**
 * A reference that is not a pick on the model, as a list value: a base plane ('top' | 'front' | 'right'), a part
 * axis ('x' | 'y' | 'z'), the origin, typed coordinates ('xyz'), the u or v axis of the plane being turned, or a step
 * ('plane:<id>' | 'axis:<id>' | 'point:<id>').
 */
export type RefKind = 'plane' | 'line' | 'point' | 'curve';

/** In this app Y is up: Top is the XZ plane (normal +Y), Front XY (normal +Z), Right YZ (normal +X). */
export const BASE_PLANES: [string, string][] = [['top', 'Top plane (XZ)'], ['front', 'Front plane (XY)'], ['right', 'Right plane (YZ)']];
const BASE_AXES: [string, string][] = [['x', 'X axis'], ['y', 'Y axis'], ['z', 'Z axis']];
const OWN_AXES: [string, string][] = [['u', 'Its horizontal axis (u)'], ['v', 'Its vertical axis (v)']];

/** What kind of reference a list value is. */
export function refKind(ref: string): RefKind | null {
    if (curvePointOf(ref)) {
        return 'point';
    }
    if (curveIdOf(ref)) {
        return 'curve';
    }
    if (BASE_PLANES.some(([v]) => v === ref) || ref.startsWith('plane:')) {
        return 'plane';
    }
    if (BASE_AXES.some(([v]) => v === ref) || ref === 'u' || ref === 'v' || ref.startsWith('axis:')) {
        return 'line';
    }
    return ref === 'origin' || ref === 'xyz' || ref.startsWith('point:') ? 'point' : null;
}

const stepName = (steps: Feature[], id: string): string => steps.find((f) => f.id === id)?.name ?? id;

/** A list value's label, e.g. "Top plane (XZ)" or a step's name. */
export function refLabel(ref: string, steps: Feature[] = []): string {
    const onCurve = curveLabel(ref, steps);
    if (onCurve) {
        return onCurve;
    }
    const fixed = [...BASE_PLANES, ...BASE_AXES, ...OWN_AXES, ['origin', 'Origin'], ['xyz', 'Coordinates']].find(([v]) => v === ref);
    if (fixed) {
        return fixed[1];
    }
    const at = ref.indexOf(':');
    return at > 0 ? stepName(steps, ref.slice(at + 1)) : ref;
}

export const refItem = (ref: string, steps: Feature[] = []): PickItem => ({ kind: 'ref', ref, label: refLabel(ref, steps) });

/** The list choices of a reference box: what it takes, from the steps before the one being made. */
export function refOptions(kinds: RefKind[], steps: Feature[], ownAxes = false): { value: string; label: string }[] {
    const of = (op: Feature['op']) => steps.filter((f) => f.op === op && !f.suppressed).map((f) => ({ value: `${op}:${f.id}`, label: f.name ?? f.id }));
    const pairs = (list: [string, string][]) => list.map(([value, label]) => ({ value, label }));
    return [
        { value: '', label: 'Picked in the view' },
        ...(kinds.includes('plane') ? [...pairs(BASE_PLANES), ...of('plane')] : []),
        ...(kinds.includes('line') ? [...(ownAxes ? pairs(OWN_AXES) : []), ...pairs(BASE_AXES), ...of('axis')] : []),
        ...(kinds.includes('point') ? [...pairs([['origin', 'Origin'], ['xyz', 'Coordinates']]), ...of('point'), ...curveOptions(steps, true)] : []),
        ...(kinds.includes('curve') ? curveOptions(steps, false) : []),
    ];
}

/** The box item of a reference step clicked in the view. */
export function stepItem(step: Pick<Feature, 'id' | 'name' | 'op'>): PickItem | null {
    if (step.op === 'helix') {
        return curveItem(step.id, [step as Feature]);
    }
    return step.op === 'plane' || step.op === 'axis' || step.op === 'point'
        ? { kind: 'ref', ref: `${step.op}:${step.id}`, label: step.name ?? step.id } : null;
}

/** The geometry class of a box item, as the reference forms tell them apart. */
export type ItemClass = 'plane' | 'line' | 'point' | 'cylinder' | 'cone' | 'circle' | 'surface' | 'curve';

export function itemClass(item: PickItem): ItemClass {
    if (item.kind === 'ref') {
        return refKind(item.ref) ?? 'curve';
    }
    if (item.kind === 'vertex') {
        return 'point';
    }
    const g = item.model?.geom;
    switch (g?.type) {
        case 'plane':
            return 'plane';
        case 'line':
            return 'line';
        case 'vertex':
            return 'point';
        case 'cylinder':
        case 'cone':
        case 'circle':
        case 'surface':
        case 'curve':
            return g.type;
        default:
            return item.kind === 'face' ? 'surface' : 'curve';
    }
}

const geomOf = (item: PickItem): ModelPick['geom'] | null => (item.kind === 'ref' ? null : item.model?.geom ?? null);

/** A straight or circular edge's geometry as the step keeps it (where it was last found). */
function shapeOf(g: ModelPick['geom'] | null): ModelEdgeShape | undefined {
    if (g?.type === 'line') {
        return { type: 'line', a: [...g.a], b: [...g.b] };
    }
    if (g?.type === 'circle' && g.radius > 0) {
        return { type: 'circle', centre: [...g.centre], normal: [...g.normal], radius: g.radius, full: g.full, start: [...g.start], end: [...g.end] };
    }
    return undefined;
}

/**
 * How a step keeps a pick on the model, for the kernel to find it again: a reopened step's own pick (an edge with its
 * geometry as shown now), else where it was clicked, with the faces that meet at an edge or a vertex. Null for a
 * reference of an older step kept by value, and for steps and base planes.
 */
export function pickOf(item: PickItem): ModelEntityPick | null {
    if (item.kind === 'ref' || item.model?.fixed) {
        return null;
    }
    const m = item.model;
    const shape = shapeOf(m?.geom ?? null);
    if (m?.pick) {
        return 'edge' in m.pick ? { ...m.pick, ...(shape ? { shape } : {}) } : m.pick;
    }
    const faces = m?.faces?.length ? { faces: m.faces.map((f) => (f.normal ? { at: [...f.at] as Vec3, normal: [...f.normal] as Vec3 } : { at: [...f.at] as Vec3 })) } : {};
    switch (item.kind) {
        case 'face': {
            const normal = item.normal ?? (m?.geom.type === 'plane' ? m.geom.normal : undefined);
            return { face: normal ? { at: [...item.at], normal: [...normal] } : { at: [...item.at] } };
        }
        case 'vertex':
            return { vertex: [...item.at], ...faces };
        default:
            return { edge: [...item.at], ...faces, ...(shape ? { shape } : {}) };
    }
}

const edgePickOf = (item: PickItem): ModelEdgePick | null => {
    const p = pickOf(item);
    return p && 'edge' in p ? p : null;
};

/** The item as a plane: a reference plane, a flat face, or a circular edge's plane. */
export function asPlane(item: PickItem): PlaneRef {
    if (item.kind === 'ref') {
        if (item.ref.startsWith('plane:')) {
            return { planeRef: item.ref.slice(6) };
        }
        if (refKind(item.ref) === 'plane') {
            return item.ref as PlaneRef;
        }
    }
    const g = geomOf(item);
    const pick = pickOf(item);
    if (g?.type === 'plane') {
        const face = pick && 'face' in pick ? { pick } : {};
        return { fixedPlane: { origin: [...g.origin], normal: [...g.normal], xDir: defaultXDir(g.normal) }, from: 'face', ...face };
    }
    if (g?.type === 'circle') {
        const edge = pick && 'edge' in pick ? { pick } : {};
        return { fixedPlane: { origin: [...g.centre], normal: [...g.normal], xDir: defaultXDir(g.normal) }, from: 'circle', ...edge };
    }
    throw new Error('Pick a plane or a flat face.');
}

/** The item as a line: a reference axis (or the u / v axis of the plane being turned), a straight edge, a cylinder's or cone's axis. */
export function asLine(item: PickItem): AxisRef | 'u' | 'v' {
    if (item.kind === 'ref') {
        if (item.ref.startsWith('axis:')) {
            return { axisRef: item.ref.slice(5) };
        }
        if (refKind(item.ref) === 'line') {
            return item.ref as AxisRef | 'u' | 'v';
        }
    }
    const g = geomOf(item);
    const pick = pickOf(item);
    if (g?.type === 'line') {
        // Through the edge's midpoint, so a plane normal to the edge alone sits halfway along it.
        const edge = pick && 'edge' in pick ? { pick } : {};
        return { fixedAxis: { point: scale(add(g.a, g.b), 0.5), direction: unit(sub(g.b, g.a)) }, from: 'edge', ...edge };
    }
    if (g?.type === 'cylinder' || g?.type === 'cone') {
        const face = pick && 'face' in pick ? { pick } : {};
        return { fixedAxis: { point: [...g.point], direction: [...g.direction] }, from: g.type, ...face };
    }
    throw new Error('Pick an axis, a straight edge or a cylindrical face.');
}

const asAxis = (item: PickItem): AxisRef => {
    const line = asLine(item);
    if (line === 'u' || line === 'v') {
        throw new Error('Its own u or v axis only turns a plane: pick an axis or an edge.');
    }
    return line;
};

/** The item as a point: a vertex, a circle's centre, a point step, the origin, or the box's typed coordinates (`<key>p`). */
export function asPoint(item: PickItem, v: RefValues, key: string): PointRef {
    if (item.kind === 'ref') {
        const onCurve = curvePointOf(item.ref);
        if (onCurve) {
            return onCurve;
        }
        if (item.ref.startsWith('point:')) {
            return { pointRef: item.ref.slice(6) };
        }
        if (item.ref === 'origin') {
            return [0, 0, 0];
        }
        if (item.ref === 'xyz') {
            return vec(v, `${key}p`, 'Point');
        }
    }
    // A vertex or a circle's centre on the model, followed by the kernel (an older step's: coordinates, by value).
    const pick = pickOf(item);
    const g = geomOf(item);
    if (item.kind === 'vertex' || g?.type === 'vertex') {
        const at: Vec3 = item.kind === 'vertex' ? [...item.at] : [...(g as { at: Vec3 }).at];
        return pick && 'vertex' in pick ? { fixedPoint: at, from: 'vertex', pick } : at;
    }
    if (g?.type === 'circle') {
        return pick && 'edge' in pick ? { fixedPoint: [...g.centre], from: 'centre', pick } : [...g.centre];
    }
    throw new Error('Pick a point or a vertex.');
}

/** What a reopened item keeps of its step's reference: the pick, to save it again as it was, or that it was by value. */
const kept = (pick: ModelEntityPick | undefined): Pick<ModelPick, 'pick' | 'fixed'> => (pick ? { pick } : { fixed: true });

/** p moved onto the plane through `origin` with unit normal n. */
const ontoPlane = (p: Vec3, origin: Vec3, n: Vec3): Vec3 => add(p, scale(n, dot(sub(origin, p), n)));

/** A stored edge pick as a box item: on the edge as last found (so the view finds it), with its geometry. */
function edgeItem(pick: ModelEdgePick, geom: ModelPick['geom']): PickItem {
    const shape = pick.shape;
    const at: Vec3 = shape?.type === 'circle' ? [...shape.start] : shape?.type === 'line' ? scale(add(shape.a, shape.b), 0.5) : [...pick.edge];
    return { kind: 'edge', at, model: { geom, click: at, pick } };
}

/** An edge pick's geometry as last found, for the form (`centre`: a circle's centre when the pick keeps no shape). */
function edgeGeom(pick: ModelEdgePick, centre?: Vec3): ModelPick['geom'] {
    const s = pick.shape;
    if (s?.type === 'line') {
        return { type: 'line', a: [...s.a], b: [...s.b] };
    }
    if (s?.type === 'circle') {
        return { type: 'circle', centre: [...s.centre], normal: unit(s.normal), radius: s.radius, full: s.full, start: [...s.start], end: [...s.end] };
    }
    const c = centre ?? pick.edge;
    return { type: 'circle', centre: [...c], normal: [0, 1, 0], radius: 0, full: true, start: [...c], end: [...c] };
}

/** The box item and extra values that show a stored plane reference. */
function planeItem(ref: PlaneRef, steps: Feature[]): PickItem {
    if (typeof ref === 'string') {
        return refItem(ref, steps);
    }
    if ('planeRef' in ref) {
        return refItem(`plane:${ref.planeRef}`, steps);
    }
    const { origin, normal } = ref.fixedPlane;
    const n = unit(normal);
    if (ref.from === 'circle') {
        if (ref.pick && 'edge' in ref.pick) {
            const geom = edgeGeom(ref.pick, origin);
            return edgeItem(ref.pick, geom.type === 'circle' ? { ...geom, normal: n } : geom);
        }
        // The circle's size is not kept: only its plane matters here.
        return { kind: 'edge', at: [...origin], model: { geom: { type: 'circle', centre: [...origin], normal: n, radius: 0, full: true, start: [...origin], end: [...origin] }, click: [...origin], ...kept(undefined) } };
    }
    // On the face where it is now: the pick moved onto its plane.
    const at = ref.pick && 'face' in ref.pick ? ontoPlane(ref.pick.face.at, origin, n) : [...origin] as Vec3;
    return { kind: 'face', at, normal: n, model: { geom: { type: 'plane', origin: [...origin], normal: n }, click: at, centre: [...origin], ...kept(ref.pick) } };
}

function lineItem(ref: AxisRef | 'u' | 'v', steps: Feature[]): PickItem {
    if (typeof ref === 'string') {
        return refItem(ref, steps);
    }
    if ('axisRef' in ref) {
        return refItem(`axis:${ref.axisRef}`, steps);
    }
    const { point, direction } = ref.fixedAxis;
    const d = unit(direction);
    if (ref.from === 'cylinder' || ref.from === 'cone') {
        const geom: ModelPick['geom'] = ref.from === 'cone'
            ? { type: 'cone', point: [...point], direction: d } : { type: 'cylinder', point: [...point], direction: d, radius: 0 };
        const at = ref.pick && 'face' in ref.pick ? [...ref.pick.face.at] as Vec3 : [...point] as Vec3;
        return { kind: 'face', at, model: { geom, click: at, ...kept(ref.pick) } };
    }
    if (ref.pick && 'edge' in ref.pick) {
        const shape = ref.pick.shape;
        // The line as it is now: through its midpoint, as long as the edge was last found.
        const half = shape?.type === 'line' ? len(sub(shape.b, shape.a)) / 2 : 0.5;
        return edgeItem(ref.pick, { type: 'line', a: sub(point, scale(d, half)), b: add(point, scale(d, half)) });
    }
    // The edge's ends are not kept: a unit length about its midpoint gives the same line.
    return { kind: 'edge', at: [...point], model: { geom: { type: 'line', a: sub(point, scale(d, 0.5)), b: add(point, scale(d, 0.5)) }, click: [...point], ...kept(undefined) } };
}

/** A point taken from the model as a box item: a vertex, or a circular edge for its centre. */
function fixedPointItem(ref: FixedPointRef): PickItem {
    const p = ref.fixedPoint;
    if ('vertex' in ref.pick) {
        return { kind: 'vertex', at: [...p], model: { geom: { type: 'vertex', at: [...p] }, click: [...p], pick: ref.pick } };
    }
    return edgeItem(ref.pick, edgeGeom(ref.pick, p));
}

/** A stored point reference in box `key`: the item, and the typed coordinates when it is one. */
function pointItem(ref: PointRef, key: string, steps: Feature[]): RefValues {
    if (Array.isArray(ref)) {
        return { [key]: [refItem('xyz')], [`${key}list`]: 'xyz', ...vecValues(`${key}p`, ref) };
    }
    if ('fixedPoint' in ref) {
        return { [key]: [fixedPointItem(ref)], [`${key}list`]: '' };
    }
    if ('curveRef' in ref) {
        return { [key]: [curvePointItem(ref, steps)], [`${key}list`]: curvePointValue(ref) };
    }
    return { [key]: [refItem(`point:${ref.pointRef}`, steps)], [`${key}list`]: `point:${ref.pointRef}` };
}

/** Box `key` showing `item` (its list value in step with it). */
const boxValues = (key: string, item: PickItem): RefValues => ({ [key]: [item], [`${key}list`]: item.kind === 'ref' ? item.ref : '' });

/** Empty reference boxes with their lists and coordinates. */
const emptyBoxes = (keys: string[]): RefValues =>
    Object.fromEntries(keys.flatMap((k) => [[k, []], [`${k}list`, ''], [`${k}p0`, '0'], [`${k}p1`, '0'], [`${k}p2`, '0']]));

/**
 * Keeps a box and its list in step: choosing from the list puts that reference in the box, a click in the view
 * shows "Picked in the view" in the list. Null when `key` is neither.
 */
export function boxListPatch(key: string, v: RefValues, steps: Feature[]): RefValues | null {
    if (key.endsWith('list')) {
        const box = key.slice(0, -4);
        if (!(box in v)) {
            return null;
        }
        const ref = typeof v[key] === 'string' ? v[key] as string : '';
        if (ref) {
            return { [box]: [refItem(ref, steps)] };
        }
        // Back to the view: drop a list reference, keep a pick.
        return pickItems(v[box]).some((i) => i.kind === 'ref') ? { [box]: [] } : null;
    }
    if (`${key}list` in v) {
        const item = pickItems(v[key])[0];
        return { [`${key}list`]: item?.kind === 'ref' ? item.ref : '' };
    }
    return null;
}

// ---- Plane --------------------------------------------------------------------------------------------------------

/** The three reference boxes of the Plane form. */
export const PLANE_BOXES = ['r1', 'r2', 'r3'];

/** What a reference counts as in the Plane form (a circular edge is its plane, a cone its axis); null: unusable. */
export type PlaneClass = 'plane' | 'line' | 'point' | 'cyl' | 'curve';

export function planeClass(item: PickItem): PlaneClass | null {
    // A helix or spiral step; other curved edges have no plane square to them here yet.
    if (isCurveItem(item)) {
        return 'curve';
    }
    switch (itemClass(item)) {
        case 'plane':
        case 'circle':
            return 'plane';
        case 'line':
        case 'cone':
            return 'line';
        case 'point':
            return 'point';
        case 'cylinder':
            return 'cyl';
        default:
            return null;
    }
}

/** The constraints each kind of reference offers (SolidWorks' constraint buttons), first = default. */
export const PLANE_CONSTRAINTS: Record<PlaneClass, [string, string][]> = {
    plane: [['offset', 'Offset distance'], ['coincident', 'Coincident'], ['parallel', 'Parallel'], ['perpendicular', 'Perpendicular'],
        ['angle', 'At angle'], ['mid', 'Mid plane']],
    line: [['coincident', 'Coincident'], ['perpendicular', 'Perpendicular']],
    point: [['coincident', 'Coincident']],
    cyl: [['tangent', 'Tangent'], ['coincident', 'Coincident (through its axis)']],
    curve: [['perpendicular', 'Perpendicular']],
};

/** Why a pick cannot be a plane reference, or null. */
export function planeAccept(item: PickItem): string | null {
    return planeClass(item) ? null : 'Pick a flat or cylindrical face, a straight or circular edge, a vertex, a helix or spiral, or a reference.';
}

/** The class of box k's reference, or null when empty or unusable. */
export function slotClass(v: RefValues, k: number): PlaneClass | null {
    const item = pickItems(v[`r${k}`])[0];
    return item ? planeClass(item) : null;
}

export function planeDefaults(): RefValues {
    const v: RefValues = { ...emptyBoxes(PLANE_BOXES), flipNormal: false, pn: false, ...vecValues('nv', [0, 1, 0]), pnx: '', keepOff: false, originOnCurve: false };
    for (const k of [1, 2, 3]) {
        Object.assign(v, {
            [`c${k}plane`]: 'offset', [`c${k}line`]: 'coincident', [`c${k}point`]: 'coincident', [`c${k}cyl`]: 'tangent', [`c${k}curve`]: 'perpendicular',
            [`d${k}`]: '10', [`a${k}`]: '45', [`f${k}`]: false, [`n${k}`]: '1',
        });
    }
    return v;
}

interface Slot {
    k: number;
    item: PickItem;
    cls: PlaneClass;
    c: string;
}

function planeSlots(v: RefValues): Slot[] {
    return [1, 2, 3].flatMap((k) => {
        const item = pickItems(v[`r${k}`])[0];
        if (!item) {
            return [];
        }
        const cls = planeClass(item);
        if (!cls) {
            throw new Error(`The ${['first', 'second', 'third'][k - 1]} reference cannot define a plane.`);
        }
        return [{ k, item, cls, c: String(v[`c${k}${cls}`] ?? PLANE_CONSTRAINTS[cls][0][0]) }];
    });
}

/** The point on a cylinder nearest a click on it (so the tangent plane touches it there). */
function onCylinder(c: FixedCylinder, p: Vec3): Vec3 {
    const d = unit(c.direction);
    const rel = sub(p, c.point);
    const along = scale(d, dot(rel, d));
    const w = sub(rel, along);
    return len(w) > 0 ? add(add(c.point, along), scale(unit(w), c.radius)) : p;
}

function cylinderOf(item: PickItem): FixedCylinder & { click: Vec3 } {
    const g = geomOf(item);
    if (g?.type !== 'cylinder' || !(g.radius > 0)) {
        throw new Error('Tangent needs a cylindrical face picked in the view.');
    }
    const click = item.kind !== 'ref' && item.model ? item.model.click : g.point;
    const pick = pickOf(item);
    const face = pick && 'face' in pick ? { pick } : {};
    return { point: [...g.point], direction: [...g.direction], radius: g.radius, ...face, click: [...click] };
}

/**
 * The plane the form defines, from its references and their constraints; `index` makes the n-th of several offset
 * or angle planes (1 = the first). Throws what is still missing (the form's message).
 */
export function planeDefinition(v: RefValues, index = 1): PlaneDefinition {
    const d = planeOnly(v, index);
    return v.flipNormal ? { ...d, flipNormal: true } : d;
}

function planeOnly(v: RefValues, index: number): PlaneDefinition {
    const slots = planeSlots(v);
    if (slots.length === 0) {
        throw new Error('Pick a first reference: a face, an edge, a vertex, a plane, an axis or a point.');
    }
    const where = (s: Slot) => ['first', 'second', 'third'][s.k - 1];
    const sign = (s: Slot) => (v[`f${s.k}`] ? -1 : 1);
    const over = (used: number) => {
        if (slots.length > used) {
            throw new Error('The plane is over-defined: remove a reference or change a constraint.');
        }
    };
    const planes = slots.filter((s) => s.cls === 'plane');
    const lines = slots.filter((s) => s.cls === 'line' || (s.cls === 'cyl' && s.c === 'coincident'));
    const points = slots.filter((s) => s.cls === 'point');
    const tangent = slots.find((s) => s.cls === 'cyl' && s.c === 'tangent');
    const point = (s: Slot) => asPoint(s.item, v, `r${s.k}`);
    const curve = slots.find((s) => s.cls === 'curve');
    if (curve) {
        // Perpendicular to a helix or spiral, through a point (SolidWorks needs the point too).
        over(2);
        const through = slots.find((s) => s !== curve);
        if (!through || through.cls !== 'point') {
            throw new Error('Perpendicular to a curve: pick a point for the plane to pass through, such as the curve\'s start or end.');
        }
        const id = curveIdOf((curve.item as Extract<PickItem, { kind: 'ref' }>).ref)!;
        return { kind: 'curveNormal', curve: { curveRef: id }, point: point(through), ...(v.originOnCurve ? { originOnCurve: true } : {}) };
    }

    if (tangent) {
        const cyl = cylinderOf(tangent.item);
        const { click, ...cylinder } = cyl;
        const others = slots.filter((s) => s !== tangent);
        over(2);
        const flip = !!v[`f${tangent.k}`];
        if (others.length === 0) {
            return { kind: 'tangent', cylinder, point: onCylinder(cylinder, click) };
        }
        const o = others[0];
        if (o.cls === 'point') {
            return { kind: 'tangent', cylinder, point: point(o), ...(flip ? { flip } : {}) };
        }
        if (o.cls === 'plane' && (o.c === 'parallel' || o.c === 'angle')) {
            const angle = o.c === 'angle' ? sign(o) * num(v, `a${o.k}`, 'Angle') : 0;
            return { kind: 'tangent', cylinder, plane: asPlane(o.item), ...(angle ? { angle } : {}), ...(flip ? { flip } : {}) };
        }
        throw new Error('With Tangent, the other reference is a point, or a plane set to Parallel or At angle.');
    }
    if (v.pn && slots.length === 1 && points.length === 1) {
        // A point and normal plane (written by Jarvis), edited.
        const xDir = typeof v.pnx === 'string' && v.pnx ? JSON.parse(v.pnx) as Vec3 : undefined;
        return { kind: 'pointNormal', point: point(points[0]), normal: vec(v, 'nv', 'Normal'), ...(xDir ? { xDir } : {}) };
    }
    const mids = planes.filter((s) => s.c === 'mid');
    if (mids.length > 0) {
        if (mids.length < 2) {
            throw new Error('Mid plane: pick a second plane or flat face and set it to Mid plane too.');
        }
        over(2);
        return { kind: 'midplane', a: asPlane(mids[0].item), b: asPlane(mids[1].item) };
    }
    if (planes.length > 1) {
        throw new Error('Two planes: set both to Mid plane, or remove one.');
    }
    const plane = planes[0];
    if (plane) {
        const others = slots.filter((s) => s !== plane);
        const base = asPlane(plane.item);
        switch (plane.c) {
            case 'offset':
            case 'coincident':
                over(1);
                return { kind: 'offset', base, distance: plane.c === 'coincident' ? 0 : sign(plane) * num(v, `d${plane.k}`, 'Distance') * index };
            case 'parallel': {
                over(2);
                const o = others[0];
                if (!o) {
                    throw new Error('Parallel: pick a point, a vertex or an edge for the plane to pass through.');
                }
                if (o.cls === 'point') {
                    return { kind: 'parallel', base, point: point(o) };
                }
                const axis = asAxis(o.item);
                if (typeof axis === 'object' && 'axisRef' in axis) {
                    throw new Error('Parallel through an axis step: pick a point on it instead.');
                }
                return { kind: 'parallel', base, point: resolveAxis(axis, []).point };
            }
            case 'angle':
            case 'perpendicular': {
                over(2);
                const o = lines[0];
                if (!o) {
                    throw new Error(`${plane.c === 'angle' ? 'At angle' : 'Perpendicular'}: pick an edge or an axis for the plane to pass through.`);
                }
                if (plane.c === 'perpendicular') {
                    return { kind: 'perpendicular', base, axis: asAxis(o.item) };
                }
                const about = asLine(o.item);
                const angle = sign(plane) * num(v, `a${plane.k}`, 'Angle') * index;
                return about === 'u' || about === 'v' || v.keepOff
                    ? { kind: 'angle', base, about, angle } : { kind: 'angle', base, about, angle, throughAxis: true };
            }
            default:
                throw new Error(`The ${where(plane)} reference needs a constraint.`);
        }
    }
    if (lines.length > 1) {
        throw new Error('Two edges or axes do not make a plane here: pick a point or a plane instead of one of them.');
    }
    const line = lines[0];
    if (line) {
        over(2);
        const axis = asAxis(line.item);
        if (line.c === 'perpendicular') {
            return points[0] ? { kind: 'normal', axis, point: point(points[0]) } : { kind: 'normal', axis };
        }
        if (!points[0]) {
            throw new Error('Coincident with an edge or axis: pick a point for the plane to pass through, or set it to Perpendicular.');
        }
        return { kind: 'linePoint', axis, point: point(points[0]) };
    }
    if (points.length < 3) {
        throw new Error(`Through points: pick ${['', 'two more points', 'a third point'][points.length]} or vertices.`);
    }
    return { kind: 'threePoints', points: [point(points[0]), point(points[1]), point(points[2])] };
}

/**
 * The Plane form's offset distance as a drag handle (part frame): from the offset reference's plane along its
 * normal (reversed by Flip offset), or null when no reference is set to Offset distance.
 */
export function planeOffsetHandle(v: RefValues, steps: Feature[]): { key: string; origin: Vec3; direction: Vec3; value: number } | null {
    const s = planeSlots(v).find((slot) => slot.cls === 'plane' && slot.c === 'offset');
    if (!s) {
        return null;
    }
    const value = Number(v[`d${s.k}`]);
    if (!Number.isFinite(value)) {
        return null;
    }
    const base = resolvePlane(asPlane(s.item), steps);
    return { key: `d${s.k}`, origin: base.origin, direction: v[`f${s.k}`] ? scale(base.normal, -1) : base.normal, value };
}

/**
 * At angle needs something to turn about. When it is chosen with no edge or axis in any box yet, the plane's own
 * horizontal axis goes into the next free box: the plane turns at once, and the box shows what it turns about, so
 * another axis or an edge can be put there instead.
 */
export function planeAngleAxisPatch(key: string, v: RefValues, steps: Feature[] = []): RefValues {
    const k = Number(/^c([123])plane$/.exec(key)?.[1] ?? 0);
    if (!k || v[key] !== 'angle' || slotClass(v, k) !== 'plane' || [1, 2, 3].some((j) => slotClass(v, j) === 'line')) {
        return {};
    }
    // The first box does not list a plane's own axes: only a later one will do.
    const free = [2, 3].find((j) => j !== k && pickItems(v[`r${j}`]).length === 0);
    return free ? { [`r${free}`]: [refItem('u', steps)], [`r${free}list`]: 'u', [`c${free}line`]: 'coincident' } : {};
}

/** The arc that sets an angled plane's angle in the view: about what it turns, from the base plane. */
export function planeAngleHandle(v: RefValues, steps: Feature[]): { key: string; origin: Vec3; axis: Vec3; start: Vec3; value: number } | null {
    let slots: Slot[];
    try {
        slots = planeSlots(v);
    } catch {
        return null;
    }
    const s = slots.find((slot) => slot.cls === 'plane' && slot.c === 'angle');
    const about = slots.find((slot) => slot.cls === 'line');
    const value = s ? Number(v[`a${s.k}`]) : NaN;
    if (!s || !about || !Number.isFinite(value)) {
        return null;
    }
    try {
        const base = resolvePlane(asPlane(s.item), steps);
        const line = asLine(about.item);
        const own = line === 'u' || line === 'v';
        const axis = own ? { point: base.origin, direction: line === 'u' ? base.xDir : cross(base.normal, base.xDir) } : resolveAxis(line, steps);
        const d = unit(axis.direction);
        // Start in the base plane, square to the axis; an axis square to the plane has no such direction.
        const across = cross(d, base.normal);
        if (len(across) < 1e-9) {
            return null;
        }
        const foot = add(axis.point, scale(d, dot(sub(base.origin, axis.point), d)));
        return { key: `a${s.k}`, origin: own ? base.origin : foot, axis: v[`f${s.k}`] ? scale(d, -1) : d, start: unit(across), value: Math.abs(value) };
    } catch {
        return null;
    }
}

/** How many planes the form makes (Number of planes, for offset and angle). */
export function planeCount(v: RefValues): number {
    for (const s of planeSlots(v)) {
        if (s.cls === 'plane' && (s.c === 'offset' || s.c === 'angle')) {
            return Math.round(Number(v[`n${s.k}`]) || 1);
        }
    }
    return 1;
}

/** Form values of a stored plane definition. */
export function planeValues(d: PlaneDefinition, steps: Feature[] = []): RefValues {
    const v: RefValues = { ...planeDefaults(), flipNormal: !!d.flipNormal };
    const set = (k: number, item: PickItem, c?: string, extra: RefValues = {}) => {
        const cls = planeClass(item);
        Object.assign(v, boxValues(`r${k}`, item), c && cls ? { [`c${k}${cls}`]: c } : {}, extra);
    };
    const setPoint = (k: number, p: PointRef) => Object.assign(v, pointItem(p, `r${k}`, steps));
    switch (d.kind) {
        case 'offset':
            set(1, planeItem(d.base, steps), 'offset', { d1: fmt(Math.abs(d.distance)), f1: d.distance < 0 });
            break;
        case 'angle':
            set(1, planeItem(d.base, steps), 'angle', { a1: fmt(Math.abs(d.angle)), f1: d.angle < 0 });
            set(2, lineItem(d.about, steps), 'coincident');
            if (!d.throughAxis && d.about !== 'u' && d.about !== 'v') {
                // An older step turned about an axis off the plane, without moving onto it: kept as it was.
                v.keepOff = true;
            }
            break;
        case 'midplane':
            set(1, planeItem(d.a, steps), 'mid');
            set(2, planeItem(d.b, steps), 'mid');
            break;
        case 'parallel':
            set(1, planeItem(d.base, steps), 'parallel');
            setPoint(2, d.point);
            break;
        case 'threePoints':
            d.points.forEach((p, i) => setPoint(i + 1, p));
            break;
        case 'normal':
            set(1, lineItem(d.axis, steps), 'perpendicular');
            if (d.point) {
                setPoint(2, d.point);
            }
            break;
        case 'pointNormal':
            setPoint(1, d.point);
            Object.assign(v, { pn: true, ...vecValues('nv', d.normal), pnx: d.xDir ? JSON.stringify(d.xDir) : '' });
            break;
        case 'perpendicular':
            set(1, planeItem(d.base, steps), 'perpendicular');
            set(2, lineItem(d.axis, steps), 'coincident');
            break;
        case 'linePoint':
            set(1, lineItem(d.axis, steps), 'coincident');
            setPoint(2, d.point);
            break;
        case 'curveNormal':
            set(1, curveItem(d.curve.curveRef, steps), 'perpendicular');
            setPoint(2, d.point);
            v.originOnCurve = !!d.originOnCurve;
            break;
        case 'tangent': {
            const { point, direction, radius } = d.cylinder;
            const p = d.point && Array.isArray(d.point) ? d.point : null;
            const rel = p ? sub(p, point) : null;
            const onSurface = !!rel && !d.plane
                && Math.abs(len(sub(rel, scale(unit(direction), dot(rel, unit(direction))))) - radius) <= 1e-6 * Math.max(1, radius);
            const cyl: PickItem = {
                kind: 'face', at: [...(onSurface ? p! : d.cylinder.pick?.face.at ?? point)],
                model: {
                    geom: { type: 'cylinder', point: [...point], direction: unit(direction), radius }, click: [...(onSurface ? p! : point)],
                    ...kept(d.cylinder.pick),
                },
            };
            set(1, cyl, 'tangent', { f1: !!d.flip });
            if (d.plane) {
                set(2, planeItem(d.plane, steps), d.angle ? 'angle' : 'parallel', { a2: fmt(Math.abs(d.angle ?? 0)), f2: (d.angle ?? 0) < 0 });
            } else if (d.point && !onSurface) {
                setPoint(2, d.point);
            }
            break;
        }
    }
    return v;
}

/**
 * Constraints set when box `key` gets a reference, as SolidWorks picks them: a plane alone is offset, two planes are
 * mid plane, a plane and a point parallel, a plane and an edge at angle, a cylinder tangent, an edge alone perpendicular.
 */
export function planeAutoPatch(key: string, v: RefValues): RefValues {
    const k = PLANE_BOXES.indexOf(key) + 1;
    const cls = k > 0 ? slotClass(v, k) : null;
    if (!cls) {
        return {};
    }
    const others = [1, 2, 3].filter((j) => j !== k).map((j) => ({ j, cls: slotClass(v, j) })).filter((o) => o.cls);
    const plane = others.find((o) => o.cls === 'plane');
    const loosePlane = plane && ['offset', 'coincident', 'parallel', 'angle'].includes(String(v[`c${plane.j}plane`]));
    const patch: RefValues = {};
    switch (cls) {
        case 'plane':
            if (plane) {
                patch[`c${k}plane`] = 'mid';
                patch[`c${plane.j}plane`] = 'mid';
            } else if (others.some((o) => o.cls === 'point' || o.cls === 'cyl')) {
                patch[`c${k}plane`] = 'parallel';
            } else {
                patch[`c${k}plane`] = others.some((o) => o.cls === 'line') ? 'angle' : 'offset';
            }
            break;
        case 'point':
            patch[`c${k}point`] = 'coincident';
            if (plane && loosePlane) {
                patch[`c${plane.j}plane`] = 'parallel';
            }
            break;
        case 'line':
            patch[`c${k}line`] = others.length === 0 ? 'perpendicular' : 'coincident';
            if (plane && loosePlane) {
                patch[`c${plane.j}plane`] = 'angle';
            }
            break;
        case 'curve':
            patch[`c${k}curve`] = 'perpendicular';
            break;
        case 'cyl':
            patch[`c${k}cyl`] = 'tangent';
            if (plane && loosePlane) {
                patch[`c${plane.j}plane`] = 'parallel';
            }
            break;
    }
    return patch;
}

// ---- Axis -------------------------------------------------------------------------------------------------------

export const AXIS_KINDS: [string, string][] = [
    ['along', 'One line/edge/axis'], ['cylinder', 'Cylindrical/conical face'], ['planeIntersection', 'Two planes'],
    ['twoPoints', 'Two points/vertices'], ['pointPlane', 'Point and face/plane'], ['sketchLine', 'Sketch line or centreline'],
];

/** The Axis form's boxes: a line, a cylinder, two planes, two points. */
export const AXIS_BOXES = ['ln', 'cy', 'pa', 'pb', 'qa', 'qb'];

/** The line field of the Axis form for one sketch step (each sketch has its own lines). */
export const lineKey = (sketchId: unknown): string => `line_${String(sketchId ?? '')}`;

/** Why a pick does not fit an Axis box, or null. */
export function axisAccept(box: string): (item: PickItem) => string | null {
    return (item) => {
        const c = itemClass(item);
        switch (box) {
            case 'ln':
                return c === 'line' || c === 'cylinder' || c === 'cone' ? null : 'Pick a straight edge or an axis.';
            case 'cy':
                return c === 'cylinder' || c === 'cone' ? null : 'Pick a cylindrical or conical face.';
            case 'pa':
            case 'pb':
                return c === 'plane' ? null : 'Pick a flat face or a plane.';
            default:
                return c === 'point' || c === 'circle' ? null : 'Pick a vertex, a point or a circular edge (its centre).';
        }
    };
}

export function axisDefaults(): RefValues {
    return { kind: 'along', sketch: '', ...emptyBoxes(AXIS_BOXES), ...vecValues('direction', [0, 1, 0]) };
}

export function axisValues(d: AxisDefinition, steps: Feature[] = []): RefValues {
    const v: RefValues = { ...axisDefaults(), kind: d.kind };
    const set = (key: string, item: PickItem) => Object.assign(v, boxValues(key, item));
    switch (d.kind) {
        case 'sketchLine':
            return { ...v, sketch: d.sketchRef, [lineKey(d.sketchRef)]: d.line };
        case 'planeIntersection':
            set('pa', planeItem(d.a, steps));
            set('pb', planeItem(d.b, steps));
            return v;
        case 'twoPoints':
            return { ...v, ...pointItem(d.a, 'qa', steps), ...pointItem(d.b, 'qb', steps) };
        case 'pointPlane':
            set('pa', planeItem(d.plane, steps));
            return { ...v, ...pointItem(d.point, 'qa', steps) };
        case 'pointDirection':
            return { ...v, ...pointItem(d.point, 'qa', steps), ...vecValues('direction', d.direction) };
        case 'along': {
            const cyl = typeof d.axis === 'object' && 'fixedAxis' in d.axis && (d.axis.from === 'cylinder' || d.axis.from === 'cone');
            set(cyl ? 'cy' : 'ln', lineItem(d.axis, steps));
            return { ...v, kind: cyl ? 'cylinder' : 'along' };
        }
    }
}

export function axisDefinition(v: RefValues): AxisDefinition {
    const item = (key: string, what: string): PickItem => {
        const found = pickItems(v[key])[0];
        if (!found) {
            throw new Error(`Pick ${what}.`);
        }
        return found;
    };
    switch (v.kind) {
        case 'along':
            return { kind: 'along', axis: asAxis(item('ln', 'a straight edge or an axis')) };
        case 'cylinder':
            return { kind: 'along', axis: asAxis(item('cy', 'a cylindrical or conical face')) };
        case 'sketchLine': {
            const sketch = typeof v.sketch === 'string' ? v.sketch : '';
            const line = v[lineKey(sketch)];
            if (!sketch || typeof line !== 'string' || !line) {
                throw new Error('Pick a sketch and one of its lines.');
            }
            return { kind: 'sketchLine', sketchRef: sketch, line };
        }
        case 'planeIntersection':
            return { kind: 'planeIntersection', a: asPlane(item('pa', 'the first plane or face')), b: asPlane(item('pb', 'the second plane or face')) };
        case 'twoPoints':
            return { kind: 'twoPoints', a: asPoint(item('qa', 'the first point'), v, 'qa'), b: asPoint(item('qb', 'the second point'), v, 'qb') };
        case 'pointPlane':
            return { kind: 'pointPlane', point: asPoint(item('qa', 'a point or vertex'), v, 'qa'), plane: asPlane(item('pa', 'a flat face or a plane')) };
        case 'pointDirection':
            return { kind: 'pointDirection', point: asPoint(item('qa', 'a point'), v, 'qa'), direction: vec(v, 'direction', 'Direction') };
        default:
            throw new Error('Pick how the axis is defined.');
    }
}

/** Checks a definition against the steps before it, as the kernel will (the same resolver), with a plain message. */
export function checkReference(op: 'plane' | 'axis', definition: PlaneDefinition | AxisDefinition, steps: Feature[]): void {
    const probe = { id: '__new', op, definition } as Feature;
    const all = [...steps, probe];
    try {
        if (op === 'plane') {
            resolvePlane({ planeRef: '__new' }, all, 'plane');
        } else {
            resolveAxis({ axisRef: '__new' }, all, 'axis');
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(message.replace(/^(plane|axis): /, '').replace(/^./, (c) => c.toUpperCase()));
    }
}

/** The form's message: "Fully defined", or what is missing or wrong. */
export function referenceStatus(op: 'plane' | 'axis', v: RefValues, steps: Feature[]): { ok: boolean; text: string } {
    try {
        checkReference(op, op === 'plane' ? planeDefinition(v) : axisDefinition(v), steps);
        return { ok: true, text: 'Fully defined' };
    } catch (e) {
        return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
}

// ---- Point ------------------------------------------------------------------------------------------------------

export const POINT_KINDS: [string, string][] = [
    ['xyz', 'Coordinates'], ['arcCentre', 'Arc centre'], ['faceCentre', 'Centre of face'], ['vertex', 'On point'],
    ['intersection', 'Intersection'], ['along', 'Along curve distance or percentage'],
];

/** Why a pick does not fit a Point box, or null. */
export function pointAccept(box: string): (item: PickItem) => string | null {
    return (item) => {
        const c = itemClass(item);
        switch (box) {
            case 'arc':
                return c === 'circle' ? null : 'Pick a circular edge or arc.';
            case 'fc':
                return item.kind === 'face' ? null : 'Pick a face.';
            case 'vx':
                return item.kind === 'vertex' || isCurvePointItem(item) ? null : 'Pick a vertex (click an edge at its end) or the start or end of a helix.';
            case 'e1':
            case 'e2':
                return c === 'line' && item.kind === 'edge' ? null : 'Pick a straight edge.';
            default:
                return (item.kind === 'edge' && (c === 'line' || c === 'circle')) || isCurveItem(item) ? null : 'Pick a straight or circular edge, or a helix or spiral.';
        }
    };
}

export function pointDefaults(position: Vec3 = [0, 0, 0]): RefValues {
    return {
        kind: 'xyz', ...vecValues('pos', position), arc: [], fc: [], vx: [], e1: [], e2: [], ed: [], vxlist: '', edlist: '',
        by: 'distance', amount: '10', count: '1', reverse: false, index: '1',
    };
}

/**
 * Form values of a stored point step: one taken from the model reopens as it was made (its picks as the kernel last
 * found them); coordinates, and older steps kept by value, as coordinates.
 */
export function pointValues(step: Extract<Feature, { op: 'point' }>, steps: Feature[] = []): RefValues {
    const v = pointDefaults(step.position);
    const d = step.definition;
    const p = step.position;
    switch (d?.kind) {
        case 'arcCentre':
            return { ...v, kind: 'arcCentre', arc: [edgeItem(d.edge, edgeGeom(d.edge, p))] };
        case 'faceCentre': {
            const normal = d.face.normal ? { normal: [...d.face.normal] as Vec3 } : {};
            const model: ModelPick = { geom: { type: 'surface' }, click: [...d.face.at], centre: [...p], pick: { face: d.face } };
            return { ...v, kind: 'faceCentre', fc: [{ kind: 'face', at: [...d.face.at], ...normal, model }] };
        }
        case 'vertex':
            return { ...v, kind: 'vertex', vx: [{ kind: 'vertex', at: [...p], model: { geom: { type: 'vertex', at: [...p] }, click: [...p], pick: d.vertex } }] };
        case 'intersection':
            return { ...v, kind: 'intersection', e1: [edgeItem(d.a, edgeGeom(d.a))], e2: [edgeItem(d.b, edgeGeom(d.b))] };
        case 'along':
            return {
                ...v, kind: 'along', ed: [edgeItem(d.edge, edgeGeom(d.edge))], by: d.by, amount: fmt(d.amount), reverse: !!d.reverse, index: String(d.index),
            };
        case 'onCurve':
            return { ...v, kind: 'vertex', vx: [curvePointItem(d.curve, steps)], vxlist: curvePointValue(d.curve) };
        case 'alongCurve':
            return {
                ...v, kind: 'along', ed: [curveItem(d.curve.curveRef, steps)], edlist: `curve:${d.curve.curveRef}`, by: d.by, amount: fmt(d.amount), reverse: !!d.reverse, index: String(d.index),
            };
        default:
            return v;
    }
}

function boxGeom(v: RefValues, key: string, what: string): ModelPick['geom'] {
    const item = pickItems(v[key])[0];
    const g = item ? geomOf(item) : null;
    if (!g) {
        throw new Error(`Pick ${what}.`);
    }
    return g;
}

/** The positions the Point form makes (several for Along curve with a number of points). */
export function pointPositions(v: RefValues, steps: Feature[] = []): Vec3[] {
    switch (v.kind) {
        case 'xyz':
            return [vec(v, 'pos', 'Point')];
        case 'arcCentre': {
            const g = boxGeom(v, 'arc', 'a circular edge');
            if (g.type !== 'circle') {
                throw new Error('Pick a circular edge or arc.');
            }
            return [g.centre];
        }
        case 'faceCentre': {
            const item = pickItems(v.fc)[0];
            if (!item || item.kind !== 'face' || !item.model?.centre) {
                throw new Error('Pick a face.');
            }
            return [[...item.model.centre]];
        }
        case 'vertex': {
            const item = pickItems(v.vx)[0];
            const onCurve = item?.kind === 'ref' ? curvePointOf(item.ref) : null;
            if (onCurve) {
                return [resolvePoint(onCurve, steps, 'point')];
            }
            if (!item || item.kind !== 'vertex') {
                throw new Error('Pick a vertex.');
            }
            return [[...item.at]];
        }
        case 'intersection': {
            const a = boxGeom(v, 'e1', 'the first straight edge');
            const b = boxGeom(v, 'e2', 'the second straight edge');
            if (a.type !== 'line' || b.type !== 'line') {
                throw new Error('Pick two straight edges.');
            }
            return [linesMeet(a.a, unit(sub(a.b, a.a)), b.a, unit(sub(b.b, b.a)))];
        }
        case 'along':
            return alongPositions(v, steps);
        default:
            throw new Error('Pick how the point is defined.');
    }
}

/**
 * Points along a straight or circular edge from its start (Reverse: from its end), spaced by a distance or a
 * percentage of its length; the first is one spacing from the end, as in SolidWorks.
 */
function alongPositions(v: RefValues, steps: Feature[]): Vec3[] {
    const picked = pickItems(v.ed)[0];
    const curve = picked?.kind === 'ref' ? curveIdOf(picked.ref) : null;
    const g = curve ? null : boxGeom(v, 'ed', 'a straight or circular edge');
    const count = Math.round(num(v, 'count', 'Number of points'));
    if (count < 1 || count > 100) {
        throw new Error('Number of points must be 1 to 100.');
    }
    const amount = num(v, 'amount', v.by === 'percent' ? 'Percentage' : 'Distance');
    if (!(amount > 0)) {
        throw new Error(`${v.by === 'percent' ? 'Percentage' : 'Distance'} must be greater than 0.`);
    }
    if (curve) {
        return pointsAlongCurve(curveOf(curve, steps), v.by === 'percent' ? 'percent' : 'distance', amount, count, !!v.reverse, fmt);
    }
    const shape = shapeOf(g);
    if (!shape) {
        throw new Error('Pick a straight or circular edge.');
    }
    return pointsAlong(shape, v.by === 'percent' ? 'percent' : 'distance', amount, count, !!v.reverse, fmt);
}

/**
 * The point steps the Point form makes: each position, and for one taken from the model how it was taken (the kernel
 * finds it again at every rebuild). `editing`: one step; Along curve keeps the edited point's place in its row.
 */
export function pointSteps(v: RefValues, editing = false, before: Feature[] = []): { position: Vec3; definition?: PointDefinition }[] {
    const along = v.kind === 'along';
    const index = editing && along ? Math.max(1, Math.round(Number(v.index) || 1)) : 1;
    const positions = pointPositions(editing ? { ...v, count: String(index) } : v, before);
    const made = editing ? positions.slice(-1) : positions;
    const steps = (definition: (i: number) => PointDefinition | null) => made.map((position, i) => {
        const d = definition(i);
        return d ? { position, definition: d } : { position };
    });
    const item = (key: string): PickItem | undefined => pickItems(v[key])[0];
    const pickIn = (key: string): ModelEntityPick | null => {
        const found = item(key);
        return found ? pickOf(found) : null;
    };
    const edgeIn = (key: string): ModelEdgePick | null => {
        const found = item(key);
        return found ? edgePickOf(found) : null;
    };
    switch (v.kind) {
        case 'arcCentre': {
            const edge = edgeIn('arc');
            return steps(() => (edge ? { kind: 'arcCentre', edge } : null));
        }
        case 'faceCentre': {
            const pick = pickIn('fc');
            return steps(() => (pick && 'face' in pick ? { kind: 'faceCentre', face: pick.face } : null));
        }
        case 'vertex': {
            const found = item('vx');
            const onCurve = found?.kind === 'ref' ? curvePointOf(found.ref) : null;
            if (onCurve) {
                return steps(() => ({ kind: 'onCurve', curve: onCurve }));
            }
            const pick = pickIn('vx');
            return steps(() => (pick && 'vertex' in pick ? { kind: 'vertex', vertex: pick } : null));
        }
        case 'intersection': {
            const [a, b] = [edgeIn('e1'), edgeIn('e2')];
            return steps(() => (a && b ? { kind: 'intersection', a, b } : null));
        }
        case 'along': {
            const edge = edgeIn('ed');
            const by = v.by === 'percent' ? 'percent' : 'distance';
            const amount = num(v, 'amount', by === 'percent' ? 'Percentage' : 'Distance');
            const found = item('ed');
            const curve = found?.kind === 'ref' ? curveIdOf(found.ref) : null;
            if (curve) {
                return steps((i) => ({
                    kind: 'alongCurve', curve: { curveRef: curve }, by, amount, index: editing ? index : i + 1, ...(v.reverse ? { reverse: true } : {}),
                }));
            }
            return steps((i) => (edge?.shape
                ? { kind: 'along', edge, by, amount, index: editing ? index : i + 1, ...(v.reverse ? { reverse: true } : {}) } : null));
        }
        default:
            return steps(() => null);
    }
}

// ---- Picks in the view for other tools ----------------------------------------------------------------------------

/** What an axis step clicked in the view sets in the open Revolve form, or null. */
export function refPickPatch(toolId: string | null, v: RefValues, op: Feature['op'], id: string): RefValues | null {
    if (toolId === 'revolve' && op === 'axis') {
        return { [revolveAxisKey(v.sketch)]: `axis:${id}` };
    }
    return null;
}

/**
 * Lines of a sketch step that a click in the view can pick for the open tool: the Revolve axis or the Axis tool's
 * line. Returns the sketch, the form key and the value prefix, or null.
 */
export function linePickTarget(toolId: string | null, v: RefValues): { sketch: string; key: string; prefix: string } | null {
    const sketch = typeof v.sketch === 'string' ? v.sketch : '';
    if (!sketch) {
        return null;
    }
    if (toolId === 'revolve') {
        return { sketch, key: revolveAxisKey(sketch), prefix: 'line:' };
    }
    if (toolId === 'axis' && v.kind === 'sketchLine') {
        return { sketch, key: lineKey(sketch), prefix: '' };
    }
    return null;
}
