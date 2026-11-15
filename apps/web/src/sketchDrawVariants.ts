// The draw tool variants and options beyond the plain click tools (SolidWorks Line, Rectangle, Slot and Polygon
// PropertyManagers): oriented and midpoint lines, the line tool's switch to a tangent arc, 3 point centre
// rectangles, parallelograms, rectangle construction lines, centrepoint and arc slots with their dimensions,
// polygons on an inscribed circle, construction geometry from any tool, and the parameter edits of the forms.
// Everything is built from points, lines, circles and arcs with relations, like the plain tools.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { AXIS_U, ORIGIN, curveOf, pointOf } from './solver';
import {
    addConstraint, addPolygon, addSlot, addTangentArc, constraintRefs, geometryEntities, liveIds, newId, placePoint, removeItems, tangentAt,
    type NewConstraint, type PointRef,
} from './sketchGeometry';
import { circleThrough, dist, round, type NewEntity, type Pt } from './sketchMath';
import { markEndless } from './sketchInfinite';
import { conicStep } from './sketchConicTools';

export type LineOrientation = 'sketched' | 'horizontal' | 'vertical' | 'angle';
export type RectLines = 'none' | 'corners' | 'midpoints';
/** Tools that share one SolidWorks PropertyManager, and so one For construction setting. */
export type DrawFamily = 'line' | 'rect' | 'circle' | 'arc' | 'slot' | 'polygon' | 'point' | 'conic';

/** The options of the draw tools' forms. */
export interface DrawOptions {
    construction: Partial<Record<DrawFamily, boolean>>;
    lineOrientation: LineOrientation;
    /** The Midpoint line option of the Line tool (the Midpoint line tool always is one). */
    lineMidpoint: boolean;
    /** Length of an oriented line; 0: as far as the pointer. */
    lineLength: number;
    /** Angle of an Angle line from the horizontal, degrees. */
    lineAngle: number;
    lineDimensions: boolean;
    rectLines: RectLines;
    slotDimensions: boolean;
    /** Straight slot length dimension over the whole slot, else centre to centre. */
    slotOverall: boolean;
    /** The polygon's construction circle touches its sides (inscribed), else passes through its corners. */
    polygonInscribed: boolean;
    /** Line: Infinite length (the line runs on without end both ways). */
    lineInfinite?: boolean;
    /** Conic: Auto tangency (tangent at the ends, the top vertex from their tangents). */
    conicAutoTangency?: boolean;
}

export const DEFAULT_DRAW_OPTIONS: DrawOptions = {
    construction: {}, lineOrientation: 'sketched', lineMidpoint: false, lineLength: 0, lineAngle: 30, lineDimensions: false,
    rectLines: 'none', slotDimensions: false, slotOverall: false, polygonInscribed: false,
};

const FAMILIES: Record<string, DrawFamily> = {
    line: 'line', centerline: 'line', midpointLine: 'line',
    rect: 'rect', centerRect: 'rect', rect3: 'rect', centerRect3: 'rect', parallelogram: 'rect',
    circle: 'circle', perimeterCircle: 'circle',
    arc: 'arc', centerArc: 'arc', tangentArc: 'arc',
    slot: 'slot', centerSlot: 'slot', arcSlot3: 'slot', centerArcSlot: 'slot',
    polygon: 'polygon', point: 'point', conic: 'conic',
};

export const drawFamily = (tool: string): DrawFamily | null => FAMILIES[tool] ?? null;

const RECT_TOOLS = ['rect', 'centerRect', 'rect3', 'centerRect3', 'parallelogram'];

/** The line tool's automatic switch to a tangent arc: back over the end point and away again, or A. */
export interface LineArc {
    arc: boolean;
    /** at: the pointer is on the chain's end (just clicked); out: it left; back: it came back to it. */
    phase: 'at' | 'out' | 'back';
}

export const LINE_ARC_IDLE: LineArc = { arc: false, phase: 'at' };

/** The next state as the pointer moves `d` from the chain's end; leaving the end again after coming back toggles. */
export function lineArcMove(s: LineArc, d: number, tolerance: number, canArc: boolean): LineArc {
    const near = d <= tolerance;
    if (s.phase === 'at') {
        return near ? s : { ...s, phase: 'out' };
    }
    if (s.phase === 'out') {
        return near ? { ...s, phase: 'back' } : s;
    }
    return near ? s : { arc: canArc ? !s.arc : false, phase: 'out' };
}

// ---- Building ---------------------------------------------------------------------------------------------

type Arc = Extract<SketchCurve, { kind: 'arc' }>;
type Line = Extract<SketchCurve, { kind: 'line' }>;

