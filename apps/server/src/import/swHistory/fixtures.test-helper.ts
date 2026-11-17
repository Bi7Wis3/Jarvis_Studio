// Builds .jarvis-sw.json documents exactly as tools/solidworks/JarvisHistoryExport.vbs writes them (SolidWorks system
// units, MathTransform.ArrayData in SolidWorks' row layout), for small parts whose volume is known. The files in
// fixtures/ are these documents; swHistory.test.ts checks they stay in step.

import type { SwDocument, SwEntity, SwFeature, SwRelation, SwSegment, SwSketch, SwSketchPoint, V3 } from './format.js';

const M = 0.001;
type Axes = { x: V3; y: V3; z: V3 };
export const FRONT: Axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export const TOP: Axes = { x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0] };
export const RIGHT: Axes = { x: [0, 0, -1], y: [0, 1, 0], z: [1, 0, 0] };

const d3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A plane's transform (plane to model): the rows are where its axes go, then its origin (mm in, m out). */
export function planeTransform(axes: Axes, originMm: V3 = [0, 0, 0]): number[] {
    const o = originMm.map((v) => v * M);
    return [...axes.x, ...axes.y, ...axes.z, ...o, 1, 0, 0, 0];
}

/** ModelToSketchTransform (model to sketch) of a sketch with these axes and origin (mm). */
export function toSketchTransform(axes: Axes, originMm: V3 = [0, 0, 0]): number[] {
    const o = originMm.map((v) => v * M) as V3;
    const { x, y, z } = axes;
    return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2], -d3(o, x), -d3(o, y), -d3(o, z), 1, 0, 0, 0];
}

/** A transform turning about Y by `degrees` and moving by `moveMm` (a component placed in an assembly). */
export function turnY(degrees: number, moveMm: V3): number[] {
    const a = (degrees * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Rows: where x, y and z go (right-handed turn about +Y).
    return [c, 0, -s, 0, 1, 0, s, 0, c, ...moveMm.map((v) => v * M), 1, 0, 0, 0];
}

export class SketchBuilder {
    private points: SwSketchPoint[] = [];
    private segments: SwSegment[] = [];
    private relations: SwRelation[] = [];
    private n = 10;

    point(x: number, y: number, type = 1): string {
        const id = `p${this.n++}_0`;
        this.points.push({ id, x: x * M, y: y * M, z: 0, type });
        return id;
    }

    private at(id: string): [number, number] {
        const p = this.points.find((q) => q.id === id)!;
        return [p.x / M, p.y / M];
    }

    line(a: string, b: string, construction = false): string {
        const id = `s0_${this.n++}_0`;
        const [pa, pb] = [this.at(a), this.at(b)];
        this.segments.push({ id, type: 0, kind: 'line', construction, length: Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) * M, start: a, end: b, infinite: false });
        return id;
    }

    circle(cx: number, cy: number, r: number): { id: string; centre: string } {
        const centre = this.point(cx, cy);
        const id = `s1_${this.n++}_0`;
        this.segments.push({ id, type: 1, kind: 'arc', construction: false, length: 2 * Math.PI * r * M, start: null, end: null, centre, radius: r * M, dir: 1, circle: true, normal: [0, 0, 1] });
        return { id, centre };
    }

    relation(type: number, refs: { type: number; ref: string }[], dimension?: { value: number; type: number; driven?: boolean }): void {
        this.relations.push({
            type, suppressed: false, entities: refs,
            ...(dimension ? { dimension: { value: dimension.value, type: dimension.type, driven: dimension.driven ? 1 : 2, name: `D${this.relations.length + 1}` } } : {}),
        });
    }

    /** A rectangle centred at (cx, cy), with horizontal and vertical relations and its width and height dimensioned. */
    rect(cx: number, cy: number, w: number, h: number): string[] {
        const p = [this.point(cx - w / 2, cy - h / 2), this.point(cx + w / 2, cy - h / 2), this.point(cx + w / 2, cy + h / 2), this.point(cx - w / 2, cy + h / 2)];
        const l = [this.line(p[0], p[1]), this.line(p[1], p[2]), this.line(p[2], p[3]), this.line(p[3], p[0])];
        this.relation(4, [{ type: 3, ref: l[0] }]);
        this.relation(5, [{ type: 3, ref: l[1] }]);
        this.relation(4, [{ type: 3, ref: l[2] }]);
        this.relation(5, [{ type: 3, ref: l[3] }]);
        this.relation(1, [{ type: 3, ref: l[0] }], { value: w * M, type: 2 });
        this.relation(1, [{ type: 3, ref: l[1] }], { value: h * M, type: 2 });
        return l;
    }

    /** An arc counter-clockwise from `start` to `end` (point ids) about a new centre point. */
    arc(cx: number, cy: number, start: string, end: string): string {
        const centre = this.point(cx, cy);
        const [s, e] = [this.at(start), this.at(end)];
        const r = Math.hypot(s[0] - cx, s[1] - cy);
        let sweep = Math.atan2(e[1] - cy, e[0] - cx) - Math.atan2(s[1] - cy, s[0] - cx);
        while (sweep <= 0) sweep += 2 * Math.PI;
        const id = `s1_${this.n++}_0`;
        this.segments.push({ id, type: 1, kind: 'arc', construction: false, length: r * sweep * M, start, end, centre, radius: r * M, dir: 1, circle: false, normal: [0, 0, 1] });
        return id;
    }

    /** A closed outline of lines and arcs: each item a corner point, or an arc's centre to the next corner. */
    outline(items: ({ at: [number, number] } | { arc: [number, number] })[]): void {
        const corners = items.filter((i): i is { at: [number, number] } => 'at' in i).map((i) => this.point(i.at[0], i.at[1]));
        let k = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if ('arc' in item) continue;
            const from = corners[k];
            const to = corners[(k + 1) % corners.length];
            const next = items[(i + 1) % items.length];
            if ('arc' in next) this.arc(next.arc[0], next.arc[1], from, to);
            else this.line(from, to);
            k++;
        }
    }

    diameter(circle: { id: string }, d: number): void {
        this.relation(15, [{ type: 4, ref: circle.id }], { value: d * M, type: 6 });
    }

    sketch(axes: Axes, originMm: V3 = [0, 0, 0]): SwSketch {
        return { is3d: false, toSketch: toSketchTransform(axes, originMm), segments: this.segments, relations: this.relations, contours: [], points: this.points };
    }
}

