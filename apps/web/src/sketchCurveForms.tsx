// PropertyManagers of the selected ellipse, partial ellipse, spline, parabola or conic (SolidWorks: Ellipse, Spline,
// Parabola and Conic PropertyManagers): Existing and Add relations, For construction and the Parameters of each. They
// open in the left panel when such a curve is selected or has just been drawn; OK applies the values through the
// solver. The line, circle, arc and point forms are in sketchEntityForms.tsx.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { conicAt, conicRhoForRadius, conicShoulderRadius, ellipseAt, ellipseAxes, ellipseParam } from '@jarvis/core/curves';
import type { Field, Result, ToolDef, Values } from './toolDefs';
import { curveOf, pointOf } from './solver';
import { editCurve, replaceGeometry, useSketcher } from './sketcher';
import { CURVE_NOUN, type ExtraCurve, type ExtraKind } from './sketchCurves';
import { addConstraint, newId } from './sketchGeometry';
import { splineForms } from './sketchSplineForms';
import { valueText } from './numberText';
import { conicTangentBothEnds, setConicTangency } from './sketchConicTools';
import { EntityRelations, entityForms } from './sketchEntityForms';

type Pt = [number, number];
const fmt = valueText;
const TAU = 2 * Math.PI;

const vec = (key: string, label: string, section = 'Parameters'): Field => ({ key, label, kind: 'vec', unit: 'mm', axes: ['X', 'Y', ''], section });
const number = (key: string, label: string, unit = 'mm', section = 'Parameters'): Field => ({ key, label, kind: 'number', unit, section });
const construction: Field = { key: 'construction', label: 'For construction', kind: 'check', section: 'Options' };
const axesField: Field = { key: 'axes', label: 'Add construction lines', kind: 'check', section: 'Options' };


function num(v: Values, key: string, label: string): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return n;
}

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};
const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);
const put = (v: Values, key: string, p: Pt) => {
    v[`${key}0`] = fmt(p[0]);
    v[`${key}1`] = fmt(p[1]);
};
const read = (v: Values, key: string, label: string): Pt => [num(v, `${key}0`, `${label} X`), num(v, `${key}1`, `${label} Y`)];

/** The selected curve of this kind, if one is selected. */
function selected(kinds: ExtraKind[]): { g: SketchGeometry; c: ExtraCurve } | null {
    const s = useSketcher.getState();
    const id = s.selection.find((x) => x.type === 'curve')?.id;
    const c = id ? curveOf(s.geometry, id) : undefined;
    return c && (kinds as string[]).includes(c.kind) ? { g: s.geometry, c: c as ExtraCurve } : null;
}

/** Included angle of a partial ellipse, degrees, measured about its centre from start round to end. */
function includedAngle(c: Pt, s: Pt, e: Pt): number {
    const a = Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]);
    return ((((a % TAU) + TAU) % TAU) || TAU) * 180 / Math.PI;
}

function valuesOf(g: SketchGeometry, c: SketchCurve): Values {
    const v: Values = { id: c.id, construction: !!c.construction };
    switch (c.kind) {
        case 'ellipse':
        case 'ellipseArc': {
            const centre = P(g, c.center);
            put(v, 'centre', centre);
            v.r1 = fmt(dist(centre, P(g, c.major)));
            v.r2 = fmt(dist(centre, P(g, c.minor)));
            v.axes = !!axisLines(g, c);
            if (c.kind === 'ellipseArc') {
                put(v, 'start', P(g, c.start));
                put(v, 'end', P(g, c.end));
                v.angle = fmt(includedAngle(centre, P(g, c.start), P(g, c.end)));
            }
            break;
        }
        case 'parabola':
            put(v, 'start', P(g, c.start));
            put(v, 'end', P(g, c.end));
            put(v, 'focus', P(g, c.focus));
            put(v, 'apex', P(g, c.vertex));
            break;
        case 'conic': {
            const [s, e, t] = [P(g, c.start), P(g, c.end), P(g, c.apex)];
            put(v, 'start', s);
            put(v, 'end', e);
            put(v, 'apex', t);
            put(v, 'shoulder', conicAt(s, t, e, c.rho, 0.5));
            v.rho = fmt(c.rho);
            v.radius = fmt(conicShoulderRadius(s, t, e, c.rho));
            v.auto = conicTangentBothEnds(g, c.id);
            break;
        }
        default:
            break;
    }
    return v;
}

