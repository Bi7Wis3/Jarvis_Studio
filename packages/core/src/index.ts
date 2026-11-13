// Shared project model and wire protocol. Units are millimetres, Y is up.

export type Vec3 = [number, number, number];

export type Shape =
    | { kind: 'box'; size: Vec3; radius?: number }
    | { kind: 'cylinder'; radius: number; radiusTop?: number; height: number; bevel?: number }
    | { kind: 'tube'; outerRadius: number; innerRadius: number; height: number }
    | { kind: 'sphere'; radius: number }
    | { kind: 'torus'; radius: number; tube: number }
    | { kind: 'cone'; radius: number; height: number }
    | { kind: 'capsule'; radius: number; length: number }
    | { kind: 'lathe'; profile: [number, number][]; smooth?: boolean }
    | { kind: 'extrude'; outline: [number, number][]; height: number; bevel?: number }
    | FastenerShape
    | ScriptShape
    | SketchShape
    /** No body yet: the part's history starts with a sketch, and its first extrude/revolve/loft (add) makes the body. */
    | { kind: 'empty' };

// ---- Sketches: 2D profiles on a plane, extruded or revolved into solids -----------------------------------

/**
 * Sketch planes in the part's frame, named by the view that looks straight at them. (u, v) are the sketch's own
 * 2D axes as seen in that view: top (normal +Y): u = +X, v = -Z; front (normal +Z): u = +X, v = +Y;
 * right (normal +X): u = -Z, v = +Y. `offset` moves the plane along its normal.
 */
export type SketchPlaneName = 'top' | 'front' | 'right';

/**
 * A sketch plane at any position and angle in the part frame: `origin` is the sketch's (0, 0), `normal` the
 * direction extrusions go, `xDir` the sketch's u axis (perpendicular to normal); v = normal × u. Used for sketches
 * on angled faces, and on curved faces (the plane touching the surface where the user clicked).
 */
export interface CustomSketchPlane {
    origin: Vec3;
    normal: Vec3;
    xDir: Vec3;
}

export type SketchPlane = SketchPlaneName | CustomSketchPlane | { planeRef: string };

// ---- Reference geometry: construction planes, axes and points as history steps ---------------------------

/** A named base plane, or an earlier plane step of the same part by id. */
export type PlaneRef = SketchPlaneName | { planeRef: string };
/** A part-frame axis through the origin, or an earlier axis step by id. */
export type AxisRef = 'x' | 'y' | 'z' | { axisRef: string };

export type PlaneDefinition =
    | { kind: 'offset'; base: PlaneRef; distance: number }
    /** The base plane turned about one of its own axes (u or v, through its origin) or about an axis, in degrees. */
    | { kind: 'angle'; base: PlaneRef; about: 'u' | 'v' | AxisRef; angle: number }
    | { kind: 'threePoints'; points: [Vec3, Vec3, Vec3] }
    /** Through a point with a normal, e.g. tangent to a curved face where the user clicked. */
    | { kind: 'pointNormal'; point: Vec3; normal: Vec3; xDir?: Vec3 }
    | { kind: 'midplane'; a: PlaneRef; b: PlaneRef };

export type AxisDefinition =
    | { kind: 'twoPoints'; a: Vec3; b: Vec3 }
    | { kind: 'pointDirection'; point: Vec3; direction: Vec3 }
    | { kind: 'planeIntersection'; a: PlaneRef; b: PlaneRef };

/** A helix around an axis, used as a sweep path (springs, coils, spiral grooves). */
export interface HelixPath {
    axis: AxisRef;
    /** Distance from the axis; omit to use the profile's distance from the axis. */
    radius?: number;
    pitch: number;
    turns: number;
    leftHanded?: boolean;
    /** Taper angle in degrees (conical spring); 0 = cylindrical. */
    taper?: number;
}

export type SketchSegment =
    | { kind: 'line'; to: [number, number] }
    /** Circular arc from the current point to `to`, passing through `through`. */
    | { kind: 'arc'; to: [number, number]; through: [number, number] };

