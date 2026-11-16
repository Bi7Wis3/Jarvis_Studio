// The .jarvis-sw.json files that tools/solidworks/JarvisHistoryExport.vbs writes: a SolidWorks part's feature history
// (or an assembly's components and mates) as the SolidWorks API gives it, in SolidWorks system units (metres, radians,
// kilograms). Transforms are MathTransform.ArrayData: 9 rotation, 3 translation, 1 scale, 3 unused. The exporter only
// reads; everything here is interpreted by the importer (features.ts, sketch.ts), so a mistake in reading a value is
// fixed here without running the exporter again.

export type V3 = [number, number, number];

export interface SwBox {
    min: V3;
    max: V3;
}

export interface SwMass {
    volume: number;
    area: number;
    centre: V3;
    mass?: number;
    density?: number;
}

/** A face, edge, vertex, feature or sketch item a feature uses, as the exporter could describe it. */
export type SwEntity =
    | { kind: 'face'; point: V3; normal: V3; surface?: string; params?: number[] | null; box?: number[] | null }
    | { kind: 'edge'; point: V3; start?: V3 | null; end?: V3 | null; curve?: string; params?: number[] | null }
    | { kind: 'vertex'; point: V3 }
    | { kind: 'feature'; name: string; type: string; transform?: number[] | null }
    | { kind: 'refPlane'; transform: number[] | null }
    | { kind: 'refAxis'; params: number[] | null }
    | { kind: 'refPoint'; at: number[] | null }
    | { kind: 'loop'; edges: SwEntity[] }
    | { kind: 'contour'; segments: string[]; toSketch?: number[] | null }
    | { kind: 'sketchPoint'; id: string; at: V3 }
    | { kind: 'sketchSegment'; id: string }
    | { kind: 'component'; name: string }
    | { kind: 'body'; name: string }
    | { kind: string; typeName?: string };

export type SwValue = number | boolean | string | null | SwEntity | SwValue[];

export interface SwSketchPoint {
    id: string;
    x: number;
    y: number;
    z?: number;
    /** swSketchPointType_e: 8 the sketch origin. */
    type?: number;
}

export interface SwSplineData {
    dimension: number;
    order: number;
    count: number;
    periodic?: number;
    controlPoints: number[] | null;
    knots: number[] | null;
}

export interface SwSegment {
    id: string;
    /** swSketchSegments_e: 0 line, 1 arc, 2 ellipse, 3 spline, 4 text, 5 parabola. */
    type: number;
    kind: 'line' | 'arc' | 'ellipse' | 'spline' | 'parabola' | 'text' | 'unknown';
    construction: boolean;
    length?: number | null;
    start?: string | null;
    end?: string | null;
    centre?: string | null;
    infinite?: boolean;
    radius?: number | null;
    /** GetRotationDir: 1 or -1 (see sketch.ts for how the importer settles the direction). */
    dir?: number | null;
    circle?: boolean;
    normal?: number[] | null;
    major?: string | null;
    minor?: string | null;
    points?: (string | null)[];
    bspline?: SwSplineData | null;
    focus?: string | null;
    apex?: string | null;
}

export interface SwRelationEntity {
    /** swSketchRelationEntityTypes_e: 2 point, 3 line, 4 arc, 5 ellipse, 6 parabola, 7 spline, 10 plane, ... */
    type: number;
    ref?: string | null;
    entity?: SwEntity | null;
}

export interface SwRelation {
    /** swConstraintType_e. */
    type: number;
    suppressed?: boolean;
    entities: SwRelationEntity[];
    /** For dimensions: value in m or rad, swDimensionType_e, swDimensionDrivenState_e (1 driven, 2 driving). */
    dimension?: { value: number | null; type: number | null; driven: number | null; name?: string | null };
}

export interface SwSketch {
    is3d: boolean;
    /** ModelToSketchTransform: model to sketch coordinates. */
    toSketch: number[] | null;
    segments: SwSegment[];
    relations: SwRelation[];
    /** The closed contours, each its segment ids. */
    contours: string[][];
    points: SwSketchPoint[];
}

export interface SwAfter {
    volume: number | null;
    area: number | null;
    bodies: number;
    box?: SwBox | null;
}

