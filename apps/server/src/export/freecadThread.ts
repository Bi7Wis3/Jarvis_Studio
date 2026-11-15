// Threads for the FreeCAD history macro, built the way the kernel builds them (build.ts threadFeature): an internal
// thread bores the hole to the major diameter and adds a helical ridge; an external one turns a band off the shaft
// and adds a core with the ridge. The ridge is an AdditiveHelix of the kernel's trapezoid profile in a body of its
// own (patterned for more starts, trimmed to the hole or shaft), joined to the part by a Boolean. FreeCAD's own
// modelled threads exist only in Hole features, with another profile, so they are not used.

import type { Feature, PrintSettings, Vec3 } from '@jarvis/core';
import { num, str } from './freecadSketch.js';
import { toFc } from './freecadFacts.js';

export interface ThreadPlan {
    /** Python lines making the thread; the last feature of the body is `v`. */
    code: (v: string, name: string, fresh: (prefix: string) => string) => string[];
    detail: string;
}

const TAN30 = Math.tan(Math.PI / 6);
const OVERLAP = 0.02;
const MINOR_DEPTH = 1.0825;

const vec = (v: readonly number[]): string => `(${v.map(num).join(', ')})`;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rodrigues rotation of v about unit k by angle (radians). */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/**
 * The thread's own frame as build.ts placeOnAxis makes it: Y along the axis, X where the ridge starts (turned
 * `startAngle` degrees about Y, then the turn that takes -Y onto -axis).
 */
function threadFrame(axis: Vec3, startAngle: number): { x: Vec3; y: Vec3; z: Vec3 } {
    const t = (startAngle * Math.PI) / 180;
    let x: Vec3 = [Math.cos(t), 0, -Math.sin(t)];
    let z: Vec3 = [Math.sin(t), 0, Math.cos(t)];
    const l = Math.hypot(...axis);
    const d: Vec3 = [-axis[0] / l, -axis[1] / l, -axis[2] / l];
    const cos = -d[1];
    if (cos < -1 + 1e-9) {
        x = rotate(x, [1, 0, 0], Math.PI);
        z = rotate(z, [1, 0, 0], Math.PI);
    } else if (cos <= 1 - 1e-9) {
        const k0: Vec3 = [-d[2], 0, d[0]];
        const kl = Math.hypot(...k0);
        const k: Vec3 = [k0[0] / kl, k0[1] / kl, k0[2] / kl];
        const angle = Math.acos(cos);
        x = rotate(x, k, angle);
        z = rotate(z, k, angle);
    }
    return { x, y: [axis[0] / l, axis[1] / l, axis[2] / l], z };
}

const framePy = (origin: Vec3, x: Vec3, n: Vec3): string => `frame(${vec(toFc(origin))}, ${vec(toFc(x))}, ${vec(toFc(n))})`;