/** One closed profile in sketch coordinates (u, v), mm. */
export type SketchProfile =
    | { kind: 'rect'; center: [number, number]; width: number; height: number; radius?: number }
    | { kind: 'circle'; center: [number, number]; radius: number }
    | { kind: 'slot'; from: [number, number]; to: [number, number]; radius: number }
    | { kind: 'polygon'; points: [number, number][] }
    /** Closed path of lines and arcs; it closes back to `start` with a line if needed. */
    | { kind: 'path'; start: [number, number]; segments: SketchSegment[] };

/**
 * Closed profiles on one plane. Profiles that lie inside another become holes in it (nested again: islands),
 * so a circle drawn inside a rectangle makes a plate with a hole.
 */
export interface Sketch {
    plane: SketchPlane;
    /** Moves the plane along its normal (named and custom planes alike). */
    offset?: number;
    profiles: SketchProfile[];
    /**
     * The editable, constrained source of the sketch (points, curves, constraints and dimensions), kept by the
     * sketcher. `profiles` is always the solved result and is what the CAD kernel builds from; a sketch written
     * directly as profiles (e.g. by Jarvis) has no geometry.
     */
    geometry?: SketchGeometry;
    /**
     * Every bounded region of the sketch (the areas between its curves), written by the sketcher next to `profiles`
     * so features can use some of them. Absent for sketches written directly as profiles.
     */
    regions?: SketchRegion[];
}

/** One bounded region: `loops[0]` is its outline, the other loops are holes in it; `at` is a point inside it. */
export interface SketchRegion {
    loops: SketchProfile[];
    at: [number, number];
}

/** A point of a constrained sketch, in (u, v) mm. The point id 'origin' is reserved for the fixed sketch origin. */
export interface SketchPoint {
    id: string;
    u: number;
    v: number;
    fixed?: boolean;
}

/** construction: reference geometry (centre lines, guides) that is never part of a profile. */
export type SketchCurve =
    | { id: string; kind: 'line'; a: string; b: string; construction?: boolean }
    | { id: string; kind: 'circle'; center: string; radius: number; construction?: boolean }
    /** Counter-clockwise from start to end around center. */
    | { id: string; kind: 'arc'; center: string; start: string; end: string; construction?: boolean };

/**
 * Geometric constraints and driving dimensions. Dimensions are in mm and degrees. 'origin' and the sketch axes
 * (curve ids 'axis-u' and 'axis-v') can be referenced, so offsets from the origin or an axis are distances to them.
 * A dimension's `at` is where the user put its label, in sketch (u, v).
 */
export type SketchConstraint = { id: string } & (
    | { kind: 'coincident'; a: string; b: string }
    | { kind: 'horizontal' | 'vertical'; line: string }
    | { kind: 'parallel' | 'perpendicular' | 'equal' | 'tangent'; a: string; b: string }
    | { kind: 'pointOnCurve'; point: string; curve: string }
    | { kind: 'midpoint'; point: string; line: string }
    | { kind: 'symmetric'; a: string; b: string; about: string }
    | { kind: 'fix'; point: string }
    /** Distance between two points, or from a point to a line (perpendicular); axis 'u' or 'v' measures one direction only. */
    | { kind: 'distance'; a: string; b: string; value: number; axis?: 'u' | 'v'; at?: [number, number] }
    | { kind: 'length'; line: string; value: number; at?: [number, number] }
    | { kind: 'angle'; a: string; b: string; value: number; at?: [number, number] }
    | { kind: 'radius' | 'diameter'; curve: string; value: number; at?: [number, number] }
);

export interface SketchGeometry {
    points: SketchPoint[];
    curves: SketchCurve[];
    constraints: SketchConstraint[];
}

/** How far an extrusion goes: along the plane normal, the opposite way, or half each way. */
export type ExtrudeDirection = 'normal' | 'reverse' | 'symmetric';

/**
 * Where an extrusion stops: after its distance, through the whole body, or up to next (until it reaches the body
 * ahead, for a boss; through the first wall of material it meets, for a cut).
 */
export type ExtrudeEnd = 'blind' | 'throughAll' | 'upToNext';

/** The second direction of an extrude: opposite to the first, from the same start. */
export interface ExtrudeSide {
    end: ExtrudeEnd;
    distance?: number;
    draft?: number;
    draftOutward?: boolean;
}

