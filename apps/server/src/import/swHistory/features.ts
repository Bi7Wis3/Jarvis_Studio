// SolidWorks features as studio features, in tree order. Each SolidWorks feature becomes the studio feature that does
// the same (names kept), its sketch a sketch step before it. The first feature that changes the solid and cannot be
// rebuilt ends the rebuild: the importer continues from there with SolidWorks' own body (importPart.ts).

import { Euler, Quaternion, Vector3 } from 'three';
import type { AxisRef, Feature, FeatureFolder, FacePickRef, PlaneRef, Vec3 } from '@jarvis/core';
import type { SwAfter, SwDocument, SwEntity, SwFeature, SwValue } from './format.js';
import { add, clean, cleanV, conventionFromPlanes, cross, deg, dot, frameOf, MM, mm, norm, rigidOf, scale, sub, unit, v3, type Convention } from './math.js';
import { mapSketch, planeOfFrame, type MappedSketch, type SketchFrame3 } from './sketch.js';
import { inside, type P2 } from './loops.js';

/** What a SolidWorks feature became. */
export interface FeatureOrigin {
    name: string;
    type: string;
    /** The studio steps it became (none: left out). */
    ids: string[];
    /** It changes the solid (so SolidWorks' volume after it can be compared). */
    solid: boolean;
    suppressed: boolean;
    after?: SwAfter;
}

export interface Skipped {
    name: string;
    type: string;
    why: string;
}

export interface MappedPart {
    features: Feature[];
    folders: FeatureFolder[];
    origins: FeatureOrigin[];
    /** Left out without changing the solid (sketches never used, cosmetic threads, suppressed features...). */
    skipped: Skipped[];
    /** The first feature that changes the solid and could not be rebuilt: SolidWorks' body takes over there. */
    stop: Skipped | null;
    /** Everything from `stop` on, in the SolidWorks body. */
    after: Skipped[];
    notes: string[];
    convention: Convention;
    /** How each extrude's and hole's direction was settled: by the faces it made agreeing or not with the rule, or by the rule alone. */
    votes: ('agree' | 'disagree' | 'none')[];
}

/** Tree items that build nothing and need nothing. */
const IGNORED = new Set([
    'CommentsFolder', 'FavoriteFolder', 'HistoryFolder', 'SelectionSetFolder', 'SensorFolder', 'DocsFolder', 'DetailCabinet',
    'SurfaceBodyFolder', 'SolidBodyFolder', 'EnvFolder', 'EqnFolder', 'MaterialFolder', 'OriginProfileFeature',
    'MateReferenceGroupFolder', 'ProfileFtrFolder', 'RefPlaneFtrFolder', 'RefAxisFtrFolder', 'BlockFolder', 'CutListFolder',
    'Attribute', 'LiveSection', 'AmbientLight', 'DirectionLight', 'PointLight', 'SpotLight', 'CameraFeature', 'Configuration',
    'PartConfiguration', 'CoordSys', 'GridFeature', 'LiveSectionFolder', 'InkMarkupFolder', 'Journal', 'DesignTableFeature',
    'SketchBlockDef', 'TableFolder', 'FeatSolidBodyFolder', 'FeatSurfaceBodyFolder', 'ReferenceBrowser', 'SubAtomFolder',
]);

class Unsupported extends Error {}
function no(why: string): never {
    throw new Unsupported(why);
}

// ---- Reading the feature data ---------------------------------------------------------------------------------

const num = (d: Record<string, SwValue> | null | undefined, key: string): number | null => {
    const v = d?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null;
};
const bool = (d: Record<string, SwValue> | null | undefined, key: string): boolean | null => {
    const v = d?.[key];
    return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : null;
};
const isEntity = (v: SwValue | undefined): v is SwEntity => !!v && typeof v === 'object' && !Array.isArray(v) && 'kind' in v;
const entities = (d: Record<string, SwValue> | null | undefined, key: string): SwEntity[] => {
    const v = d?.[key];
    if (Array.isArray(v)) return v.filter(isEntity);
    return isEntity(v) ? [v] : [];
};
const pointOf = (e: SwEntity): Vec3 | null => ('point' in e && Array.isArray(e.point) ? cleanV(mm(e.point)) : null);
const normalOf = (e: SwEntity): Vec3 | null => ('normal' in e && Array.isArray(e.normal) ? unit(v3(e.normal)) : null);
const facePick = (e: SwEntity): FacePickRef | null => {
    const at = pointOf(e);
    const normal = normalOf(e);
    return at ? { at, ...(normal && norm(normal) > 0 ? { normal: cleanV(normal) } : {}) } : null;
};

/** Ids like the history tools make them: lower-case words joined by dashes, unique in the part. */
function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step';
}

// ---- The mapping ----------------------------------------------------------------------------------------------

interface PlaneInfo {
    ref: PlaneRef;
    frame: SketchFrame3;
}