/** What every SolidWorks part starts with: folders, the three planes, the origin. */
function standardTree(): SwFeature[] {
    const folder = (type: string, name: string): SwFeature => ({ name, type, id: 0, suppressed: false });
    const plane = (name: string, axes: Axes, id: number): SwFeature => ({
        name, type: 'RefPlane', id, suppressed: false, parents: [], subFeatures: [], plane: { transform: planeTransform(axes) },
        data: { object: 'IRefPlaneFeatureData', Type: 0, Type2: 0 }, errors: [],
    });
    return [
        folder('CommentsFolder', 'Comments'), folder('FavoriteFolder', 'Favorites'), folder('HistoryFolder', 'History'),
        folder('SensorFolder', 'Sensors'), folder('DetailCabinet', 'Annotations'), folder('SolidBodyFolder', 'Solid Bodies'),
        folder('MaterialFolder', 'Material <not specified>'),
        plane('Front Plane', FRONT, 1), plane('Top Plane', TOP, 2), plane('Right Plane', RIGHT, 3), folder('OriginProfileFeature', 'Origin'),
    ];
}

function doc(file: string, features: SwFeature[], volumeMm3: number, box: [V3, V3]): SwDocument {
    return {
        format: 'jarvis-sw-history', version: 1, kind: 'part',
        units: { length: 'm', angle: 'rad', area: 'm^2', volume: 'm^3', mass: 'kg' },
        exporter: { script: 'JarvisHistoryExport.vbs', version: '1.0', solidworks: '23.2.1', date: '2026-11-16 20:00:00' },
        document: { file, path: `Z:\\3D_Prints\\Fixtures\\${file}`, title: file, configuration: 'Default' },
        mass: { volume: volumeMm3 * 1e-9, area: 0, centre: [0, 0, 0], mass: volumeMm3 * 1e-9 * 1000, density: 1000 },
        box: { min: box[0].map((v) => v * M) as V3, max: box[1].map((v) => v * M) as V3 },
        tessBox: { min: box[0].map((v) => v * M) as V3, max: box[1].map((v) => v * M) as V3 },
        bodies: [{ name: 'Body1', type: 0, volume: volumeMm3 * 1e-9 }],
        features: [...standardTree(), ...features],
        log: ['Jarvis history export 1.0 (fixture written by fixtures.test-helper.ts)'],
    };
}

const sketchFeature = (name: string, sketch: SwSketch, parents: string[], id: number): SwFeature => ({
    name, type: 'ProfileFeature', id, suppressed: false, parents, subFeatures: [], sketch, errors: [],
});