/**
 * Where a sketch-based step gets its sketch: inline, or by the id of an earlier `sketch` step of the same part
 * (editing that sketch then updates every step that uses it).
 */
export type SketchSource = { sketch: Sketch; sketchRef?: undefined } | { sketchRef: string; sketch?: undefined };

/**
 * Which regions of its sketch a feature uses, as points in sketch (u, v): each selects the sketch region that
 * contains it. Absent or empty: the whole sketch. Ignored for sketches without `regions`.
 */
export interface RegionPicks {
    regions?: [number, number][];
}

/** A new body made from a sketch: extruded by `extrude`, or revolved about the sketch's u or v axis. */
export interface SketchShape {
    kind: 'sketch';
    sketch: Sketch;
    extrude?: { distance: number; direction?: ExtrudeDirection };
    revolve?: { axis: 'u' | 'v'; angle?: number };
}

/**
 * A solid written as replicad code (the OpenCascade CAD library), for forms primitives cannot express:
 * splines, lofts, sweeps, bent and organic parts. The code is the body of a function that receives the
 * replicad module as `r` (and `params`) and returns one solid in mm, authored in replicad's own Z-up frame.
 * The kernel turns it onto the part frame (script Z becomes +Y, script -Y becomes front +Z), keeping the origin.
 * `size` is its rough bounding box, used until the kernel has built it.
 */
export interface ScriptShape {
    kind: 'script';
    code: string;
    params?: Record<string, number>;
    size: Vec3;
}

// ---- Real CAD: fasteners, holes and the feature history -------------------------------------------------

export const THREAD_SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8'] as const;
export type ThreadSize = (typeof THREAD_SIZES)[number];

/**
 * ISO hardware. Screws and bolts: origin at the centre of the head's bearing face (the underside of the head;
 * for countersunk screws, the top of the head, flush with the surface), head toward +Y, shank toward -Y,
 * `length` as sold (under the head, overall for countersunk). Nuts, washers and inserts: axis along Y,
 * bottom face at y = 0.
 */
export type FastenerType =
    | 'socketCap' // ISO 4762
    | 'buttonHead' // ISO 7380
    | 'countersunk' // ISO 10642
    | 'hexBolt' // ISO 4017
    | 'hexNut' // ISO 4032
    | 'nylocNut' // ISO 10511
    | 'squareNut' // DIN 562
    | 'washer' // ISO 7089
    | 'heatsetInsert'; // brass threaded insert for plastic

export interface FastenerShape {
    kind: 'fastener';
    type: FastenerType;
    size: ThreadSize;
    length?: number;
    /** 'modelled' sweeps a real helix; 'plain' is a smooth shank at the major diameter. Default 'modelled'. */
    thread?: 'modelled' | 'plain';
}

/**
 * A standard hole, sized from the fastener tables and the project's print tolerance.
 * clearance: screw passes freely. tap: for cutting or self-tapping a thread. heatset: for a brass insert.
 * counterbore and countersink: clearance hole with a recess so a socketCap or countersunk head sits flush.
 * nutTrap: hexagonal pocket that holds a hexNut (plus clearance hole). plain: just `diameter`.
 */
export interface HoleSpec {
    kind: 'clearance' | 'tap' | 'heatset' | 'counterbore' | 'countersink' | 'nutTrap' | 'plain';
    size?: ThreadSize;
    diameter?: number;
    fit?: 'close' | 'normal';
}

/** Edges picked in the part's local frame: 'top'/'bottom' lie at its highest/lowest Y, 'vertical' run along Y. */
/** A face picked in the view: a point on it and its outward normal there, in the part's own frame. */
export type FacePickRef = { at: Vec3; normal?: Vec3 };

export type EdgeSelect = 'all' | 'top' | 'bottom' | 'vertical' | 'horizontal';
/** Faces picked by their outward direction in the part's local frame. front = +Z, right = +X, top = +Y. */
export type FaceSelect = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

interface FeatureBase {
    /** Stable id, used by the timeline. */
    id: string;
    /** Engineer-style name shown in the timeline, e.g. "Lid screw holes". */
    name?: string;
    /** Suppressed features stay in the history but are skipped when the solid is built. */
    suppressed?: boolean;
}

