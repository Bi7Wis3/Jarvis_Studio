// "Export history for FreeCAD": a FreeCAD Python macro (.FCMacro) that rebuilds parts step by step as a PartDesign
// Body, with the app's step names: sketches as Sketcher sketches with their relations and dimensions, features as
// FreeCAD features. A step FreeCAD cannot express is carried over as solids (what it removed and added, from the
// CAD kernel) so the result is still exactly the app's; the macro says so in a comment and the export report lists it.
// After every step the macro compares the rebuilt body with the app's (volume and size) and reports differences.
// Runs in the CAD worker (it needs the kernel for those solids and checks).

import type {
    AxisRef, CustomSketchPlane, Feature, HelixPath, Part, PlaneRef, PrintSettings, Project, RevolveAxis, Sketch, SketchPlane,
    SketchProfile, Vec3,
} from '@jarvis/core';
import { DEFAULT_PRINT, effectivePart } from '@jarvis/core';
import { holeDimensions } from '@jarvis/core/fasteners';
import { resolveAxis, resolvePlane } from '@jarvis/core/reference';
import { derivedSketch } from '@jarvis/core/derived';
import { combineContext } from '../cad/context.js';
import { errorMessage } from '../cad/build.js';
import { selectedRegions } from '../cad/sketch.js';
import { PRELUDE } from './freecadPrelude.js';
import {
    brep, chamferFlips, delta, edgePoints, facePoint, measure, PartFacts, pickedFaces, sideFaces, stepEdges, threadEdge, toFc,
    upToNextDepth, type Measure,
} from './freecadFacts.js';
import { fcSketch, geometryOfProfiles, num, profileGeometry, seamedGeometry, sketchOfProfiles, str, type FcSketch } from './freecadSketch.js';
import { threadSteps } from './freecadThread.js';

/** How a step came across. */
export type StepHow = 'feature' | 'changed' | 'solid' | 'left out';

export interface StepReport {
    name: string;
    op: string;
    how: StepHow;
    /** The FreeCAD feature, or what differs, or why it is carried over as solids. */
    detail: string;
}

export interface PartExport {
    id: string;
    name: string;
    steps: StepReport[];
    /** The app's finished body, FreeCAD frame (null: no body). */
    expected: Measure | null;
    /** Why the app's own build stopped, when it did. */
    error: string | null;
    /** What of the part (not of a step) does not come across. */
    notes: string[];
}

export interface FreecadExport {
    text: string;
    parts: PartExport[];
}

type P2 = [number, number];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scale3(a, 1 / (Math.hypot(...a) || 1));
const vec = (v: readonly number[]): string => `(${v.map(num).join(', ')})`;
const mm = (n: number): string => `${Math.round(n * 1e6) / 1e6} mm`;
/** Equal gaps for a pattern of `count` (FreeCAD keeps a gap per instance; -1 is "the spacing", and a stale 0 stacks them). */
const gaps = (count: number): string => `[${Array.from({ length: Math.max(1, Math.floor(count) - 1) }, () => '-1.0').join(', ')}]`;

const OP_NAMES: Record<string, string> = {
    extrude: 'extrude', revolve: 'revolve', sketch: 'sketch', loft: 'loft', sweep: 'sweep', fillet: 'fillet', chamfer: 'chamfer',
    shell: 'shell', draft: 'draft', mirror: 'mirror', pattern: 'pattern', plane: 'plane', axis: 'axis', point: 'point',
    thread: 'thread', hole: 'hole', add: 'added shape', cut: 'cut shape', combine: 'combine', split: 'split',
};

/** Placement Python for a plane frame of the part (app frame in, FreeCAD frame out). */
function framePy(origin: Vec3, xDir: Vec3, normal: Vec3): string {
    return `frame(${vec(toFc(origin))}, ${vec(toFc(xDir))}, ${vec(toFc(normal))})`;
}

class StepFailed extends Error {}

/** Where a written sketch sits: its attachment, placement and plane (app frame, offset applied). */
interface SketchEntryPlace {
    support: string;
    placement: string;
    plane: CustomSketchPlane;
}

/** Writes one part's function. */
class PartWriter {
    readonly lines: string[] = [];
    readonly steps: StepReport[] = [];
    /** Python variable of each step's FreeCAD object. */
    private readonly vars = new Map<string, string>();
    /** Sketch steps: their FreeCAD sketch and the concrete app sketch. */
    private readonly sketches = new Map<string, SketchEntryPlace & { v: string; sketch: Sketch; fc: FcSketch }>();
    /** Sketch steps' sketches as the kernel takes them (derived ones resolved), before their planes are. */
    private readonly appSketches = new Map<string, Sketch>();
    /** Steps exported as FreeCAD features that add or remove material (patterns and mirrors can repeat them). */
    private readonly tools = new Set<string>();
    /** The last feature that holds the body (null: none yet). */
    private tip: string | null = null;
    private counter = 0;

    constructor(
        readonly part: Part,
        readonly facts: PartFacts,
        readonly blobs: Map<string, string>,
        readonly key: string,
    ) {}

    private fresh(prefix = 'x'): string {
        this.counter += 1;
        return `${prefix}${this.counter}`;
    }

    private emit(...code: string[]): void {
        this.lines.push(...code.map((c) => `    ${c}`));
    }

    private blob(name: string, text: string): string {
        const id = `${this.key}_${name}`;
        this.blobs.set(id, text);
        return `BLOBS[${str(id)}]`;
    }

    private get features(): Feature[] {
        return this.facts.features;
    }

    // ---- Planes, axes, sketches ----------------------------------------------------------------------------

    /** Support and placement of a plane reference: named planes and plane steps are attached to, others placed by value. */
    private planeSupport(ref: SketchPlane | PlaneRef, index: number, offset = 0): { support: string; placement: string; plane: CustomSketchPlane } {
        const plane = resolvePlane(ref, this.features.slice(0, index), 'plane');
        const origin = add3(plane.origin, scale3(plane.normal, offset));
        const placement = framePy(origin, plane.xDir, plane.normal);
        let support = 'None';
        if (typeof ref === 'string') {
            support = `[(origin(body, ${str({ top: 'XY_Plane', front: 'XZ_Plane', right: 'YZ_Plane' }[ref])}), '')]`;
        } else if ('planeRef' in ref && this.vars.has(ref.planeRef)) {
            support = `[(${this.vars.get(ref.planeRef)}, '')]`;
        }
        return { support, placement, plane: { ...plane, origin } };
    }

