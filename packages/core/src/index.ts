// Shared project model and wire protocol. Units are millimetres, Y is up.

export type Vec3 = [number, number, number];

export type Shape =
    | { kind: 'box'; size: Vec3; radius?: number }
    | { kind: 'cylinder'; radius: number; radiusTop?: number; height: number; bevel?: number }
    | { kind: 'tube'; outerRadius: number; innerRadius: number; height: number; bevel?: number }
    | { kind: 'sphere'; radius: number }
    | { kind: 'torus'; radius: number; tube: number }
    | { kind: 'cone'; radius: number; height: number }
    | { kind: 'capsule'; radius: number; length: number }
    /** A ramp: base size[0] (X) by size[2] (Z), full height size[1] at -X sloping down to nothing at +X; centred. */
    | { kind: 'wedge'; size: Vec3 }
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

/** What a reference taken from the model was picked on (for the history text and the form). */
export type ModelPickKind = 'face' | 'edge' | 'circle' | 'cylinder' | 'cone';

/**
 * An edge as last found: a straight edge from a to b, or a circle or arc running counter-clockwise about `normal`
 * from start to end (a full circle starts and ends at the same point).
 */
export type ModelEdgeShape =
    | { type: 'line'; a: Vec3; b: Vec3 }
    | { type: 'circle'; centre: Vec3; normal: Vec3; radius: number; full: boolean; start: Vec3; end: Vec3 };

/**
 * An edge of the model as picked in the view (part frame): a point on it and the faces that meet there, so the kernel
 * finds it again when it moves with those faces. `shape` is the edge as it was last found.
 */
export interface ModelEdgePick {
    edge: Vec3;
    faces?: FacePickRef[];
    shape?: ModelEdgeShape;
}

/** A vertex of the model as picked in the view: where it was, and the faces that meet there. */
export interface ModelVertexPick {
    vertex: Vec3;
    faces?: FacePickRef[];
}

/**
 * Where a reference was taken from the model: a face (a point on it and its outward normal), an edge or a vertex. The
 * kernel finds it again on the body at every rebuild, so the reference follows changes made before it.
 */
export type ModelEntityPick = { face: FacePickRef } | ModelEdgePick | ModelVertexPick;

/**
 * A plane taken from the model: a flat face (or the plane of a circular edge). With `pick` the kernel finds that
 * face or edge again at every rebuild and `fixedPlane` is only where it was last found (an error names the plane when
 * it is gone); without `pick` (older steps) the plane is kept by value as it was when picked.
 */
export interface FixedPlaneRef {
    fixedPlane: CustomSketchPlane;
    from?: ModelPickKind;
    pick?: { face: FacePickRef } | ModelEdgePick;
}

/** A line in the part frame: a point on it and its direction. */
export interface FixedLine {
    point: Vec3;
    direction: Vec3;
}

/**
 * A line taken from the model: a straight edge (through its midpoint), or the axis of a cylindrical or conical face.
 * With `pick` it follows the model as a FixedPlaneRef does; without it (older steps) it is kept by value.
 */
export interface FixedAxisRef {
    fixedAxis: FixedLine;
    from?: ModelPickKind;
    pick?: ModelEdgePick | { face: FacePickRef };
}

/** A named base plane, an earlier plane step of the same part by id, or a plane taken from the model. */
export type PlaneRef = SketchPlaneName | { planeRef: string } | FixedPlaneRef;
/** A part-frame axis through the origin, an earlier axis step by id, or a line taken from the model. */
export type AxisRef = 'x' | 'y' | 'z' | { axisRef: string } | FixedAxisRef;

/**
 * A point taken from the model: a vertex, or the centre of a circular edge. `fixedPoint` is where it was last found;
 * the kernel finds the vertex or edge of `pick` again at every rebuild.
 */
export interface FixedPointRef {
    fixedPoint: Vec3;
    from: 'vertex' | 'centre';
    pick: ModelVertexPick | ModelEdgePick;
}

/** A point in the part frame: coordinates, an earlier point step by id, or a point taken from the model. */
export type PointRef = Vec3 | { pointRef: string } | FixedPointRef;

/** A cylindrical face taken from the model: its axis and radius (with `pick`, as last found: it follows the model). */
export interface FixedCylinder extends FixedLine {
    radius: number;
    pick?: { face: FacePickRef };
}

/**
 * How a point step was taken from the model; the kernel finds it again at every rebuild and the step's `position` is
 * where it was last found. A circular edge's centre, a face's centre (its area centroid), a vertex, where two straight
 * edges (extended) meet, or along a straight or circular edge from the start of its `shape` (from its end with
 * `reverse`): the `index`-th of points spaced `amount` mm or `amount` percent of the edge's length apart.
 */