/** One step of a part's history. Applied in order to the part's body, in its local frame. */
export type Feature = FeatureBase & (
    /**
     * Rounds edges. Edges picked in the view (`at`: a point on each) and the edges of picked `faces` are used when
     * given, else the `edges` group. tangent: follow each picked edge along its smooth chain. radius2: the radius at
     * the far end of each edge, for a fillet that changes along it.
     */
    | { op: 'fillet'; radius: number; edges?: EdgeSelect; at?: Vec3[]; faces?: FacePickRef[]; tangent?: boolean; radius2?: number }
    /**
     * Bevels edges, picked like a fillet's. size alone: equal distance; with distance2: two distances; with angle
     * (degrees): distance and angle. `side` is the normal of the face that `size` is measured on.
     */
    | {
        op: 'chamfer'; size: number; edges?: EdgeSelect; at?: Vec3[]; faces?: FacePickRef[]; tangent?: boolean;
        distance2?: number; angle?: number; side?: Vec3;
    }
    /** Hollows the solid to a wall `thickness`, removing the `open` faces (none: a closed hollow body). */
    /** Hollows the body. Faces to remove: by side (`open`) and/or picked in the view (`remove`). outward: grow the wall outside. */
    | { op: 'shell'; thickness: number; open?: FaceSelect[]; remove?: FacePickRef[]; outward?: boolean }
    | { op: 'add'; shape: Shape; position?: Vec3; rotation?: Vec3; repeat?: Repeat }
    | { op: 'cut'; shape: Shape; position?: Vec3; rotation?: Vec3; repeat?: Repeat }
    /**
     * Drills from `position` (on the surface) along `direction` (default [0, -1, 0], straight down).
     * `depth` defaults to through-all. Counterbores, countersinks and nut traps sit at the entry point.
     */
    | { op: 'hole'; spec: HoleSpec; position: Vec3; direction?: Vec3; depth?: number; repeat?: Repeat }
    /**
     * Sketch extruded into the part: mode add joins material, cut removes it. Direction 1 ends by `end`
     * (default blind: `distance`; `through: true` is the older spelling of throughAll). `from` starts it that far
     * from the sketch plane along direction 1. `draft` tapers the walls (degrees, narrowing along the extrusion;
     * draftOutward widens). `flipSide` (cuts) removes what is outside the profile instead. `second` extrudes the
     * other way from the same start (not with direction symmetric; null: none).
     */
    | ({
        op: 'extrude'; distance?: number; through?: boolean; direction?: ExtrudeDirection; mode: 'add' | 'cut';
        end?: ExtrudeEnd; from?: number; draft?: number; draftOutward?: boolean; flipSide?: boolean; second?: ExtrudeSide | null;
    } & SketchSource & RegionPicks)
    /** Sketch revolved about its u or v axis (through the sketch origin) by `angle` degrees (default 360). */
    | ({ op: 'revolve'; axis: 'u' | 'v'; angle?: number; mode: 'add' | 'cut' } & SketchSource & RegionPicks)
    /** A sketch as its own history step. It builds nothing; extrude, revolve and loft steps after it use it by id. */
    | { op: 'sketch'; sketch: Sketch }
    /**
     * Blends a solid through two or more sections, in order (each one closed profile without holes), e.g. from a
     * rectangle on the bottom plane to a circle on an offset plane. ruled: straight between sections, else smooth.
     */
    | { op: 'loft'; sections: SketchSource[]; ruled?: boolean; mode: 'add' | 'cut' }
    /**
     * Mirrors across a plane (moved `offset` along its normal): a base plane (front, top, right; the older
     * YZ / XY / XZ spellings are right / front / top) or a plane step. With `features`, those earlier steps are
     * applied again mirrored (Features to mirror); else the body built so far is mirrored and the copy joined
     * (Bodies to mirror). keepOriginal false replaces the body with its mirror image (used by Mirror copy).
     */
    | { op: 'mirror'; plane: 'YZ' | 'XY' | 'XZ' | PlaneRef; offset?: number; keepOriginal?: boolean; features?: string[] }
    /** Construction plane (builds nothing); sketches and other steps use it by id. */
    | { op: 'plane'; definition: PlaneDefinition }
    /** Construction axis (builds nothing); revolves, coils and patterns use it by id. */
    | { op: 'axis'; definition: AxisDefinition }
    /** Construction point (builds nothing). */
    | { op: 'point'; position: Vec3 }
    /**
     * Sweeps a closed profile along a path: an open or closed chain of lines and arcs in another sketch, or a helix
     * (springs, coils). twist rotates the profile along the path in degrees.
     */
    | { op: 'sweep'; profile: SketchSource; path: SketchSource | { helix: HelixPath }; twist?: number; mode: 'add' | 'cut' }
    /**
     * Repeats earlier steps (by id) in a line or around an axis, e.g. a bolt-hole circle. Instances are numbered
     * from 1 (the seed) along each direction; `skip` lists [direction 1, direction 2] instance numbers left out
     * (direction 2 is 1 without a second direction, and always 1 for circular).
     */
    | {
        op: 'pattern'; features: string[]; kind: 'linear'; direction: AxisRef | Vec3; count: number; spacing: number; reverse?: boolean;
        /** Direction 2: a second row direction. seedOnly2: only the seed is repeated along it, not the direction 1 copies. */
        direction2?: AxisRef | Vec3; count2?: number; spacing2?: number; reverse2?: boolean; seedOnly2?: boolean;
        skip?: [number, number][];
    }
    | {
        /** equal (default true): `angle` is the total angle (default 360) shared out equally; false: the angle between instances. */
        op: 'pattern'; features: string[]; kind: 'circular'; axis: AxisRef; count: number; angle?: number; equal?: boolean;
        reverse?: boolean; skip?: [number, number][];
    }
    /**
     * Boolean with another part's body, as placed in the assembly: join adds it, cut removes it (e.g. a clearance
     * pocket shaped by a PCB), intersect keeps only the overlap.
     */
    | { op: 'combine'; part: string; operation: 'join' | 'cut' | 'intersect' }
    /** Cuts the body with a plane and keeps one side (or both, as separate solids). */
    | { op: 'split'; plane: PlaneRef; keep: 'positive' | 'negative' | 'both' }
    /** Tilts faces by `angle` degrees relative to a neutral plane (draft for moulding, easier printing). */
    | {
        op: 'draft'; angle: number;
        /** Faces to tilt: by side and/or picked in the view. */
        faces?: FaceSelect[]; picked?: FacePickRef[]; tangent?: boolean;
        /** The plane the faces pivot about: a plane, or a flat face picked in the view. flip reverses the pull direction. */
        neutral?: PlaneRef; neutralFace?: FacePickRef; flip?: boolean;
    }
    /** Printable ISO-style thread: external on a boss of `diameter`, or internal in a bore of `diameter`. */
    | { op: 'thread'; kind: 'external' | 'internal'; diameter: number; pitch: number; length: number; position?: Vec3 }
);

