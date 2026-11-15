// The sketch draw tools as PropertyManager forms (SolidWorks Insert Line, Rectangle, Slot, Circle, Arc, Polygon and
// Point): the form holds the tool's options while clicks in the view draw; its Parameters show the entity just
// drawn (or the one selected before the tool) and change it when edited. OK or Esc ends the tool.

import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import type { SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { pointOf, solveGeometry, solverReady } from './solver';
import { commitGeometry, setDrawOptions, setTool, useSketcher, type DrawTool } from './sketcher';
import {
    arcParams, circleParams, drawFamily, editArc, editCircle, editPoint, polygonInfo, rebuildPolygon, type DrawFamily, type DrawOptions,
} from './sketchDrawVariants';
import { valueText } from './numberText';
import { conicAt, conicRhoForRadius, conicShoulderRadius } from '@jarvis/core/curves';
import { editSlot, setSlotLengthKind, slotAmong, slotParams, type SlotFound } from './sketchSlotParams';
import { rectangleOf, rectTargets, rectValues, type RectFound } from './sketchRectParams';
import type { Target } from './sketchEntityParams';

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

// ---- What the tool just drew ----------------------------------------------------------------------------------

/** The curves and points the open draw tool added last (its Parameters edit them). */
const useDrawn = create<{ curves: string[]; points: string[] }>(() => ({ curves: [], points: [] }));

useSketcher.subscribe((s, prev) => {
    if (s.geometry === prev.geometry || !s.active || !drawFamily(s.tool)) {
        return;
    }
    const oldCurves = new Set(prev.geometry.curves.map((c) => c.id));
    const oldPoints = new Set(prev.geometry.points.map((p) => p.id));
    const curves = s.geometry.curves.filter((c) => !oldCurves.has(c.id)).map((c) => c.id);
    const points = s.geometry.points.filter((p) => !oldPoints.has(p.id)).map((p) => p.id);
    if (curves.length || points.length) {
        useDrawn.setState({ curves, points });
    }
});

const forget = () => useDrawn.setState({ curves: [], points: [] });

// ---- Parameters ------------------------------------------------------------------------------------------------

type Numbers = Record<string, number>;

interface ParamSet {
    fields: Field[];
    /** The values of the entity just drawn, or null when there is none. */
    read: (g: SketchGeometry, drawn: { curves: string[]; points: string[] }) => Numbers | null;
    /** The sketch with the changed values (before solving), or an error. */
    edit?: (g: SketchGeometry, drawn: { curves: string[]; points: string[] }, next: Numbers) => SketchGeometry | string;
    /** Instead of `edit`: where points are pulled for the changed values, the relations moving the rest with them. */
    targets?: (g: SketchGeometry, drawn: { curves: string[]; points: string[] }, next: Numbers, now: Numbers) => Target[] | string;
}

const num = (key: string, label: string, unit = 'mm', extra: Partial<Field> = {}): Field =>
    ({ key, label, kind: 'number', unit, section: 'Parameters', show: (v) => !!v._subject, ...extra });

const lastOf = (g: SketchGeometry, ids: string[], kind: 'circle' | 'arc') =>
    [...ids].reverse().find((id) => g.curves.some((c) => c.id === id && c.kind === kind));

const CIRCLE: ParamSet = {
    fields: [num('p_cx', 'Centre X'), num('p_cy', 'Centre Y'), num('p_r', 'Radius', 'mm', { min: 0 })],
    read: (g, d) => {
        const id = lastOf(g, d.curves, 'circle');
        const p = id ? circleParams(g, id) : null;
        return p && { p_cx: p.cx, p_cy: p.cy, p_r: p.r };
    },
    edit: (g, d, n) => {
        if (!(n.p_r > 0)) {
            return 'The radius must be above zero.';
        }
        return editCircle(g, lastOf(g, d.curves, 'circle')!, { cx: n.p_cx, cy: n.p_cy, r: n.p_r });
    },
};

const ARC_KEYS = { p_cx: 'cx', p_cy: 'cy', p_sx: 'sx', p_sy: 'sy', p_ex: 'ex', p_ey: 'ey', p_r: 'r', p_angle: 'angle' } as const;

const ARC: ParamSet = {
    fields: [
        num('p_cx', 'Centre X'), num('p_cy', 'Centre Y'), num('p_sx', 'Start X'), num('p_sy', 'Start Y'), num('p_ex', 'End X'), num('p_ey', 'End Y'),
        num('p_r', 'Radius', 'mm', { min: 0 }), num('p_angle', 'Angle', 'deg', { min: 0, max: 360 }),
    ],
    read: (g, d) => {
        const id = lastOf(g, d.curves, 'arc');
        const p = id ? arcParams(g, id) : null;
        return p && Object.fromEntries(Object.entries(ARC_KEYS).map(([key, name]) => [key, p[name]]));
    },
    edit: (g, d, n) => {
        if (!(n.p_r > 0) || !(n.p_angle > 0 && n.p_angle < 360)) {
            return 'The radius must be above zero and the angle between 0° and 360°.';
        }
        const id = lastOf(g, d.curves, 'arc')!;
        const now = arcParams(g, id)!;
        // Only what was changed: each parameter moves the arc its own way.
        const patch = Object.fromEntries(Object.entries(ARC_KEYS).filter(([key, name]) => Math.abs(n[key] - now[name]) > 1e-12).map(([key, name]) => [name, n[key]]));
        return editArc(g, id, patch);
    },
};

const POINT: ParamSet = {
    fields: [num('p_x', 'X'), num('p_y', 'Y')],
    read: (g, d) => {
        const p = d.curves.length ? null : d.points.map((id) => pointOf(g, id)).find(Boolean);
        return p ? { p_x: p.u, p_y: p.v } : null;
    },
    edit: (g, d, n) => editPoint(g, d.points[0], n.p_x, n.p_y),
};

const polygonOf = (g: SketchGeometry, d: { curves: string[] }) => (d.curves.length ? polygonInfo(g, d.curves) : null);

const POLYGON: ParamSet = {
    fields: [num('p_cx', 'Centre X'), num('p_cy', 'Centre Y'), num('p_d', 'Circle diameter', 'mm', { min: 0 }), num('p_angle', 'Angle', 'deg')],
    read: (g, d) => {
        const p = polygonOf(g, d);
        return p && { p_cx: p.cx, p_cy: p.cy, p_d: p.diameter, p_angle: p.angle };
    },
    edit: (g, d, n) => {
        const info = polygonOf(g, d)!;
        const o = useSketcher.getState();
        const built = rebuildPolygon(g, info, {
            sides: o.sides, inscribed: o.drawOptions.polygonInscribed, cx: n.p_cx, cy: n.p_cy, diameter: n.p_d, angle: n.p_angle,
        });
        return built ? built.g : 'The diameter must be above zero.';
    },
};

const slotOfDrawn = (g: SketchGeometry, d: { curves: string[] }, kind: SlotFound['kind']): SlotFound | null => {
    const found = d.curves.length ? slotAmong(g, d.curves) : null;
    return found?.kind === kind ? found : null;
};

/** A slot's Parameters (SolidWorks Slot PropertyManager): centre, width, length; arc slots also radius and angle. */
function slotParamSet(kind: SlotFound['kind']): ParamSet {
    const arc = kind === 'arc';
    return {
        fields: [
            num('p_cx', 'Centre X'), num('p_cy', 'Centre Y'), num('p_w', 'Width', 'mm', { min: 0 }), num('p_l', 'Length', 'mm', { min: 0 }),
            ...(arc ? [num('p_r', 'Radius', 'mm', { min: 0 }), num('p_a', 'Angle', 'deg', { min: 0, max: 360 })] : []),
        ],
        read: (g, d) => {
            const found = slotOfDrawn(g, d, kind);
            if (!found) {
                return null;
            }
            const p = slotParams(g, found, useSketcher.getState().drawOptions.slotOverall);
            return { p_cx: p.cx, p_cy: p.cy, p_w: p.width, p_l: p.length, ...(arc ? { p_r: p.radius!, p_a: p.angle! } : {}) };
        },
        edit: (g, d, n) => editSlot(g, slotOfDrawn(g, d, kind)!, {
            cx: n.p_cx, cy: n.p_cy, width: n.p_w, length: n.p_l, ...(arc ? { radius: n.p_r, angle: n.p_a } : {}),
        }, useSketcher.getState().drawOptions.slotOverall),
    };
}

const STRAIGHT_SLOT = slotParamSet('straight');
const ARC_SLOT = slotParamSet('arc');

/** Center to Center or Overall Length chosen with a straight slot just drawn: its length dimension changes over. */
function slotLengthNow(): void {
    const s = useSketcher.getState();
    const found = slotOfDrawn(s.geometry, useDrawn.getState(), 'straight');
    const next = found ? setSlotLengthKind(s.geometry, found, s.drawOptions.slotOverall) : s.geometry;
    if (next !== s.geometry) {
        commitGeometry(next);
    }
}

const conicOf = (g: SketchGeometry, d: { curves: string[] }) => {
    const id = [...d.curves].reverse().find((c) => g.curves.some((k) => k.id === c && k.kind === 'conic'));
    const c = id ? g.curves.find((k) => k.id === id) : undefined;
    return c?.kind === 'conic' ? c : null;
};

/** The Conic PropertyManager's Parameters: ends, shoulder, top vertex, Rho and the radius of curvature at the shoulder. */
const CONIC: ParamSet = {
    fields: [
        num('p_sx', 'Start X'), num('p_sy', 'Start Y'), num('p_ex', 'End X'), num('p_ey', 'End Y'), num('p_hx', 'Shoulder X'), num('p_hy', 'Shoulder Y'),
        num('p_tx', 'Top vertex X'), num('p_ty', 'Top vertex Y'), num('p_rho', 'Rho', '', { min: 0, max: 1 }), num('p_rad', 'Radius of curvature at the shoulder'),
    ],
    read: (g, d) => {
        const c = conicOf(g, d);
        const [s, e, t] = c ? [pointOf(g, c.start), pointOf(g, c.end), pointOf(g, c.apex)] : [];
        if (!c || !s || !e || !t) {
            return null;
        }
        const [S, E, T]: [number, number][] = [[s.u, s.v], [e.u, e.v], [t.u, t.v]];
        const h = conicAt(S, T, E, c.rho, 0.5);
        return { p_sx: S[0], p_sy: S[1], p_ex: E[0], p_ey: E[1], p_hx: h[0], p_hy: h[1], p_tx: T[0], p_ty: T[1], p_rho: c.rho, p_rad: conicShoulderRadius(S, T, E, c.rho) };
    },
    edit: (g, d, n) => {
        const c = conicOf(g, d)!;
        const now = CONIC.read(g, d)!;
        const changed = (...keys: string[]) => keys.some((k) => Math.abs(n[k] - now[k]) > 1e-12);
        const [S, E, T]: [number, number][] = [[n.p_sx, n.p_sy], [n.p_ex, n.p_ey], [n.p_tx, n.p_ty]];
        let rho = n.p_rho;
        if (changed('p_rad')) {
            const r = conicRhoForRadius(S, T, E, n.p_rad);
            if (r === null) {
                return 'No conic with these ends and top vertex has that radius at its shoulder.';
            }
            rho = r;
        } else if (changed('p_hx', 'p_hy')) {
            // The shoulder slides on the line from the chord's middle to the top vertex: Rho is how far along.
            const m: [number, number] = [(S[0] + E[0]) / 2, (S[1] + E[1]) / 2];
            const v: [number, number] = [T[0] - m[0], T[1] - m[1]];
            rho = ((n.p_hx - m[0]) * v[0] + (n.p_hy - m[1]) * v[1]) / (v[0] * v[0] + v[1] * v[1] || 1);
        }
        if (!(rho > 0 && rho < 1)) {
            return 'Rho must be between 0 and 1 (0.5 is a parabola).';
        }
        const moved = editPoint(editPoint(editPoint(g, c.start, S[0], S[1]), c.end, E[0], E[1]), c.apex, T[0], T[1]);
        return { ...moved, curves: moved.curves.map((k) => (k.id === c.id ? { ...c, rho } : k)) };
    },
};

/** Applies edited parameters: solved first, and only if the relations let the values hold. */
function applyParams(set: ParamSet, v: Values): void {
    const s = useSketcher.getState();
    const drawn = useDrawn.getState();
    const now = set.read(s.geometry, drawn);
    if (!now) {
        return;
    }
    const next: Numbers = {};
    for (const key of Object.keys(now)) {
        const text = v[key];
        const n = typeof text === 'string' && text.trim() !== '' ? Number(text) : NaN;
        if (!Number.isFinite(n)) {
            return;
        }
        next[key] = n;
    }
    if (Object.keys(now).every((key) => Math.abs(next[key] - now[key]) < 1e-12)) {
        return;
    }
    if (set.targets) {
        applyTargets(set.targets(s.geometry, drawn, next, now));
        return;
    }
    const edited = set.edit!(s.geometry, drawn, next);
    if (typeof edited === 'string') {
        useSketcher.setState({ message: edited });
        return;
    }
    if (solverReady()) {
        const solved = solveGeometry(edited);
        // Read back from the solved sketch (a rebuilt polygon has new ids: they are what was just drawn now).
        const fresh = edited.curves.filter((c) => !s.geometry.curves.some((k) => k.id === c.id)).map((c) => c.id);
        const subject = fresh.length ? { curves: fresh, points: [] } : drawn;
        const after = solved.ok ? set.read(solved.geometry, subject) : null;
        // Compared with what the edit made (a new radius moves the arc's ends too), not with the old values.
        const meant = set.read(edited, subject);
        if (!after || !meant || Object.keys(meant).some((key) => Math.abs(after[key] - meant[key]) > 1e-6)) {
            useSketcher.setState({ message: 'Relations or dimensions hold that value; change or delete them first.' });
            return;
        }
    }
    commitGeometry(edited);
}

/** Pulls the points to their targets: committed only when every one gets there. */
function applyTargets(targets: Target[] | string): void {
    if (typeof targets === 'string' || !targets.length) {
        useSketcher.setState({ message: typeof targets === 'string' ? targets : null });
        return;
    }
    if (!solverReady()) {
        useSketcher.setState({ message: 'The solver is still loading; try again in a moment.' });
        return;
    }
    const r = solveGeometry(useSketcher.getState().geometry, { targets });
    const reached = r.ok && targets.every((t) => {
        const p = pointOf(r.geometry, t.point);
        return !!p && Math.hypot(p.u - t.u, p.v - t.v) <= 1e-6;
    });
    if (!reached) {
        useSketcher.setState({ message: 'Relations or dimensions hold that value; change or delete them first.' });
        return;
    }
    commitGeometry(r.geometry);
}

const rectOfDrawn = (g: SketchGeometry, d: { curves: string[] }): RectFound | null => (d.curves.length ? rectangleOf(g, d.curves) : null);

/** A rectangle's Parameters (SolidWorks Rectangle PropertyManager): its four corners; the centre kinds also the centre. */
function rectParamSet(centre: boolean): ParamSet {
    const point = (key: string, label: string): Field => ({
        key, label, kind: 'vec', unit: 'mm', axes: ['X', 'Y', ''], section: 'Parameters', show: (v) => !!v._subject,
    });
    return {
        fields: [1, 2, 3, 4].map((i) => point(`p_c${i}`, `Corner ${i}`)).concat(centre ? [point('p_m', 'Centre')] : []),
        read: (g, d) => {
            const r = rectOfDrawn(g, d);
            return r && rectValues(g, r, centre);
        },
        targets: (g, d, next, now) => {
            const r = rectOfDrawn(g, d);
            return r ? rectTargets(g, r, next, now) : 'Draw or select a rectangle first.';
        },
    };
}

// ---- The forms ---------------------------------------------------------------------------------------------------

/** Rectangle type and Slot type in the form: another type opens that tool's form, as the toolbar flyout does. */
const TYPE_KEYS = ['rectType', 'slotType'];

function switchType(from: DrawTool, to: string): void {
    if (to && to !== from && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: `sk-${to}` }));
    }
}