export function mapPart(doc: SwDocument): MappedPart {
    const all = doc.features ?? [];
    const notes: string[] = [];
    const refPlanes = all.filter((f) => f.type === 'RefPlane');
    const convention = conventionFromPlanes(refPlanes.slice(0, 3).map((f) => f.plane?.transform)) ?? 'rows';
    if (refPlanes.length >= 3 && !conventionFromPlanes(refPlanes.slice(0, 3).map((f) => f.plane?.transform))) {
        notes.push('The standard planes did not show how SolidWorks lays out its transforms; read as documented (rows)');
    }
    const features: Feature[] = [];
    const used = new Set<string>();
    const origins: FeatureOrigin[] = [];
    const skipped: Skipped[] = [];
    const after: Skipped[] = [];
    let stop: Skipped | null = null;
    const sketches = new Map<string, { id: string; mapped: MappedSketch }>();
    const sketchErrors = new Map<string, string>();
    const planes = new Map<string, PlaneInfo>();
    const axes = new Map<string, { id: string; point: Vec3; direction: Vec3 }>();
    const made = new Map<string, string[]>();
    const usedSketches = new Set<string>();
    // Feature tree folders: a FtrFolder opens one, a "___EndTag___" one closes the innermost.
    const folders: FeatureFolder[] = [];
    const open: FeatureFolder[] = [];
    const folderIds = new Set<string>();
    const sizeHint = boxSize(doc);
    let standard = 0;
    const directionVotes: ('agree' | 'disagree' | 'none')[] = [];

    const newId = (name: string): string => {
        const base = slug(name);
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        return id;
    };
    // Features are checked against the history tools' schema when the part is added (parts_add).
    const push = (f: object, name: string): string => {
        const id = (f as { id?: string }).id ?? newId(name);
        features.push({ ...f, id } as unknown as Feature);
        open[open.length - 1]?.items.push(id);
        return id;
    };

    for (const sw of all) {
        const type = sw.type === 'ICE' ? sw.baseType ?? 'ICE' : sw.type;
        if (type === 'FtrFolder') {
            if (stop) continue;
            if (/___EndTag___/.test(sw.name)) {
                open.pop();
            } else {
                let id = `folder-${slug(sw.name)}`;
                for (let n = 2; folderIds.has(id); n++) id = `folder-${slug(sw.name)}-${n}`;
                folderIds.add(id);
                const folder: FeatureFolder = { id, name: sw.name, items: [] };
                open[open.length - 1]?.items.push(id);
                folders.push(folder);
                open.push(folder);
            }
            continue;
        }
        if (IGNORED.has(type)) {
            continue;
        }
        if (stop) {
            after.push({ name: sw.name, type: sw.type, why: 'in the SolidWorks body' });
            continue;
        }
        const origin: FeatureOrigin = { name: sw.name, type: sw.type, ids: [], solid: false, suppressed: sw.suppressed, ...(sw.after ? { after: sw.after } : {}) };
        const before = features.length;
        try {
            mapOne(sw, type);
            origin.ids = features.slice(before).map((f) => f.id);
            made.set(sw.name, origin.ids);
            origins.push(origin);
        } catch (error) {
            features.length = before;
            for (const f of open) f.items = f.items.filter((id) => features.some((g) => g.id === id) || folderIds.has(id));
            const why = error instanceof Error ? error.message : String(error);
            if (!(error instanceof Unsupported) && !(error instanceof Error)) throw error;
            const changesSolid = solidKind(type);
            origins.push(origin);
            if (changesSolid && !sw.suppressed) {
                stop = { name: sw.name, type: sw.type, why };
                origin.solid = true;
            } else {
                skipped.push({ name: sw.name, type: sw.type, why: sw.suppressed ? `suppressed, and ${why}` : why });
            }
        }
    }

    // Sketches no feature used stay in the history (as in SolidWorks); those that failed are said.
    for (const [name, why] of sketchErrors) {
        if (!skipped.some((s) => s.name === name)) skipped.push({ name, type: 'ProfileFeature', why });
    }
    const kept = new Set(features.map((f) => f.id));
    const liveFolders = pruneFolders(folders, kept);
    return { features, folders: liveFolders, origins, skipped, stop, after, notes, convention, votes: directionVotes };

    // ---- One SolidWorks feature -----------------------------------------------------------------------------

    function mapOne(sw: SwFeature, type: string): void {
        const d = sw.data ?? null;
        const suppressed = sw.suppressed ? { suppressed: true } : {};
        const base = { name: sw.name, ...suppressed };
        switch (type) {
            case 'RefPlane':
                return refPlane(sw, base);
            case 'RefAxis':
                return refAxis(sw, base);
            case 'RefPoint': {
                const at = sw.point?.at;
                if (!at) no('the export gave no position');
                push({ op: 'point', position: cleanV(mm(at)), ...base }, sw.name);
                return;
            }
            case 'ProfileFeature': {
                try {
                    if (!sw.sketch) no('the export holds no sketch');
                    const mapped = mapSketch(sw.sketch!, convention);
                    const plane = onPlaneStep(sw, mapped.frame);
                    const sketch = plane ? { ...mapped.sketch, plane, offset: undefined } : mapped.sketch;
                    if (sketch.offset === undefined) delete sketch.offset;
                    const id = push({ op: 'sketch', sketch, ...base }, sw.name);
                    sketches.set(sw.name, { id, mapped });
                    for (const note of mapped.notes) notes.push(`${sw.name}: ${note}`);
                } catch (error) {
                    sketchErrors.set(sw.name, error instanceof Error ? error.message : String(error));
                }
                return;
            }
            case '3DProfileFeature':
                sketchErrors.set(sw.name, 'it is a 3D sketch; the studio has 2D sketches only');
                return;
            case 'CosmeticThread':
                no('a cosmetic thread changes no geometry; the studio\'s threads are modelled');
                return;
            case 'Extrusion':
            case 'Boss':
            case 'Cut':
            case 'ICE':
                return extrude(sw, type, d, base);
            case 'BossThin':
            case 'CutThin':
                no('thin features are not in the studio yet');
                return;
            case 'Revolution':
            case 'RevCut':
                return revolve(sw, type, d, base);
            case 'RevolutionThin':
                no('thin features are not in the studio yet');
                return;
            case 'Fillet':
                return fillet(sw, d, base);
            case 'Chamfer':
                return chamfer(sw, d, base);
            case 'HoleWzd':
                return holeWizard(sw, d, base);
            case 'HoleSimple':
            case 'SimpleHole':
                return simpleHole(sw, d, base);
            case 'LPattern':
            case 'CirPattern':
                return pattern(sw, type, d, base);
            case 'MirrorPattern':
                return mirrorFeatures(sw, d, base);
            case 'MirrorSolid':
                return mirrorBody(sw, d, base);
            case 'Shell':
                return shell(d, base, sw);
            case 'Blend':
            case 'BlendCut':
                return loft(sw, type, d, base);
            case 'Sweep':
            case 'SweepCut':
                return sweep(sw, type, d, base);
            case 'Draft':
                return draft(d, base, sw);
            case 'VarFillet':
                no('variable radius fillets are not in the studio yet');
                return;
            case 'Rib':
                no('ribs are not in the studio yet');
                return;
            default:
                no(`the studio has no ${type} feature yet`);
        }
    }

    function refPlane(sw: SwFeature, base: { name: string; suppressed?: boolean }): void {
        const rigid = rigidOf(sw.plane?.transform, convention);
        if (!rigid) no('the export gave no plane position');
        const f = frameOf(rigid!);
        const frame: SketchFrame3 = { origin: f.origin, x: unit(f.x), y: cross(unit(f.z), unit(f.x)), normal: unit(f.z) };
        const named = planeOfFrame(frame);
        // The first three planes are Front, Top and Right: the studio's own.
        if (standard < 3) {
            standard++;
            if (typeof named.plane === 'string' && named.offset === undefined) {
                planes.set(sw.name, { ref: named.plane, frame });
                return;
            }
        }
        const definition = typeof named.plane === 'string'
            ? { kind: 'offset' as const, base: named.plane, distance: named.offset ?? 0 }
            : { kind: 'pointNormal' as const, point: cleanV(frame.origin), normal: cleanV(frame.normal), xDir: cleanV(frame.x) };
        const id = push({ op: 'plane', definition, ...base }, sw.name);
        planes.set(sw.name, { ref: { planeRef: id }, frame });
    }

    function refAxis(sw: SwFeature, base: { name: string; suppressed?: boolean }): void {
        const p = sw.axis?.params;
        if (!p || p.length < 6) no('the export gave no axis position');
        const a = cleanV(mm(p!.slice(0, 3)));
        const b = mm(p!.slice(3, 6));
        const direction = cleanV(unit(sub(b, a)));
        if (!(norm(direction) > 0)) no('the axis has no length');
        const id = push({ op: 'axis', definition: { kind: 'pointDirection', point: a, direction }, ...base }, sw.name);
        axes.set(sw.name, { id, point: a, direction });
    }

    /** A sketch on a plane step of this import: drawn on that step (same frame), so moving the plane moves the sketch. */
    function onPlaneStep(sw: SwFeature, frame: SketchFrame3): { planeRef: string } | null {
        for (const parent of sw.parents ?? []) {
            const p = planes.get(parent);
            if (p && typeof p.ref === 'object' && 'planeRef' in p.ref && sameFrame(p.frame, frame)) {
                return p.ref;
            }
        }
        return null;
    }

    function sketchFor(sw: SwFeature, index = 0): { id: string; mapped: MappedSketch; name: string } {
        const names = [...(sw.subFeatures ?? []).filter((s) => s.type === 'ProfileFeature').map((s) => s.name),
            ...(sw.parents ?? []).filter((p) => sketches.has(p) || sketchErrors.has(p))];
        const unique = [...new Set(names)];
        const name = unique[index];
        if (!name) no('its sketch was not found in the export');
        const s = sketches.get(name);
        if (!s) no(`its sketch ${name} could not be read: ${sketchErrors.get(name) ?? 'not in the export'}`);
        usedSketches.add(name);
        return { ...s!, name };
    }

    // ---- Extrude ---------------------------------------------------------------------------------------------

    function extrude(sw: SwFeature, type: string, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        if (bool(d, 'IsThinFeature')) no('thin features are not in the studio yet');
        const boss = bool(d, 'IsBossFeature') ?? (type !== 'Cut');
        const mode = boss ? 'add' as const : 'cut' as const;
        const { id: sketchRef, mapped } = sketchFor(sw);
        const n = mapped.frame.normal;
        const o = mapped.frame.origin;
        const end1 = num(d, 'GetEndCondition(True)') ?? 0;
        const end2 = num(d, 'GetEndCondition(False)') ?? 0;
        const both = !!bool(d, 'BothDirections');
        const depth1 = clean((num(d, 'GetDepth(True)') ?? 0) * MM);
        const depth2 = clean((num(d, 'GetDepth(False)') ?? 0) * MM);
        // Direction 1 along the sketch normal for a boss and against it for a cut, unless reversed; the faces the
        // feature made say which way it really went when they can.
        const ruled = (boss ? 1 : -1) * (bool(d, 'ReverseDirection') ? -1 : 1);
        const seen = sideOfFaces(sw.faces ?? [], o, n, end1 === 6 || both);
        const sign = seen ?? ruled;
        directionVotes.push(seen === null ? 'none' : seen === ruled ? 'agree' : 'disagree');
        const regions = contourPicks(d, mapped);
        const f: Record<string, unknown> = { op: 'extrude', sketchRef, mode, ...(regions ? { regions } : {}), ...base };
        const draftOf = (forward: boolean): { draft?: number; draftOutward?: boolean } => {
            if (!bool(d, `GetDraftWhileExtruding(${forward ? 'True' : 'False'})`)) return {};
            const angle = clean(deg(num(d, `GetDraftAngle(${forward ? 'True' : 'False'})`) ?? 0));
            return angle > 0 ? { draft: angle, ...(bool(d, `GetDraftOutward(${forward ? 'True' : 'False'})`) ? { draftOutward: true } : {}) } : {};
        };
        if (!boss && bool(d, 'FlipSideToCut')) f.flipSide = true;
        const fromType = num(d, 'FromType') ?? 0;
        if (fromType === 3) {
            const offset = clean((num(d, 'FromOffsetDistance') ?? 0) * MM) * (bool(d, 'FromOffsetReverse') ? -1 : 1);
            if (offset) f.from = clean(offset * sign);
        } else if (fromType !== 0) {
            no('it starts from a surface or vertex; the studio starts extrudes from the sketch plane or an offset');
        }
        const endOf = (cond: number, depth: number, forward: boolean, dirSign: number): { end: 'blind' | 'throughAll' | 'upToNext'; distance?: number } => {
            switch (cond) {
                case 0:
                    return { end: 'blind', distance: depth };
                case 1:
                    return { end: 'throughAll' };
                case 2:
                    return { end: 'upToNext' };
                case 3:
                case 4:
                case 5: {
                    const distance = upToDistance(sw, forward ? 0 : 1, cond, depth, o, n, dirSign);
                    if (distance === null) no('it goes up to a vertex or surface that is not flat and parallel to the sketch; the studio has no such end');
                    notes.push(`${sw.name}: ${cond === 3 ? 'up to vertex' : cond === 4 ? 'up to surface' : 'offset from surface'} was rebuilt as blind ${distance} mm`);
                    return { end: 'blind', distance: distance! };
                }
                case 7:
                    return no('up to body is not in the studio yet');
                default:
                    return no(`end condition ${cond} is not in the studio yet`);
            }
        };
        if (end1 === 6 || end1 === 9) {
            f.direction = 'symmetric';
            f.end = end1 === 6 ? 'blind' : 'throughAll';
            if (end1 === 6) f.distance = depth1;
            Object.assign(f, draftOf(true));
        } else {
            f.direction = sign > 0 ? 'normal' : 'reverse';
            const e1 = endOf(end1, depth1, true, sign);
            f.end = e1.end;
            if (e1.distance !== undefined) f.distance = e1.distance;
            Object.assign(f, draftOf(true));
            if (both) {
                const e2 = endOf(end2, depth2, false, -sign);
                const draft2 = draftOf(false);
                f.second = { end: e2.end, ...(e2.distance !== undefined ? { distance: e2.distance } : {}), ...draft2 };
            }
        }
        if (f.end === 'blind' && !(Number(f.distance) > 0)) no('its depth was not exported');
        push(f, sw.name);
    }

    // ---- Revolve ---------------------------------------------------------------------------------------------

    function revolve(sw: SwFeature, type: string, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        if (bool(d, 'IsThinFeature')) no('thin features are not in the studio yet');
        const boss = bool(d, 'IsBossFeature') ?? (type !== 'RevCut');
        const { id: sketchRef, mapped } = sketchFor(sw);
        const axis = revolveAxis(entities(d, 'Axis')[0], mapped);
        const t = num(d, 'Type') ?? 0;
        const a1 = clean(deg(num(d, 'GetRevolutionAngle(True)') ?? Math.PI * 2));
        const a2 = clean(deg(num(d, 'GetRevolutionAngle(False)') ?? 0));
        const f: Record<string, unknown> = { op: 'revolve', sketchRef, mode: boss ? 'add' : 'cut', axis, ...base };
        const regions = contourPicks(d, mapped);
        if (regions) f.regions = regions;
        if (t === 3 || t === 4 || t === 5 || a1 >= 360 - 1e-9) {
            f.angle = 360;
        } else if (t === 1) {
            f.type = 'midPlane';
            f.angle = a1;
        } else {
            f.angle = a1;
            if (bool(d, 'ReverseDirection')) f.reverse = true;
            if (t === 2 && a2 > 0) f.angle2 = a2;
        }
        push(f, sw.name);
    }

    function revolveAxis(e: SwEntity | undefined, mapped: MappedSketch): Extract<Feature, { op: 'revolve' }>['axis'] {
        if (!e) no('its axis was not exported');
        if (e!.kind === 'sketchSegment' && 'id' in e! && mapped.curves.get(e!.id as string)?.kind === 'line') {
            return { line: e!.id as string };
        }
        return axisOf(e!);
    }

    // ---- Fillet and chamfer ---------------------------------------------------------------------------------

    function fillet(sw: SwFeature, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        const t = num(d, 'Type') ?? 0;
        if (t === 1) no('variable radius fillets are not in the studio yet');
        if (t === 2) no('face fillets are not in the studio yet');
        if (t === 3) no('full round fillets are not in the studio yet');
        if (bool(d, 'AsymmetricFillet')) no('asymmetric fillets are not in the studio yet');
        if (bool(d, 'ConstantWidth')) no('constant width fillets are not in the studio yet');
        const tangent = bool(d, 'PropagateToTangentFaces') ? { tangent: true } : {};
        const picks = edgeAndFacePicks(d, ['Edges', 'Loops'], ['GetFaces(0)']);
        if (entities(d, 'Features').length) no('it fillets whole features; pick-by-feature is not in the studio yet');
        if (bool(d, 'IsMultipleRadius') && sw.items?.length) {
            // One fillet per radius (SolidWorks rounds them in one go; corners where radii meet may differ).
            const byRadius = new Map<number, { at: Vec3[]; faces: FacePickRef[] }>();
            for (const item of sw.items) {
                const r = clean((item.radius ?? 0) * MM);
                if (!(r > 0) || !item.entity) continue;
                const group = byRadius.get(r) ?? { at: [], faces: [] };
                if (item.entity.kind === 'edge') group.at.push(pointOf(item.entity)!);
                else if (item.entity.kind === 'face') group.faces.push(facePick(item.entity)!);
                byRadius.set(r, group);
            }
            if (!byRadius.size) no('its radii were not exported');
            let k = 0;
            for (const [radius, g] of byRadius) {
                push({ op: 'fillet', radius, ...(g.at.length ? { at: g.at } : {}), ...(g.faces.length ? { faces: g.faces } : {}), ...tangent, ...base, name: k ? `${sw.name} (${k + 1})` : sw.name }, sw.name);
                k++;
            }
            if (byRadius.size > 1) notes.push(`${sw.name}: a fillet with ${byRadius.size} radii became one fillet per radius`);
            return;
        }
        const radius = clean((num(d, 'DefaultRadius') ?? 0) * MM);
        if (!(radius > 0)) no('its radius was not exported');
        if (!picks.at.length && !picks.faces.length) no('its edges were not exported');
        push({ op: 'fillet', radius, ...(picks.at.length ? { at: picks.at } : {}), ...(picks.faces.length ? { faces: picks.faces } : {}), ...tangent, ...base }, sw.name);
    }

    function chamfer(sw: SwFeature, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        const type = num(d, 'Type') ?? 16;
        // Types are bit flags: 1 angle-distance, 2 distance-distance, 3 vertex, 16 equal distance.
        const t = (type & 16) || bool(d, 'EqualDistance') ? 16 : type & 15;
        if (t === 3) no('vertex chamfers are not in the studio yet');
        const picks = edgeAndFacePicks(d, ['Edges', 'Loops'], ['Faces']);
        if (!picks.at.length && !picks.faces.length) no('its edges were not exported');
        const d1 = clean((num(d, 'GetEdgeChamferDistance(0)') ?? 0) * MM);
        const d2 = clean((num(d, 'GetEdgeChamferDistance(1)') ?? 0) * MM);
        const tangent = bool(d, 'TangentPropagation') ? { tangent: true } : {};
        const f: Record<string, unknown> = { op: 'chamfer', ...(picks.at.length ? { at: picks.at } : {}), ...(picks.faces.length ? { faces: picks.faces } : {}), ...tangent, ...base };
        if (t === 1) {
            const angle = clean(deg(num(d, 'EdgeChamferAngle') ?? 0));
            if (!(d1 > 0) || !(angle > 0 && angle < 90)) no('its distance or angle was not exported');
            f.size = d1;
            f.angle = angle;
            if (bool(d, 'GetIsFlipped')) notes.push(`${sw.name}: the chamfer is flipped in SolidWorks; check which face the distance is on`);
        } else if (t === 2 && Math.abs(d1 - d2) > 1e-9 && d2 > 0) {
            f.size = d1;
            f.distance2 = d2;
            notes.push(`${sw.name}: a chamfer of two distances; check which face each is on`);
        } else {
            if (!(d1 > 0)) no('its distance was not exported');
            f.size = d1;
        }
        push(f, sw.name);
    }

    function edgeAndFacePicks(d: Record<string, SwValue>, edgeKeys: string[], faceKeys: string[]): { at: Vec3[]; faces: FacePickRef[] } {
        const at: Vec3[] = [];
        const faces: FacePickRef[] = [];
        for (const key of edgeKeys) {
            for (const e of entities(d, key)) {
                if (e.kind === 'edge') at.push(pointOf(e)!);
                else if (e.kind === 'loop' && 'edges' in e) (e.edges as SwEntity[]).forEach((x) => x.kind === 'edge' && at.push(pointOf(x)!));
                else if (e.kind === 'face') faces.push(facePick(e)!);
            }
        }
        for (const key of faceKeys) {
            for (const e of entities(d, key)) {
                if (e.kind === 'face') faces.push(facePick(e)!);
            }
        }
        return { at: at.filter(Boolean), faces: faces.filter(Boolean) };
    }

    // ---- Holes ----------------------------------------------------------------------------------------------

    function holeWizard(sw: SwFeature, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        const t = num(d, 'Type');
        if (t === 3) no('tapered pipe tap holes are not in the studio yet');
        if (t === 5) no('legacy holes are not in the studio yet');
        if (t !== null && t >= 6) no('slot holes are not in the studio yet');
        const pts = entities(d, 'GetSketchPoints').filter((e) => e.kind === 'sketchPoint') as Extract<SwEntity, { kind: 'sketchPoint' }>[];
        if (!pts.length) no('its hole positions were not exported');
        // Of the Hole Wizard's two sketches, the one holding the hole points places them.
        const candidates = [...new Set([...(sw.subFeatures ?? []).filter((s) => s.type === 'ProfileFeature').map((s) => s.name), ...(sw.parents ?? [])])]
            .filter((name) => sketches.has(name));
        const posName = candidates.find((name) => pts.every((p) => sketches.get(name)!.mapped.points.has(p.id))) ?? candidates[0];
        if (!posName) no('its position sketch could not be read');
        const pos = { ...sketches.get(posName!)!, name: posName! };
        usedSketches.add(posName!);
        const first = (...keys: string[]): number => {
            for (const k of keys) {
                const v = num(d, k);
                if (v !== null && v > 0) return clean(v * MM);
            }
            return 0;
        };
        const end = num(d, 'EndCondition') ?? 0;
        const through = end === 1 || end === 9;
        if (!(end === 0 || through)) no('only blind and through all holes are rebuilt so far');
        const tap = t === 4;
        const diameter = tap ? first('TapDrillDiameter', 'ThruTapDrillDiameter', 'HoleDiameter', 'Diameter')
            : t === 0 || t === 1 ? first('ThruHoleDiameter', 'HoleDiameter', 'Diameter') : first('HoleDiameter', 'Diameter', 'ThruHoleDiameter');
        const depth = through ? sizeHint * 2 + 10 : tap ? first('TapDrillDepth', 'HoleDepth', 'Depth') : first('HoleDepth', 'ThruHoleDepth', 'Depth');
        if (!(diameter > 0) || !(depth > 0)) no('its diameter or depth was not exported');
        const r = diameter / 2;
        const above = 0.5;
        const profile: [number, number][] = [];
        if (t === 0) {
            const cb = first('CounterBoreDiameter') / 2;
            const cbDepth = first('CounterBoreDepth');
            if (!(cb > r) || !(cbDepth > 0)) no('its counterbore was not exported');
            profile.push([cb, above], [cb, -cbDepth], [r, -cbDepth]);
        } else if (t === 1) {
            const cs = first('CounterSinkDiameter') / 2;
            const angle = num(d, 'CounterSinkAngle') ?? Math.PI / 2;
            if (!(cs > r)) no('its countersink was not exported');
            const h = (cs - r) / Math.tan(angle / 2);
            profile.push([cs, above], [cs, 0], [r, -h]);
        } else {
            const near = bool(d, 'NearSideCounterSink') ? first('NearCounterSinkDiameter') / 2 : 0;
            if (near > r) {
                const h = (near - r) / Math.tan((num(d, 'NearCounterSinkAngle') ?? Math.PI / 2) / 2);
                profile.push([near, above], [near, 0], [r, -h]);
            } else {
                profile.push([r, above]);
            }
        }
        profile.push([r, -depth]);
        if (!through) {
            // The drill point at the bottom of a blind hole.
            const angle = num(d, 'DrillAngle') ?? (118 * Math.PI) / 180;
            if (angle > 0 && angle < Math.PI) profile.push([0, clean(-depth - r / Math.tan(angle / 2))]);
        }
        const n = pos.mapped.frame.normal;
        const o = pos.mapped.frame.origin;
        const seen = sideOfFaces(sw.faces ?? [], o, n, false);
        const ruled = bool(d, 'ReverseDirection') ? 1 : -1;
        const into = scale(n, seen ?? ruled);
        directionVotes.push(seen === null ? 'none' : seen === ruled ? 'agree' : 'disagree');
        const rotation = rotationTaking([0, -1, 0], into);
        pts.forEach((p, i) => {
            const at = pos.mapped.to3d([p.at[0] * MM, p.at[1] * MM]);
            push({
                op: 'cut', shape: { kind: 'lathe', profile: profile.map(([a, b]) => [clean(a), clean(b)] as [number, number]) },
                position: cleanV(at), rotation, ...base, name: i ? `${sw.name} (${i + 1})` : sw.name,
            }, sw.name);
        });
        if (pts.length > 1) notes.push(`${sw.name}: the Hole Wizard holes are ${pts.length} cuts, one per position`);
        if (tap) notes.push(`${sw.name}: tapped holes are cut at the tap drill size; the thread itself was cosmetic`);
    }

    function simpleHole(sw: SwFeature, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        const { id: sketchRef, mapped } = sketchFor(sw);
        const end = num(d, 'Type') ?? 0;
        const depth = clean((num(d, 'Depth') ?? 0) * MM);
        const seen = sideOfFaces(sw.faces ?? [], mapped.frame.origin, mapped.frame.normal, false);
        const sign = seen ?? (bool(d, 'ReverseDirection') ? 1 : -1);
        const f: Record<string, unknown> = { op: 'extrude', sketchRef, mode: 'cut', direction: sign > 0 ? 'normal' : 'reverse', ...base };
        if (end === 1) f.end = 'throughAll';
        else if (end === 2) f.end = 'upToNext';
        else if (end === 0 && depth > 0) Object.assign(f, { end: 'blind', distance: depth });
        else no(`end condition ${end} is not in the studio yet`);
        push(f, sw.name);
    }

    // ---- Patterns and mirrors -------------------------------------------------------------------------------

    /** The studio steps of the SolidWorks features a pattern or mirror repeats (only steps that add or cut). */
    function seeds(d: Record<string, SwValue>): string[] {
        const names = entities(d, 'PatternFeatureArray').filter((e) => e.kind === 'feature').map((e) => (e as { name: string }).name);
        if (!names.length) no('the features it repeats were not exported');
        const ids: string[] = [];
        for (const name of names) {
            const steps = made.get(name);
            if (!steps) no(`it repeats ${name}, which was not rebuilt`);
            ids.push(...steps!.filter((id) => ['extrude', 'revolve', 'cut', 'add', 'hole', 'loft', 'sweep'].includes(features.find((f) => f.id === id)?.op ?? '')));
        }
        if (!ids.length) no('the studio repeats only features that add or cut material');
        return ids;
    }

    function pattern(sw: SwFeature, type: string, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        if (bool(d, 'BodyPattern')) no('patterns of bodies are not in the studio yet');
        if (bool(d, 'VarySketch')) no('vary sketch is not in the studio yet');
        const featuresToRepeat = seeds(d);
        const transforms = new Map((sw.instances ?? []).map((i) => [i.instance, rigidOf(i.transform, convention)]));
        const skippedItems = Array.isArray(d.SkippedItemArray) ? (d.SkippedItemArray as SwValue[]).filter((x): x is number => typeof x === 'number') : [];
        if (type === 'LPattern') {
            const n1 = num(d, 'D1TotalInstances') ?? 0;
            const two = !!bool(d, 'IsDirection2Specified');
            const n2 = two ? num(d, 'D2TotalInstances') ?? 0 : 1;
            const step = (a: number, b: number): Vec3 | null => {
                const ta = transforms.get(a);
                const tb = transforms.get(b);
                return ta && tb ? sub(tb.t, ta.t) : null;
            };
            const v1 = step(1, 2) ?? fallbackStep(d, 'D1Axis', 'D1Spacing', 'D1ReverseDirection');
            if (!v1 || !(n1 >= 2)) no('its direction or count was not exported');
            const f: Record<string, unknown> = {
                op: 'pattern', kind: 'linear', features: featuresToRepeat, count: n1, direction: cleanV(unit(v1!)), spacing: clean(norm(v1!)), ...base,
            };
            if (two && n2 >= 2) {
                const v2 = step(n1 + 1, n1 + 2) ?? fallbackStep(d, 'D2Axis', 'D2Spacing', 'D2ReverseDirection');
                if (!v2) no('its second direction was not exported');
                Object.assign(f, { direction2: cleanV(unit(v2!)), spacing2: clean(norm(v2!)), count2: n2, ...(bool(d, 'D2PatternSeedOnly') ? { seedOnly2: true } : {}) });
            }
            if (skippedItems.length) {
                f.skip = skippedItems.map((k) => [(k % n1) + 1, Math.floor(k / n1) + 1]);
                notes.push(`${sw.name}: skipped instances read as SolidWorks numbers them (row by row); check them`);
            }
            push(f, sw.name);
            return;
        }
        const count = num(d, 'TotalInstances') ?? 0;
        if (!(count >= 2)) no('its count was not exported');
        const second = transforms.get(2);
        let axis: AxisRef;
        let angle: number;
        if (second) {
            const r = rotationAxis(second);
            if (!r) no('its instances do not turn about an axis');
            axis = { fixedAxis: { point: cleanV(r!.point), direction: cleanV(r!.direction) } };
            angle = clean(r!.angle);
        } else {
            const e = entities(d, 'Axis')[0];
            if (!e) no('its axis was not exported');
            axis = axisOf(e);
            const spacing = deg(num(d, 'Spacing') ?? 0);
            angle = clean(bool(d, 'EqualSpacing') ? (spacing >= 360 - 1e-9 ? 360 / count : spacing / (count - 1)) : spacing);
            if (bool(d, 'ReverseDirection')) angle = -angle;
        }
        const f: Record<string, unknown> = { op: 'pattern', kind: 'circular', features: featuresToRepeat, axis, count, angle: Math.abs(angle), equal: false, ...(angle < 0 ? { reverse: true } : {}), ...base };
        if (skippedItems.length) f.skip = skippedItems.map((k) => [k + 1, 1]);
        push(f, sw.name);
    }

    function fallbackStep(d: Record<string, SwValue>, axisKey: string, spacingKey: string, reverseKey: string): Vec3 | null {
        const e = entities(d, axisKey)[0];
        const spacing = (num(d, spacingKey) ?? 0) * MM;
        if (!e || !(spacing > 0)) return null;
        let dir: Vec3 | null = null;
        if (e.kind === 'edge' && 'params' in e && e.curve === 'line' && e.params) dir = unit(v3(e.params.slice(3, 6)));
        else if (e.kind === 'edge' && 'start' in e && e.start && e.end) dir = unit(sub(mm(e.end), mm(e.start)));
        else if (e.kind === 'refAxis' && 'params' in e && e.params) dir = unit(sub(mm(e.params.slice(3, 6)), mm(e.params.slice(0, 3))));
        else if (e.kind === 'feature' && 'name' in e && axes.has(e.name)) dir = axes.get(e.name)!.direction;
        if (!dir) return null;
        return scale(dir, spacing * (bool(d, reverseKey) ? -1 : 1));
    }

    function mirrorFeatures(sw: SwFeature, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        if (entities(d, 'MirrorFaceArray').length && !entities(d, 'PatternFeatureArray').length) no('mirroring faces is not in the studio yet');
        const plane = planeRefOf(entities(d, 'Plane')[0]);
        push({ op: 'mirror', plane, features: seeds(d), ...base }, sw.name);
    }

    function mirrorBody(sw: SwFeature, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (d && bool(d, 'Merge') === false) no('a mirror kept as a separate body is not in the studio yet');
        const x = rigidOf(sw.transform, convention);
        let plane: PlaneRef | null = null;
        if (x) {
            // A reflection: the plane is halfway between a point and its image.
            const probes: Vec3[] = [[0, 0, 0], [1000, 0, 0], [0, 1000, 0], [0, 0, 1000]];
            const moved = probes.map((p) => ({ p, q: add([x.r[0][0] * p[0] + x.r[0][1] * p[1] + x.r[0][2] * p[2], x.r[1][0] * p[0] + x.r[1][1] * p[1] + x.r[1][2] * p[2], x.r[2][0] * p[0] + x.r[2][1] * p[1] + x.r[2][2] * p[2]], x.t) }));
            const best = moved.reduce((a, b) => (norm(sub(b.q, b.p)) > norm(sub(a.q, a.p)) ? b : a));
            if (norm(sub(best.q, best.p)) > 1e-6) {
                const normal = unit(sub(best.q, best.p));
                const origin = scale(add(best.p, best.q), 0.5);
                plane = fixedPlane(origin, normal);
            }
        }
        if (!plane) plane = planeRefOf(entities(d, 'Face')[0]);
        push({ op: 'mirror', plane, ...base }, sw.name);
    }

    function planeRefOf(e: SwEntity | undefined): PlaneRef {
        if (!e) no('its plane was not exported');
        if (e!.kind === 'feature' && 'name' in e! && planes.has(e!.name)) return planes.get(e!.name)!.ref;
        if ((e!.kind === 'feature' || e!.kind === 'refPlane') && 'transform' in e! && e!.transform) {
            const x = rigidOf(e!.transform, convention);
            if (x) {
                const f = frameOf(x);
                return { fixedPlane: { origin: cleanV(f.origin), normal: cleanV(unit(f.z)), xDir: cleanV(unit(f.x)) } };
            }
        }
        if (e!.kind === 'face') {
            const at = pointOf(e!);
            const normal = normalOf(e!);
            if (at && normal && (!('surface' in e!) || e!.surface === 'plane')) return fixedPlane(at, normal);
        }
        return no('its plane is not one the studio can use');
    }

    // ---- Shell, loft, sweep, draft --------------------------------------------------------------------------

    function shell(d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }, sw: SwFeature): void {
        if (!d) no('the export holds no feature data');
        if ((num(d, 'GetMultipleThicknessFacesCount') ?? 0) > 0 || entities(d, 'MultipleThicknessFaces').length) no('shells with faces of other thicknesses are not in the studio yet');
        const thickness = clean((num(d, 'Thickness') ?? 0) * MM);
        if (!(thickness > 0)) no('its thickness was not exported');
        const remove = entities(d, 'FacesRemoved').filter((e) => e.kind === 'face').map(facePick).filter((p): p is FacePickRef => !!p);
        push({ op: 'shell', thickness, ...(remove.length ? { remove } : {}), ...(bool(d, 'Direction') ? { outward: true } : {}), ...base }, sw.name);
    }

    function loft(sw: SwFeature, type: string, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        if (bool(d, 'IsThinFeature')) no('thin features are not in the studio yet');
        if (entities(d, 'GuideCurves').length || (num(d, 'GetGuideCurvesCount') ?? 0) > 0) no('lofts with guide curves are not in the studio yet');
        if (entities(d, 'Centerline').length) no('lofts along a centreline are not in the studio yet');
        if ((num(d, 'StartTangencyType') ?? 0) !== 0 || (num(d, 'EndTangencyType') ?? 0) !== 0) no('lofts with start or end constraints are not in the studio yet');
        const profiles = entities(d, 'Profiles');
        const sections = profiles.map((e) => {
            if (e.kind !== 'feature' || !('name' in e) || !sketches.has(e.name)) no('a loft profile is not a sketch the studio could read');
            usedSketches.add((e as { name: string }).name);
            return { sketchRef: sketches.get((e as { name: string }).name)!.id };
        });
        if (sections.length < 2) no('its profiles were not exported');
        const boss = bool(d, 'IsBossFeature') ?? type === 'Blend';
        push({ op: 'loft', sections, mode: boss ? 'add' : 'cut', ...(bool(d, 'Close') ? { closed: true } : {}), ...base }, sw.name);
        notes.push(`${sw.name}: loft sections are joined from their first points; check the result for twist`);
    }

    function sweep(sw: SwFeature, type: string, d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }): void {
        if (!d) no('the export holds no feature data');
        if (bool(d, 'IsThinFeature')) no('thin features are not in the studio yet');
        if (entities(d, 'GuideCurves').length || (num(d, 'GetGuideCurvesCount') ?? 0) > 0) no('sweeps with guide curves are not in the studio yet');
        if ((num(d, 'TwistControlType') ?? 0) !== 0) no('sweeps with twist control are not in the studio yet');
        const sketchOf = (e: SwEntity | undefined, what: string): string => {
            if (!e || e.kind !== 'feature' || !('name' in e) || !sketches.has(e.name)) no(`its ${what} is not a sketch the studio could read`);
            usedSketches.add((e as { name: string }).name);
            return sketches.get((e as { name: string }).name)!.id;
        };
        const profile = sketchOf(entities(d, 'Profile')[0], 'profile');
        const path = sketchOf(entities(d, 'Path')[0], 'path');
        const boss = bool(d, 'IsBossFeature') ?? type === 'Sweep';
        push({ op: 'sweep', profile: { sketchRef: profile }, path: { sketchRef: path }, mode: boss ? 'add' : 'cut', ...base }, sw.name);
    }

    function draft(d: Record<string, SwValue> | null, base: { name: string; suppressed?: boolean }, sw: SwFeature): void {
        if (!d) no('the export holds no feature data');
        if ((num(d, 'Type') ?? 0) !== 0) no('parting line and step drafts are not in the studio yet');
        const angle = clean(deg(num(d, 'Angle') ?? 0));
        const picked = entities(d, 'FacesToDraft').filter((e) => e.kind === 'face').map(facePick).filter((p): p is FacePickRef => !!p);
        if (!(angle > 0) || !picked.length) no('its angle or faces were not exported');
        const neutral = entities(d, 'NeutralPlane')[0];
        const f: Record<string, unknown> = { op: 'draft', angle, picked, ...base };
        if (neutral?.kind === 'face') f.neutralFace = facePick(neutral);
        else f.neutral = planeRefOf(neutral);
        if (bool(d, 'ReverseDirection')) f.flip = true;
        if ((num(d, 'FacePropagation') ?? 0) === 1) f.tangent = true;
        push(f, sw.name);
        notes.push(`${sw.name}: check the pull direction of the draft`);
    }

    // ---- Shared ---------------------------------------------------------------------------------------------

    function axisOf(e: SwEntity): AxisRef {
        if (e.kind === 'feature' && 'name' in e && axes.has(e.name)) return { axisRef: axes.get(e.name)!.id };
        if (e.kind === 'refAxis' && 'params' in e && e.params) {
            const a = mm(e.params.slice(0, 3));
            return { fixedAxis: { point: cleanV(a), direction: cleanV(unit(sub(mm(e.params.slice(3, 6)), a))) } };
        }
        if (e.kind === 'edge' && 'curve' in e && e.curve === 'line' && e.params) {
            return { fixedAxis: { point: cleanV(mm(e.params.slice(0, 3))), direction: cleanV(unit(v3(e.params.slice(3, 6)))) } };
        }
        if (e.kind === 'face' && 'surface' in e && (e.surface === 'cylinder' || e.surface === 'cone') && e.params) {
            return { fixedAxis: { point: cleanV(mm(e.params.slice(0, 3))), direction: cleanV(unit(v3(e.params.slice(3, 6)))) } };
        }
        return no('its axis is not one the studio can use');
    }

    function contourPicks(d: Record<string, SwValue>, mapped: MappedSketch): [number, number][] | undefined {
        const contours = entities(d, 'Contours');
        if (!contours.length) return undefined;
        const regions = mapped.sketch.regions ?? [];
        const picks: [number, number][] = [];
        for (const c of contours) {
            if (c.kind !== 'contour' || !('segments' in c)) no('a selected sketch region could not be identified');
            const ids = new Set((c as { segments: string[] }).segments);
            // The areas whose outline is made of the contour's curves; else the areas inside it.
            let hits = mapped.loops.faces.map((f, i) => ({ f, i })).filter(({ f }) => f.pieces.every((p) => ids.has(p.piece.id)));
            if (!hits.length) {
                const outline = mapped.loops.outlines.find((o) => o.pieces.every((p) => ids.has(p.piece.id)));
                if (outline) hits = mapped.loops.faces.map((f, i) => ({ f, i })).filter(({ i }) => regions[i] && inside(regions[i].at as P2, outline.polygon));
            }
            if (!hits.length) no('a selected contour could not be matched to an area of its sketch');
            for (const { i } of hits) {
                if (regions[i]) picks.push([clean(regions[i].at[0]), clean(regions[i].at[1])]);
            }
        }
        return picks.length ? picks : undefined;
    }

    /** Planar faces cut away later are not in the export: the end is found from the reference, else from a cap face. */
    function upToDistance(sw: SwFeature, which: number, cond: number, depth: number, o: Vec3, n: Vec3, dirSign: number): number | null {
        const ref = sw.ends?.[which]?.reference ?? null;
        let along: number | null = null;
        if (ref?.kind === 'vertex') {
            along = dot(sub(pointOf(ref)!, o), n);
        } else if (ref && (ref.kind === 'face' || ref.kind === 'feature' || ref.kind === 'refPlane')) {
            if (ref.kind === 'face') {
                const p = pointOf(ref);
                const fn = normalOf(ref);
                if (!p || !fn || ('surface' in ref && ref.surface !== 'plane') || Math.abs(Math.abs(dot(fn, n)) - 1) > 1e-9) return null;
                along = dot(sub(p, o), n);
            } else {
                const x = rigidOf('transform' in ref ? ref.transform : null, convention);
                if (!x) return null;
                const f = frameOf(x);
                if (Math.abs(Math.abs(dot(unit(f.z), n)) - 1) > 1e-9) return null;
                along = dot(sub(f.origin, o), n);
            }
        } else {
            // No reference: the farthest flat face of the feature parallel to the sketch, on its side.
            for (const face of sw.faces ?? []) {
                const p = pointOf(face);
                const fn = normalOf(face);
                if (!p || !fn || ('surface' in face && face.surface !== 'plane') || Math.abs(Math.abs(dot(fn, n)) - 1) > 1e-9) continue;
                const s = dot(sub(p, o), n);
                if (s * dirSign > 1e-9 && (along === null || Math.abs(s) > Math.abs(along))) along = s;
            }
            if (along === null) return null;
            const reach = clean(Math.abs(along));
            return reach > 0 ? reach : null;
        }
        if (cond === 5) {
            along -= Math.sign(along) * depth;
        }
        const reach = clean(along * dirSign);
        return reach > 0 ? reach : null;
    }
}