export type PointDefinition =
    | { kind: 'arcCentre'; edge: ModelEdgePick }
    | { kind: 'faceCentre'; face: FacePickRef }
    | { kind: 'vertex'; vertex: ModelVertexPick }
    | { kind: 'intersection'; a: ModelEdgePick; b: ModelEdgePick }
    | { kind: 'along'; edge: ModelEdgePick; by: 'distance' | 'percent'; amount: number; index: number; reverse?: boolean };

/** `flipNormal` turns any plane's normal around (its u axis stays, so v turns too). */
export type PlaneDefinition = (
    | { kind: 'offset'; base: PlaneRef; distance: number }
    /**
     * The base plane turned about one of its own axes (u or v, through its origin) or about an axis, in degrees.
     * `throughAxis`: the plane is first moved to pass through the axis (which must lie in or parallel to it), as
     * SolidWorks' At angle does for an edge off the plane.
     */
    | { kind: 'angle'; base: PlaneRef; about: 'u' | 'v' | AxisRef; angle: number; throughAxis?: boolean }
    | { kind: 'threePoints'; points: [PointRef, PointRef, PointRef] }
    /** Through a point with a normal, e.g. tangent to a curved face where the user clicked. */
    | { kind: 'pointNormal'; point: PointRef; normal: Vec3; xDir?: Vec3 }
    | { kind: 'midplane'; a: PlaneRef; b: PlaneRef }
    /** Parallel to a plane, through a point. */
    | { kind: 'parallel'; base: PlaneRef; point: PointRef }
    /** Perpendicular to an axis, through a point (default: the axis's own point). */
    | { kind: 'normal'; axis: AxisRef; point?: PointRef }
    /** Through an axis or edge, perpendicular to a plane. */
    | { kind: 'perpendicular'; base: PlaneRef; axis: AxisRef }
    /** Through an axis or edge and a point off it. */
    | { kind: 'linePoint'; axis: AxisRef; point: PointRef }
    /**
     * Tangent to a cylinder: through a point (on the surface: tangent there; off it: one of the two tangent planes
     * through it, `flip` for the other), or parallel to a plane that is parallel to the axis, turned `angle` degrees
     * about the axis (`flip`: the tangent on the other side).
     */
    | { kind: 'tangent'; cylinder: FixedCylinder; point?: PointRef; plane?: PlaneRef; angle?: number; flip?: boolean }
) & { flipNormal?: boolean };

export type AxisDefinition =
    | { kind: 'twoPoints'; a: PointRef; b: PointRef }
    | { kind: 'pointDirection'; point: PointRef; direction: Vec3 }
    | { kind: 'planeIntersection'; a: PlaneRef; b: PlaneRef }
    /** Along a line or centreline (curve id `line`) of an earlier sketch step. */
    | { kind: 'sketchLine'; sketchRef: string; line: string }
    /** Through a point, normal to a plane. */
    | { kind: 'pointPlane'; point: PointRef; plane: PlaneRef }
    /** Along an axis: an earlier axis step, a part axis, or a straight edge or a cylinder's axis taken from the model. */
    | { kind: 'along'; axis: AxisRef };

/**
 * What a revolve turns about: the sketch's own u or v axis (through its origin), a line or centreline of its sketch
 * (by curve id), a part axis or an earlier axis step.
 */
export type RevolveAxis = 'u' | 'v' | { line: string } | AxisRef;
/** How a revolve's Direction 1 angle is measured: one way from the sketch plane, or half to each side. */
export type RevolveType = 'blind' | 'midPlane';

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
    | { kind: 'arc'; to: [number, number]; through: [number, number] }
    /**
     * Elliptical arc from the current point to `to` on the ellipse with centre `center`, one axis ending at `major` and
     * the other radius `minor` (the longer of the two is the major axis); counter-clockwise when `ccw`.
     */
    | { kind: 'ellipse'; to: [number, number]; center: [number, number]; major: [number, number]; minor: number; ccw: boolean }
    /**
     * Spline from the current point through `through` to `to`: the curvature-continuous cubic interpolation of
     * @jarvis/core/curves (splineBezier). Ending where it starts, it is closed and runs smoothly through its start.
     */
    | {
        kind: 'spline'; to: [number, number]; through: [number, number][];
        /** Tangency handles at the ends (open splines): each is the first control point off its end, so it sets the end's direction and weight. */
        startHandle?: [number, number]; endHandle?: [number, number];
        /** See SketchCurve 'spline'. */
        spacing?: number[];
        /**
         * Tangency handles at other points (`at` counts the points from the start: 0 the start, then `through`, then
         * `to`): the control points just before and after the point, in line with it (@jarvis/core/splines).
         */
        handles?: { at: number; prev: [number, number]; next: [number, number] }[];
        /** Curvature held at points that have a handle: signed, 1/mm, positive where the spline turns left. */
        curvature?: { at: number; value: number }[];
        /** Curvature kept continuous across the handles too (SolidWorks: Maintain internal continuity). */
        continuity?: boolean;
    }
    /**
     * Style spline from the current point to `to`, its control polygon running through `poles` in between: a Bezier
     * curve when `degree` is the number of control vertices less one, else a clamped B-spline of that degree with
     * evenly spaced knots (@jarvis/core/curves bsplineAt).
     */
    | {
        kind: 'bspline'; to: [number, number]; poles: [number, number][]; degree: number;
        /** See SketchCurve 'styleSpline'. */
        knots?: number[];
        /** A weight for each control vertex, from the first (the current point) to the last (`to`): a rational curve. */
        weights?: number[];
    }
    /**
     * Conic from the current point to `to`, its end tangents meeting at `apex` (the top vertex); `rho` (0 to 1) is how
     * far the shoulder is from the chord's middle towards the apex: below 0.5 elliptic, 0.5 a parabola, above hyperbolic.
     */
    | { kind: 'conic'; to: [number, number]; apex: [number, number]; rho: number };