/** A small mutable builder over immutable geometry. */
function builder(start: SketchGeometry) {
    let g = start;
    const curve = (c: Omit<Line, 'id'> | Omit<Arc, 'id'> | Omit<Extract<SketchCurve, { kind: 'circle' }>, 'id'>, construction: boolean): string => {
        const id = newId('c', g);
        g = { ...g, curves: [...g.curves, { ...c, id, ...(construction ? { construction: true } : {}) } as SketchCurve] };
        return id;
    };
    return {
        get g() {
            return g;
        },
        point(ref: PointRef | Pt): string {
            const r = placePoint(g, Array.isArray(ref) ? { at: ref } : ref);
            g = r.g;
            return r.id;
        },
        line: (a: string, b: string, construction = false) => curve({ kind: 'line', a, b }, construction),
        arc: (center: string, start: string, end: string, construction = false) => curve({ kind: 'arc', center, start, end }, construction),
        circle: (center: string, radius: number, construction = false) => curve({ kind: 'circle', center, radius }, construction),
        rel(c: NewConstraint) {
            g = addConstraint(g, c).g;
        },
    };
}

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const unit = (d: Pt): Pt => {
    const l = Math.hypot(d[0], d[1]) || 1;
    return [d[0] / l, d[1] / l];
};
const polar = (c: Pt, r: number, t: number): Pt => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
const deg = (rad: number) => (rad * 180) / Math.PI;

function lineDistance(p: Pt, a: Pt, b: Pt): number {
    const l = dist(a, b);
    return l ? Math.abs(cross(sub(b, a), sub(p, a))) / l : dist(p, a);
}

/** The direction an oriented line runs in, or null when it is drawn as sketched. */
export function lineDirection(o: DrawOptions): Pt | null {
    switch (o.lineOrientation) {
        case 'horizontal':
            return [1, 0];
        case 'vertical':
            return [0, 1];
        case 'angle':
            return polar([0, 0], 1, (o.lineAngle * Math.PI) / 180);
        default:
            return null;
    }
}

/**
 * Where a line from `from` toward `toward` ends: along the orientation's direction (the pointer projected on it),
 * at the form's length (or the typed one) when one is set. A midpoint line's `from` is its middle, so half of it.
 */
export function lineEnd(from: Pt, toward: Pt, o: DrawOptions, midpoint: boolean, typed?: number[]): Pt {
    const dir = typed?.[1] !== undefined ? null : lineDirection(o);
    const length = typed?.[0] !== undefined ? Math.abs(typed[0]) : dir ? o.lineLength : 0;
    const half = midpoint ? 0.5 : 1;
    if (!dir) {
        const d = dist(from, toward);
        return length > 0 && d > 1e-12 ? add(from, sub(toward, from), (length * half) / d) : toward;
    }
    const t = (toward[0] - from[0]) * dir[0] + (toward[1] - from[1]) * dir[1];
    return add(from, dir, length > 0 ? (Math.sign(t) || 1) * length * half : t);
}

/** What the tools need to place the next point. */
export interface DrawInput {
    tool: string;
    g: SketchGeometry;
    draft: PointRef[];
    ref: PointRef;
    /** What the cursor snapped to: horizontal / vertical alignment adds that relation to an as-sketched line. */
    kind: string | null;
    options: DrawOptions;
    sides: number;
    /** Centre-point arcs: the angle swept from the start toward the cursor (radians, + counter-clockwise). */
    sweep: number;
    typed?: number[];
    chainStart: string | null;
    lineArc: boolean;
}

/** More points needed, a finished entity (and what the draft goes on with), or why the click does nothing. */
export type DrawStep = { draft: PointRef[] } | { g: SketchGeometry; draft: PointRef[]; chainStart: string | null } | { error: string };