/** What OK does: the points' new places and the curve's own values. */
function applyValues(v: Values): Result {
    const s = useSketcher.getState();
    const g = s.geometry;
    const c = curveOf(g, String(v.id ?? ''));
    if (!c) {
        return { text: 'Select the curve again: it is not in the sketch any more.', isError: true };
    }
    const targets: { point: string; u: number; v: number }[] = [];
    const to = (point: string, p: Pt) => targets.push({ point, u: p[0], v: p[1] });
    const patch: Record<string, unknown> = { construction: v.construction ? true : undefined };
    const before = valuesOf(g, c);
    const changed = (...keys: string[]) => keys.some((k) => String(v[k]) !== String(before[k]));
    switch (c.kind) {
        case 'ellipse':
        case 'ellipseArc': {
            if (v.axes && !axisLines(g, c)) {
                // Add construction lines: the two axes as construction lines across the ellipse, halved by its centre.
                const error = replaceGeometry(withAxisLines(g, c));
                if (error) {
                    return { text: error, isError: true };
                }
            }
            const [c0, m0, n0] = [P(g, c.center), P(g, c.major), P(g, c.minor)];
            const centre = read(v, 'centre', 'Centre');
            const r1 = num(v, 'r1', 'Radius 1');
            const r2 = num(v, 'r2', 'Radius 2');
            if (!(r1 > 0 && r2 > 0)) {
                return { text: 'Radius 1 and Radius 2 must be above zero.', isError: true };
            }
            const d1: Pt = [(m0[0] - c0[0]) / (dist(c0, m0) || 1), (m0[1] - c0[1]) / (dist(c0, m0) || 1)];
            const d2: Pt = [(n0[0] - c0[0]) / (dist(c0, n0) || 1), (n0[1] - c0[1]) / (dist(c0, n0) || 1)];
            to(c.center, centre);
            to(c.major, [centre[0] + d1[0] * r1, centre[1] + d1[1] * r1]);
            to(c.minor, [centre[0] + d2[0] * r2, centre[1] + d2[1] * r2]);
            if (c.kind === 'ellipseArc') {
                // The ends stay at the same place round the ellipse unless they were given.
                const e0 = ellipseAxes(c0, m0, dist(c0, n0));
                const e1 = ellipseAxes(centre, [centre[0] + d1[0] * r1, centre[1] + d1[1] * r1], r2);
                const moved = (p: Pt): Pt => ellipseAt(e1, ellipseParam(e0, p) + e0.angle - e1.angle);
                const start = changed('start0', 'start1') ? ellipseAt(e1, ellipseParam(e1, read(v, 'start', 'Start'))) : moved(P(g, c.start));
                let end = changed('end0', 'end1') ? ellipseAt(e1, ellipseParam(e1, read(v, 'end', 'End'))) : moved(P(g, c.end));
                if (changed('angle')) {
                    // Angle: the end turned round the centre from the start by this many degrees.
                    const a = (num(v, 'angle', 'Angle') * Math.PI) / 180;
                    if (!(a > 0 && a < TAU)) {
                        return { text: 'The angle must be between 0 and 360 degrees.', isError: true };
                    }
                    const t = Math.atan2(start[1] - centre[1], start[0] - centre[0]) + a;
                    end = ellipseAt(e1, ellipseParam(e1, [centre[0] + Math.cos(t), centre[1] + Math.sin(t)]));
                }
                to(c.start, start);
                to(c.end, end);
            }
            break;
        }
        case 'parabola': {
            to(c.focus, read(v, 'focus', 'Centre'));
            to(c.vertex, read(v, 'apex', 'Apex'));
            to(c.start, read(v, 'start', 'Start'));
            to(c.end, read(v, 'end', 'End'));
            break;
        }
        case 'conic': {
            const [s, e, t] = [read(v, 'start', 'Start'), read(v, 'end', 'End'), read(v, 'apex', 'Top vertex')];
            // Only the points typed: Auto tangency may move the top vertex itself.
            for (const [key, point, at] of [['start', c.start, s], ['end', c.end, e], ['apex', c.apex, t]] as const) {
                if (changed(`${key}0`, `${key}1`)) {
                    to(point, at);
                }
            }
            let rho = num(v, 'rho', 'Rho');
            if (changed('radius')) {
                const r = conicRhoForRadius(s, t, e, num(v, 'radius', 'Radius of curvature'));
                if (r === null) {
                    return { text: 'No conic with these ends and top vertex has that radius at its shoulder.', isError: true };
                }
                rho = r;
            } else if (changed('shoulder0', 'shoulder1')) {
                // The shoulder slides on the line from the chord's middle to the top vertex: Rho is how far along.
                const q = read(v, 'shoulder', 'Shoulder');
                const m: Pt = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
                const d: Pt = [t[0] - m[0], t[1] - m[1]];
                rho = ((q[0] - m[0]) * d[0] + (q[1] - m[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1);
            }
            if (!(rho > 0 && rho < 1)) {
                return { text: 'Rho must be between 0 and 1 (0.5 is a parabola).', isError: true };
            }
            if (Math.abs(rho - c.rho) > 1e-12 && g.constraints.some((k) => k.kind === 'rho' && k.curve === c.id && !k.driven && !k.suppressed)) {
                return { text: 'A Rho dimension holds Rho: change the dimension instead.', isError: true };
            }
            patch.rho = rho;
            if (!!v.auto !== !!before.auto) {
                // Auto tangency: tangent where the conic joins lines or arcs (the top vertex goes onto both tangents).
                const error = replaceGeometry(setConicTangency(g, c.id, !!v.auto));
                if (error) {
                    return { text: error, isError: true };
                }
            }
            break;
        }
        default:
            break;
    }
    const error = editCurve(c.id, targets, patch);
    return { text: error ?? '', isError: !!error };
}

/** The ellipse's construction axis lines (ending at its axis points, halved by its centre), if it has them. */
function axisLines(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'ellipse' | 'ellipseArc' }>): string[] | null {
    const lines = [c.major, c.minor].map((end) => g.curves.find((k) => k.kind === 'line' && k.construction && (k.a === end || k.b === end)
        && g.constraints.some((r) => r.kind === 'midpoint' && r.point === c.center && r.line === k.id))?.id);
    return lines.every(Boolean) ? (lines as string[]) : null;
}

function withAxisLines(g: SketchGeometry, c: Extract<SketchCurve, { kind: 'ellipse' | 'ellipseArc' }>): SketchGeometry {
    let out = g;
    const centre = P(g, c.center);
    for (const end of [c.major, c.minor]) {
        const e = P(g, end);
        const far = newId('p', out);
        out = { ...out, points: [...out.points, { id: far, u: 2 * centre[0] - e[0], v: 2 * centre[1] - e[1] }] };
        const line = newId('c', out);
        out = { ...out, curves: [...out.curves, { id: line, kind: 'line', a: end, b: far, construction: true }] };
        out = addConstraint(out, { kind: 'midpoint', point: c.center, line }).g;
    }
    return out;
}

function form(kind: ExtraKind, label: string, fields: (v: Values) => Field[]): ToolDef {
    return {
        id: `sk-pm-${kind}`,
        label,
        icon: kind === 'ellipseArc' ? 'partial-ellipse' : kind,
        hint: `the selected ${CURVE_NOUN[kind]}`,
        panel: true,
        width: 300,
        fields: () => {
            const found = selected([kind]);
            return [construction, ...fields(found ? valuesOf(found.g, found.c) : {})];
        },
        defaults: () => {
            const found = selected([kind]);
            return found ? valuesOf(found.g, found.c) : {};
        },
        top: () => (selected([kind]) ? <EntityRelations /> : <p className="tb-note">Select the {CURVE_NOUN[kind]} in the view first.</p>),
        apply: async (v) => {
            try {
                return applyValues(v);
            } catch (e) {
                return { text: e instanceof Error ? e.message : String(e), isError: true };
            }
        },
    };
}

/** The PropertyManagers, opened by id (sk-pm-<kind>) when a curve of that kind is selected or drawn. */
export const curveForms: ToolDef[] = [
    // Line properties, Circle, Arc and Point (sketchEntityForms.tsx).
    ...entityForms,
    form('ellipse', 'Ellipse', () => [axesField, vec('centre', 'Centre'), number('r1', 'Radius 1'), number('r2', 'Radius 2')]),
    form('ellipseArc', 'Partial ellipse', () => [
        axesField, vec('centre', 'Centre'), vec('start', 'Start'), vec('end', 'End'), number('r1', 'Radius 1'), number('r2', 'Radius 2'),
        number('angle', 'Angle', 'deg'),
    ]),
    // Spline and Style spline (sketchSplineForms.tsx), with the Curvature scale and Spline polygon forms.
    ...splineForms,

    form('parabola', 'Parabola', () => [vec('start', 'Start'), vec('end', 'End'), vec('focus', 'Centre (focus)'), vec('apex', 'Apex')]),
    form('conic', 'Conic', () => [
        { key: 'auto', label: 'Auto tangency', kind: 'check', section: 'Options' },
        vec('start', 'Start'), vec('end', 'End'), vec('shoulder', 'Shoulder'), vec('apex', 'Top vertex'), number('rho', 'Rho', ''),
        number('radius', 'Radius of curvature at the shoulder'),
    ]),
];