/** One closed profile in sketch coordinates (u, v), mm. */
export type SketchProfile =
    | { kind: 'rect'; center: [number, number]; width: number; height: number; radius?: number }
    | { kind: 'circle'; center: [number, number]; radius: number }
    /** Ellipse: centre, the end of one axis, and the other radius (the longer of the two is the major axis). */
    | { kind: 'ellipse'; center: [number, number]; major: [number, number]; minor: number }
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
    /**
     * The open chains of the sketch (lines and arcs on no closed area: a sweep path, a guide), each a `path` profile
     * that is not closed back to its start. Written by the sketcher next to `profiles`, which keeps only the closed
     * areas the kernel extrudes; a sweep takes its path from here.
     */
    open?: SketchProfile[];
    /** 2D to 3D: the view of the part this sketch was taken out of a drawing sketch as (Add to Front Sketch, ...). */
    view?: SketchView;
    /**
     * Derived Sketch: the sketch follows the earlier sketch step `from` (its entities, profiles and regions), placed on
     * this sketch's own plane; its own geometry is a copy kept for the sketcher. Underive drops the link.
     */
    derived?: { from: string };
}

/** The views a 2D to 3D conversion folds a drawing's sketches into. */
export type SketchView = 'front' | 'top' | 'right' | 'left' | 'bottom' | 'back' | 'auxiliary';

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

/**
 * construction: reference geometry (centre lines, guides) that is never part of a profile. A line's `endless` side
 * runs on without end beyond that point (SolidWorks Infinite length; trimming gives it ends): never part of a profile.
 */
export type SketchCurve =
    | { id: string; kind: 'line'; a: string; b: string; construction?: boolean; endless?: 'a' | 'b' | 'both' }
    | { id: string; kind: 'circle'; center: string; radius: number; construction?: boolean }
    /** Counter-clockwise from start to end around center. */
    | { id: string; kind: 'arc'; center: string; start: string; end: string; construction?: boolean }
    /** Ellipse: its centre and the ends of its two axes (Radius 1 and Radius 2; either may be the longer). */
    | { id: string; kind: 'ellipse'; center: string; major: string; minor: string; construction?: boolean }
    /** Partial ellipse: as an ellipse, counter-clockwise from start to end. */
    | { id: string; kind: 'ellipseArc'; center: string; major: string; minor: string; start: string; end: string; construction?: boolean }
    /** Spline through its points in order; closed when the last point is the first. */
    | {
        id: string; kind: 'spline'; points: string[]; startHandle?: string; endHandle?: string; construction?: boolean;
        /**
         * Per piece between points, its parameter length as a multiple of its chord (absent: 1); a piece cut from a
         * longer spline, a split or a control polygon drag keeps its shape this way, and Relax spline drops it.
         */
        spacing?: number[];
        /**
         * Tangency handles at other points (SolidWorks: an active spline handle): `handle` is the control point after
         * `point` (before it, with `before`: a spline run the other way); the other side runs the opposite way, `back`
         * times as long (1 when left out).
         */
        handles?: { point: string; handle: string; back?: number; before?: true }[];
        /** Curvature held at points that have a handle (Add Curvature Control): signed, 1/mm, positive turning left. */
        curvature?: { point: string; value: number }[];
        /** Maintain internal continuity (curvature continuous across the handles): on unless false. */
        continuity?: false;
        /** Proportional: dragging an end point resizes and turns the whole spline, its shape kept. */
        proportional?: boolean;
        /** Fit Spline, Constrained: fitted to these curves within the tolerance, and fitted again when they change. */
        fit?: { curves: string[]; tolerance: number };
    }
    /** Style spline of control vertices: Bezier (no degree) or a B-spline of degree 3, 5 or 7. */
    | {
        id: string; kind: 'styleSpline'; points: string[]; degree?: 3 | 5 | 7; construction?: boolean;
        /** The B-spline's inner knots (0 to 1, ascending) when not evenly spaced: a piece cut from a longer one, or a converted spline. */
        knots?: number[];
        /** Rational spline: a weight for each control vertex (1: as a non-rational one). */
        weights?: number[];
        /** Local edit: dragging one of its control vertices leaves the style splines joined to it as they are. */
        localEdit?: boolean;
    }
    /** Parabola: its focus and vertex (apex), from start to end. */
    | { id: string; kind: 'parabola'; focus: string; vertex: string; start: string; end: string; construction?: boolean }
    /** Conic from start to end, its end tangents meeting at the top vertex `apex`; Rho 0 to 1 (see SketchSegment). */
    | { id: string; kind: 'conic'; start: string; end: string; apex: string; rho: number; construction?: boolean };