/** Places a point for the tools and options handled here; null leaves it to the plain tool. */
export function placeVariant(input: DrawInput): DrawStep | null {
    const { tool, draft, options: o } = input;
    switch (tool) {
        case 'line':
        case 'centerline': {
            const last = draft[draft.length - 1];
            if (tool === 'line' && input.lineArc && last?.point && tangentAt(input.g, last.point)) {
                return lineArcStep(input);
            }
            if (o.lineInfinite) {
                // Infinite length: each two clicks give one line through them, without end either way.
                const step = lineStep(input, false);
                if (!('g' in step)) {
                    return step;
                }
                const endless = markEndless(input.g, step.g);
                const old = new Set(input.g.curves.map((c) => c.id));
                // An infinite centreline is construction geometry, as any centreline.
                return { ...step, g: tool === 'centerline' ? { ...endless, curves: endless.curves.map((c) => (old.has(c.id) ? c : { ...c, construction: true })) } : endless };
            }
            if (o.lineOrientation === 'sketched' && !o.lineMidpoint) {
                return null;
            }
            return lineStep(input, o.lineMidpoint);
        }
        case 'midpointLine':
            return lineStep(input, true);
        case 'centerRect3':
        case 'parallelogram':
            return draft.length < 2 ? { draft: [...draft, input.ref] } : rectStep(input);
        case 'slot':
        case 'centerSlot':
            return draft.length < 2 ? { draft: [...draft, input.ref] } : straightSlotStep(input);
        case 'arcSlot3':
        case 'centerArcSlot':
            return arcSlotStep(input);
        case 'conic':
            return conicStep(input.g, draft, input.ref, !!o.conicAutoTangency);
        case 'polygon':
            if (!o.polygonInscribed) {
                return null;
            }
            if (!draft.length) {
                return { draft: [input.ref] };
            }
            return polygonStep(input);
        default:
            return null;
    }
}

function lineStep(input: DrawInput, midpoint: boolean): DrawStep {
    const { g, draft, ref, kind, options: o, typed } = input;
    const last = draft[draft.length - 1];
    if (!last) {
        return { draft: [ref] };
    }
    const end = lineEnd(last.at, ref.at, o, midpoint, typed);
    if (dist(end, last.at) < 1e-9) {
        return { draft };
    }
    // The click's snap only counts when the line really ends there.
    const endRef: PointRef = dist(end, ref.at) < 1e-9 ? ref : { at: end };
    const b = builder(g);
    let line: string;
    if (midpoint) {
        const m = b.point(last);
        const a = b.point(sub(add(last.at, last.at), end));
        line = b.line(a, b.point(endRef));
        b.rel({ kind: 'midpoint', point: m, line });
    } else {
        line = b.line(b.point(last), b.point(endRef));
    }
    const fixed = o.lineOrientation !== 'sketched';
    const orient = o.lineOrientation === 'horizontal' || o.lineOrientation === 'vertical' ? o.lineOrientation
        : o.lineOrientation === 'sketched' && (kind === 'horizontal' || kind === 'vertical') ? kind : null;
    if (orient && typed?.[1] === undefined) {
        b.rel({ kind: orient, line });
    }
    const drawn = curveOf(b.g, line) as Line;
    const d = sub(P(b.g, drawn.b), P(b.g, drawn.a));
    if (typed?.[0] !== undefined || (fixed && o.lineDimensions)) {
        b.rel({ kind: 'length', line, value: round(typed?.[0] !== undefined ? Math.abs(typed[0]) : Math.hypot(d[0], d[1])) });
    }
    if (typed?.[1] !== undefined || (o.lineOrientation === 'angle' && o.lineDimensions)) {
        // The angle from +u to the line as drawn (from its start), 0-180 either side.
        b.rel({ kind: 'angle', a: AXIS_U, b: line, value: round(Math.abs(deg(Math.atan2(d[1], d[0])))), reverseA: false, reverseB: false });
    }
    return { g: b.g, draft: [], chainStart: null };
}

/** The line tool switched to an arc: a tangent arc from the chain's end, and the chain goes on from its end. */
function lineArcStep(input: DrawInput): DrawStep {
    const { g, draft, ref, chainStart } = input;
    const r = addTangentArc(g, draft[draft.length - 1].point!, ref);
    if ('error' in r) {
        return { error: r.error };
    }
    const closes = ref.point !== undefined && ref.point === chainStart;
    return { g: r.g, draft: closes ? [] : [{ at: P(r.g, r.end), point: r.end }], chainStart: closes ? null : chainStart };
}

/** The four corners of a 3 point centre rectangle: centre `c`, `m` the middle of a side, `p` sets the width. */
export function centreRectCorners3(c: Pt, m: Pt, p: Pt): [Pt, Pt, Pt, Pt] | null {
    const h = sub(m, c);
    if (Math.hypot(h[0], h[1]) < 1e-9) {
        return null;
    }
    const n = unit([-h[1], h[0]]);
    const w = (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1];
    if (Math.abs(w) < 1e-9) {
        return null;
    }
    const wn: Pt = [n[0] * w, n[1] * w];
    return [sub(sub(c, h), wn), sub(add(c, h), wn), add(add(c, h), wn), add(sub(c, h), wn)];
}