/** Features that change the solid when they work (the rest are references, sketches and annotations). */
function solidKind(type: string): boolean {
    return !['RefPlane', 'RefAxis', 'RefPoint', 'ProfileFeature', '3DProfileFeature', 'CosmeticThread', 'FtrFolder'].includes(type) && !IGNORED.has(type);
}

function sameFrame(a: SketchFrame3, b: SketchFrame3): boolean {
    const close = (x: Vec3, y: Vec3, tol: number) => norm(sub(x, y)) < tol;
    return close(a.origin, b.origin, 1e-6) && close(a.x, b.x, 1e-9) && close(a.normal, b.normal, 1e-9);
}

function fixedPlane(origin: Vec3, normal: Vec3): PlaneRef {
    const n = unit(normal);
    const x = Math.abs(n[1]) < 0.9 ? unit(cross([0, 1, 0], n)) : unit(cross(n, [1, 0, 0]));
    return { fixedPlane: { origin: cleanV(origin), normal: cleanV(n), xDir: cleanV(x) } };
}

/**
 * Which side of the sketch plane a feature's faces lie on: +1 along the normal, -1 against it, null when they do
 * not say (none away from the plane, or both sides for a feature that goes both ways).
 */
function sideOfFaces(faces: SwEntity[], origin: Vec3, normal: Vec3, both: boolean): 1 | -1 | null {
    if (both) return null;
    let plus = 0;
    let minus = 0;
    for (const f of faces) {
        const box = 'box' in f && Array.isArray(f.box) && f.box.length >= 6 ? f.box : null;
        const pts: Vec3[] = box ? [mm(box.slice(0, 3)), mm(box.slice(3, 6))] : pointOf(f) ? [pointOf(f)!] : [];
        const p = pointOf(f);
        if (p) pts.push(p);
        for (const q of pts) {
            const s = dot(sub(q, origin), normal);
            if (s > 1e-4) plus++;
            else if (s < -1e-4) minus++;
        }
    }
    if (plus && !minus) return 1;
    if (minus && !plus) return -1;
    if (plus > 3 * minus) return 1;
    if (minus > 3 * plus) return -1;
    return null;
}