/**
 * Geometric constraints and driving dimensions. Dimensions are in mm and degrees. 'origin' and the sketch axes
 * (curve ids 'axis-u' and 'axis-v') can be referenced, so offsets from the origin or an axis are distances to them.
 * A dimension's `at` is where the user put its label, in sketch (u, v). suppressed: kept in the sketch but not
 * solved (SolidWorks: Suppressed in Display/Delete Relations and SketchXpert).
 */
export type SketchConstraint = { id: string; suppressed?: boolean } & (
    | { kind: 'coincident'; a: string; b: string }
    | { kind: 'horizontal' | 'vertical'; line: string }
    /** Two points level with each other (horizontal) or one above the other (vertical). */
    | { kind: 'horizontalPoints' | 'verticalPoints'; a: string; b: string }
    /**
     * concentric: same centre (arcs/circles, or a point and an arc/circle); coradial: same centre and radius;
     * collinear: two lines on one infinite line.
     */
    | { kind: 'parallel' | 'perpendicular' | 'equal' | 'tangent' | 'concentric' | 'coradial' | 'collinear'; a: string; b: string }
    | { kind: 'pointOnCurve'; point: string; curve: string }
    | { kind: 'midpoint'; point: string; line: string }
    /** The point where lines a and b cross (on both infinite lines). */
    | { kind: 'intersection'; point: string; a: string; b: string }
    /**
     * a and b mirror images about a line. `part` holds only half of it: a-b square to the line, or its middle on the
     * line (for a point that its curve already holds on a line, so the whole relation would repeat itself).
     */
    | { kind: 'symmetric'; a: string; b: string; about: string; part?: 'perpendicular' | 'midpoint' }
    /** A locked point; with `axis` only that coordinate is held (a point that can only slide along its curve). */
    | { kind: 'fix'; point: string; axis?: 'u' | 'v' }
    /** A locked circle or arc keeps its radius (its centre is locked by 'fix'). */
    | { kind: 'fixRadius'; curve: string }
    /**
     * Distance between two points, or from a point to a line (perpendicular); axis 'u' or 'v' measures one direction only.
     * aMid / bMid: that end is a line or an arc, measured at its midpoint. aCond / bCond: that end is a circle or arc, measured to
     * the nearest (min) or farthest (max) point of it (without: the centre, by its point id). doubled: a point to a
     * centreline, the value being twice the distance (a diameter of a revolved profile). ordinate: shown as an
     * ordinate dimension (from the zero `a`, the value at `b`, aligned with the others of its row). unaligned: an
     * ordinate taken out of its row (Break alignment): its label moves on its own.
     */
    | ({ kind: 'distance'; a: string; b: string; value: number; axis?: 'u' | 'v'; at?: [number, number]
        aMid?: boolean; bMid?: boolean; aCond?: 'min' | 'max'; bCond?: 'min' | 'max'; doubled?: boolean; ordinate?: boolean; unaligned?: boolean } & Driven)
    /** The total length of a chain of lines and arcs, end to end; driving (the chain keeps that length) or driven. */
    | ({ kind: 'pathLength'; curves: string[]; value: number; at?: [number, number] } & Driven)
    | ({ kind: 'length'; line: string; value: number; at?: [number, number] } & Driven)
    /**
     * The angle between line a and line b, each taken from its first point to its second, or the other way round
     * when reversed: the pair of directions picks which of the four angles at the crossing is dimensioned (0-180).
     * Either may also be a spline's tangency handle point: the direction from the spline's end to the handle.
     */
    | ({ kind: 'angle'; a: string; b: string; value: number; at?: [number, number]; reverseA?: boolean; reverseB?: boolean } & Driven)
    | ({ kind: 'radius' | 'diameter'; curve: string; value: number; at?: [number, number] } & Driven)
    /** The true length of an arc, along it. */
    | ({ kind: 'arcLength'; curve: string; value: number; at?: [number, number] } & Driven)
    /**
     * The angle at point `vertex` from the direction to point a to the direction to point b (0-180). running: one of
     * an angular running set from the zero `a`, measured anticlockwise (0-360), or the nearer way when bidirectional
     * (0-180); unaligned: taken out of the set's ring (Break alignment).
     */
    | ({ kind: 'pointAngle'; vertex: string; a: string; b: string; value: number; at?: [number, number]
        running?: boolean; bidirectional?: boolean; unaligned?: boolean } & Driven)
    /**
     * A path (SketchGeometry.paths, its member curves listed here too) tangent to `curve` wherever they touch: the
     * member in contact holds it, and the contact passes from member to member as they move (a cam and its follower).
     */
    | { kind: 'pathTangent'; path: string; curves: string[]; curve: string }
    /** Arcs a and b sweep the same angle (part of Equal slots for arc slots). */
    | { kind: 'equalSweep'; a: string; b: string }
    /** The Rho of a conic as a dimension: driving, it sets the conic's rho. */
    | ({ kind: 'rho'; curve: string; value: number; at?: [number, number] } & Driven)
);