/** The four corners of a parallelogram: the first side a→b, then the next corner c; the last one closes it. */
export function parallelogramCorners(a: Pt, b: Pt, c: Pt): [Pt, Pt, Pt, Pt] | null {
    return Math.abs(cross(sub(b, a), sub(c, b))) < 1e-9 ? null : [a, b, c, add(a, sub(c, b))];
}

/** A closed loop of four lines through the corners (refs keep what they snapped to). */
function quad(b: ReturnType<typeof builder>, corners: (PointRef | Pt)[]): { ids: string[]; lines: string[] } {
    const ids = corners.map((q) => b.point(q));
    return { ids, lines: ids.map((id, i) => b.line(id, ids[(i + 1) % 4])) };
}

function rectStep(input: DrawInput): DrawStep {
    const { tool, g, draft, ref } = input;
    const [a, m] = draft;
    const b = builder(g);
    if (tool === 'parallelogram') {
        const corners = parallelogramCorners(a.at, m.at, ref.at);
        if (!corners) {
            return { error: 'The last corner is on the line of the first side, so there is no parallelogram: click it off that line.' };
        }
        const { lines } = quad(b, [a, m, ref, corners[3]]);
        b.rel({ kind: 'parallel', a: lines[0], b: lines[2] });
        b.rel({ kind: 'parallel', a: lines[1], b: lines[3] });
        return { g: b.g, draft: [], chainStart: null };
    }
    const corners = centreRectCorners3(a.at, m.at, ref.at);
    if (!corners) {
        return { error: 'The rectangle would have no width: click the last point off the line of the first side.' };
    }
    const { ids, lines } = quad(b, corners);
    b.rel({ kind: 'parallel', a: lines[0], b: lines[2] });
    b.rel({ kind: 'parallel', a: lines[1], b: lines[3] });
    b.rel({ kind: 'perpendicular', a: lines[0], b: lines[1] });
    // The centre holds the middle of a construction diagonal, as in the centre rectangle.
    const diagonal = b.line(ids[0], ids[2], true);
    b.rel({ kind: 'midpoint', point: b.point(a), line: diagonal });
    return { g: b.g, draft: [], chainStart: null };
}

/** Straight slots: two end centres (or the centre and one end centre), then the width. */
function straightSlotStep(input: DrawInput): DrawStep {
    const { tool, g, draft, ref, options: o, typed } = input;
    const [a, b] = draft;
    const centred = tool === 'centerSlot';
    const ends: [PointRef, PointRef] = centred ? [b, { at: sub(add(a.at, a.at), b.at) }] : [a, b];
    if (dist(ends[0].at, ends[1].at) < 1e-9) {
        return { error: 'The slot needs a length.' };
    }
    const radius = typed?.length ? Math.abs(typed[0]) / 2 : lineDistance(ref.at, ends[0].at, ends[1].at);
    if (!(radius > 1e-9)) {
        return { draft };
    }
    return { g: straightSlot(g, ends[0], ends[1], round(radius), o, centred ? a : null, !!typed?.length), draft: [], chainStart: null };
}

/**
 * A straight slot (lines and end arcs, tangent, the arcs equal) with its construction centreline between the arc
 * centres; `centre` sits at the middle of it. Add dimensions: the width, and the length centre to centre or overall
 * (to two points where the centreline meets the end arcs).
 */
export function straightSlot(g: SketchGeometry, ca: PointRef, cb: PointRef, radius: number, o: DrawOptions, centre: PointRef | null = null,
    typedWidth = false): SketchGeometry {
    const slot = addSlot(g, ca, cb, radius);
    const [arcA, arcB] = slot.arcs.map((id) => curveOf(slot.g, id) as Arc);
    const b = builder(slot.g);
    const axis = b.line(arcA.center, arcB.center, true);
    if (centre) {
        b.rel({ kind: 'midpoint', point: b.point(centre), line: axis });
    }
    const [pa, pb] = [P(b.g, arcA.center), P(b.g, arcB.center)];
    const length = dist(pa, pb);
    if (o.slotDimensions) {
        b.rel({ kind: 'distance', a: arcA.start, b: arcA.end, value: round(2 * radius) });
        if (o.slotOverall) {
            const u = unit(sub(pb, pa));
            const e1 = b.point(add(pa, u, -radius));
            const e2 = b.point(add(pb, u, radius));
            b.rel({ kind: 'pointOnCurve', point: e1, curve: arcA.id });
            b.rel({ kind: 'pointOnCurve', point: e1, curve: axis });
            b.rel({ kind: 'pointOnCurve', point: e2, curve: arcB.id });
            b.rel({ kind: 'pointOnCurve', point: e2, curve: axis });
            b.rel({ kind: 'distance', a: e1, b: e2, value: round(length + 2 * radius) });
        } else {
            b.rel({ kind: 'length', line: axis, value: round(length) });
        }
    } else if (typedWidth) {
        b.rel({ kind: 'radius', curve: arcA.id, value: radius });
    }
    return b.g;
}