const optionKeys = (fields: Field[]) => fields.filter((f) => !f.key.startsWith('p_') && f.key !== 'sides' && !TYPE_KEYS.includes(f.key)).map((f) => f.key);

/** Form values for the options, from the sketcher. */
function optionValues(family: DrawFamily | null, fields: Field[]): Values {
    const s = useSketcher.getState();
    const o = s.drawOptions as unknown as Record<string, unknown>;
    const out: Values = { _subject: '' };
    for (const f of fields) {
        if (f.key === 'construction') {
            out.construction = !!(family && s.drawOptions.construction[family]);
        } else if (f.key === 'rectAdd') {
            out.rectAdd = s.drawOptions.rectLines !== 'none';
        } else if (f.key === 'rectFrom') {
            out.rectFrom = s.drawOptions.rectLines === 'midpoints' ? 'midpoints' : 'corners';
        } else if (f.key === 'polygonInscribed') {
            out.polygonInscribed = s.drawOptions.polygonInscribed ? 'inscribed' : 'circumscribed';
        } else if (f.key === 'slotOverall') {
            out.slotOverall = s.drawOptions.slotOverall ? 'overall' : 'centre';
        } else if (f.key === 'sides') {
            out.sides = String(s.sides);
        } else if (TYPE_KEYS.includes(f.key)) {
            // The form's own tool (drawForm sets it).
        } else if (f.key.startsWith('p_')) {
            out[f.key] = '';
        } else if (f.kind === 'check') {
            out[f.key] = !!o[f.key];
        } else {
            out[f.key] = f.kind === 'number' ? valueText(Number(o[f.key]) || 0) : String(o[f.key] ?? '');
        }
    }
    return out;
}