/**
 * driven: a reference dimension that only reports the size (its value follows the geometry and holds nothing);
 * absent for a driving one.
 */
interface Driven {
    driven?: boolean;
    /** Tolerance and precision the value is shown with (Dimension PropertyManager); they change nothing in the sketch. */
    tolerance?: DimensionTolerance;
}

/**
 * How a dimension's value is shown. type: none | basic (boxed, the exact value) | bilateral (+max / -min) | limit
 * (the upper and lower limits) | symmetric (± max) | min | max (suffixes). max / min: the amounts over and under the
 * value. precision / tolPrecision: digits after the decimal point of the value and of the tolerance (absent: as the
 * app shows values). parentheses: around the value with its tolerance.
 */
export interface DimensionTolerance {
    type: 'none' | 'basic' | 'bilateral' | 'limit' | 'symmetric' | 'min' | 'max';
    max?: number;
    min?: number;
    precision?: number;
    tolPrecision?: number;
    parentheses?: boolean;
}

export interface SketchGeometry {
    points: SketchPoint[];
    curves: SketchCurve[];
    constraints: SketchConstraint[];
    /** Sketch text items; each owns the glyph curves it generated (see SketchText). */
    texts?: SketchText[];
    /** Pictures on the sketch plane, a backdrop to trace over; never part of a profile. */
    pictures?: SketchPicture[];
    /** Equation driven curves; each owns the spline it generated. */
    equations?: SketchEquationCurve[];
    /** Block definitions of this sketch, in block coordinates (the insertion point at 0, 0). */
    blocks?: SketchBlock[];
    /** Placed instances of the blocks; each owns the curves it generated. */
    inserts?: SketchBlockInsert[];
    /** Offsets of chains with ellipses, splines, parabolas or conics; each owns the curves it generated. */
    offsets?: SketchOffset[];
    /** Segment tool groups: equally spaced points (or pieces) of one entity, re-spaced when one of them is deleted. */
    segments?: SketchSegmentGroup[];
    /** Linear and circular sketch patterns, kept so they can be edited (count, spacing) after they are made. */
    patterns?: SketchPatternRecord[];
    /** Paths (SolidWorks Make Path): chains of curves treated as one, and belts round pulleys. */
    paths?: SketchPath[];
}

/**
 * A path: curves joined end to end, in order, selected and related as one (Make Path). A belt's path is the belt
 * round its pulleys (SolidWorks Belt/Chain): its lines and arcs are built from `belt` and rebuilt when it is edited.
 */
export interface SketchPath {
    id: string;
    curves: string[];
    belt?: SketchBelt;
}

export interface SketchBelt {
    /** The circles or arcs the belt runs round, in order. */
    pulleys: string[];
    /** Per pulley: the belt runs round it the other way (on its other side). */
    flip: boolean[];
    /** The belt sits this far off each pulley (Use belt thickness), mm. */
    thickness?: number;
    /** Driving: the belt is this long (mm) and the pulleys move to suit; absent, the length follows the layout. */
    length?: number;
}