/** Arc slots: three points on the arc or its centre, start and end; then the width. */
function arcSlotStep(input: DrawInput): DrawStep {
    const { tool, g, draft, ref, sweep, options: o, typed } = input;
    if (draft.length < 2) {
        return { draft: [...draft, ref] };
    }
    if (draft.length === 2) {
        // Turn the clicks into the arc: its centre, then its start and end counter-clockwise.
        if (tool === 'arcSlot3') {
            const [s, e] = draft;
            const circle = circleThrough(s.at, ref.at, e.at);
            if (!circle) {
                return { error: 'Those three points are in a line; no arc passes through them.' };
            }
            const ccw = cross(sub(ref.at, s.at), sub(e.at, s.at)) > 0;
            return { draft: [{ at: circle.c }, ccw ? s : e, ccw ? e : s] };
        }
        const [c, s] = draft;
        if (Math.abs(sweep) < 1e-6) {
            return { draft };
        }
        const end: PointRef = { at: polar(c.at, dist(c.at, s.at), Math.atan2(s.at[1] - c.at[1], s.at[0] - c.at[0]) + sweep) };
        return { draft: sweep > 0 ? [c, s, end] : [c, end, s] };
    }
    const [c, s, e] = draft;
    const width = typed?.length ? Math.abs(typed[0]) : 2 * Math.abs(dist(ref.at, c.at) - dist(s.at, c.at));
    const built = arcSlot(g, c, s, e, round(width), o);
    return 'error' in built ? built : { g: built, draft: [], chainStart: null };
}

/**
 * An arc slot about the construction arc from `s` to `e` (counter-clockwise round `c`): outer and inner arcs on its
 * centre, end arcs on its ends, tangent where they meet (which makes the end arcs equal). Add dimensions: the arc's radius, the width,
 * and (up to half a turn) the angle between construction lines from the centre to the ends.
 */
export function arcSlot(g: SketchGeometry, c: PointRef, s: PointRef, e: PointRef, width: number, o: DrawOptions): SketchGeometry | { error: string } {
    const r = dist(c.at, s.at);
    const w = width / 2;
    if (!(w > 1e-9)) {
        return { error: 'The slot needs a width.' };
    }
    if (w >= r) {
        return { error: 'The slot is wider than its arc; make it narrower or the arc larger.' };
    }
    const b = builder(g);
    const cid = b.point(c);
    const sid = b.point(s);
    const eid = b.point(e);
    const centre = b.arc(cid, sid, eid, true);
    const across = (p: Pt, k: number) => add(c.at, unit(sub(p, c.at)), k);
    const [oS, iS, oE, iE] = [b.point(across(s.at, r + w)), b.point(across(s.at, r - w)), b.point(across(e.at, r + w)), b.point(across(e.at, r - w))];
    const outer = b.arc(cid, oS, oE);
    const inner = b.arc(cid, iS, iE);
    const capS = b.arc(sid, iS, oS);
    const capE = b.arc(eid, oE, iE);
    for (const [x, y] of [[capS, outer], [capS, inner], [capE, outer], [capE, inner]]) {
        b.rel({ kind: 'tangent', a: x, b: y });
    }
    // The end arcs come out equal without an equal relation: both span the gap between the outer and inner arcs
    // (one would be redundant, and the sketch over defined).
    if (o.slotDimensions) {
        b.rel({ kind: 'radius', curve: centre, value: round(r) });
        b.rel({ kind: 'distance', a: oS, b: iS, value: round(width) });
        let angle = Math.atan2(e.at[1] - c.at[1], e.at[0] - c.at[0]) - Math.atan2(s.at[1] - c.at[1], s.at[0] - c.at[0]);
        angle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (deg(angle) < 179.999) {
            const toS = b.line(cid, sid, true);
            const toE = b.line(cid, eid, true);
            b.rel({ kind: 'angle', a: toS, b: toE, value: round(deg(angle)), reverseA: false, reverseB: false });
        }
    }
    return b.g;
}

function polygonStep(input: DrawInput): DrawStep {
    const { g, draft, ref, sides, typed } = input;
    const centre = draft[0];
    if (dist(centre.at, ref.at) < 1e-9) {
        return { draft };
    }
    const r = addInscribedPolygon(g, centre, ref.at, sides);
    const out = typed?.length ? addConstraint(r.g, { kind: 'radius', curve: r.circle, value: Math.abs(typed[0]) }).g : r.g;
    return { g: out, draft: [], chainStart: null };
}