/** The sketcher's options from the form's values. */
function toOptions(family: DrawFamily | null, keys: string[], v: Values): Partial<DrawOptions> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        const value = v[key];
        if (key === 'construction') {
            if (family) {
                out.construction = { [family]: !!value };
            }
        } else if (key === 'rectAdd' || key === 'rectFrom') {
            out.rectLines = v.rectAdd ? (v.rectFrom === 'midpoints' ? 'midpoints' : 'corners') : 'none';
        } else if (key === 'polygonInscribed') {
            out.polygonInscribed = value === 'inscribed';
        } else if (key === 'slotOverall') {
            out.slotOverall = value === 'overall';
        } else if (typeof value === 'boolean') {
            out[key] = value;
        } else if (key === 'lineLength' || key === 'lineAngle') {
            const n = Number(value);
            if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(n)) {
                out[key] = key === 'lineLength' ? Math.abs(n) : n;
            }
        } else {
            out[key] = value;
        }
    }
    return out as Partial<DrawOptions>;
}

/** Keeps the sketcher on this tool while the form is open and the Parameters on what it just drew. */
function DrawSession({ tool, api, params }: { tool: DrawTool; api: PopupApi; params: ParamSet | null }) {
    const current = useSketcher((s) => s.tool);
    const g = useSketcher((s) => s.geometry);
    const drawn = useDrawn();
    const seen = useRef(false);
    useEffect(() => {
        // Selected geometry (picked before the tool) is what the Parameters show until something is drawn.
        const selection = useSketcher.getState().selection;
        useDrawn.setState({
            curves: selection.filter((x) => x.type === 'curve').map((x) => x.id),
            points: selection.filter((x) => x.type === 'point').map((x) => x.id),
        });
        if (useSketcher.getState().tool !== tool) {
            setTool(tool);
        }
        return () => {
            forget();
            if (useSketcher.getState().tool === tool) {
                setTool('select');
            }
        };
    }, [tool]);
    useEffect(() => {
        if (current === tool) {
            seen.current = true;
        } else if (seen.current) {
            api.run(async () => ({ text: '', isError: false }));
        }
    }, [current]);
    useEffect(() => {
        const now = params?.read(g, drawn) ?? null;
        const patch: Values = { _subject: now ? 'yes' : '' };
        for (const [key, n] of Object.entries(now ?? {})) {
            const text = api.values[key];
            // Text being typed that already means this value stays as it is ("1." while typing 1.5).
            if (!(typeof text === 'string' && text.trim() !== '' && Math.abs(Number(text) - n) < 1e-9)) {
                patch[key] = valueText(n);
            }
        }
        if (tool === 'polygon' && now) {
            const info = polygonOf(g, drawn);
            if (info) {
                patch.sides = String(info.sides);
                patch.polygonInscribed = info.inscribed ? 'inscribed' : 'circumscribed';
            }
        }
        api.set(patch);
    }, [g, drawn]);
    return null;
}

