// Mates between the parts of a project (SolidWorks assembly mates), as stored with the project. A mate relates
// entities picked on two components (faces, edges, vertices, planes, axes, origins, sketch entities); the solver
// (solver.ts) places the floating components so that every mate holds. See docs/SOLIDWORKS_REFERENCE.md, Part D.

import type { FacePickRef, SketchPlaneName, Vec3 } from '../index';

/**
 * The mate types. Phase 1 has the standard mates; the advanced and mechanical ones (profile centre, symmetric,
 * width, path, linear coupler, limits, cam, slot, hinge, gear, rack and pinion, screw, universal joint) will join this
 * union on the same data: a type, its references in order, and its values.
 */
export type MateType = 'coincident' | 'parallel' | 'perpendicular' | 'tangent' | 'concentric' | 'lock' | 'distance' | 'angle';

export const STANDARD_MATES: MateType[] = ['coincident', 'parallel', 'perpendicular', 'tangent', 'concentric', 'lock', 'distance', 'angle'];

/**
 * What was picked on a component, in the part's own frame (so it survives the part's own edits: the kernel finds the
 * face, edge or vertex again, as feature picks are, see apps/server/src/cad/refs.ts and followRefs.ts).
 * - face: a point on it and its outward normal there.
 * - edge: a point on it, and the faces that meet there (a point inside each and its normal), to find it again.
 * - vertex: where it is, and the faces that meet there.
 * - plane: a base plane of the part (or the assembly), or a plane step of the part by id.
 * - axis: a part axis (x, y, z through the origin) or an axis step by id.
 * - point: the origin (with its axes, for Align axes) or a point step by id.
 * - sketch: a point or line of a sketch step, by the step's id and the sketch's own point or curve id.
 * - component: the component as a whole (Lock mates).
 */
export type MatePick =
    | { kind: 'face'; at: Vec3; normal?: Vec3 }
    | { kind: 'edge'; at: Vec3; faces?: FacePickRef[] }
    | { kind: 'vertex'; at: Vec3; faces?: FacePickRef[] }
    | { kind: 'plane'; plane: SketchPlaneName | { step: string } }
    | { kind: 'axis'; axis: 'x' | 'y' | 'z' | { step: string } }
    | { kind: 'point'; point: 'origin' | { step: string } }
    | { kind: 'sketch'; step: string; item: string }
    | { kind: 'component' };

/**
 * The geometry of a picked entity in the part's frame, as the kernel found it (or as the reference resolves).
 * - plane: a point on it and its normal (a face's outward normal).
 * - line: a straight edge (from its start towards its end), an axis or a sketch line.
 * - point: a vertex, a point step or sketch point.
 * - frame: an origin, with its axes (Align axes).
 * - cylinder / cone / sphere: `inside` when the face's outward normal points towards the axis or centre (a hole).
 *   A cone runs from its apex along `direction`, its side at `halfAngle` degrees to the axis.
 * - circle: a circular or arc edge (centre, axis normal, radius).
 * - surface / curve: other faces and edges, which no standard mate takes yet.
 */
export type MateGeom =
    | { type: 'plane'; origin: Vec3; normal: Vec3 }
    | { type: 'line'; point: Vec3; direction: Vec3 }
    | { type: 'point'; point: Vec3 }
    | { type: 'frame'; origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }
    | { type: 'cylinder'; point: Vec3; direction: Vec3; radius: number; inside?: boolean }
    | { type: 'cone'; apex: Vec3; direction: Vec3; halfAngle: number; inside?: boolean }
    | { type: 'sphere'; centre: Vec3; radius: number; inside?: boolean }
    | { type: 'circle'; centre: Vec3; normal: Vec3; radius: number }
    | { type: 'surface' }
    | { type: 'curve' };

/**
 * One side of a mate: a component (`part`, a part id: an instance has its own id; absent for the assembly's own
 * planes, axes and origin, which never move), which copy of a patterned part (Part.repeat, 0 the part itself), what
 * was picked on it, and its geometry as last found (part frame), which the server keeps up to date.
 */
export interface MateRef {
    part?: string;
    copy?: number;
    pick: MatePick;
    found?: MateGeom;
}

/** Where a distance to a cylinder or sphere is measured: its axis or centre, its nearest side or its farthest. */
export type DistanceEnd = 'centre' | 'min' | 'max';

/**
 * What the solver holds that the mate's values do not say, set when the mate is made or edited.
 * - relative: Lock, the second component's placement in the first's frame (Euler XYZ degrees, as Part.rotation).
 * - across: Concentric with Lock rotation, a direction across the axis in each part's frame (the same in the world when
 *   locked).
 * - about: Angle, the axis the angle turns about (first part's frame), so Flip dimension says which way it opens.
 */
export interface MateHold {
    relative?: { position: Vec3; rotation: Vec3 };
    across?: [Vec3, Vec3];
    about?: Vec3;
}

export interface Mate {
    id: string;
    /** Coincident1, Distance2, ... as SolidWorks names them; can be renamed. */
    name: string;
    type: MateType;
    /** The entities mated, in the order picked (two for the standard mates). */
    refs: MateRef[];
    /** Normals (or axis directions) of the two entities the same way or opposite; absent where it has no meaning. */
    alignment?: 'aligned' | 'antiAligned';
    /** Distance (mm) or Angle (degrees). */
    value?: number;
    /** Flip dimension: measured to the other side (distance) or the other way round (angle). */
    flip?: boolean;
    /** Concentric: no rotation about the common axis. */
    lockRotation?: boolean;
    /** Coincident between origins: the axes line up too, which fixes the component fully. */
    alignAxes?: boolean;
    /** Distance with cylinders or spheres: where each side is measured (Center to Center when absent). */
    ends?: [DistanceEnd, DistanceEnd];
    suppressed?: boolean;
    hold?: MateHold;
}

/** A folder of the Mates folder: a named group of mates (any of them, in any order). */
export interface MateFolder {
    id: string;
    name: string;
    mates: string[];
}

/** The project's mates, their folders, and which components are fixed in place. */
export interface AssemblyMates {
    mates: Mate[];
    folders?: MateFolder[];
    /** Parts fixed in place ((f) in the tree); absent: only the first part, as SolidWorks fixes the first component. */
    fixed?: string[];
}

/** How a mate stands after solving. error: red (not satisfied, or its entities are gone); warning: yellow. */
export interface MateStatus {
    state: 'ok' | 'warning' | 'error' | 'suppressed';
    message?: string;
    /** Error kind: the references are lost, the pair cannot take this mate, the mate fights others or could not be solved. */
    reason?: 'missing' | 'invalid' | 'conflict' | 'unsolved' | 'redundant';
}

/** A component's prefix in the tree: fixed, under defined, over defined, not solved, or none (fully defined). */
export type ComponentState = 'fixed' | 'under' | 'over' | 'unsolved' | 'defined';

/** A part's placement in the assembly, as Part stores it. */
export interface Placement {
    position: Vec3;
    rotation: Vec3;
}