/** Settings for designing parts to be 3D printed (FDM by default). */
export interface PrintSettings {
    bed: Vec3;
    nozzle: number;
    layerHeight: number;
    /** Added to the diameter of printed holes and pockets so hardware fits. */
    holeTolerance: number;
}

export const DEFAULT_PRINT: PrintSettings = { bed: [220, 220, 250], nozzle: 0.4, layerHeight: 0.2, holeTolerance: 0.2 };

/** Copies of a part: around the vertical axis through `centre` [x, z], or along a straight line. */
export type Repeat =
    | { kind: 'radial'; count: number; centre?: [number, number]; angle?: number }
    | { kind: 'linear'; count: number; step: Vec3 };

export interface Material {
    color: string;
    metalness: number;
    roughness: number;
    emissive?: string;
    emissiveIntensity?: number;
    opacity?: number;
    clearcoat?: number;
    transmission?: number;
}

export interface Part {
    id: string;
    name: string;
    description?: string;
    shape: Shape;
    position: Vec3;
    rotation: Vec3;
    material: Material;
    explodeOffset?: Vec3;
    repeat?: Repeat;
    labelSide?: 'left' | 'right';
    /**
     * This part is another instance of the part with this id: it uses that part's shape, features, material and
     * decals, with its own position, rotation and repeat (four wheels = one wheel part placed four times).
     */
    instanceOf?: string;
    /** History applied to `shape`, in order. */
    features?: Feature[];
    /** Off-the-shelf hardware (fasteners, electronics): shown and listed in the BOM, not printed. */
    purchased?: boolean;
    /** Pictures applied onto the part's surface (deck graphics, labels, logos). Visual only: not in STL or STEP. */
    decals?: Decal[];
}