const after = (mm3: number) => ({ volume: mm3 * 1e-9, area: null, bodies: 1 });

function extrudeData(o: { boss: boolean; end: number; depth?: number; end2?: number; depth2?: number; both?: boolean; reverse?: boolean }): Record<string, unknown> {
    return {
        object: 'IExtrudeFeatureData2', IsBossFeature: o.boss, IsThinFeature: false, BothDirections: !!o.both, ReverseDirection: !!o.reverse,
        FlipSideToCut: false, FromType: 0, FromOffsetDistance: 0, FromOffsetReverse: false, Merge: true,
        'GetEndCondition(True)': o.end, 'GetEndCondition(False)': o.end2 ?? 0, 'GetDepth(True)': (o.depth ?? 0) * M, 'GetDepth(False)': (o.depth2 ?? 0) * M,
        'GetDraftWhileExtruding(True)': false, 'GetDraftWhileExtruding(False)': false, 'GetDraftAngle(True)': 0, 'GetDraftAngle(False)': 0,
        'GetDraftOutward(True)': false, 'GetDraftOutward(False)': false, Contours: null, FeatureScopeBodies: null,
    };
}

const edge = (x: number, y: number, z: number): SwEntity => ({ kind: 'edge', point: [x * M, y * M, z * M], start: null, end: null, curve: 'line', params: null });

/** A 60 x 40 x 5 plate on the Top plane, two 6 mm holes cut through it, its four vertical edges rounded 2 mm. */
export function plateDoc(): SwDocument {
    const s1 = new SketchBuilder();
    s1.rect(0, 0, 60, 40);
    const s2 = new SketchBuilder();
    const h1 = s2.circle(-20, 0, 3);
    const h2 = s2.circle(20, 0, 3);
    s2.diameter(h1, 6);
    s2.diameter(h2, 6);
    const v1 = 60 * 40 * 5;
    const v2 = v1 - 2 * Math.PI * 9 * 5;
    const v3 = v2 - 4 * 5 * (4 - Math.PI);
    return doc('plate.SLDPRT', [
        sketchFeature('Sketch1', s1.sketch(TOP), ['Top Plane'], 20),
        { name: 'Boss-Extrude1', type: 'Extrusion', baseType: 'Extrusion', id: 21, suppressed: false, parents: ['Sketch1'], subFeatures: [{ name: 'Sketch1', type: 'ProfileFeature' }], after: after(v1), data: extrudeData({ boss: true, end: 0, depth: 5 }) as never, ends: [], faces: [], errors: [] },
        sketchFeature('Sketch2', s2.sketch(TOP, [0, 5, 0]), ['Boss-Extrude1'], 22),
        { name: 'Cut-Extrude1', type: 'ICE', baseType: 'Cut', id: 23, suppressed: false, parents: ['Sketch2'], subFeatures: [{ name: 'Sketch2', type: 'ProfileFeature' }], after: after(v2), data: extrudeData({ boss: false, end: 1 }) as never, ends: [], faces: [], errors: [] },
        {
            name: 'Fillet1', type: 'Fillet', id: 24, suppressed: false, parents: ['Cut-Extrude1'], subFeatures: [], after: after(v3),
            data: { object: 'ISimpleFilletFeatureData2', Type: 0, DefaultRadius: 2 * M, IsMultipleRadius: false, PropagateToTangentFaces: true, AsymmetricFillet: false, Edges: [edge(-30, 2.5, -20), edge(30, 2.5, -20), edge(30, 2.5, 20), edge(-30, 2.5, 20)], 'GetFaces(0)': null, Features: null, Loops: null },
            errors: [],
        },
    ], v3, [[-30, 0, -20], [30, 5, 20]]);
}

/** A tube revolved on the Front plane about a centreline on its Y axis: 10 outer, 5 inner radius, 20 high. */
export function tubeDoc(): SwDocument {
    const s = new SketchBuilder();
    const axisA = s.point(0, 0);
    const axisB = s.point(0, 20);
    const axis = s.line(axisA, axisB, true);
    s.rect(7.5, 10, 5, 20);
    const v = Math.PI * (100 - 25) * 20;
    return doc('tube.SLDPRT', [
        sketchFeature('Sketch1', s.sketch(FRONT), ['Front Plane'], 20),
        {
            name: 'Revolve1', type: 'Revolution', id: 21, suppressed: false, parents: ['Sketch1'], subFeatures: [{ name: 'Sketch1', type: 'ProfileFeature' }], after: after(v),
            data: { object: 'IRevolveFeatureData2', IsBossFeature: true, IsThinFeature: false, Type: 0, ReverseDirection: false, 'GetRevolutionAngle(True)': 2 * Math.PI, 'GetRevolutionAngle(False)': 0, Axis: { kind: 'sketchSegment', id: axis }, Contours: null },
            errors: [],
        },
    ], v, [[-10, 0, -10], [10, 20, 10]]);
}