/**
 * Regular polygon about a construction circle that touches the middle of each side (`mid` is the middle of the
 * first side): sides tangent to the circle and equal. With an even count that still lets a rhombus-like shape
 * through, so the first side is instead held square to a construction line from the centre to its middle (the
 * other sides then make it touch the circle; a relation saying so as well would be redundant).
 */
export function addInscribedPolygon(g: SketchGeometry, center: PointRef, mid: Pt, sides: number): { g: SketchGeometry; circle: string; lines: string[] } {
    const b = builder(g);
    const cid = b.point(center);
    const c = P(b.g, cid);
    const r = dist(c, mid);
    const circle = b.circle(cid, r, true);
    const start = Math.atan2(mid[1] - c[1], mid[0] - c[0]) - Math.PI / sides;
    const corner = r / Math.cos(Math.PI / sides);
    const ids = Array.from({ length: sides }, (_, i) => b.point(polar(c, corner, start + (2 * Math.PI * i) / sides)));
    const lines = ids.map((id, i) => b.line(id, ids[(i + 1) % sides]));
    const even = sides % 2 === 0;
    for (const line of even ? lines.slice(1) : lines) {
        b.rel({ kind: 'tangent', a: line, b: circle });
    }
    for (const line of lines.slice(1)) {
        b.rel({ kind: 'equal', a: lines[0], b: line });
    }
    if (even) {
        // The first side touches the circle at its middle: a construction line from the centre, square to it.
        const m = b.point(polar(c, r, start + Math.PI / sides));
        b.rel({ kind: 'midpoint', point: m, line: lines[0] });
        b.rel({ kind: 'perpendicular', a: b.line(cid, m, true), b: lines[0] });
    }
    return { g: b.g, circle, lines };
}

// ---- After any draw tool: construction lines and construction geometry --------------------------------------

/** Applies the form options that work on whatever the tool drew (`before` is the sketch before it). */
export function finishDrawn(tool: string, before: SketchGeometry, next: SketchGeometry, o: DrawOptions): SketchGeometry {
    if (next === before) {
        return next;
    }
    const old = new Set(before.curves.map((c) => c.id));
    const fresh = (g: SketchGeometry) => g.curves.filter((c) => !old.has(c.id));
    let out = next;
    if (RECT_TOOLS.includes(tool) && o.rectLines !== 'none') {
        out = addRectLines(out, fresh(out), o.rectLines);
    }
    const family = drawFamily(tool);
    if (family && o.construction[family]) {
        const ids = new Set(fresh(out).map((c) => c.id));
        out = { ...out, curves: out.curves.map((c) => (ids.has(c.id) ? { ...c, construction: true } : c)) };
    }
    return out;
}