/**
 * An image projected onto a part's surface. position and normal are in the part's frame (a point on the surface
 * and the direction it faces); size is [width, height] in mm; rotation turns the image about the normal in degrees.
 * image is an asset id from POST /api/assets.
 */
export interface Decal {
    id: string;
    image: string;
    position: Vec3;
    normal: Vec3;
    size: [number, number];
    rotation?: number;
    opacity?: number;
    /**
     * planar (default): the picture covers every surface facing it, at any depth, wrapping over curves such as a
     * deck's kicktails without reaching the far side. box: only within `depth` of the decal point.
     */
    mode?: 'planar' | 'box';
    /** Maximum distance in mm from the decal point that the picture reaches; unset means no limit. */
    depth?: number;
}

export interface ViewState {
    explode: number;
    explodeSpacing: number | null;
    labels: boolean;
    focus: string | null;
    autoRotate: boolean;
    azimuth: number | null;
    elevation: number | null;
    /**
     * Timeline rollback: number of history steps shown (each part's creation and each of its features count
     * as one step, in part order). null shows everything.
     */
    timeline?: number | null;
    /** Parts hidden from the viewport (still part of the design and its exports). */
    hidden?: string[];
    /** Sketch steps hidden in the viewport, as "partId/featureId". Sketches are shown otherwise. */
    hiddenSketches?: string[];
    /** Part-workspace rollback: only the first `count` features of `partId` are built and shown. */
    rollback?: { partId: string; count: number } | null;
}

export interface Project {
    name: string;
    parts: Part[];
    view: ViewState;
    print?: PrintSettings;
}

/** Real geometry from the CAD kernel: mesh key per part (null while building) and build errors. */
export interface MeshStatus {
    keys: Record<string, string | null>;
    errors: Record<string, string>;
}