/** A 50 x 10 x 4 bar with a 4 mm hole patterned five times, 10 mm apart along X. */
export function barDoc(): SwDocument {
    const s1 = new SketchBuilder();
    s1.rect(0, 0, 50, 10);
    const s2 = new SketchBuilder();
    s2.diameter(s2.circle(-20, 0, 2), 4);
    const v1 = 50 * 10 * 4;
    const v2 = v1 - Math.PI * 4 * 4;
    const v3 = v1 - 5 * Math.PI * 4 * 4;
    const move = (k: number) => [1, 0, 0, 0, 1, 0, 0, 0, 1, k * 10 * M, 0, 0, 1, 0, 0, 0];
    return doc('bar.SLDPRT', [
        sketchFeature('Sketch1', s1.sketch(TOP), ['Top Plane'], 20),
        { name: 'Boss-Extrude1', type: 'Extrusion', id: 21, suppressed: false, parents: ['Sketch1'], subFeatures: [{ name: 'Sketch1', type: 'ProfileFeature' }], after: after(v1), data: extrudeData({ boss: true, end: 0, depth: 4 }) as never, errors: [] },
        sketchFeature('Sketch2', s2.sketch(TOP, [0, 4, 0]), ['Boss-Extrude1'], 22),
        { name: 'Cut-Extrude1', type: 'ICE', baseType: 'Cut', id: 23, suppressed: false, parents: ['Sketch2'], subFeatures: [{ name: 'Sketch2', type: 'ProfileFeature' }], after: after(v2), data: extrudeData({ boss: false, end: 1 }) as never, errors: [] },
        {
            name: 'LPattern1', type: 'LPattern', id: 24, suppressed: false, parents: ['Cut-Extrude1'], subFeatures: [], after: after(v3),
            data: { object: 'ILinearPatternFeatureData', BodyPattern: false, D1Spacing: 10 * M, D1TotalInstances: 5, IsDirection2Specified: false, VarySketch: false, SkippedItemArray: null, PatternFeatureArray: [{ kind: 'feature', name: 'Cut-Extrude1', type: 'ICE' }], D1Axis: null },
            instances: [1, 2, 3, 4, 5].map((k) => ({ instance: k, transform: move(k - 1) })), errors: [],
        },
    ], v3, [[-25, 0, -5], [25, 4, 5]]);
}

/** A 30 x 30 x 20 block shelled 2 mm with its top face removed: a tray. */
export function trayDoc(): SwDocument {
    const s1 = new SketchBuilder();
    s1.rect(0, 0, 30, 30);
    const v1 = 30 * 30 * 20;
    const v2 = v1 - 26 * 26 * 18;
    return doc('tray.SLDPRT', [
        { name: 'Shelled', type: 'FtrFolder', id: 30, suppressed: false },
        sketchFeature('Sketch1', s1.sketch(TOP), ['Top Plane'], 20),
        { name: 'Boss-Extrude1', type: 'Extrusion', id: 21, suppressed: false, parents: ['Sketch1'], subFeatures: [{ name: 'Sketch1', type: 'ProfileFeature' }], after: after(v1), data: extrudeData({ boss: true, end: 0, depth: 20 }) as never, errors: [] },
        {
            name: 'Shell1', type: 'Shell', id: 22, suppressed: false, parents: ['Boss-Extrude1'], subFeatures: [], after: after(v2),
            data: { object: 'IShellFeatureData', Thickness: 2 * M, Direction: false, FacesRemovedCount: 1, GetMultipleThicknessFacesCount: 0, FacesRemoved: [{ kind: 'face', point: [5 * M, 20 * M, 5 * M], normal: [0, 1, 0], surface: 'plane', params: null, box: null }], MultipleThicknessFaces: null },
            errors: [],
        },
        { name: 'Folder1___EndTag___', type: 'FtrFolder', id: 31, suppressed: false },
    ], v2, [[-15, 0, -15], [15, 20, 15]]);
}