/** Construction lines in a new rectangle (its first four new lines, in order round it): corner to corner, or between side middles. */
function addRectLines(g: SketchGeometry, fresh: SketchCurve[], mode: RectLines): SketchGeometry {
    const sides = fresh.filter((c): c is Line => c.kind === 'line' && !c.construction).slice(0, 4);
    if (sides.length < 4) {
        return g;
    }
    const b = builder(g);
    if (mode === 'corners') {
        const corners = sides.map((l) => l.a);
        for (const [i, j] of [[0, 2], [1, 3]]) {
            // A centre rectangle already has one diagonal.
            const there = fresh.some((c) => c.kind === 'line' && c.construction
                && ((c.a === corners[i] && c.b === corners[j]) || (c.a === corners[j] && c.b === corners[i])));
            if (!there) {
                b.line(corners[i], corners[j], true);
            }
        }
        return b.g;
    }
    const mids = sides.map((l) => {
        const [p, q] = [P(g, l.a), P(g, l.b)];
        const id = b.point([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
        b.rel({ kind: 'midpoint', point: id, line: l.id });
        return id;
    });
    b.line(mids[0], mids[2], true);
    b.line(mids[1], mids[3], true);
    return b.g;
}

// ---- Preview ------------------------------------------------------------------------------------------------

/**
 * What the click at `cursor` would draw for the tools and options handled here, built by the same code as the
 * click; null leaves the preview to the plain tool.
 */
export function drawPreview(input: Omit<DrawInput, 'ref' | 'kind'> & { cursor: Pt }): NewEntity[] | null {
    const { tool, g, draft, cursor, sweep } = input;
    // The conic keeps its own preview (the curve, its end tangents and Rho).
    if (!draft.length || tool === 'conic') {
        return null;
    }
    const step = placeVariant({ ...input, ref: { at: cursor }, kind: null });
    if (!step) {
        return null;
    }
    if ('g' in step) {
        const old = new Set(g.curves.map((c) => c.id));
        return geometryEntities(step.g).filter((e) => !old.has(e.id)).map(({ id: _id, construction: _c, ...e }) => e as NewEntity);
    }
    const at = draft.map((d) => d.at);
    const last = at[at.length - 1];
    if (tool === 'centerSlot' && at.length === 1) {
        return [{ kind: 'line', a: sub(add(at[0], at[0]), cursor), b: cursor }];
    }
    if (tool === 'arcSlot3' && at.length === 2) {
        return circleThrough(at[0], cursor, at[1]) ? [{ kind: 'arc', a: at[0], b: at[1], m: cursor }] : [{ kind: 'line', a: at[0], b: at[1] }];
    }
    if (tool === 'centerArcSlot' && at.length === 2) {
        const [c, s] = at;
        const r = dist(c, s);
        const from = Math.atan2(s[1] - c[1], s[0] - c[0]);
        return Math.abs(sweep) < 1e-3 ? [{ kind: 'line', a: c, b: s }]
            : [{ kind: 'line', a: c, b: s }, { kind: 'arc', a: s, b: polar(c, r, from + sweep), m: polar(c, r, from + sweep / 2) }];
    }
    return [{ kind: 'line', a: last, b: cursor }];
}

// ---- Parameters of the entity just drawn (the forms' Parameters sections) -----------------------------------

export interface CircleParams { cx: number; cy: number; r: number }
export interface ArcParams { cx: number; cy: number; sx: number; sy: number; ex: number; ey: number; r: number; angle: number }

export function circleParams(g: SketchGeometry, id: string): CircleParams | null {
    const c = curveOf(g, id);
    if (c?.kind !== 'circle' || !pointOf(g, c.center)) {
        return null;
    }
    const [cx, cy] = P(g, c.center);
    return { cx, cy, r: c.radius };
}

export function arcParams(g: SketchGeometry, id: string): ArcParams | null {
    const c = curveOf(g, id);
    if (c?.kind !== 'arc' || !pointOf(g, c.center) || !pointOf(g, c.start) || !pointOf(g, c.end)) {
        return null;
    }
    const [C, S, E] = [P(g, c.center), P(g, c.start), P(g, c.end)];
    let angle = Math.atan2(E[1] - C[1], E[0] - C[0]) - Math.atan2(S[1] - C[1], S[0] - C[0]);
    angle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return { cx: C[0], cy: C[1], sx: S[0], sy: S[1], ex: E[0], ey: E[1], r: dist(C, S), angle: deg(angle) };
}

const moved = (g: SketchGeometry, to: Record<string, Pt>): SketchGeometry =>
    ({ ...g, points: g.points.map((p) => (to[p.id] && p.id !== ORIGIN ? { ...p, u: to[p.id][0], v: to[p.id][1] } : p)) });

/** The circle with a new centre and / or radius (to be solved: relations may hold it). */
export function editCircle(g: SketchGeometry, id: string, p: Partial<CircleParams>): SketchGeometry {
    const c = curveOf(g, id);
    const now = circleParams(g, id);
    if (c?.kind !== 'circle' || !now) {
        return g;
    }
    const out = moved(g, { [c.center]: [p.cx ?? now.cx, p.cy ?? now.cy] });
    return p.r === undefined ? out : { ...out, curves: out.curves.map((k) => (k.id === id ? { ...k, radius: p.r! } : k)) };
}

/**
 * The arc with changed parameters: a new centre moves the whole arc; a new start or end moves that end and puts
 * the other at the new radius on its own angle; a radius moves both ends; an angle moves the end round from the start.
 */
export function editArc(g: SketchGeometry, id: string, p: Partial<ArcParams>): SketchGeometry {
    const c = curveOf(g, id);
    const now = arcParams(g, id);
    if (c?.kind !== 'arc' || !now) {
        return g;
    }
    let C: Pt = [now.cx, now.cy];
    let S: Pt = [now.sx, now.sy];
    let E: Pt = [now.ex, now.ey];
    if (p.cx !== undefined || p.cy !== undefined) {
        const d: Pt = [(p.cx ?? now.cx) - now.cx, (p.cy ?? now.cy) - now.cy];
        [C, S, E] = [add(C, d), add(S, d), add(E, d)];
    }
    const onRadius = (q: Pt, r: number) => add(C, unit(sub(q, C)), r);
    if (p.sx !== undefined || p.sy !== undefined) {
        S = [p.sx ?? S[0], p.sy ?? S[1]];
        E = onRadius(E, dist(C, S));
    }
    if (p.ex !== undefined || p.ey !== undefined) {
        E = [p.ex ?? E[0], p.ey ?? E[1]];
        S = onRadius(S, dist(C, E));
    }
    if (p.r !== undefined) {
        [S, E] = [onRadius(S, p.r), onRadius(E, p.r)];
    }
    if (p.angle !== undefined) {
        E = polar(C, dist(C, S), Math.atan2(S[1] - C[1], S[0] - C[0]) + (p.angle * Math.PI) / 180);
    }
    return moved(g, { [c.center]: C, [c.start]: S, [c.end]: E });
}

export function editPoint(g: SketchGeometry, id: string, x: number, y: number): SketchGeometry {
    return moved(g, { [id]: [x, y] });
}

/** A polygon as the polygon tools draw it: its construction circle, its sides and the values of its form. */
export interface PolygonInfo {
    circle: string;
    lines: string[];
    centre: string;
    inscribed: boolean;
    construction: boolean;
    sides: number;
    cx: number;
    cy: number;
    diameter: number;
    /** Direction of the first corner from the centre, degrees. */
    angle: number;
}

/** The polygon among `curves` (what the tool drew): one construction circle and the lines round it. */
export function polygonInfo(g: SketchGeometry, curves: string[]): PolygonInfo | null {
    const own = curves.map((id) => curveOf(g, id)).filter((c): c is SketchCurve => !!c);
    const circle = own.find((c): c is Extract<SketchCurve, { kind: 'circle' }> => c.kind === 'circle' && !!c.construction);
    // The sides; an even polygon's construction line from the centre is not one.
    const lines = own.filter((c): c is Line => c.kind === 'line' && c.a !== circle?.center && c.b !== circle?.center);
    if (!circle || lines.length < 3 || !pointOf(g, circle.center)) {
        return null;
    }
    const c = P(g, circle.center);
    const first = P(g, lines[0].a);
    const inscribed = Math.abs(dist(c, first) - circle.radius) > 1e-6 * Math.max(1, circle.radius);
    return {
        circle: circle.id, lines: lines.map((l) => l.id), centre: circle.center, inscribed, construction: lines.every((l) => !!l.construction),
        sides: lines.length, cx: c[0], cy: c[1], diameter: 2 * circle.radius, angle: deg(Math.atan2(first[1] - c[1], first[0] - c[0])),
    };
}

/** The polygon drawn again with new values (same centre point while the centre stays). */
export function rebuildPolygon(g: SketchGeometry, info: PolygonInfo,
    next: Pick<PolygonInfo, 'sides' | 'inscribed' | 'cx' | 'cy' | 'diameter' | 'angle'>): { g: SketchGeometry; curves: string[] } | null {
    if (!(next.diameter > 0) || next.sides < 3) {
        return null;
    }
    // Corners go with the sides (unless other curves use them), and the side-middle points; the centre point stays,
    // with its relations, and moves to the new centre.
    const own = new Set([...info.lines, info.circle]);
    const middles = g.constraints.filter((k) => k.kind === 'midpoint' && own.has(k.line)).map((k) => (k as { point: string }).point);
    let stripped = removeItems(g, [...own, ...middles]);
    const old = pointOf(g, info.centre);
    if (old && !pointOf(stripped, info.centre)) {
        const points = [...stripped.points, old];
        const alive = liveIds({ ...stripped, points });
        const back = g.constraints.filter((k) => !stripped.constraints.includes(k) && constraintRefs(k).includes(info.centre)
            && constraintRefs(k).every((id) => alive.has(id)));
        stripped = { ...stripped, points, constraints: [...stripped.constraints, ...back] };
    }
    const centre: Pt = [next.cx, next.cy];
    stripped = moved(stripped, { [info.centre]: centre });
    const ref: PointRef = { at: centre, point: info.centre };
    const r = next.diameter / 2;
    const t = (next.angle * Math.PI) / 180;
    const built = next.inscribed
        ? addInscribedPolygon(stripped, ref, polar(centre, r, t + Math.PI / next.sides), next.sides).g
        : addPolygon(stripped, ref, polar(centre, r, t), next.sides).g;
    const kept = new Set(stripped.curves.map((c) => c.id));
    let out = built;
    if (info.construction) {
        out = { ...out, curves: out.curves.map((c) => (kept.has(c.id) ? c : { ...c, construction: true })) };
    }
    return { g: out, curves: out.curves.filter((c) => !kept.has(c.id)).map((c) => c.id) };
}