/** A picture pasted or dropped into the prompt bar. data is base64 without the data: prefix. */
export interface ImageAttachment {
    data: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

/** Viewport controls the buttons apply directly, without a turn by Jarvis. */
export type ViewAction = 'explode' | 'assemble' | 'spin' | 'undo';

export interface ProjectEntry {
    slug: string;
    name: string;
}

/** One command sent to Jarvis, for the activity panel. */
export interface ActivityEntry {
    turn: number;
    text: string;
    images: number;
    at: number;
    state: 'running' | 'done' | 'stopped' | 'failed';
}

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'speaking';

export type ServerMessage =
    | { type: 'state'; project: Project }
    | ({ type: 'meshes' } & MeshStatus)
    | { type: 'status'; status: AgentStatus; detail?: string }
    /** muted: another browser is speaking this sentence, so only show it as a subtitle. */
    | { type: 'say'; turn: number; text: string; audio: string | null; muted?: boolean }
    | { type: 'stop'; turn: number }
    | { type: 'activity'; entries: ActivityEntry[] }
    | { type: 'toolResult'; id: string; text: string; isError: boolean }
    | { type: 'info'; model: string; voice: string | null; ears: boolean; quality: 'fast' | 'best' }
    | { type: 'capture'; id: string }
    | { type: 'projects'; projects: ProjectEntry[]; current: string }
    | { type: 'download'; url: string; filename: string }
    | { type: 'error'; message: string };

export type ClientMessage =
    | { type: 'prompt'; text: string; images?: ImageAttachment[] }
    | { type: 'stop' }
    /** soft: take the voice only if no other browser has it (sent on connect). */
    | { type: 'active'; soft?: boolean }
    | { type: 'quality'; quality: 'fast' | 'best' }
    /** Runs a studio tool directly (toolbar), the same registry Jarvis and MCP clients use. */
    | { type: 'tool'; id: string; name: string; args: Record<string, unknown> }
    | { type: 'action'; action: ViewAction }
    | { type: 'open'; slug: string }
    | { type: 'create'; name: string }
    | { type: 'delete'; slug: string }
    | { type: 'hide'; partId: string; hidden: boolean }
    | { type: 'hideSketch'; partId: string; featureId: string; hidden: boolean }
    | { type: 'rollback'; partId: string; count: number | null }
    | { type: 'rename'; name: string }
    | { type: 'saveAs'; name: string }
    | { type: 'suppress'; partId: string; featureId: string; suppressed: boolean }
    | { type: 'focus'; id: string | null }
    | { type: 'capture'; id: string; image: string | null };

export const DEFAULT_VIEW: ViewState = {
    explode: 0,
    explodeSpacing: null,
    labels: false,
    focus: null,
    autoRotate: false,
    azimuth: null,
    elevation: null,
};

/** Half extents of a part's shape, ignoring rotation. */
export function shapeHalfExtents(shape: Shape): Vec3 {
    switch (shape.kind) {
        case 'box':
            return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
        case 'cylinder': {
            const r = Math.max(shape.radius, shape.radiusTop ?? shape.radius);
            return [r, shape.height / 2, r];
        }
        case 'tube':
            return [shape.outerRadius, shape.height / 2, shape.outerRadius];
        case 'sphere':
            return [shape.radius, shape.radius, shape.radius];
        case 'torus': {
            const r = shape.radius + shape.tube;
            return [r, shape.tube, r];
        }
        case 'cone':
            return [shape.radius, shape.height / 2, shape.radius];
        case 'capsule':
            return [shape.radius, shape.length / 2 + shape.radius, shape.radius];
        case 'extrude': {
            let x = 0;
            let z = 0;
            for (const [px, pz] of shape.outline) {
                x = Math.max(x, Math.abs(px));
                z = Math.max(z, Math.abs(pz));
            }
            return [x, shape.height / 2, z];
        }
        case 'script':
            return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
        case 'sketch':
            return sketchHalfExtents(shape);
        case 'empty':
            return [0, 0, 0];
        case 'fastener': {
            // Rough envelope until the kernel's mesh arrives; the real size comes from the fastener tables.
            const d = Number(shape.size.slice(1)) * 1.9;
            const length = shape.length ?? d * 2;
            return [d / 2, length / 2, d / 2];
        }
        case 'lathe': {
            let r = 0;
            let y = 0;
            for (const [pr, py] of shape.profile) {
                r = Math.max(r, Math.abs(pr));
                y = Math.max(y, Math.abs(py));
            }
            return [r, y, r];
        }
    }
}

/**
 * Offset of every part at explode factor 1. Parts with an explicit explodeOffset keep it;
 * the rest are lifted along Y in order of height, so the stack opens upward from the part on the ground.
 */
export function explodeOffsets(project: Project): Record<string, Vec3> {
    const out: Record<string, Vec3> = {};
    const auto = project.parts.filter((p) => !p.explodeOffset);
    const levels = [...new Set(auto.map((p) => Math.round(p.position[1])))].sort((a, b) => a - b);
    let spacing = project.view.explodeSpacing;
    if (spacing == null) {
        const tallest = Math.max(1, ...auto.map((p) => shapeHalfExtents(p.shape)[1] * 2));
        spacing = Math.max(15, tallest * 0.6);
    }
    for (const p of project.parts) {
        if (p.explodeOffset) {
            out[p.id] = p.explodeOffset;
            continue;
        }
        const rank = levels.indexOf(Math.round(p.position[1]));
        out[p.id] = [0, rank * spacing, 0];
    }
    return out;
}

/** One entry in the design timeline: a part's creation, or one feature of it. */
export interface TimelineStep {
    partId: string;
    /** null for the step that creates the part. */
    featureId: string | null;
    label: string;
    /** Shape kind for a creation step, feature op otherwise. */
    kind: string;
    suppressed: boolean;
}

/** The design history in order: each part's creation followed by its features, parts in project order. */
export function timelineSteps(project: Project): TimelineStep[] {
    const steps: TimelineStep[] = [];
    for (const part of project.parts) {
        steps.push({ partId: part.id, featureId: null, label: part.name, kind: part.shape.kind, suppressed: false });
        for (const feature of part.features ?? []) {
            steps.push({
                partId: part.id,
                featureId: feature.id,
                label: feature.name ?? feature.op,
                kind: feature.op,
                suppressed: feature.suppressed ?? false,
            });
        }
    }
    return steps;
}

/** The parts as they were at the timeline marker: later parts left out, later features cut off. */
export function partsAtTimeline(project: Project): Part[] {
    const rollback = project.view.rollback;
    const parts = rollback
        ? project.parts.map((p) => (p.id === rollback.partId && (p.features?.length ?? 0) > rollback.count
            ? { ...p, features: p.features!.slice(0, Math.max(0, rollback.count)) }
            : p))
        : project.parts;
    const limit = project.view.timeline;
    if (limit == null) {
        return parts;
    }
    const out: Part[] = [];
    let remaining = limit;
    for (const part of parts) {
        if (remaining <= 0) {
            break;
        }
        remaining -= 1;
        const features = part.features ?? [];
        const kept = Math.min(features.length, remaining);
        remaining -= kept;
        out.push(kept === features.length ? part : { ...part, features: features.slice(0, kept) });
    }
    return out;
}

/** Bounds of a sketch's profiles in its own (u, v) coordinates. */
export function sketchBounds(sketch: Sketch): { min: [number, number]; max: [number, number] } {
    const min: [number, number] = [Infinity, Infinity];
    const max: [number, number] = [-Infinity, -Infinity];
    const add = (u: number, v: number, pad = 0) => {
        min[0] = Math.min(min[0], u - pad);
        min[1] = Math.min(min[1], v - pad);
        max[0] = Math.max(max[0], u + pad);
        max[1] = Math.max(max[1], v + pad);
    };
    for (const p of sketch.profiles) {
        if (p.kind === 'rect') {
            add(p.center[0] - p.width / 2, p.center[1] - p.height / 2);
            add(p.center[0] + p.width / 2, p.center[1] + p.height / 2);
        } else if (p.kind === 'circle') {
            add(p.center[0], p.center[1], p.radius);
        } else if (p.kind === 'slot') {
            add(p.from[0], p.from[1], p.radius);
            add(p.to[0], p.to[1], p.radius);
        } else if (p.kind === 'polygon') {
            p.points.forEach(([u, v]) => add(u, v));
        } else {
            add(p.start[0], p.start[1]);
            p.segments.forEach((s) => {
                add(s.to[0], s.to[1]);
                if (s.kind === 'arc') {
                    add(s.through[0], s.through[1]);
                }
            });
        }
    }
    return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0], max: [0, 0] };
}