/** The rotation of a circular pattern's instance: its axis (through a point), and the angle in degrees about it. */
function rotationAxis(x: { r: [Vec3, Vec3, Vec3]; t: Vec3 }): { point: Vec3; direction: Vec3; angle: number } | null {
    const [[a, b, c], [d, e, f], [g, h, i]] = x.r;
    const cos = (a + e + i - 1) / 2;
    const axis: Vec3 = [h - f, c - g, d - b];
    const s = norm(axis) / 2;
    if (!(s > 1e-9)) return null;
    const direction = unit(axis);
    const angle = (Math.atan2(s, cos) * 180) / Math.PI;
    // A point on the axis: (I - R) p = t, solved in the plane across the axis (least squares through the normal equations).
    const m: [Vec3, Vec3, Vec3] = [[1 - a, -b, -c], [-d, 1 - e, -f], [-g, -h, 1 - i]];
    const mt = (u: Vec3, k: number) => u[k];
    const ata: number[][] = [0, 1, 2].map((r) => [0, 1, 2].map((q) => m.reduce((sum, row) => sum + mt(row, r) * mt(row, q), 0)));
    const atb = [0, 1, 2].map((r) => m.reduce((sum, row, k) => sum + mt(row, r) * x.t[k], 0));
    // Add the axis direction as a constraint (p . dir = 0) to make the system regular.
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) ata[r][q] += direction[r] * direction[q];
    const det = (M: number[][]) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const D = det(ata);
    if (Math.abs(D) < 1e-12) return null;
    const col = (k: number) => ata.map((row, r) => row.map((v, q) => (q === k ? atb[r] : v)));
    const point: Vec3 = [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
    return { point, direction, angle };
}