/** The plate with a rib after it (not in the studio): the SolidWorks body takes over at the rib. */
export function ribbedDoc(sldprt: string, volumeMm3: number): SwDocument {
    const plate = plateDoc();
    const features = plate.features!.filter((f) => f.type !== 'Fillet');
    features.push({ name: 'Rib1', type: 'Rib', id: 30, suppressed: false, parents: [], subFeatures: [], data: { object: 'IRibFeatureData2', Thickness: 0.002 }, errors: [] });
    return { ...plate, document: { ...plate.document, file: sldprt }, mass: { ...plate.mass!, volume: volumeMm3 * 1e-9 }, box: null, tessBox: null, features };
}

/** Area of an outline of corners and arcs (each arc a quarter circle between its corners, centre given). */
function outlineArea(items: ({ at: [number, number] } | { arc: [number, number] })[]): number {
    const corners = items.filter((i): i is { at: [number, number] } => 'at' in i).map((i) => i.at);
    let area = 0;
    for (let i = 0; i < corners.length; i++) {
        const [x0, y0] = corners[i];
        const [x1, y1] = corners[(i + 1) % corners.length];
        area += (x0 * y1 - x1 * y0) / 2;
    }
    // Each arc adds its circular segment beyond the chord (all are convex quarter circles here).
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!('arc' in item)) continue;
        const prev = items[i - 1] as { at: [number, number] };
        const r = Math.hypot(prev.at[0] - item.arc[0], prev.at[1] - item.arc[1]);
        area += (r * r / 2) * (Math.PI / 2 - 1);
    }
    return area;
}

/**
 * rpm.OLED.mount, one of the owner's parts, as its faces show it was made: an outline with rounded notches extruded
 * 1.2 mm up and 3 mm down from the Front plane, a 28.3 mm square pocket cut 3 mm into its back, and a cross-shaped
 * display window cut 1.2 mm through its front. SolidWorks' volume is that of the solid in the owner's SLDPRT.
 */
export function oledMountDoc(): SwDocument {
    const outline: ({ at: [number, number] } | { arc: [number, number] })[] = [
        { at: [-5, -26] }, { at: [5, -26] }, { arc: [5, -22] }, { at: [9, -22] }, { at: [9, -20] }, { at: [11, -20] }, { arc: [11, -14] },
        { at: [17, -14] }, { at: [17, 14] }, { arc: [11, 14] }, { at: [11, 20] }, { at: [9, 20] }, { at: [9, 22] }, { arc: [5, 22] },
        { at: [5, 26] }, { at: [-5, 26] }, { arc: [-5, 22] }, { at: [-9, 22] }, { at: [-9, 20] }, { at: [-11, 20] }, { arc: [-11, 14] },
        { at: [-17, 14] }, { at: [-17, -14] }, { arc: [-11, -14] }, { at: [-11, -20] }, { at: [-9, -20] }, { at: [-9, -22] }, { arc: [-5, -22] },
    ];
    const window: ({ at: [number, number] })[] = [
        [6, -13.175], [6, -9.675], [13.8, -9.675], [13.8, 9.675], [6, 9.675], [6, 13.175], [-6, 13.175], [-6, 9.675],
        [-13.8, 9.675], [-13.8, -9.675], [-6, -9.675], [-6, -13.175],
    ].map((at) => ({ at: at as [number, number] }));
    const s1 = new SketchBuilder();
    s1.outline(outline);
    const s2 = new SketchBuilder();
    s2.rect(0, 0, 28.3, 28.3);
    const s3 = new SketchBuilder();
    s3.outline(window);
    const v1 = outlineArea(outline) * 4.2;
    const v2 = v1 - 28.3 * 28.3 * 3;
    const v3 = v2 - outlineArea(window) * 1.2;
    const feature = (name: string, sketch: string, id: number, data: Record<string, unknown>, volume: number): SwFeature => ({
        name, type: 'ICE', baseType: data.IsBossFeature ? 'Extrusion' : 'Cut', id, suppressed: false, parents: [sketch],
        subFeatures: [{ name: sketch, type: 'ProfileFeature' }], after: after(volume), data: data as never, errors: [],
    });
    return doc('rpm.OLED.mount.SLDPRT', [
        sketchFeature('Sketch1', s1.sketch(FRONT), ['Front Plane'], 20),
        feature('Boss-Extrude1', 'Sketch1', 21, extrudeData({ boss: true, end: 0, depth: 1.2, both: true, end2: 0, depth2: 3 }), v1),
        sketchFeature('Sketch2', s2.sketch(FRONT), ['Front Plane'], 22),
        feature('Cut-Extrude1', 'Sketch2', 23, extrudeData({ boss: false, end: 0, depth: 3 }), v2),
        sketchFeature('Sketch3', s3.sketch(FRONT), ['Front Plane'], 24),
        feature('Cut-Extrude2', 'Sketch3', 25, extrudeData({ boss: false, end: 0, depth: 1.2, reverse: true }), v3),
    ], OLED_MOUNT_VOLUME, [[-17, -26, -3], [17, 26, 1.2]]);
}