/** How a thread step is written, or why it cannot be (then it is carried over as solids). */
export function threadSteps(f: Extract<Feature, { op: 'thread' }>,
    edge: { centre: Vec3; axis: Vec3; radius: number; reach: number; hole: boolean } | null, print: PrintSettings): ThreadPlan | string {
    const pitch = f.pitch;
    const starts = f.starts ?? 1;
    const lead = pitch * starts;
    let origin: Vec3 = f.position ?? [0, 0, 0];
    let axis: Vec3 = [0, 1, 0];
    let diameter = f.diameter;
    let reach = Infinity;
    if (edge) {
        ({ centre: origin, axis, reach } = edge);
        diameter ??= f.kind === 'external' ? 2 * edge.radius : 2 * edge.radius + MINOR_DEPTH * pitch;
    }
    if (diameter === undefined) {
        return 'make a thread without a diameter';
    }
    const back = edge ? f.length2 ?? 0 : 0;
    const offset = (f.offset ?? 0) - back;
    origin = add(origin, scale(axis, offset));
    const forward = f.revolutions !== undefined ? f.revolutions * lead : f.length;
    if (forward === undefined) {
        return 'make a thread without a length';
    }
    const length = forward + back;
    let trim: [number, number] | null = null;
    if (edge) {
        const from = Math.max(offset, 0);
        const to = Math.min(offset + length, reach);
        if (offset < -1e-6 || offset + length > reach + 1e-6) {
            trim = [from - offset, to - offset];
        }
    }
    const [low, high] = trim ?? [0, length];
    const { x, y, z } = threadFrame(axis, f.startAngle ?? 0);
    const at = (t: number): Vec3 => add(origin, scale(y, t));
    const external = f.kind === 'external';
    const rMaj = external ? diameter / 2 : (diameter + print.holeTolerance) / 2;
    const rRoot = rMaj - 0.6134 * pitch;
    // The ridge's trapezoid (build.ts externalRidge / internalRidge), radially from rBase to rCrest.
    const rBase = external ? rRoot - OVERLAP : rMaj + OVERLAP;
    const rCrest = external ? rMaj : rMaj - (MINOR_DEPTH * pitch) / 2;
    const wCrest = external ? pitch / 8 : pitch / 4;
    const wBase = wCrest + 2 * Math.abs(rCrest - rBase) * TAN30;
    const y0 = wBase / 2 + 0.01;
    const height = length - wBase / 2 - 0.01 - y0;
    if (height < pitch || wBase >= pitch * 0.98) {
        return 'make a thread this short for its pitch';
    }
    // The kernel sweeps the ridge along one helix edge, which it only approximates closely up to about 30 turns
    // (40 turns: the ridge 7 % small); FreeCAD's helix is exact, so a longer thread differs from Jarvis Studio's.
    const turns = height / lead;
    const detail = `${external ? 'a band turned off the shaft and a core' : 'the hole bored to the major diameter'} (pocket), `
        + `and the ridge as an additive helix of Jarvis Studio's profile in a body of its own${starts > 1 ? ` (polar pattern of ${starts} starts)` : ''}`
        + `${trim ? ', trimmed to the ' + (external ? 'shaft' : 'hole') : ''}, joined by a Boolean (FreeCAD's own threads are Hole features with another profile)`
        + `${turns > 30 ? `; its ridge runs ${Math.round(turns)} turns, more than Jarvis Studio models exactly (about 30), so FreeCAD's exact ridge `
            + 'differs a little from Jarvis Studio\'s' : ''}`;
    return {
        detail,
        code: (v, name, fresh) => {
            const lines: string[] = [];
            const sk = fresh('sketch');
            const pocket = fresh('f');
            // Bore or band: a pocket from `high` back to `low` (pockets go against their sketch normal).
            const circles = external
                ? `(circle(0.0, 0.0, ${num(rRoot - 0.05)}), False), (circle(0.0, 0.0, ${num(rMaj + 0.05)}), False)`
                : `(circle(0.0, 0.0, ${num(rMaj)}), False)`;
            lines.push(
                `# ${name}: ${external ? 'the band the thread replaces' : 'the bore'}, then the ridge in a body of its own.`,
                `${sk} = sketch(body, ${str(`${name} ${external ? 'band' : 'bore'} sketch`)}, None, ${framePy(at(high), x, y)}, [${circles}])`,
                `${sk}.Visibility = False`,
                `${pocket} = add(body, 'PartDesign::Pocket', ${str(`${name} ${external ? 'band' : 'bore'}`)})`,
                `${pocket}.Profile = ${sk}`,
                `${pocket}.Type = 'Length'`,
                `${pocket}.Length = ${num(high - low)}`,
            );
            const tool = fresh('ridge');
            lines.push(`${tool} = tool_body(${str(`${name} ridge body`)})`);
            if (external) {
                const core = fresh('sketch');
                const pad = fresh('f');
                lines.push(
                    `${core} = sketch(${tool}, ${str(`${name} core sketch`)}, None, ${framePy(at(0), x, y)}, [(circle(0.0, 0.0, ${num(rRoot)}), False)])`,
                    `${core}.Visibility = False`,
                    `${pad} = add(${tool}, 'PartDesign::Pad', ${str(`${name} core`)})`,
                    `${pad}.Profile = ${core}`,
                    `${pad}.Length = ${num(length)}`,
                );
            }
            const profile = fresh('sketch');
            const helix = fresh('f');
            const corners: [number, number][] = [[rBase, y0 - wBase / 2], [rCrest, y0 - wCrest / 2], [rCrest, y0 + wCrest / 2], [rBase, y0 + wBase / 2]];
            const edges = corners.map((p, i) => {
                const q = corners[(i + 1) % 4];
                return `(line(${num(p[0])}, ${num(p[1])}, ${num(q[0])}, ${num(q[1])}), False)`;
            });
            lines.push(
                `${profile} = sketch(${tool}, ${str(`${name} ridge profile`)}, None, ${framePy(origin, x, z)}, [${edges.join(', ')}])`,
                `constrain(${profile}, [('Coincident', 0, 2, 1, 1), ('Coincident', 1, 2, 2, 1), ('Coincident', 2, 2, 3, 1), ('Coincident', 3, 2, 0, 1)])`,
                `${profile}.Visibility = False`,
                `${helix} = add(${tool}, 'PartDesign::AdditiveHelix', ${str(`${name} ridge`)})`,
                `${helix}.Profile = ${profile}`,
                `${helix}.ReferenceAxis = (${profile}, ['V_Axis'])`,
                `${helix}.Mode = 'pitch-height-angle'`,
                `${helix}.Pitch = ${num(lead)}`,
                `${helix}.Height = ${num(height)}`,
                `${helix}.Angle = 0.0`,
                `${helix}.LeftHanded = ${f.leftHanded ? 'True' : 'False'}`,
            );
            if (starts > 1) {
                const pattern = fresh('f');
                lines.push(
                    `${pattern} = add(${tool}, 'PartDesign::PolarPattern', ${str(`${name} starts`)})`,
                    `${pattern}.Originals = [${helix}]`,
                    `${pattern}.Axis = (${profile}, ['V_Axis'])`,
                    `${pattern}.Angle = 360.0`,
                    `${pattern}.Occurrences = ${starts}`,
                );
            }
            if (trim) {
                // What the ridge runs past the hole or shaft is cut off within it.
                const cuts: [number, boolean][] = [];
                if (trim[0] > 1e-9) cuts.push([trim[0], false]);
                if (trim[1] < length - 1e-9) cuts.push([trim[1], true]);
                for (const [t, ahead] of cuts) {
                    const cs = fresh('sketch');
                    const cp = fresh('f');
                    lines.push(
                        `${cs} = sketch(${tool}, ${str(`${name} ${ahead ? 'end' : 'start'} trim sketch`)}, None, ${framePy(at(t), x, y)}, [(circle(0.0, 0.0, ${num(rMaj + pitch)}), False)])`,
                        `${cs}.Visibility = False`,
                        `${cp} = add(${tool}, 'PartDesign::Pocket', ${str(`${name} ${ahead ? 'end' : 'start'} trim`)})`,
                        `${cp}.Profile = ${cs}`,
                        `${cp}.Type = 'ThroughAll'`,
                        `${cp}.Reversed = ${ahead ? 'True' : 'False'}`,
                    );
                }
            }
            lines.push(`${tool}.Visibility = False`, `${v} = boolean(body, ${str(name)}, 'Fuse', ${tool})`);
            return lines;
        },
    };
}