/**
 * Generated sketch items (text, equation curves, block instances) own ordinary curves and points of the sketch, so
 * profiles, regions and the kernel use them like any other entity; their points are fixed, and the item rebuilds
 * them when it is edited. Dissolving or exploding the item drops the item and keeps the entities.
 */
export interface SketchOwned {
    curves: string[];
    points: string[];
}

/**
 * Sketch text (SolidWorks Sketch Text). The text may hold codes for parts of it: <b>bold</b>, <i>italic</i> and
 * <r30>rotated 30 degrees counter-clockwise</r> (each character about its own centre). Glyph outlines are the font's
 * own lines and quadratic or cubic Bezier curves, kept exact as lines and Bezier style splines.
 */
export interface SketchText extends SketchOwned {
    id: string;
    text: string;
    /** Font family, as the server lists it. */
    font: string;
    bold?: boolean;
    italic?: boolean;
    /** Height of the capital letters, mm. */
    height: number;
    /** Width factor and spacing between characters, percent (100: as the font has them). */
    widthFactor?: number;
    spacing?: number;
    /** Start of the baseline when the text does not run along curves. */
    at: [number, number];
    /** Sketch curves the text runs along, end to end in order. */
    along?: string[];
    /** Along curves only. */
    align?: 'left' | 'center' | 'right' | 'full';
    /** flipV along curves only: the text goes to the other side of the curve. flipH mirrors the text. */
    flipV?: boolean;
    flipH?: boolean;
    construction?: boolean;
}

/** A picture on the sketch plane (SolidWorks Sketch Picture), its lower left corner at `at`. */
export interface SketchPicture {
    id: string;
    /** Asset id of the stored image. */
    asset: string;
    at: [number, number];
    width: number;
    height: number;
    /** Degrees, counter-clockwise, about `at`. */
    angle: number;
    flipH?: boolean;
    flipV?: boolean;
    lockAspect?: boolean;
    /** The image's size in pixels. */
    pixels: [number, number];
    /** none: opaque; file: the file's own transparency; full: the whole picture; colour: one colour within a tolerance. */
    transparency?: 'none' | 'file' | 'full' | 'colour';
    /** 0 to 1 (full and colour). */
    amount?: number;
    colour?: string;
    /** 0 to 1, how far from `colour` still counts as it. */
    tolerance?: number;
    hidden?: boolean;
}

/**
 * Equation driven curve: explicit y(x) for x from `from` to `to`, or parametric x(t), y(t) for t from `from` to `to`
 * (expressions; angles in radians). It is built as a spline through enough points to keep within `tolerance`.
 */
export interface SketchEquationCurve extends SketchOwned {
    id: string;
    type: 'explicit' | 'parametric';
    /** Explicit: y; parametric: x and y. */
    x?: string;
    y: string;
    from: string;
    to: string;
    /** The largest deviation allowed, mm; `deviation` is what the spline achieved. */
    tolerance: number;
    deviation?: number;
    construction?: boolean;
    /** How far the curve was moved from where its equations put it (Move, Copy): added to every point, mm. */
    offset?: [number, number];
    /**
     * How far it was turned (degrees, counter-clockwise about the equations' origin, before `offset`): the curve is
     * rigid and follows relations and dimensions on its end points.
     */
    angle?: number;
    /** Range locks: an unlocked end (false) can be dragged along the curve, which changes the range. */
    lockFrom?: false;
    lockTo?: false;
}

/**
 * A block definition: its entities with their own relations, in block coordinates. Its geometry may hold text,
 * equation curves and instances of other blocks (nested blocks; their definitions are in the sketch's `blocks`).
 */
export interface SketchBlock {
    id: string;
    name: string;
    geometry: SketchGeometry;
    /** Sketch/curve colour of the block's entities, #rrggbb. */
    colour?: string;
    /** Link to file: the block file (by name) every instance follows; the block is not edited in this sketch. */
    link?: string;
}

/**
 * One placed instance of a block: insertion point, rotation (degrees) and scale. In the solver an instance is one
 * rigid body: relations to its entities move and turn it as a whole.
 */
export interface SketchBlockInsert extends SketchOwned {
    id: string;
    block: string;
    at: [number, number];
    angle: number;
    scale: number;
    /** The insertion point: a point of the sketch (last of `points`) that relations can use and that drags the instance. */
    origin?: string;
    /** Lock angle: the instance can be dragged but not turned. */
    lockAngle?: boolean;
    /** For construction: every entity of the instance is construction geometry. */
    construction?: boolean;
    /** Hidden in the view (it is still part of the sketch). */
    hidden?: boolean;
}