interface DrawForm {
    tool: DrawTool;
    fields: Field[];
    params?: ParamSet;
    note?: () => ReactNode;
    extra?: (api: PopupApi) => ReactNode;
}

function drawForm({ tool, fields, params, note, extra }: DrawForm): Partial<ToolDef> & { id: string } {
    const family = drawFamily(tool);
    const all = [...fields, ...(params?.fields ?? [])];
    const keys = optionKeys(fields);
    const typeKey = fields.find((f) => TYPE_KEYS.includes(f.key))?.key;
    return {
        id: `sk-${tool}`,
        panel: true,
        width: 300,
        active: (_, s) => s.sketchTool === tool,
        fields: () => all,
        defaults: () => ({ ...optionValues(family, all), ...(typeKey ? { [typeKey]: tool } : {}) }),
        onChange: (key, v) => {
            if (key === typeKey) {
                switchType(tool, String(v[key] ?? ''));
                return;
            }
            if (key.startsWith('p_')) {
                if (params) {
                    applyParams(params, v);
                }
                return;
            }
            if (key === 'sides') {
                const n = Number(v.sides);
                if (!Number.isInteger(n) || n < 3 || n > 40) {
                    useSketcher.setState({ message: 'A polygon has 3 to 40 sides.' });
                    return;
                }
                useSketcher.setState({ sides: n, message: null });
            } else {
                setDrawOptions(toOptions(family, keys, v));
            }
            // A polygon just drawn takes its new side count or circle (SolidWorks edits it until New polygon).
            if (tool === 'polygon' && (key === 'sides' || key === 'polygonInscribed')) {
                rebuildNow();
            }
            // Center to Center or Overall Length works on a straight slot that is there too.
            if (key === 'slotOverall') {
                slotLengthNow();
            }
        },
        top: note ? () => note() : undefined,
        extra: (api) => (
            <>
                <DrawSession tool={tool} api={api} params={params ?? null} />
                {extra?.(api)}
            </>
        ),
        apply: async (): Promise<Result> => ({ text: '', isError: false }),
    };
}