    /** A datum line for an axis, made on the spot when it is not a step of its own; returns a LinkSub Python value. */
    private axisLink(axis: AxisRef | Vec3, index: number, label: string): { link: string; direction: Vec3 } {
        if (typeof axis === 'string') {
            const role = { x: 'X_Axis', y: 'Z_Axis', z: 'Y_Axis' }[axis];
            // FreeCAD's Y axis is the app's -Z.
            const direction: Vec3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, -1];
            return { link: `(origin(body, ${str(role)}), [''])`, direction };
        }
        if (!Array.isArray(axis) && 'axisRef' in axis && this.vars.has(axis.axisRef)) {
            return { link: `(${this.vars.get(axis.axisRef)}, [''])`, direction: resolveAxis(axis, this.features.slice(0, index)).direction };
        }
        const resolved = Array.isArray(axis) ? { point: [0, 0, 0] as Vec3, direction: unit(axis) } : resolveAxis(axis, this.features.slice(0, index));
        const v = this.fresh('axis');
        this.emit(`${v} = datum_line(body, ${str(label)}, ${vec(toFc(resolved.point))}, ${vec(toFc(resolved.direction))})`, `${v}.Visibility = False`);
        return { link: `(${v}, [''])`, direction: resolved.direction };
    }

    private planeStep(f: Extract<Feature, { op: 'plane' }>, index: number): StepReport {
        const before = this.features.slice(0, index);
        const plane = resolvePlane({ planeRef: f.id }, [...before, f], 'plane');
        const d = f.definition;
        const base = d.kind === 'offset' || d.kind === 'parallel' || (d.kind === 'angle' && (d.about === 'u' || d.about === 'v')) ? d.base
            : d.kind === 'midplane' ? d.a : null;
        let support = 'None';
        if (base !== null && !(typeof base === 'object' && 'fixedPlane' in base)) {
            support = this.planeSupport(base, index).support;
        }
        const v = this.fresh('plane');
        this.vars.set(f.id, v);
        this.emit(`${v} = datum_plane(body, ${str(f.name ?? f.id)}, ${support}, ${framePy(plane.origin, plane.xDir, plane.normal)})`);
        return support === 'None'
            ? { name: f.name ?? f.id, op: 'plane', how: 'changed', detail: 'Datum plane, placed where the plane is (not linked to what it was made from)' }
            : { name: f.name ?? f.id, op: 'plane', how: 'feature', detail: 'Datum plane on its base plane' };
    }

    private axisStep(f: Extract<Feature, { op: 'axis' }>, index: number): StepReport {
        const resolved = resolveAxis({ axisRef: f.id }, [...this.features.slice(0, index), f]);
        const v = this.fresh('axis');
        this.vars.set(f.id, v);
        this.emit(`${v} = datum_line(body, ${str(f.name ?? f.id)}, ${vec(toFc(resolved.point))}, ${vec(toFc(resolved.direction))})`);
        return { name: f.name ?? f.id, op: 'axis', how: 'changed', detail: 'Datum line, placed where the axis is (not linked to what it was made from)' };
    }

    private pointStep(f: Extract<Feature, { op: 'point' }>): StepReport {
        const v = this.fresh('point');
        this.vars.set(f.id, v);
        this.emit(`${v} = datum_point(body, ${str(f.name ?? f.id)}, ${vec(toFc(f.position))})`);
        return f.definition
            ? { name: f.name ?? f.id, op: 'point', how: 'changed', detail: 'Datum point, placed where Jarvis Studio finds it on the model (not linked to the model)' }
            : { name: f.name ?? f.id, op: 'point', how: 'feature', detail: 'Datum point' };
    }

    /** Writes a sketch; returns its variable. */
    private writeSketch(label: string, sketch: Sketch, index: number, fc: FcSketch = fcSketch(sketch)): SketchEntryPlace & { v: string } {
        const { support, placement, plane } = this.planeSupport(sketch.plane, index, sketch.offset ?? 0);
        const v = this.fresh('sketch');
        this.writeSketchAt(v, label, support, placement, plane, fc);
        return { v, support, placement, plane };
    }

    private writeSketchAt(v: string, label: string, support: string, placement: string, plane: CustomSketchPlane, fc: FcSketch): void {
        const geometry = seamedGeometry(fc, plane.xDir, cross(plane.normal, plane.xDir), plane.normal)
            .map((g) => `        (${g.expr}, ${g.construction ? 'True' : 'False'}),`);
        this.emit(`${v} = sketch(body, ${str(label)}, ${support}, ${placement}, [`);
        this.lines.push(...geometry.map((l) => `    ${l}`));
        this.emit(`], expose=[${fc.expose.join(', ')}])`);
        if (fc.constraints.length) {
            this.emit('sk = ' + v);
            this.emit(`constrain(sk, [`);
            this.lines.push(...fc.constraints.map((c) => `            ${c},`));
            this.emit(`])`);
        }
    }

    private sketchStep(f: Extract<Feature, { op: 'sketch' }>, index: number): StepReport {
        // A derived sketch has its parent's contents on its own plane; FreeCAD sketches cannot follow another sketch.
        let own = f.sketch;
        const notes: string[] = [];
        if (f.sketch.derived) {
            const parent = this.features.find((g) => g.id === f.sketch.derived!.from);
            try {
                own = derivedSketch(f.sketch, this.appSketches.get(f.sketch.derived.from));
                notes.push(`it is derived from ${parent?.name ?? f.sketch.derived.from}: here it is a copy of that sketch on its own plane (not linked)`);
            } catch {
                notes.push('it is derived from a sketch that is gone: its own copy is used');
            }
        }
        this.appSketches.set(f.id, own);
        const sketch = this.concrete(own, index);
        const fc = fcSketch(sketch);
        const written = this.writeSketch(f.name ?? f.id, own, index, fc);
        this.vars.set(f.id, written.v);
        this.sketches.set(f.id, { ...written, sketch, fc });
        notes.push(...fc.notes);
        if (!sketch.geometry) notes.push('it has no relations or dimensions in Jarvis Studio (it was written as profiles)');
        return {
            name: f.name ?? f.id, op: 'sketch', how: notes.length > (sketch.geometry ? 0 : 1) ? 'changed' : 'feature',
            detail: `Sketch${notes.length ? `: ${notes.join('; ')}` : ''}`,
        };
    }

    private concrete(sketch: Sketch, index: number): Sketch {
        const plane = sketch.plane;
        if (plane && typeof plane === 'object' && 'planeRef' in plane) {
            return { ...sketch, plane: resolvePlane(plane, this.features.slice(0, index), 'sketch plane') };
        }
        return sketch;
    }

    /**
     * The Profile of a sketch-based feature: the sketch, some of its edges, or (for regions FreeCAD cannot pick) a
     * copy of the picked regions as a sketch of its own. `notes` collects what differs.
     */
    private profile(source: { sketch?: Sketch; sketchRef?: string }, regions: P2[] | undefined, index: number, label: string,
        notes: string[], single = false): { value: string; sketchVar: string; loops: SketchProfile[] } {
        let entry = source.sketchRef ? this.sketches.get(source.sketchRef) : undefined;
        if (!entry) {
            if (!source.sketch) {
                throw new StepFailed(`its sketch "${source.sketchRef}" is not an earlier sketch step`);
            }
            const sketch = this.concrete(source.sketch, index);
            const fc = fcSketch(sketch);
            const written = this.writeSketch(`${label} sketch`, source.sketch, index, fc);
            entry = { ...written, sketch, fc };
            if (fc.notes.length) notes.push(`its sketch: ${fc.notes.join('; ')}`);
        }
        const parts = selectedRegions(entry.sketch, regions);
        const loops = parts.flatMap((p) => p.profiles);
        if (single && loops.length !== 1) {
            throw new StepFailed(`it needs exactly one closed profile (the sketch has ${loops.length})`);
        }
        const ids = geometryOfProfiles(entry.fc, loops);
        this.emit(`${entry.v}.Visibility = False`);
        if (ids) {
            const all = profileGeometry(entry.fc);
            const whole = ids.length === all.length && all.every((id) => ids.includes(id));
            return {
                value: whole ? entry.v : `(${entry.v}, sketch_edges(${entry.v}, [${ids.join(', ')}]))`,
                sketchVar: entry.v,
                loops,
            };
        }
        // Curves that cross (regions split from them): a sketch of the picked regions on the same plane.
        const copy = sketchOfProfiles(loops);
        const v = this.fresh('sketch');
        this.writeSketchAt(v, `${label} profile`, entry.support, entry.placement, entry.plane, copy);
        this.emit(`${v}.Visibility = False`);
        notes.push('its regions are split from crossing curves, which FreeCAD cannot pick: they are a sketch of their own (a copy, not linked to the original sketch)');
        return { value: v, sketchVar: v, loops };
    }

    // ---- Checks and fallbacks ----------------------------------------------------------------------------------

    private check(v: string, index: number): void {
        const m = measure(this.facts.after(index));
        if (m) {
            this.emit(`check(${v}, ${num(m.volume)}, ${vec(m.box)})`);
        }
    }

    /** Ends a step that made a solid feature `v`. */
    private solidDone(f: Feature, v: string, index: number, tool: boolean): void {
        this.vars.set(f.id, v);
        if (tool) this.tools.add(f.id);
        this.tip = v;
        this.check(v, index);
    }

    /** Carries a step over as solids: what it removed from the body, then what it added. */
    private asSolids(f: Feature, index: number, reason: string): StepReport {
        const name = f.name ?? f.id;
        const before = this.facts.before(index);
        const after = this.facts.after(index);
        const { removed, added } = delta(before, after);
        this.emit(`# ${name}: FreeCAD cannot ${reason}. It is carried over as solids: what it removes and adds.`);
        if (!this.tip && added && !removed) {
            this.emit(`body.BaseFeature = carried(${str(`${name} (solid)`)}, ${this.blob(`s${index}a`, brep(added))})`);
            this.tip = 'body.BaseFeature';
            this.check('body.BaseFeature', index);
            return { name, op: f.op, how: 'solid', detail: `the body's base solid (FreeCAD cannot ${reason})` };
        }
        if (!removed && !added) {
            this.emit(`# (${name} does not change the body.)`);
            return { name, op: f.op, how: 'solid', detail: `nothing (it does not change the body; FreeCAD cannot ${reason})` };
        }
        let v = '';
        if (removed) {
            v = this.fresh('f');
            this.emit(`${v} = boolean(body, ${str(added ? `${name} (removed)` : name)}, 'Cut', carried(${str(`${name} removed`)}, ${this.blob(`s${index}r`, brep(removed))}))`);
        }
        if (added) {
            v = this.fresh('f');
            this.emit(`${v} = boolean(body, ${str(name)}, 'Fuse', carried(${str(`${name} added`)}, ${this.blob(`s${index}a`, brep(added))}))`);
        }
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'solid', detail: `Boolean with solids (FreeCAD cannot ${reason})` };
    }

    // ---- Steps ---------------------------------------------------------------------------------------------

    /** The base body (part shapes other than empty): a sketch body is rebuilt, any other carried over as a solid. */
    writeBase(): StepReport | null {
        const shape = this.part.shape;
        if (shape.kind === 'empty') {
            return null;
        }
        const name = `${this.part.name} base`;
        const base = this.facts.base();
        if (!base) {
            return null;
        }
        this.emit(`# The base body (${shape.kind}) is carried over as a solid.`);
        this.emit(`body.BaseFeature = carried(${str(name)}, ${this.blob('base', brep(base))})`);
        this.tip = 'body.BaseFeature';
        const m = measure(base);
        if (m && !(this.part.features ?? []).length) {
            this.emit(`check(body.BaseFeature, ${num(m.volume)}, ${vec(m.box)})`);
        }
        return { name, op: shape.kind, how: 'solid', detail: `the body's base solid (a ${shape.kind} has no FreeCAD feature that builds it the same way)` };
    }

    step(f: Feature, index: number): StepReport {
        const name = f.name ?? f.id;
        const error = this.facts.built(index + 1).error;
        if (error) {
            throw new StepFailed(`it fails in Jarvis Studio: ${error}`);
        }
        this.emit('', `# ---- ${name} (${OP_NAMES[f.op] ?? f.op})`);
        if (f.suppressed && f.op !== 'sketch') {
            this.emit(`# ${name} is suppressed in Jarvis Studio: left out.`);
            return { name, op: f.op, how: 'left out', detail: 'suppressed' };
        }
        switch (f.op) {
            case 'sketch':
                return this.sketchStep(f, index);
            case 'plane':
                return this.planeStep(f, index);
            case 'axis':
                return this.axisStep(f, index);
            case 'point':
                return this.pointStep(f);
            case 'extrude':
                return this.extrude(f, index);
            case 'revolve':
                return this.revolve(f, index);
            case 'loft':
                return this.loft(f, index);
            case 'sweep':
                return this.sweep(f, index);
            case 'fillet':
                return this.fillet(f, index);
            case 'chamfer':
                return this.chamfer(f, index);
            case 'shell':
                return this.shell(f, index);
            case 'draft':
                return this.draft(f, index);
            case 'mirror':
                return this.mirror(f, index);
            case 'pattern':
                return this.pattern(f, index);
            case 'thread':
                return this.thread(f, index);
            case 'combine':
                return this.asSolids(f, index, 'combine with another part\'s body inside a body; the other part is in the solids');
            case 'split':
                return this.asSolids(f, index, 'split a body with a plane and keep one side');
            case 'hole':
                return this.hole(f, index);
            case 'add':
            case 'cut':
                return this.asSolids(f, index, `${f.op === 'add' ? 'add' : 'cut'} a ${f.shape.kind} placed by position and rotation`);
        }
        return this.asSolids(f, index, 'express this step');
    }

    private extrude(f: Extract<Feature, { op: 'extrude' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        const direction = f.direction ?? 'normal';
        const end = f.end ?? (f.through ? 'throughAll' : 'blind');
        if (f.from) {
            return this.asSolids(f, index, 'start a pad or pocket away from its sketch plane');
        }
        if (f.flipSide && f.mode === 'cut') {
            return this.asSolids(f, index, 'cut away what is outside the profile (flip side to cut)');
        }
        const before = this.facts.before(index);
        const notes: string[] = [];
        const profile = this.profile(f, f.regions, index, name, notes);
        const sketch = f.sketchRef ? this.sketches.get(f.sketchRef)!.sketch : this.concrete(f.sketch!, index);
        const plane = resolvePlane(sketch.plane, [], 'sketch plane');
        const frameOrigin = add3(plane.origin, scale3(plane.normal, sketch.offset ?? 0));
        // How far the body reaches ahead of the sketch plane along `sign` (for a through all boss).
        const reach = (sign: number): number => {
            if (!before) return 0;
            const box = before.boundingBox;
            const [lo, hi] = box.bounds as [Vec3, Vec3];
            box.delete();
            let r = -Infinity;
            for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
                r = Math.max(r, sign * dot([x - frameOrigin[0], y - frameOrigin[1], z - frameOrigin[2]], plane.normal));
            }
            return r;
        };
        const cut = f.mode === 'cut';
        const v = this.fresh('f');
        const props: string[] = [];
        // The kernel's draft narrows along the extrusion when positive; FreeCAD's taper widens when positive.
        const taper = (draft: number | undefined, out: boolean | undefined): number => (out ? draft ?? 0 : -(draft ?? 0));
        /** One direction as FreeCAD Type and Length; `sign` is its way along the sketch normal. */
        const leg = (which: '' | '2', legEnd: string, distance: number | undefined, sign: number, angle: number): void => {
            if (legEnd === 'blind') {
                props.push(`Type${which} = 'Length'`, `Length${which} = ${num(Math.abs(distance ?? 0))}`);
            } else if (legEnd === 'throughAll') {
                if (cut && !angle) {
                    props.push(`Type${which} = 'ThroughAll'`);
                } else {
                    // The kernel extrudes through all to 1 mm past the body's box (and drafts that far).
                    const length = Math.max(reach(sign), 0) + 1;
                    props.push(`Type${which} = 'Length'`, `Length${which} = ${num(length)}`);
                    notes.push(`through all is a blind ${cut ? 'cut' : 'pad'} of ${mm(length)}, as far as Jarvis Studio `
                        + `${angle ? 'drafts it' : 'takes it (1 mm past the body)'}`);
                }
            } else {
                // Up to next: a cut removes the first material it meets; FreeCAD's Up to first stops at the first face
                // instead (on a sketch lying on a face, at once), so a cut goes as deep as that material reaches.
                const depth = cut && !angle && before ? upToNextDepth(sketch, f.regions, before, sign > 0 ? 1 : -1) : null;
                if (depth === Infinity) {
                    props.push(`Type${which} = 'ThroughAll'`);
                    notes.push('up to next is through all (nothing else is ahead of the first material it meets)');
                } else if (depth !== null) {
                    props.push(`Type${which} = 'Length'`, `Length${which} = ${num(depth)}`);
                    notes.push(`up to next is a blind cut of ${mm(depth)}, past the first material it meets and short of the next`);
                } else {
                    props.push(`Type${which} = 'UpToFirst'`);
                }
            }
            if (angle) props.push(`TaperAngle${which} = ${num(angle)}`);
        };
        const angle1 = taper(f.draft, f.draftOutward);
        if (direction === 'symmetric') {
            if (f.second) {
                return this.asSolids(f, index, 'combine mid plane with a second direction');
            }
            if (end === 'throughAll' && (!cut || angle1)) {
                // Two blind directions as far as the kernel goes (plain: the body's box both ways, 1 mm past it).
                const [ahead, behind] = [reach(1), reach(-1)];
                const [l1, l2] = angle1 ? [Math.max(ahead, 0) + 1, Math.max(behind, 0) + 1] : [ahead + 1, behind + 1];
                if (!(l1 > 0 && l2 > 0)) {
                    return this.asSolids(f, index, 'make a mid plane through all pad that starts away from its sketch plane');
                }
                props.push(`SideType = 'Two sides'`, `Type = 'Length'`, `Length = ${num(l1)}`, `Type2 = 'Length'`, `Length2 = ${num(l2)}`);
                if (angle1) props.push(`TaperAngle = ${num(angle1)}`, `TaperAngle2 = ${num(angle1)}`);
                notes.push(`mid plane through all is two blind directions of ${mm(l1)} and ${mm(l2)}, as far as Jarvis Studio takes it`);
            } else {
                props.push(`SideType = 'Symmetric'`);
                leg('', end, f.distance, 1, angle1);
            }
        } else {
            const sign = (direction === 'reverse') !== ((f.distance ?? 0) < 0) ? -1 : 1;
            // A pad goes along the sketch normal, a pocket against it.
            props.push(`Reversed = ${(cut ? sign > 0 : sign < 0) ? 'True' : 'False'}`);
            if (f.second) {
                props.push(`SideType = 'Two sides'`);
                leg('', end, f.distance, sign, angle1);
                leg('2', f.second.end, f.second.distance, -sign, taper(f.second.draft, f.second.draftOutward));
            } else {
                props.push(`SideType = 'One side'`);
                leg('', end, f.distance, sign, angle1);
            }
        }
        this.emit(`${v} = add(body, ${str(cut ? 'PartDesign::Pocket' : 'PartDesign::Pad')}, ${str(name)})`, `${v}.Profile = ${profile.value}`);
        this.emit(...props.map((p) => `${v}.${p}`));
        this.solidDone(f, v, index, true);
        return { name, op: f.op, how: notes.length ? 'changed' : 'feature', detail: `${cut ? 'Pocket' : 'Pad'}${notes.length ? `: ${notes.join('; ')}` : ''}` };
    }

    private revolve(f: Extract<Feature, { op: 'revolve' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        const notes: string[] = [];
        const profile = this.profile(f, f.regions, index, name, notes);
        const sketch = f.sketchRef ? this.sketches.get(f.sketchRef)!.sketch : this.concrete(f.sketch!, index);
        const plane = resolvePlane(sketch.plane, [], 'sketch plane');
        const u = plane.xDir;
        const vDir = cross(plane.normal, plane.xDir);
        const axis: RevolveAxis = f.axis;
        let link: string;
        let direction: Vec3;
        if (axis === 'u' || axis === 'v') {
            link = `(${profile.sketchVar}, [${str(axis === 'u' ? 'H_Axis' : 'V_Axis')}])`;
            direction = axis === 'u' ? u : vDir;
        } else if (typeof axis === 'object' && 'line' in axis) {
            const entry = f.sketchRef ? this.sketches.get(f.sketchRef) : undefined;
            const curve = sketch.geometry?.curves.find((c) => c.id === axis.line);
            // Sketches with geometry have one FreeCAD geometry per curve, in order.
            const geo = sketch.geometry ? sketch.geometry.curves.findIndex((c) => c.id === axis.line) : -1;
            if (!entry || !curve || curve.kind !== 'line' || geo < 0) {
                return this.asSolids(f, index, 'find the revolve axis line in the sketch');
            }
            link = `(${entry.v}, [sketch_axis(${entry.v}, ${geo})])`;
            const p = sketch.geometry!.points;
            const a = p.find((q) => q.id === curve.a) ?? { u: 0, v: 0 };
            const b = p.find((q) => q.id === curve.b) ?? { u: 0, v: 0 };
            direction = unit(add3(scale3(u, b.u - a.u), scale3(vDir, b.v - a.v)));
        } else {
            const made = this.axisLink(axis, index, `${name} axis`);
            link = made.link;
            direction = made.direction;
        }
        // The app's own direction is resolved (u/v/line/axis); FreeCAD turns about the linked axis's direction.
        const resolved = (() => {
            if (axis === 'u') return u;
            if (axis === 'v') return vDir;
            if (typeof axis === 'object' && 'line' in axis) return direction;
            return resolveAxis(axis as AxisRef, this.features.slice(0, index)).direction;
        })();
        const flip = dot(resolved, direction) < 0 ? -1 : 1;
        const angle = f.angle ?? 360;
        const cut = f.mode === 'cut';
        const v = this.fresh('f');
        this.emit(`${v} = add(body, ${str(cut ? 'PartDesign::Groove' : 'PartDesign::Revolution')}, ${str(name)})`, `${v}.Profile = ${profile.value}`,
            `${v}.ReferenceAxis = ${link}`);
        if (f.type === 'midPlane') {
            this.emit(`${v}.Midplane = True`, `${v}.Angle = ${num(Math.abs(angle))}`);
        } else {
            const sign = (f.reverse ? -1 : 1) * Math.sign(angle) * flip;
            this.emit(`${v}.Angle = ${num(Math.abs(angle))}`, `${v}.Reversed = ${sign < 0 ? 'True' : 'False'}`);
            if (f.angle2) {
                this.emit(`${v}.Type = 'TwoAngles'`, `${v}.Angle2 = ${num(f.angle2)}`);
            }
        }
        this.solidDone(f, v, index, true);
        return { name, op: f.op, how: notes.length ? 'changed' : 'feature', detail: `${cut ? 'Groove' : 'Revolution'}${notes.length ? `: ${notes.join('; ')}` : ''}` };
    }

    private loft(f: Extract<Feature, { op: 'loft' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        const notes: string[] = [];
        const sections = f.sections.map((s) => this.profile(s, undefined, index, name, notes, true));
        const cut = f.mode === 'cut';
        const v = this.fresh('f');
        const link = (p: { value: string }): string => (p.value.startsWith('(') ? p.value : `(${p.value}, [''])`);
        this.emit(`${v} = add(body, ${str(cut ? 'PartDesign::SubtractiveLoft' : 'PartDesign::AdditiveLoft')}, ${str(name)})`,
            `${v}.Profile = ${sections[0].value}`,
            `${v}.Sections = [${sections.slice(1).map(link).join(', ')}]`,
            `${v}.Ruled = ${f.ruled ? 'True' : 'False'}`,
            `${v}.Closed = ${f.closed ? 'True' : 'False'}`);
        this.solidDone(f, v, index, true);
        return { name, op: f.op, how: notes.length ? 'changed' : 'feature', detail: `${cut ? 'Subtractive' : 'Additive'} loft${notes.length ? `: ${notes.join('; ')}` : ''}` };
    }

    private sweep(f: Extract<Feature, { op: 'sweep' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        if (f.twist) {
            return this.asSolids(f, index, 'twist a sweep along a straight path');
        }
        if ('helix' in f.path && f.path.helix) {
            return this.helixSweep(f, f.path.helix, index);
        }
        if (!f.profile) {
            return this.asSolids(f, index, 'sweep a circular profile without a profile sketch');
        }
        const notes: string[] = [];
        const profile = this.profile(f.profile, f.regions, index, name, notes);
        const pathSource = f.path as { sketch?: Sketch; sketchRef?: string };
        const pathEntry = pathSource.sketchRef ? this.sketches.get(pathSource.sketchRef) : undefined;
        if (!pathEntry) {
            return this.asSolids(f, index, 'use a path sketch written inside the sweep');
        }
        const open = !!pathEntry.sketch.open?.length;
        const ids = geometryOfProfiles(pathEntry.fc, open ? pathEntry.sketch.open! : pathEntry.sketch.profiles, open);
        if (!ids) {
            return this.asSolids(f, index, 'pick a path made of parts of crossing curves');
        }
        const cut = f.mode === 'cut';
        const v = this.fresh('f');
        this.emit(`${v} = add(body, ${str(cut ? 'PartDesign::SubtractivePipe' : 'PartDesign::AdditivePipe')}, ${str(name)})`,
            `${v}.Profile = ${profile.value}`,
            `${v}.Spine = (${pathEntry.v}, sketch_edges(${pathEntry.v}, [${ids.join(', ')}]))`,
            `${v}.Mode = ${f.orientation === 'keepNormal' ? "'Fixed'" : "'Standard'"}`,
            `${v}.Transition = 'Round corner'`,
            `${pathEntry.v}.Visibility = False`);
        this.solidDone(f, v, index, true);
        return { name, op: f.op, how: notes.length ? 'changed' : 'feature', detail: `${cut ? 'Subtractive' : 'Additive'} pipe${notes.length ? `: ${notes.join('; ')}` : ''}` };
    }

    private helixSweep(f: Extract<Feature, { op: 'sweep' }>, helix: HelixPath, index: number): StepReport {
        const name = f.name ?? f.id;
        if (!f.profile || f.orientation === 'keepNormal') {
            return this.asSolids(f, index, 'sweep along a helix without a profile sketch or with its normal kept constant');
        }
        if (helix.radius !== undefined) {
            return this.asSolids(f, index, 'sweep a profile along a helix of a radius other than the profile\'s distance from the axis');
        }
        const notes: string[] = [];
        const profile = this.profile(f.profile, f.regions, index, name, notes);
        const axis = this.axisLink(helix.axis, index, `${name} axis`);
        const resolved = resolveAxis(helix.axis, this.features.slice(0, index)).direction;
        const cut = f.mode === 'cut';
        const v = this.fresh('f');
        this.emit(`${v} = add(body, ${str(cut ? 'PartDesign::SubtractiveHelix' : 'PartDesign::AdditiveHelix')}, ${str(name)})`,
            `${v}.Profile = ${profile.value}`,
            `${v}.ReferenceAxis = ${axis.link}`,
            `${v}.Mode = 'pitch-turns-angle'`,
            `${v}.Pitch = ${num(helix.pitch)}`,
            `${v}.Turns = ${num(helix.turns)}`,
            `${v}.Angle = ${num(helix.taper ?? 0)}`,
            `${v}.LeftHanded = ${helix.leftHanded ? 'True' : 'False'}`,
            `${v}.Reversed = ${dot(resolved, axis.direction) < 0 ? 'True' : 'False'}`);
        this.solidDone(f, v, index, true);
        return { name, op: f.op, how: notes.length ? 'changed' : 'feature', detail: `${cut ? 'Subtractive' : 'Additive'} helix${notes.length ? `: ${notes.join('; ')}` : ''}` };
    }

    private edgesOf(f: Extract<Feature, { op: 'fillet' | 'chamfer' }>, index: number): ReturnType<typeof stepEdges> {
        const before = this.facts.before(index);
        if (!before) throw new StepFailed('there is no body to work on');
        return stepEdges(before, f);
    }

    private edgeList(edges: ReturnType<typeof stepEdges>): string {
        return `[${edges.map((e) => `[${edgePoints(e).map(vec).join(', ')}]`).join(', ')}]`;
    }

    private fillet(f: Extract<Feature, { op: 'fillet' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        if (f.radius2 !== undefined) {
            return this.asSolids(f, index, 'make a fillet whose radius changes along the edge in a PartDesign body');
        }
        if (!this.tip) throw new StepFailed('there is no body to work on');
        const edges = this.edgesOf(f, index);
        const v = this.fresh('f');
        this.emit(`${v} = add(body, 'PartDesign::Fillet', ${str(name)})`,
            `${v}.Base = (${this.tip}, find_edges(${this.tip}, ${this.edgeList(edges)}))`,
            `${v}.Radius = ${num(f.radius)}`);
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'feature', detail: 'Fillet' };
    }

    private chamfer(f: Extract<Feature, { op: 'chamfer' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        if (!this.tip) throw new StepFailed('there is no body to work on');
        const edges = this.edgesOf(f, index);
        const v = this.fresh('f');
        const props: string[] = [`Size = ${num(f.size)}`];
        if (f.angle !== undefined || f.distance2 !== undefined) {
            const flips = chamferFlips(this.facts.before(index)!, edges, f.side);
            if (flips.some((x) => x !== flips[0])) {
                return this.asSolids(f, index, 'measure one chamfer from the first face of some edges and the second face of others');
            }
            props.push(f.angle !== undefined ? `ChamferType = 'Distance and Angle'` : `ChamferType = 'Two distances'`);
            props.push(f.angle !== undefined ? `Angle = ${num(f.angle)}` : `Size2 = ${num(f.distance2!)}`);
            props.push(`FlipDirection = ${flips[0] ? 'True' : 'False'}`);
        } else {
            props.push(`ChamferType = 'Equal distance'`);
        }
        this.emit(`${v} = add(body, 'PartDesign::Chamfer', ${str(name)})`,
            `${v}.Base = (${this.tip}, find_edges(${this.tip}, ${this.edgeList(edges)}))`, ...props.map((p) => `${v}.${p}`));
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'feature', detail: 'Chamfer' };
    }

    private faceList(faces: ReturnType<typeof sideFaces>): string {
        return `[${faces.map((face) => {
            const [p, area] = facePoint(face);
            return `(${vec(p)}, ${num(area)})`;
        }).join(', ')}]`;
    }

    private shell(f: Extract<Feature, { op: 'shell' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        const before = this.facts.before(index);
        if (!before || !this.tip) throw new StepFailed('there is no body to work on');
        const faces = [...(f.open ?? []).flatMap((side) => sideFaces(before, side)), ...pickedFaces(before, f.remove ?? [])];
        if (!faces.length) {
            return this.asSolids(f, index, 'hollow a body without removing a face (Thickness needs at least one face)');
        }
        const v = this.fresh('f');
        this.emit(`${v} = add(body, 'PartDesign::Thickness', ${str(name)})`,
            `${v}.Base = (${this.tip}, find_faces(${this.tip}, ${this.faceList(faces)}))`,
            `${v}.Value = ${num(f.thickness)}`, `${v}.Mode = 'Skin'`, `${v}.Join = 'Arc'`,
            `${v}.Reversed = ${f.outward ? 'False' : 'True'}`);
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'feature', detail: 'Thickness' };
    }

    private draft(f: Extract<Feature, { op: 'draft' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        const before = this.facts.before(index);
        if (!before || !this.tip) throw new StepFailed('there is no body to work on');
        const faces = [...[...new Set(f.faces ?? [])].flatMap((side) => sideFaces(before, side)), ...pickedFaces(before, f.picked ?? [], f.tangent)];
        let neutral: string;
        if (f.neutralFace) {
            neutral = `(${this.tip}, find_faces(${this.tip}, ${this.faceList(pickedFaces(before, [f.neutralFace]))}))`;
        } else if (f.neutral) {
            const support = this.planeSupport(f.neutral, index).support;
            if (support === 'None') {
                return this.asSolids(f, index, 'use a neutral plane that is not a plane of the body');
            }
            neutral = support.replace(/^\[\((.*), ''\)\]$/, '($1, [\'\'])');
        } else {
            throw new StepFailed('it has no neutral plane');
        }
        const v = this.fresh('f');
        this.emit(`${v} = add(body, 'PartDesign::Draft', ${str(name)})`,
            `${v}.Base = (${this.tip}, find_faces(${this.tip}, ${this.faceList(faces)}))`,
            `${v}.NeutralPlane = ${neutral}`,
            `${v}.Angle = ${num(Math.abs(f.angle))}`,
            `${v}.Reversed = ${(f.angle < 0) !== !!f.flip ? 'True' : 'False'}`);
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'feature', detail: 'Draft' };
    }

    /** A LinkSub to a plane for mirrors: an origin plane or plane step, or a datum made for it. */
    private planeLink(ref: PlaneRef, offset: number, index: number, label: string): string {
        const { support, plane } = this.planeSupport(ref, index, offset);
        if (support !== 'None' && Math.abs(offset) < 1e-12) {
            return support.replace(/^\[\((.*), ''\)\]$/, '($1, [\'\'])');
        }
        const v = this.fresh('plane');
        this.emit(`${v} = datum_plane(body, ${str(label)}, ${support}, ${framePy(plane.origin, plane.xDir, plane.normal)})`, `${v}.Visibility = False`);
        return `(${v}, [''])`;
    }

    private originals(ids: string[] | undefined, index: number): string[] | null {
        const out: string[] = [];
        for (const id of ids ?? []) {
            const step = this.features.find((g) => g.id === id);
            if (!step || step.suppressed) continue;
            if (!this.tools.has(id)) return null;
            out.push(this.vars.get(id)!);
        }
        return out.length ? out : null;
    }

    private mirror(f: Extract<Feature, { op: 'mirror' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        const planes: Record<string, PlaneRef> = { YZ: 'right', XY: 'front', XZ: 'top' };
        const ref = typeof f.plane === 'string' && f.plane in planes ? planes[f.plane] : f.plane as PlaneRef;
        if (f.keepOriginal === false) {
            return this.asSolids(f, index, 'replace a body by its mirror image');
        }
        const whole = !f.features?.length;
        const originals = whole ? [] : this.originals(f.features, index);
        if (!originals) {
            return this.asSolids(f, index, 'mirror steps that were not made as FreeCAD features');
        }
        const link = this.planeLink(ref, f.offset ?? 0, index, `${name} plane`);
        const v = this.fresh('f');
        this.emit(`${v} = add(body, 'PartDesign::Mirrored', ${str(name)})`, `${v}.MirrorPlane = ${link}`);
        if (whole) {
            this.emit(`${v}.TransformMode = 'Whole shape'`);
        } else {
            this.emit(`${v}.Originals = [${originals.join(', ')}]`);
        }
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'feature', detail: 'Mirrored' };
    }

    private pattern(f: Extract<Feature, { op: 'pattern' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        if (f.skip?.length) {
            return this.asSolids(f, index, 'skip instances of a pattern');
        }
        const originals = this.originals(f.features, index);
        if (!originals) {
            return this.asSolids(f, index, 'pattern steps that were not made as FreeCAD features');
        }
        const v = this.fresh('f');
        if (f.kind === 'linear') {
            if (f.seedOnly2) {
                return this.asSolids(f, index, 'repeat only the seed along the second direction');
            }
            const one = this.axisLink(f.direction, index, `${name} direction`);
            const wanted = Array.isArray(f.direction) ? unit(f.direction) : resolveAxis(f.direction, this.features.slice(0, index)).direction;
            const lines = [`${v} = add(body, 'PartDesign::LinearPattern', ${str(name)})`, `${v}.Originals = [${originals.join(', ')}]`,
                `${v}.Direction = ${one.link}`, `${v}.Mode = 'Spacing'`, `${v}.Offset = ${num(Math.abs(f.spacing))}`,
                `${v}.Occurrences = ${Math.floor(f.count)}`, `${v}.Spacings = ${gaps(f.count)}`,
                `${v}.Reversed = ${(dot(wanted, one.direction) < 0) !== ((f.reverse ? -1 : 1) * Math.sign(f.spacing) < 0) ? 'True' : 'False'}`];
            if (f.direction2 !== undefined) {
                const two = this.axisLink(f.direction2, index, `${name} direction 2`);
                const wanted2 = Array.isArray(f.direction2) ? unit(f.direction2) : resolveAxis(f.direction2, this.features.slice(0, index)).direction;
                lines.push(`${v}.Direction2 = ${two.link}`, `${v}.Mode2 = 'Spacing'`, `${v}.Offset2 = ${num(Math.abs(f.spacing2 ?? 0))}`,
                    `${v}.Occurrences2 = ${Math.floor(f.count2 ?? 1)}`, `${v}.Spacings2 = ${gaps(f.count2 ?? 1)}`,
                    `${v}.Reversed2 = ${(dot(wanted2, two.direction) < 0) !== ((f.reverse2 ? -1 : 1) * Math.sign(f.spacing2 ?? 1) < 0) ? 'True' : 'False'}`);
            }
            this.emit(...lines);
        } else {
            const axis = this.axisLink(f.axis, index, `${name} axis`);
            const wanted = resolveAxis(f.axis, this.features.slice(0, index)).direction;
            const equal = f.equal !== false;
            const angle = equal ? f.angle ?? 360 : f.angle ?? 0;
            const sign = (f.reverse ? -1 : 1) * Math.sign(angle) * (dot(wanted, axis.direction) < 0 ? -1 : 1);
            this.emit(`${v} = add(body, 'PartDesign::PolarPattern', ${str(name)})`, `${v}.Originals = [${originals.join(', ')}]`,
                `${v}.Axis = ${axis.link}`, `${v}.Occurrences = ${Math.floor(f.count)}`, `${v}.Spacings = ${gaps(f.count)}`,
                ...(equal ? [`${v}.Mode = 'Extent'`, `${v}.Angle = ${num(Math.abs(angle))}`] : [`${v}.Mode = 'Spacing'`, `${v}.Offset = ${num(Math.abs(angle))}`]),
                `${v}.Reversed = ${sign < 0 ? 'True' : 'False'}`);
        }
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'feature', detail: f.kind === 'linear' ? 'Linear pattern' : 'Polar pattern' };
    }

    /** A hole as a FreeCAD Hole feature: a sketch of its centres square to the drill direction, sized from the tables. */
    private hole(f: Extract<Feature, { op: 'hole' }>, index: number): StepReport {
        const name = f.name ?? f.id;
        const dims = holeDimensions(f.spec, this.facts.print);
        if (dims.nutTrap) {
            return this.asSolids(f, index, 'drill a hole with a hexagonal nut trap');
        }
        const dir = unit(f.direction ?? [0, -1, 0]);
        const centres: Vec3[] = [f.position];
        const repeat = f.repeat;
        if (repeat && repeat.count > 1) {
            for (let i = 1; i < repeat.count; i++) {
                if (repeat.kind === 'linear') {
                    centres.push(add3(f.position, scale3(repeat.step, i)));
                } else {
                    if (Math.abs(Math.abs(dir[1]) - 1) > 1e-9) {
                        return this.asSolids(f, index, 'repeat a hole that is not vertical around the vertical axis');
                    }
                    const [cx, cz] = repeat.centre ?? [0, 0];
                    const sweep = repeat.angle ?? 360;
                    const t = ((sweep / (sweep >= 360 ? repeat.count : repeat.count - 1)) * i * Math.PI) / 180;
                    const [x, z] = [f.position[0] - cx, f.position[2] - cz];
                    // A turn about +Y: x' = x cos + z sin, z' = -x sin + z cos.
                    centres.push([cx + x * Math.cos(t) + z * Math.sin(t), f.position[1], cz - x * Math.sin(t) + z * Math.cos(t)]);
                }
            }
        }
        if (centres.some((c) => Math.abs(dot([c[0] - f.position[0], c[1] - f.position[1], c[2] - f.position[2]], dir)) > 1e-9)) {
            return this.asSolids(f, index, 'drill holes that do not all start on one plane square to the drill');
        }
        // The sketch faces out of the material (a Hole drills against its sketch normal).
        const normal = scale3(dir, -1);
        const seed: Vec3 = Math.abs(normal[0]) > 0.9 ? [0, 0, -1] : [1, 0, 0];
        const xDir = unit(add3(seed, scale3(normal, -dot(seed, normal))));
        const yDir = cross(normal, xDir);
        const local = centres.map((c) => {
            const rel: Vec3 = [c[0] - f.position[0], c[1] - f.position[1], c[2] - f.position[2]];
            return [dot(rel, xDir), dot(rel, yDir)] as P2;
        });
        const sk = this.fresh('sketch');
        const v = this.fresh('f');
        const depth = f.depth ?? dims.depth;
        this.emit(`${sk} = sketch(body, ${str(`${name} centres`)}, None, ${framePy(f.position, xDir, normal)}, [`
            + `${local.map(([x, y]) => `(circle(${num(x)}, ${num(y)}, ${num(dims.diameter / 2)}), False)`).join(', ')}])`,
        `${sk}.Visibility = False`,
        `${v} = add(body, 'PartDesign::Hole', ${str(name)})`,
        `${v}.Profile = ${sk}`,
        `${v}.Threaded = False`,
        `${v}.Diameter = ${num(dims.diameter)}`,
        `${v}.DrillPoint = 'Flat'`,
        ...(depth !== undefined ? [`${v}.DepthType = 'Dimension'`, `${v}.Depth = ${num(depth)}`] : [`${v}.DepthType = 'ThroughAll'`]),
        ...(dims.counterbore ? [`${v}.HoleCutType = 'Counterbore'`, `${v}.HoleCutCustomValues = True`,
            `${v}.HoleCutDiameter = ${num(dims.counterbore.diameter)}`, `${v}.HoleCutDepth = ${num(dims.counterbore.depth)}`] : []),
        ...(dims.countersink && dims.countersink.diameter > dims.diameter ? [`${v}.HoleCutType = 'Countersink'`, `${v}.HoleCutCustomValues = True`,
            `${v}.HoleCutDiameter = ${num(dims.countersink.diameter)}`, `${v}.HoleCutCountersinkAngle = ${num(dims.countersink.angle)}`] : []));
        this.solidDone(f, v, index, true);
        return { name, op: f.op, how: 'feature', detail: `Hole${centres.length > 1 ? ` (${centres.length} centres in its sketch)` : ''}` };
    }

    private thread(f: Extract<Feature, { op: 'thread' }>, index: number): StepReport {
        const before = this.facts.before(index);
        if (!before || !this.tip) throw new StepFailed('there is no body to work on');
        const edge = f.at ? threadEdge(before, f.at) : null;
        const plan = threadSteps(f, edge, this.facts.print);
        if (typeof plan === 'string') {
            return this.asSolids(f, index, plan);
        }
        const name = f.name ?? f.id;
        const v = this.fresh('f');
        const lines = plan.code(v, name, (prefix) => this.fresh(prefix));
        this.emit(...lines);
        this.solidDone(f, v, index, false);
        return { name, op: f.op, how: 'changed', detail: plan.detail };
    }
}

/**
 * A part whose base body is a sketch body, as the same sketch and extrude or revolve steps on an empty part (the
 * kernel builds both alike), so it comes across as FreeCAD features too.
 */
function sketchBaseAsSteps(part: Part): Part {
    const shape = part.shape;
    if (shape.kind !== 'sketch' || !!shape.extrude === !!shape.revolve) {
        return part;
    }
    const sketch: Feature = { id: 'base-sketch', name: 'Base sketch', op: 'sketch', sketch: shape.sketch };
    const body: Feature = shape.extrude
        ? { id: 'base', name: 'Base', op: 'extrude', sketchRef: 'base-sketch', distance: shape.extrude.distance, direction: shape.extrude.direction, mode: 'add' }
        : { id: 'base', name: 'Base', op: 'revolve', sketchRef: 'base-sketch', axis: shape.revolve!.axis, angle: shape.revolve!.angle, mode: 'add' };
    return { ...part, shape: { kind: 'empty' }, features: [sketch, body, ...(part.features ?? [])] };
}

/** A Python identifier part from a name. */
const ident = (s: string): string => s.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'part';

/** Placement Python of a part in the assembly: position, then rotation (three.js XYZ Euler, Z first), Y up to Z up. */
function partPlacement(part: Part): string {
    const [rx, ry, rz] = part.rotation ?? [0, 0, 0];
    const rotation = [
        rx ? `App.Rotation(V(1, 0, 0), ${num(rx)})` : null,
        ry ? `App.Rotation(V(0, 0, 1), ${num(ry)})` : null,
        rz ? `App.Rotation(V(0, 1, 0), ${num(-rz)})` : null,
    ].filter(Boolean) as string[];
    const rot = rotation.length ? rotation.reduce((a, b) => `${a}.multiply(${b})`) : 'App.Rotation()';
    return `App.Placement(V${vec(toFc(part.position ?? [0, 0, 0]))}, ${rot})`;
}

/**
 * The macro for some parts of a project (all when `partIds` is empty). Each part becomes a Body placed where the part
 * is in the assembly; its steps keep the part's own frame.
 */
export function freecadMacro(project: Project, partIds: string[] = []): FreecadExport {
    const print: PrintSettings = project.print ?? DEFAULT_PRINT;
    const chosen = partIds.length ? project.parts.filter((p) => partIds.includes(p.id)) : project.parts;
    if (!chosen.length) {
        throw new Error(partIds.length ? `no part with id ${partIds.join(', ')}` : 'the project has no parts');
    }
    const blobs = new Map<string, string>();
    const functions: string[] = [];
    const parts: PartExport[] = [];
    chosen.forEach((original, n) => {
        const part = sketchBaseAsSteps(effectivePart(original, project.parts));
        const facts = new PartFacts({ shape: part.shape, features: part.features }, print, combineContext(part, project.parts));
        const writer = new PartWriter(part, facts, blobs, `p${n + 1}`);
        const steps: StepReport[] = [];
        let error: string | null = null;
        const base = writer.writeBase();
        if (base) steps.push(base);
        const features = part.features ?? [];
        for (let i = 0; i < features.length; i++) {
            const f = features[i];
            try {
                steps.push(writer.step(f, i));
            } catch (e) {
                const reason = errorMessage(e);
                steps.push({ name: f.name ?? f.id, op: f.op, how: 'left out', detail: reason });
                if (e instanceof StepFailed) {
                    if (reason.startsWith('it fails in Jarvis Studio')) {
                        error = reason;
                        for (const g of features.slice(i + 1)) {
                            steps.push({ name: g.name ?? g.id, op: g.op, how: 'left out', detail: 'after a step that fails in Jarvis Studio' });
                        }
                        break;
                    }
                    continue;
                }
                throw new Error(`${part.name}, step "${f.name ?? f.id}": ${reason}`);
            }
        }
        const fn = `make_${ident(part.name)}_${n + 1}`;
        functions.push(
            `def ${fn}():`,
            `    """${part.name.replace(/"/g, "'")}: ${steps.length} step(s)."""`,
            `    body = new_body(${str(part.name)}, ${partPlacement(original)})`,
            ...writer.lines,
            '    return body',
            '',
            '',
        );
        const notes: string[] = [];
        if (original.repeat && original.repeat.count > 1) {
            notes.push(`its ${original.repeat.count} repeat copies are one body here, placed where the first copy is`);
        }
        if (original.instanceOf) {
            notes.push(`it is an instance of another part here; in FreeCAD it is a body of its own with the same steps`);
        }
        parts.push({ id: original.id, name: part.name, steps, expected: measure(facts.built(features.length).shape), error, notes });
    });
    const summary = parts.flatMap((p) => [
        `#   ${p.name}:`,
        ...p.steps.map((s) => `#     ${s.name} (${OP_NAMES[s.op] ?? s.op}): ${s.how === 'feature' ? s.detail : s.how === 'changed' ? `${s.detail.replace(/^([^:]*): /, '$1, with differences: ')}`
            : s.how === 'solid' ? `carried over as solids: ${s.detail}` : `left out: ${s.detail}`}`),
    ]);
    const text = [
        '# -*- coding: utf-8 -*-',
        `# ${project.name}: part history for FreeCAD, written by Jarvis Studio.`,
        '#',
        '# Run it in FreeCAD 1.1 or later (Macro > Macros..., or freecad.cmd this-file). It makes a new document with one',
        '# PartDesign Body per part, its steps in order with their Jarvis Studio names. Millimetres. Jarvis Studio has Y up',
        '# and FreeCAD Z up: Jarvis Studio\'s Top, Front and Right planes are the body\'s XY, XZ and YZ planes, and a point',
        '# (x, y, z) of the part is (x, -z, y) here.',
        '# After every step the body is compared with Jarvis Studio\'s; any difference is reported in the Report view.',
        '#',
        '# Steps:',
        ...summary,
        '',
        PRELUDE.trim(),
        '',
        '',
        ...functions,
        'BLOBS = {',
        ...[...blobs].map(([k, b]) => `    ${str(k)}: """\n${b}\n""",`),
        '}',
        '',
        `App.newDocument(${str(ident(project.name))})`,
        `App.ActiveDocument.Label = ${str(project.name)}`,
        ...functions.filter((l) => l.startsWith('def ')).map((l) => `${l.slice(4, l.indexOf('('))}()`),
        'finish()',
        '',
    ].join('\n');
    return { text, parts };
}