/** A Segment tool group (SolidWorks equidistant points): its entity, the points in order, and what holds them. */
export interface SketchSegmentGroup {
    id: string;
    /** The entity divided (its first piece, in segments mode). */
    curve: string;
    mode: 'points' | 'segments';
    /** The new points, in order along the entity. */
    points: string[];
    /** The construction chords between neighbours, all equal (points mode). */
    chords: string[];
    /** The pieces, in order (segments mode; the first is `curve`). */
    pieces?: string[];
}

/** A linear or circular sketch pattern: what it was made from and with, and what it added (to edit it later). */
export interface SketchPatternRecord {
    id: string;
    kind: 'linear' | 'circular';
    /** The patterned curves (the original instance). */
    seed: string[];
    /** The pattern's options (the sketcher's LinearPatternOptions or CircularPatternOptions). */
    options: Record<string, unknown>;
    /** Entities and relations the pattern added: instances and its construction skeleton. */
    curves: string[];
    points: string[];
    constraints: string[];
    /** Display instance count: the count is shown in the view, where a double-click changes it. */
    showCount?: boolean;
}

/**
 * Offset Entities of a chain with curves whose offset is not of their own kind (ellipses, splines, parabolas,
 * conics): the offset is rebuilt from the chain whenever the chain changes (SolidWorks' offset relation), as fixed
 * lines, arcs and splines fitted within `tolerance` of the true offset (`deviation`: what they achieved, mm).
 */