/** Euler XYZ degrees (as Part.rotation and placed steps use them) turning `from` onto `to`. */
function rotationTaking(from: Vec3, to: Vec3): Vec3 {
    const q = new Quaternion().setFromUnitVectors(new Vector3(...from).normalize(), new Vector3(...to).normalize());
    const e = new Euler().setFromQuaternion(q, 'XYZ');
    return [e.x, e.y, e.z].map((r) => clean((r * 180) / Math.PI)) as Vec3;
}

function boxSize(doc: SwDocument): number {
    const b = doc.box ?? doc.tessBox;
    if (!b) return 1000;
    return norm(sub(mm(b.max), mm(b.min)));
}

function pruneFolders(folders: FeatureFolder[], kept: Set<string>): FeatureFolder[] {
    const ids = new Set(folders.map((f) => f.id));
    let live = folders.map((f) => ({ ...f, items: f.items.filter((i) => kept.has(i) || ids.has(i)) }));
    // Empty folders go (repeatedly: a folder holding only empty folders is empty too).
    for (;;) {
        const empty = new Set(live.filter((f) => !f.items.length).map((f) => f.id));
        if (!empty.size) break;
        live = live.filter((f) => !empty.has(f.id)).map((f) => ({ ...f, items: f.items.filter((i) => !empty.has(i)) }));
    }
    return live;
}