/** Draws the polygon just drawn again with the form's side count and circle kind. */
function rebuildNow(): void {
    const s = useSketcher.getState();
    const info = polygonOf(s.geometry, useDrawn.getState());
    if (!info || (info.sides === s.sides && info.inscribed === s.drawOptions.polygonInscribed)) {
        return;
    }
    const built = rebuildPolygon(s.geometry, info, { ...info, sides: s.sides, inscribed: s.drawOptions.polygonInscribed });
    if (built) {
        commitGeometry(built.g);
    }
}

const construction: Field = { key: 'construction', label: 'For construction', kind: 'check', section: 'Options' };

function lineFields(midpointTool: boolean, centreline: boolean): Field[] {
    const oriented = (v: Values) => v.lineOrientation !== 'sketched';
    // An infinite line has no length: only its angle is a parameter.
    const infinite = (v: Values) => !midpointTool && !!v.lineInfinite;
    return [
        {
            key: 'lineOrientation', label: 'Orientation', kind: 'select', section: 'Orientation',
            options: opts(['sketched', 'As sketched'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['angle', 'Angle']),
        },
        ...(centreline ? [] : [construction]),
        ...(midpointTool ? [] : [{ key: 'lineInfinite', label: 'Infinite length', kind: 'check', section: 'Options' } as Field]),
        ...(midpointTool ? [] : [{ key: 'lineMidpoint', label: 'Midpoint line', kind: 'check', section: 'Options', show: (v: Values) => !infinite(v) } as Field]),
        { key: 'lineLength', label: 'Length', kind: 'number', unit: 'mm', min: 0, section: 'Parameters', show: (v) => oriented(v) && !infinite(v) },
        { key: 'lineAngle', label: 'Angle', kind: 'number', unit: 'deg', section: 'Parameters', show: (v) => v.lineOrientation === 'angle' },
        { key: 'lineDimensions', label: 'Add dimensions', kind: 'check', section: 'Parameters', show: (v) => (infinite(v) ? v.lineOrientation === 'angle' : oriented(v)) },
    ];
}

const LINE_NOTE = () => (
    <p className="tb-note">
        As sketched: click points; double-click or Enter ends the chain. Back over the end and away again (or A) draws a tangent
        arc. Horizontal, vertical and angle lines are one at a time; a length of 0 follows the pointer. Infinite length: two
        clicks give a line through them without end; trim it to give it ends.
    </p>
);

const rectFields: Field[] = [
    {
        key: 'rectType', label: 'Rectangle type', kind: 'select', section: 'Rectangle type',
        options: opts(['rect', 'Corner rectangle'], ['centerRect', 'Centre rectangle'], ['rect3', '3 point corner rectangle'],
            ['centerRect3', '3 point centre rectangle'], ['parallelogram', 'Parallelogram']),
    },
    construction,
    { key: 'rectAdd', label: 'Add construction lines', kind: 'check', section: 'Options' },
    { key: 'rectFrom', label: 'From', kind: 'select', options: opts(['corners', 'Corners'], ['midpoints', 'Midpoints']), section: 'Options', show: (v) => !!v.rectAdd },
];

function slotFields(straight: boolean): Field[] {
    return [
        {
            key: 'slotType', label: 'Slot type', kind: 'select', section: 'Slot type',
            options: opts(['slot', 'Straight slot'], ['centerSlot', 'Centrepoint straight slot'], ['arcSlot3', '3 point arc slot'],
                ['centerArcSlot', 'Centrepoint arc slot']),
        },
        construction,
        { key: 'slotDimensions', label: 'Add dimensions', kind: 'check', section: 'Options' },
        ...(straight ? [{
            key: 'slotOverall', label: 'Length', kind: 'select', section: 'Options',
            options: opts(['centre', 'Centre to centre'], ['overall', 'Overall length']),
        } as Field] : []),
    ];
}

const POLYGON_FIELDS: Field[] = [
    construction,
    { key: 'sides', label: 'Number of sides', kind: 'number', min: 3, max: 40, step: 1, section: 'Parameters' },
    {
        key: 'polygonInscribed', label: 'Circle', kind: 'select', section: 'Parameters',
        options: opts(['inscribed', 'Inscribed circle'], ['circumscribed', 'Circumscribed circle']),
    },
];

function NewPolygon() {
    const has = useDrawn((d) => d.curves.length > 0);
    return (
        <div className="sk-list-actions">
            <button type="button" className="sk-small" disabled={!has} onClick={forget}>New polygon</button>
        </div>
    );
}

const FORMS: (Partial<ToolDef> & { id: string })[] = [
    drawForm({ tool: 'line', fields: lineFields(false, false), note: LINE_NOTE }),
    drawForm({ tool: 'centerline', fields: lineFields(false, true), note: LINE_NOTE }),
    drawForm({ tool: 'midpointLine', fields: lineFields(true, false) }),
    ...(['rect', 'centerRect', 'rect3', 'centerRect3', 'parallelogram'] as const).map((tool) => drawForm({
        tool, fields: rectFields, params: rectParamSet(tool === 'centerRect' || tool === 'centerRect3'),
    })),
    drawForm({ tool: 'slot', fields: slotFields(true), params: STRAIGHT_SLOT }),
    drawForm({ tool: 'centerSlot', fields: slotFields(true), params: STRAIGHT_SLOT }),
    drawForm({ tool: 'arcSlot3', fields: slotFields(false), params: ARC_SLOT }),
    drawForm({ tool: 'centerArcSlot', fields: slotFields(false), params: ARC_SLOT }),
    ...(['circle', 'perimeterCircle'] as const).map((tool) => drawForm({ tool, fields: [construction], params: CIRCLE })),
    ...(['arc', 'centerArc', 'tangentArc'] as const).map((tool) => drawForm({ tool, fields: [construction], params: ARC })),
    drawForm({ tool: 'polygon', fields: POLYGON_FIELDS, params: POLYGON, extra: () => <NewPolygon /> }),
    drawForm({ tool: 'point', fields: [], params: POINT }),
    drawForm({
        tool: 'conic', params: CONIC,
        fields: [construction, { key: 'conicAutoTangency', label: 'Auto tangency', kind: 'check', section: 'Options' }],
        note: () => (
            <p className="tb-note">
                Both ends, the top vertex (where the end tangents meet), then Rho. Auto tangency: with both ends on the ends of
                lines or arcs, the top vertex comes from their tangents and the conic is tangent to them.
            </p>
        ),
    }),
];

/** A draw tool's toolbar entry with its form (in place of the plain click tool); other tools are returned as they are. */
export function withDrawForm(tool: ToolDef): ToolDef {
    const form = FORMS.find((f) => f.id === tool.id);
    return form ? { ...tool, instant: undefined, ...form } : tool;
}