export interface SwFeature {
    name: string;
    /** GetTypeName2: Extrusion, ICE (Instant3D: see baseType), Cut, ProfileFeature, RefPlane, Fillet, FtrFolder, ... */
    type: string;
    /** GetTypeName, when it differs (the real type of an Instant3D feature). */
    baseType?: string;
    id?: number;
    suppressed: boolean;
    parents?: string[];
    subFeatures?: { name: string; type: string }[];
    /** Volume, area and bodies of the part with the rollback bar just after this feature. */
    after?: SwAfter;
    sketch?: SwSketch | null;
    plane?: { transform: number[] | null };
    axis?: { params: number[] | null };
    point?: { at: number[] | null };
    /** The feature data's values by their API names, e.g. "GetDepth(True)", "Edges". */
    data?: Record<string, SwValue> | null;
    /** Extrudes: the reference of each direction's end (up to vertex, surface, body). */
    ends?: { condition: number | null; reference: SwEntity | null }[];
    /** Faces the feature made, as found in the finished part. */
    faces?: SwEntity[];
    /** Multiple-radius fillets: each item and its radius. */
    items?: { entity: SwEntity | null; radius: number | null }[];
    /** Patterns: each instance's transform. */
    instances?: { instance: number; transform: number[] | null }[];
    /** Mirror bodies: the mirror transform. */
    transform?: number[] | null;
    errors?: string[];
}

export interface SwComponent {
    /** Name2: Part1-1, or sub-1/Part1-1 inside a subassembly. */
    name: string;
    /** The file, relative to the assembly's folder when it is inside it, else the full path. */
    file: string;
    path: string;
    configuration?: string;
    /** swComponentSuppressionState_e: 0 suppressed, 1 lightweight, 2 fully resolved, 3 resolved, 4 fully lightweight. */
    suppression?: number;
    suppressed?: boolean;
    fixed?: boolean;
    visible?: number;
    excludeFromBOM?: boolean;
    virtual?: boolean;
    /** Transform2: component to assembly (the root), ArrayData. */
    transform: number[] | null;
    children: SwComponent[];
}

export interface SwMate {
    name: string;
    featureType?: string;
    suppressed: boolean;
    /** swMateType_e: 0 coincident, 1 concentric, 2 perpendicular, 3 parallel, 4 tangent, 5 distance, 6 angle, ... */
    type?: number;
    /** swMateAlign_e: 0 aligned, 1 anti-aligned, 2 closest. */
    alignment?: number;
    flipped?: boolean;
    value?: number | null;
    min?: number | null;
    max?: number | null;
    /** EntityParams in the assembly's space: point (3), vector (3), radius 1, radius 2. */
    entities?: { referenceType: number | null; component?: string; params: number[] | null }[];
    errors?: string[];
}

export interface SwDocument {
    format: 'jarvis-sw-history';
    version: number;
    kind: 'part' | 'assembly';
    units?: Record<string, string>;
    exporter?: { script?: string; version?: string; solidworks?: string; date?: string };
    document: { file: string; path: string; title?: string; configuration?: string };
    mass: SwMass | null;
    /** SolidWorks' own box (it encloses the solid, sometimes loosely). */
    box: SwBox | null;
    /** The box of the display triangles: inside the true box. */
    tessBox?: SwBox | null;
    bodies?: { name: string; type?: number; volume?: number; area?: number; centre?: V3; box?: SwBox | null; tessBox?: SwBox | null }[];
    features?: SwFeature[];
    components?: SwComponent[];
    mates?: SwMate[];
    log?: string[];
}

/** File name suffix of the exporter's files. */
export const SW_HISTORY_SUFFIX = '.jarvis-sw.json';

/** True for a .jarvis-sw.json file name. */
export const isSwHistoryName = (name: string): boolean => name.toLowerCase().endsWith(SW_HISTORY_SUFFIX);

/** Reads and checks a .jarvis-sw.json file. */
export function parseSwDocument(bytes: Uint8Array | string): SwDocument {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8').decode(bytes);
    let doc: unknown;
    try {
        doc = JSON.parse(text.replace(/^﻿/, ''));
    } catch (error) {
        throw new Error(`not a valid .jarvis-sw.json file (${error instanceof Error ? error.message : String(error)})`);
    }
    const d = doc as Partial<SwDocument>;
    if (!d || typeof d !== 'object' || d.format !== 'jarvis-sw-history') {
        throw new Error('not a file written by the SolidWorks history export (JarvisHistoryExport.vbs)');
    }
    if (typeof d.version !== 'number' || d.version > 1) {
        throw new Error(`written by a newer version of the export (format ${String(d.version)}); update Jarvis Studio`);
    }
    if (d.kind !== 'part' && d.kind !== 'assembly') {
        throw new Error(`unknown document kind "${String(d.kind)}"`);
    }
    if (!d.document || typeof d.document.file !== 'string') {
        throw new Error('the file does not say which SolidWorks document it describes');
    }
    return { ...d, mass: d.mass ?? null, box: d.box ?? null } as SwDocument;
}