export interface SketchOffset extends SketchOwned {
    id: string;
    /** The chain's curves in the order it runs; reversed: that curve runs from its end to its start. */
    base: { curve: string; reversed?: boolean }[];
    closed?: boolean;
    /** Signed distance of each side, left of the chain's way (two sides when Bi-directional). */
    distances: number[];
    cap?: 'arcs' | 'lines';
    /** The offset is construction geometry. */
    construction?: boolean;
    /** The driven dimension showing each side's distance; a value typed into it sets that distance. */
    dimensions?: string[];
    tolerance: number;
    deviation?: number;
    /** What the offset was last built from, to tell when the chain has changed. */
    key?: string;
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

/** A new body made from a sketch: extruded by `extrude`, or revolved about the sketch's u or v axis or one of its lines. */
export interface SketchShape {
    kind: 'sketch';
    sketch: Sketch;
    extrude?: { distance: number; direction?: ExtrudeDirection };
    revolve?: { axis: 'u' | 'v' | { line: string }; angle?: number };
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
    /**
     * Sketch revolved about `axis`. Direction 1: `angle` degrees (default 360) one way (`reverse`: the other way), or
     * with type midPlane split evenly to both sides of the sketch plane. `angle2` (blind only): also revolve that many
     * degrees the other way (Direction 2; null: none).
     */
    | ({
        op: 'revolve'; axis: RevolveAxis; angle?: number; mode: 'add' | 'cut';
        type?: RevolveType; reverse?: boolean; angle2?: number | null;
    } & SketchSource & RegionPicks)
    /** A sketch as its own history step. It builds nothing; extrude, revolve and loft steps after it use it by id. */
    | { op: 'sketch'; sketch: Sketch }
    /**
     * Blends a solid through two or more sections, in order (each one closed profile without holes), e.g. from a
     * rectangle on the bottom plane to a circle on an offset plane. ruled: straight between sections, else smooth.
     */
    | { op: 'loft'; sections: SketchSource[]; ruled?: boolean; mode: 'add' | 'cut'; /** Joins the last section back to the first (3+ sections). */ closed?: boolean }
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
    /** Construction point (builds nothing); with `definition`, taken from the model and found again at every rebuild. */
    | { op: 'point'; position: Vec3; definition?: PointDefinition }
    /**
     * Sweeps a closed profile along a path: the open chain (or single closed profile) of another sketch, or a helix
     * (springs, coils). `diameter` instead of `profile`: a circular profile, a round rod centred on the path start.
     * `regions` picks the profile's areas (one, holes allowed). orientation: followPath turns the profile with the
     * path (default), keepNormal keeps it parallel to its own plane. twist rotates the profile along a straight
     * path, in degrees.
     */
    | ({
        op: 'sweep'; profile?: SketchSource; diameter?: number; path: SketchSource | { helix: HelixPath }; twist?: number;
        orientation?: 'followPath' | 'keepNormal'; mode: 'add' | 'cut';
    } & RegionPicks)
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
    /**
     * Printable ISO-style thread: external on a shaft, or internal in a bore, of nominal (major) `diameter`.
     * `at`: a point on the circular edge where it begins (an end of the shaft or hole); the axis, start and the
     * direction along the cylinder come from that edge, and `diameter` defaults to the shaft's (external) or the
     * hole's diameter + 1.0825 x pitch (internal). Without `at`: along +Y from `position`, a rod or bore of its own.
     * The thread runs `length` mm (or `revolutions` turns) from the edge, starting `offset` mm along the cylinder.
     * leftHanded: a left-hand thread. starts: a multi-start thread (lead =
     * starts x pitch). startAngle turns where the thread begins about the axis, in degrees.
     */
    | {
        op: 'thread'; kind: 'external' | 'internal'; diameter?: number; pitch: number; length?: number; position?: Vec3;
        at?: Vec3; revolutions?: number; offset?: number; leftHanded?: boolean; starts?: number; startAngle?: number;
        /** Direction 2, on a picked edge: the thread also runs this far the other way from its start, as one thread. */
        length2?: number;
        /**
         * On a picked edge. cut: only removes material (a hole drilled at tap size, a shaft at the major diameter).
         * extrude: adds the ridges (a hole at the major diameter, a shaft at the root diameter). Absent (older
         * threads): chosen from the size of the hole or shaft, as they were built before.
         */
        method?: 'cut' | 'extrude';
        /** The thread runs out through its start face (and its end) instead of starting a little inside; default true. */
        trimStart?: boolean;
        trimEnd?: boolean;
        /** More circular edges threaded the same way, each from its own hole or shaft (`at` is the first). */
        alsoAt?: Vec3[];
        /**
         * Set only on the copy a tool preview builds, never saved: the ridges are shown on the body without the slow
         * booleans, for a quick look while the form is open.
         */
        preview?: boolean;
        /**
         * Set only on the copy the view builds while the step is hidden (its eye in the tree), never saved: the hole or
         * shaft stays plain and the kernel only marks where the thread runs, as a SolidWorks cosmetic thread.
         */
        cosmetic?: boolean;
    }
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
    /** Folders of the feature tree, nested ones too (folders.ts). They group steps only: the model does not change. */
    folders?: FeatureFolder[];
}

/**
 * A folder of the feature tree (SolidWorks user folder): a named group of consecutive history steps. What it holds,
 * sub-folders included, is always one unbroken run of the history (folders.ts keeps it so).
 */
export interface FeatureFolder {
    id: string;
    name: string;
    /** What it holds in tree order: step ids and the ids of its sub-folders. */
    items: string[];
    /** Only for an empty top-level folder: the step it sits above (none: at the end). */
    before?: string;
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
    /**
     * Sketch, reference and thread steps hidden in the viewport, as "partId/featureId" (a hidden thread is built plain
     * for the view, see viewPart in visibility.ts). Absorbed sketches are hidden unless in shownSketches.
     */
    hiddenSketches?: string[];
    /** Part-workspace rollback: only the first `count` features of `partId` are built and shown. */
    rollback?: { partId: string; count: number } | null;
    /** Absorbed sketches (a later step is built from them, so hidden by default) shown one by one, as "partId/featureId". */
    shownSketches?: string[];
    /** Solid bodies hidden in the viewport, as "partId/bodyKey" (see BodyInfo in visibility.ts). */
    hiddenBodies?: string[];
    /** Solid bodies drawn see-through, as "partId/bodyKey". */
    seeThroughBodies?: string[];
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
    /** Per part, its reference steps with references taken from the model as the kernel found them, by step id. */
    followed?: Record<string, Record<string, Feature>>;
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
    | { type: 'bodyView'; partId: string; body: string; hidden?: boolean; seeThrough?: boolean }
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
        case 'wedge':
            return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
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
        } else if (p.kind === 'ellipse') {
            add(p.center[0], p.center[1], Math.max(p.minor, Math.hypot(p.major[0] - p.center[0], p.major[1] - p.center[1])));
        } else {
            add(p.start[0], p.start[1]);
            p.segments.forEach((s) => {
                add(s.to[0], s.to[1]);
                if (s.kind === 'arc') {
                    add(s.through[0], s.through[1]);
                } else if (s.kind === 'ellipse') {
                    add(s.center[0], s.center[1], Math.max(s.minor, Math.hypot(s.major[0] - s.center[0], s.major[1] - s.center[1])));
                } else if (s.kind === 'spline') {
                    s.through.forEach(([u, v]) => add(u, v));
                    [s.startHandle, s.endHandle].forEach((h) => h && add(h[0], h[1]));
                    s.handles?.forEach((k) => [k.prev, k.next].forEach(([u, v]) => add(u, v)));
                } else if (s.kind === 'bspline') {
                    s.poles.forEach(([u, v]) => add(u, v));

                } else if (s.kind === 'conic') {
                    add(s.apex[0], s.apex[1]);
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
        folders: source.folders,
        material: source.material,
        decals: source.decals,
        purchased: source.purchased,
    };
}