/** The volume of the solid in the owner's rpm.OLED.mount.SLDPRT (read by the studio's SLDPRT reader), mm³. */
export const OLED_MOUNT_VOLUME = 3287.3818355440144;

/** An assembly of two plates (one turned 90 degrees about Y) and a tube on top of the first. */
export function assemblyDoc(): SwDocument {
    const plate = 60 * 40 * 5 - 2 * Math.PI * 9 * 5 - 4 * 5 * (4 - Math.PI);
    const tube = Math.PI * 75 * 20;
    const component = (name: string, file: string, transform: number[]) => ({
        name, file, path: `Z:\\3D_Prints\\Fixtures\\${file}`, configuration: 'Default', suppression: 2, suppressed: false, fixed: name.endsWith('-1'),
        visible: 1, excludeFromBOM: false, virtual: false, transform, children: [],
    });
    return {
        format: 'jarvis-sw-history', version: 1, kind: 'assembly',
        units: { length: 'm', angle: 'rad', area: 'm^2', volume: 'm^3', mass: 'kg' },
        exporter: { script: 'JarvisHistoryExport.vbs', version: '1.0', solidworks: '23.2.1', date: '2026-11-16 20:00:00' },
        document: { file: 'stand.SLDASM', path: 'Z:\\3D_Prints\\Fixtures\\stand.SLDASM', title: 'stand.SLDASM', configuration: 'Default' },
        mass: { volume: (2 * plate + tube) * 1e-9, area: 0, centre: [0, 0, 0] },
        box: null,
        components: [
            component('plate-1', 'plate.SLDPRT', turnY(0, [0, 0, 0])),
            component('plate-2', 'plate.SLDPRT', turnY(90, [100, 0, 0])),
            component('tube-1', 'tube.SLDPRT', turnY(0, [0, 5, 0])),
        ],
        mates: [{
            name: 'Coincident1', featureType: 'MateCoincident', suppressed: false, type: 0, alignment: 1, flipped: false,
            entities: [{ referenceType: 2, component: 'plate-1', params: [0, 0.005, 0, 0, 1, 0, 0, 0] }, { referenceType: 2, component: 'tube-1', params: [0, 0.005, 0, 0, -1, 0, 0, 0] }],
            errors: [],
        }, {
            name: 'Parallel1', featureType: 'MateParallel', suppressed: false, type: 3, alignment: 0, flipped: false,
            entities: [{ referenceType: 2, component: 'plate-1', params: [0, 0.005, 0, 0, 1, 0, 0, 0] }, { referenceType: 2, component: 'plate-2', params: [0.1, 0.005, 0, 0, 1, 0, 0, 0] }],
            errors: [],
        }, {
            name: 'Distance1', featureType: 'MateDistanceDim', suppressed: false, type: 5, alignment: 1, flipped: false, value: 0.005,
            entities: [{ referenceType: 2, component: 'plate-1', params: [0, 0.005, 0, 0, 1, 0, 0, 0] }, { referenceType: 2, component: 'plate-2', params: [0.1, 0, 0, 0, -1, 0, 0, 0] }],
            errors: [],
        }, {
            name: 'GearMate1', featureType: 'MateGear', suppressed: false, type: 10, alignment: 2, flipped: false,
            entities: [{ referenceType: 2, component: 'plate-1', params: [0.02, 0, 0, 0, 1, 0, 0.003, 0] }, { referenceType: 2, component: 'tube-1', params: [0, 0.005, 0, 0, 1, 0, 0.01, 0] }],
            errors: [],
        }],
        log: ['Jarvis history export 1.0 (fixture written by fixtures.test-helper.ts)'],
    };
}

export const FIXTURES: Record<string, () => SwDocument> = {
    'plate.jarvis-sw.json': plateDoc,
    'tube.jarvis-sw.json': tubeDoc,
    'bar.jarvis-sw.json': barDoc,
    'tray.jarvis-sw.json': trayDoc,
    'stand.jarvis-sw.json': assemblyDoc,
    'rpm.OLED.mount.jarvis-sw.json': oledMountDoc,
};