/** Rough half extents of a sketch body around the part origin (exact enough for framing and placeholders). */
function sketchHalfExtents(shape: SketchShape): Vec3 {
    const { min, max } = sketchBounds(shape.sketch);
    const reach = Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[1]), Math.abs(max[1]));
    if (shape.revolve) {
        return [reach, reach, reach];
    }
    const u = Math.max(Math.abs(min[0]), Math.abs(max[0]));
    const v = Math.max(Math.abs(min[1]), Math.abs(max[1]));
    const depth = Math.abs(shape.extrude?.distance ?? 0) + Math.abs(shape.sketch.offset ?? 0);
    const plane = shape.sketch.plane;
    if (typeof plane !== 'string') {
        // Any angle: a sphere around the plane origin that holds the sketch and its extrusion.
        // A plane step can't be resolved here (no history); the kernel mesh replaces this placeholder.
        const r = Math.hypot(u, v, depth) + ('origin' in plane ? Math.hypot(...plane.origin) : 0);
        return [r, r, r];
    }
    switch (plane) {
        case 'top':
            return [u, depth, v];
        case 'front':
            return [u, v, depth];
        case 'right':
            return [depth, v, u];
    }
}

/**
 * The design a part shows: an instance takes its source part's shape, features, material, decals and purchased
 * flag, keeping its own id, name and placement. Other parts are returned unchanged.
 */
export function effectivePart(part: Part, parts: Part[]): Part {
    if (!part.instanceOf) {
        return part;
    }
    const source = parts.find((p) => p.id === part.instanceOf);
    if (!source) {
        return part;
    }
    return {
        ...part,
        shape: source.shape,
        features: source.features,
        material: source.material,
        decals: source.decals,
        purchased: source.purchased,
    };
}
