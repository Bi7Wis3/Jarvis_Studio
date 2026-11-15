// The spline forms in the left panel (SolidWorks: Spline, Style Spline, Curvature Scale and Spline Polygon
// PropertyManagers) and the Spline Tools commands: Add Tangency Control, Add Curvature Control, Show Curvature
// Combs, Show Inflection Points, Show Minimum Radius, Show Spline Handles, Display Control Polygon and Convert Spline
// Types, with their right-click entries and the spline settings of Sketch settings.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import type { MenuEntry } from './menus';
import type { Pick } from './sketchGeometry';
import { curveOf, pointOf } from './solver';
import { replaceGeometry, startInsertPoint, useSketcher } from './sketcher';
import { closedSpline, styleDegree } from './sketchCurves';
import { setStyleSplineType } from './sketchConics';
import { ownerOf } from './sketchItems';
import {
    curvatureAtPoint, handleEdit, handleInfo, handleValues, movePolygonVertex, resetAllHandles, resetHandle, setCurvature, solvedSpline,
    splinePointIds, splinePolygon, splineToStyle, styleToSpline, activateHandle, type Spline, type StyleSpline,
} from './sketchSplines';
import {
    DEFAULT_SPLINE_OPTIONS, polygonShown, setCurvatureScale, setSplineOptions, solveWithTargets, startAddControl, toggleShown, togglePolygon,
    useSplineView, type SplineOptions,
} from './sketchSplineTools';
import { valueText } from './numberText';
import './sketchSplines.css';

type Pt = [number, number];
const fmt = valueText;
const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });
const DEG = 180 / Math.PI;

function num(v: Values, key: string, label: string): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return n;
}

/** The selected curve of this kind (a curve, or a point of it), if one is selected. */
function selectedOf<K extends 'spline' | 'styleSpline'>(kind: K): { g: SketchGeometry; c: Extract<SketchCurve, { kind: K }> } | null {
    const s = useSketcher.getState();
    const g = s.geometry;
    for (const x of s.selection) {
        const c = x.type === 'curve' ? curveOf(g, x.id) : undefined;
        if (c?.kind === kind) {
            return { g, c: c as Extract<SketchCurve, { kind: K }> };
        }
    }
    const picked = useSplineView.getState().picked;
    const c = picked ? curveOf(g, picked.curve) : undefined;
    return c?.kind === kind ? { g, c: c as Extract<SketchCurve, { kind: K }> } : null;
}

/** The values a form opened with (to tell what was changed in it from what was dragged in the view meanwhile). */
const BASE = '_base';
const withBase = (v: Values): Values => ({ ...v, [BASE]: JSON.stringify(v) });
function changedIn(v: Values): (key: string) => boolean {
    let base: Values = {};
    try {
        base = JSON.parse(String(v[BASE] ?? '{}'));
    } catch {
        base = {};
    }
    return (key) => String(v[key] ?? '') !== String(base[key] ?? '');
}

// ---- Spline PropertyManager -------------------------------------------------------------------------------------

function splineValues(g: SketchGeometry, c: Spline): Values {
    const view = useSplineView.getState();
    const solved = solvedSpline(g, c);
    const ids = splinePointIds(c);
    const picked = view.picked?.curve === c.id ? Math.min(view.picked.index, ids.length - 1) : 0;
    const v: Values = {
        id: c.id, construction: !!c.construction, showCurvature: view.combs.includes(c.id), continuity: c.continuity !== false,
        proportional: !!c.proportional, scale: fmt(view.scale), density: String(view.density), point: String(picked), count: String(ids.length),
        relax: !!c.spacing,
    };
    ids.forEach((id, i) => {
        const p = pointOf(g, id);
        v[`x${i}`] = fmt(p?.u ?? 0);
        v[`y${i}`] = fmt(p?.v ?? 0);
        const h = solved ? handleInfo(g, c, i, solved) : null;
        if (!h) {
            return;
        }
        const hv = handleValues(h);
        v[`drive${i}`] = h.active;
        v[`dir${i}`] = fmt(hv.angle * DEG);
        if (hv.before !== null) {
            v[`w1_${i}`] = fmt(hv.before);
        }
        if (hv.after !== null) {
            v[`w2_${i}`] = fmt(hv.after);
        }
        v[`curv${i}`] = h.curvature !== null;
        const k = h.curvature ?? (solved ? curvatureAtPoint(solved, i).after ?? curvatureAtPoint(solved, i).before : 0) ?? 0;
        v[`k${i}`] = fmt(k);
        v[`rc${i}`] = Math.abs(k) > 1e-15 ? fmt(1 / Math.abs(k)) : '';
    });
    return withBase(v);
}

function splineFields(v: Values): Field[] {
    const n = Number(v.count ?? 0);
    const at = (i: number) => (x: Values) => String(x.point) === String(i);
    const out: Field[] = [
        { key: 'construction', label: 'For construction', kind: 'check', section: 'Options' },
        { key: 'showCurvature', label: 'Show curvature', kind: 'check', section: 'Options' },
        { key: 'continuity', label: 'Maintain internal continuity', kind: 'check', section: 'Options' },
        { key: 'scale', label: 'Scale', kind: 'number', unit: '%', min: 0, step: 10, section: 'Curvature scale', show: (x) => !!x.showCurvature },
        { key: 'density', label: 'Density', kind: 'number', min: 2, step: 5, section: 'Curvature scale', show: (x) => !!x.showCurvature },
        {
            key: 'point', label: 'Spline point number', kind: 'select', section: 'Parameters',
            options: Array.from({ length: n }, (_, i) => ({ value: String(i), label: String(i + 1) })),
        },
    ];
    for (let i = 0; i < n; i++) {
        const show = at(i);
        // Weighting and direction set the handle once Tangent driving is on.
        const driven = (x: Values) => show(x) && !!x[`drive${i}`];
        out.push(
            { key: `x${i}`, label: 'X coordinate', kind: 'number', unit: 'mm', section: 'Parameters', show },
            { key: `y${i}`, label: 'Y coordinate', kind: 'number', unit: 'mm', section: 'Parameters', show },
            { key: `rc${i}`, label: 'Radius of curvature', kind: 'number', unit: 'mm', min: 0, section: 'Parameters', show: (x) => show(x) && !!x[`curv${i}`] },
            { key: `k${i}`, label: 'Curvature', kind: 'number', unit: '1/mm', section: 'Parameters', show: (x) => show(x) && !!x[`curv${i}`] },
            { key: `w1_${i}`, label: 'Tangent weighting 1 (before the point)', kind: 'number', unit: 'mm', min: 0, section: 'Parameters', show: (x) => driven(x) && `w1_${i}` in x },
            { key: `w2_${i}`, label: 'Tangent weighting 2 (after the point)', kind: 'number', unit: 'mm', min: 0, section: 'Parameters', show: (x) => driven(x) && `w2_${i}` in x },
            { key: `dir${i}`, label: 'Tangent radial direction', kind: 'number', unit: 'deg', section: 'Parameters', show: driven },
            { key: `drive${i}`, label: 'Tangent driving', kind: 'check', section: 'Parameters', show },
        );
    }
    out.push({ key: 'proportional', label: 'Proportional', kind: 'check', section: 'Parameters' });
    return out;
}

/** What OK does in the Spline form: what was changed in it, through the solver. */
function applySpline(v: Values): Result {
    const s = useSketcher.getState();
    let g = s.geometry;
    const c0 = curveOf(g, String(v.id ?? ''));
    if (c0?.kind !== 'spline') {
        return ok('Select the spline again: it is not in the sketch any more.');
    }
    let c: Spline = c0;
    const changed = changedIn(v);
    const ids = splinePointIds(c);
    const set = (next: Spline) => {
        c = next;
        g = { ...g, curves: g.curves.map((k) => (k.id === c.id ? c : k)) };
    };
    set({
        ...c, ...(v.construction ? { construction: true } : { construction: undefined }),
        continuity: v.continuity ? undefined : false, proportional: v.proportional ? true : undefined,
    });
    if (changed('showCurvature')) {
        toggleShown('combs', [c.id], !!v.showCurvature);
    }
    if (changed('scale') || changed('density')) {
        const scale = num(v, 'scale', 'Scale');
        const density = num(v, 'density', 'Density');
        if (!(scale > 0) || !(density >= 2)) {
            return ok('Scale must be above zero and Density at least 2.');
        }
        setCurvatureScale(scale, density);
    }
    // Spline points first (their handles go with them), then handles and curvatures.
    const moves = ids.flatMap((id, i) => (changed(`x${i}`) || changed(`y${i}`)
        ? [{ point: id, u: num(v, `x${i}`, `Point ${i + 1} X`), v: num(v, `y${i}`, `Point ${i + 1} Y`) }] : []));
    if (moves.length) {
        const r = solveWithTargets(g, moves);
        if (!r || r.miss > 1e-6) {
            return ok('Its relations and dimensions do not let the spline points go there; change or delete them first.');
        }
        g = r.geometry;
        c = curveOf(g, c.id) as Spline;
    }
    for (let i = 0; i < ids.length; i++) {
        if (changed(`drive${i}`)) {
            if (v[`drive${i}`]) {
                const r = activateHandle(g, c, i);
                g = r.g;
                c = r.c;
            } else {
                g = resetHandle(g, c, i);
                c = curveOf(g, c.id) as Spline;
                continue;
            }
        }
        const edits: { angle?: number; before?: number; after?: number } = {};
        if (changed(`dir${i}`)) {
            edits.angle = num(v, `dir${i}`, 'Tangent radial direction') / DEG;
        }
        if (changed(`w1_${i}`)) {
            edits.before = num(v, `w1_${i}`, 'Tangent weighting 1');
        }
        if (changed(`w2_${i}`)) {
            edits.after = num(v, `w2_${i}`, 'Tangent weighting 2');
        }
        if (Object.keys(edits).length) {
            const r = handleEdit(g, c, i, edits);
            if ('error' in r) {
                return ok(r.error);
            }
            const solved = solveWithTargets(r.g, r.targets);
            if (!solved || solved.miss > 1e-6) {
                return ok('Relations on the handle do not let it turn or stretch that way.');
            }
            g = solved.geometry;
            c = curveOf(g, c.id) as Spline;
        }
        if (changed(`rc${i}`) || changed(`k${i}`)) {
            let k: number;
            if (changed(`k${i}`)) {
                k = num(v, `k${i}`, 'Curvature');
            } else {
                const rc = num(v, `rc${i}`, 'Radius of curvature');
                if (!(rc > 0)) {
                    return ok('Radius of curvature must be above zero.');
                }
                const before = Number(v[`k${i}`]);
                k = (before < 0 ? -1 : 1) / rc;
            }
            const r = setCurvature(g, c, i, k);
            g = r.g;
            c = r.c;
        }
    }
    const error = replaceGeometry(g);
    if (error) {
        return ok(error);
    }
    const solved = solvedSpline(useSketcher.getState().geometry, curveOf(useSketcher.getState().geometry, c.id) as Spline);
    if (solved?.unmet.length) {
        useSketcher.setState({ message: `The curvature at spline point ${solved.unmet.map((i) => i + 1).join(', ')} cannot hold: it needs a free spline point beside it (insert one).` });
    }
    return ok(null);
}

function SplineButtons({ api }: { api: PopupApi }) {
    const found = selectedOf('spline');
    if (!found) {
        return null;
    }
    const { c } = found;
    const i = Number(api.values.point ?? 0);
    const refresh = () => {
        const now = useSketcher.getState().geometry;
        const k = curveOf(now, c.id);
        if (k?.kind === 'spline') {
            api.set(splineValues(now, k));
        }
    };
    const act = (make: (g: SketchGeometry, c: Spline) => SketchGeometry) => () => {
        const g = useSketcher.getState().geometry;
        const k = curveOf(g, c.id);
        if (k?.kind !== 'spline') {
            return;
        }
        const error = replaceGeometry(make(g, k));
        if (error) {
            useSketcher.setState({ message: error });
        }
        refresh();
    };
    const unmet = solvedSpline(found.g, c)?.unmet ?? [];
    return (
        <>
            <div className="sp-row">
                <button type="button" className="sk-small" title="Returns the handle at this spline point to following the curve" onClick={act((g, k) => resetHandle(g, k, i))}>
                    Reset this handle
                </button>
                <button type="button" className="sk-small" title="Returns every handle and curvature control of the spline to following the curve" onClick={act((g, k) => resetAllHandles(g, k))}>
                    Reset all handles
                </button>
                <button type="button" className="sk-small" disabled={!c.spacing}
                    title="Re-parameterises the spline by its chord lengths (smooths it after dragging the control polygon)" onClick={act((g, k) => ({ ...g, curves: g.curves.map((x) => (x.id === k.id ? { ...k, spacing: undefined } : x)) }))}>
                    Relax spline
                </button>
            </div>
            <div className="sp-row">
                <button type="button" className="sk-small" onClick={() => startInsertPoint(c.id)}>Insert spline point</button>
                <button type="button" className="sk-small" onClick={() => startAddControl('tangency', c.id)}>Add tangency control</button>
                <button type="button" className="sk-small" onClick={() => startAddControl('curvature', c.id)}>Add curvature control</button>
                <button type="button" className="sk-small" onClick={() => togglePolygon([c.id])}>{polygonShown(c.id) ? 'Hide control polygon' : 'Display control polygon'}</button>
            </div>
            {unmet.length > 0 && (
                <p className="tb-note sx-warn">
                    Spline point {unmet.map((k) => k + 1).join(', ')}: the held curvature (or the continuity) has no free spline point beside it to come from, so it
                    does not hold there. Insert a spline point between the handles.
                </p>
            )}
            <p className="tb-note">
                Tangent weighting is the length of each side of the handle. Drag a handle&apos;s circle for weight and direction, its arrow head for weight,
                its diamond for direction; hold Alt (or Shift) to change both sides alike.
            </p>
        </>
    );
}

export const splineForm: ToolDef = {
    id: 'sk-pm-spline',
    label: 'Spline',
    icon: 'spline',
    hint: 'the selected spline',
    panel: true,
    width: 300,
    fields: () => {
        const found = selectedOf('spline');
        return splineFields(found ? splineValues(found.g, found.c) : {});
    },
    defaults: () => {
        const found = selectedOf('spline');
        return found ? splineValues(found.g, found.c) : {};
    },
    onChange: (key, v) => {
        if (key === 'point') {
            const found = selectedOf('spline');
            if (found) {
                useSplineView.setState({ picked: { curve: found.c.id, index: Number(v.point) } });
            }
        }
    },
    top: () => (selectedOf('spline') ? null : <p className="tb-note">Select the spline in the view first.</p>),
    extra: (api) => <SplineButtons api={api} />,
    apply: async (v) => {
        try {
            return applySpline(v);
        } catch (e) {
            return ok(e instanceof Error ? e.message : String(e));
        }
    },
};

// ---- Style Spline PropertyManager ---------------------------------------------------------------------------------

function styleValues(g: SketchGeometry, c: StyleSpline): Values {
    const view = useSplineView.getState();
    const v: Values = {
        id: c.id, construction: !!c.construction, showCurvature: view.combs.includes(c.id), localEdit: !!c.localEdit,
        type: c.degree ? String(c.degree) : 'bezier', rational: c.weights?.some((w) => w !== 1) ? 'rational' : 'non', vertex: '0',
        count: String(c.points.length), scale: fmt(view.scale), density: String(view.density),
    };
    c.points.forEach((id, i) => {
        const p = pointOf(g, id);
        v[`x${i}`] = fmt(p?.u ?? 0);
        v[`y${i}`] = fmt(p?.v ?? 0);
        v[`w${i}`] = fmt(c.weights?.[i] ?? 1);
    });
    return withBase(v);
}

function styleFields(v: Values): Field[] {
    const n = Number(v.count ?? 0);
    const many = useSketcher.getState().geometry.curves.filter((c) => c.kind === 'styleSpline').length >= 2;
    const out: Field[] = [
        { key: 'construction', label: 'For construction', kind: 'check', section: 'Options' },
        { key: 'showCurvature', label: 'Show curvature', kind: 'check', section: 'Options' },
        ...(many ? [{ key: 'localEdit', label: 'Local edit', kind: 'check', section: 'Options' } as Field] : []),
        { key: 'scale', label: 'Scale', kind: 'number', unit: '%', min: 0, step: 10, section: 'Curvature scale', show: (x) => !!x.showCurvature },
        { key: 'density', label: 'Density', kind: 'number', min: 2, step: 5, section: 'Curvature scale', show: (x) => !!x.showCurvature },
        {
            key: 'type', label: 'Curve type', kind: 'select', section: 'Curve type',
            options: [{ value: 'bezier', label: 'Bezier curve' }, { value: '3', label: 'B-spline: degree 3' }, { value: '5', label: 'B-spline: degree 5' }, { value: '7', label: 'B-spline: degree 7' }],
        },
        {
            key: 'rational', label: 'Spline', kind: 'select', section: 'Parameters',
            options: [{ value: 'non', label: 'Non-rational spline' }, { value: 'rational', label: 'Rational spline' }],
        },
        { key: `x0`, label: 'Start X coordinate', kind: 'number', unit: 'mm', section: 'Parameters' },
        { key: `y0`, label: 'Start Y coordinate', kind: 'number', unit: 'mm', section: 'Parameters' },
        { key: `x${n - 1}`, label: 'End X coordinate', kind: 'number', unit: 'mm', section: 'Parameters' },
        { key: `y${n - 1}`, label: 'End Y coordinate', kind: 'number', unit: 'mm', section: 'Parameters' },
        {
            key: 'vertex', label: 'Control vertex', kind: 'select', section: 'Control vertices',
            options: Array.from({ length: n }, (_, i) => ({ value: String(i), label: String(i + 1) })),
        },
    ];
    for (let i = 0; i < n; i++) {
        const show = (x: Values) => String(x.vertex) === String(i);
        out.push(
            ...(i > 0 && i < n - 1 ? [
                { key: `x${i}`, label: 'X coordinate', kind: 'number', unit: 'mm', section: 'Control vertices', show } as Field,
                { key: `y${i}`, label: 'Y coordinate', kind: 'number', unit: 'mm', section: 'Control vertices', show } as Field,
            ] : []),
            { key: `w${i}`, label: 'Control vertex weight', kind: 'number', min: 0, step: 0.1, section: 'Control vertices', show: (x) => show(x) && x.rational === 'rational' },
        );
    }
    return out;
}

function applyStyle(v: Values): Result {
    const s = useSketcher.getState();
    const g0 = s.geometry;
    const c0 = curveOf(g0, String(v.id ?? ''));
    if (c0?.kind !== 'styleSpline') {
        return ok('Select the style spline again: it is not in the sketch any more.');
    }
    const changed = changedIn(v);
    const n = c0.points.length;
    const type = String(v.type ?? 'bezier');
    const degree = type === 'bezier' ? undefined : (Number(type) as 3 | 5 | 7);
    if (degree && n <= degree) {
        return ok(`A B-spline of degree ${degree} needs at least ${degree + 1} control vertices (this one has ${n}): insert control vertices first.`);
    }
    let weights: number[] | undefined;
    if (v.rational === 'rational') {
        weights = c0.points.map((_, i) => num(v, `w${i}`, `Control vertex ${i + 1} weight`));
        if (!weights.every((w) => w > 0)) {
            return ok('Control vertex weights must be above zero.');
        }
    }
    const sameDegree = (degree ?? n - 1) === styleDegree(c0);
    const c: StyleSpline = {
        ...c0, construction: v.construction ? true : undefined, localEdit: v.localEdit ? true : undefined, degree,
        weights, knots: sameDegree ? c0.knots : undefined,
    };
    setStyleSplineType(degree ?? 'bezier');
    if (changed('showCurvature')) {
        toggleShown('combs', [c.id], !!v.showCurvature);
    }
    if (changed('scale') || changed('density')) {
        setCurvatureScale(num(v, 'scale', 'Scale'), num(v, 'density', 'Density'));
    }
    const g: SketchGeometry = { ...g0, curves: g0.curves.map((k) => (k.id === c.id ? c : k)) };
    const moves = c.points.flatMap((id, i) => (changed(`x${i}`) || changed(`y${i}`)
        ? [{ point: id, u: num(v, `x${i}`, `Control vertex ${i + 1} X`), v: num(v, `y${i}`, `Control vertex ${i + 1} Y`) }] : []));
    const r = solveWithTargets(g, moves);
    if (!r || r.miss > 1e-6) {
        return ok('Its relations and dimensions do not let the control vertices go there; change or delete them first.');
    }
    return ok(replaceGeometry(r.geometry));
}

function StyleButtons() {
    const found = selectedOf('styleSpline');
    return found ? (
        <div className="sp-row">
            <button type="button" className="sk-small" onClick={() => startInsertPoint(found.c.id)}>Insert control vertex</button>
            <span className="tb-note">Control vertices: {found.c.points.length}; curve degree {styleDegree(found.c)}.</span>
        </div>
    ) : null;
}

export const styleSplineForm: ToolDef = {
    id: 'sk-pm-styleSpline',
    label: 'Style spline',
    icon: 'style-spline',
    hint: 'the selected style spline',
    panel: true,
    width: 300,
    fields: () => {
        const found = selectedOf('styleSpline');
        return styleFields(found ? styleValues(found.g, found.c) : {});
    },
    defaults: () => {
        const found = selectedOf('styleSpline');
        return found ? styleValues(found.g, found.c) : {};
    },
    top: () => (selectedOf('styleSpline') ? null : <p className="tb-note">Select the style spline in the view first.</p>),
    extra: () => <StyleButtons />,
    apply: async (v) => {
        try {
            return applyStyle(v);
        } catch (e) {
            return ok(e instanceof Error ? e.message : String(e));
        }
    },
};

// ---- Curvature Scale and Spline Polygon PropertyManagers --------------------------------------------------------------

export const curvatureScaleForm: ToolDef = {
    id: 'sk-curvature-scale',
    label: 'Curvature scale',
    icon: 'spline',
    hint: 'size and number of the curvature combs of the sketch',
    panel: true,
    width: 280,
    fields: () => [
        { key: 'scale', label: 'Scale', kind: 'number', unit: '%', min: 0, step: 10, section: 'Scale' },
        { key: 'density', label: 'Density', kind: 'number', min: 2, step: 5, section: 'Density' },
    ],
    defaults: () => {
        const s = useSplineView.getState();
        return { scale: fmt(s.scale), density: String(s.density) };
    },
    onChange: (key, v) => {
        // The combs follow the values as they are typed.
        const [scale, density] = [Number(v.scale), Number(v.density)];
        if ((key === 'scale' || key === 'density') && scale > 0 && density >= 2) {
            setCurvatureScale(scale, density);
        }
    },
    apply: async (v) => {
        const [scale, density] = [Number(v.scale), Number(v.density)];
        if (!(scale > 0) || !(density >= 2)) {
            return ok('Scale must be above zero and Density at least 2.');
        }
        setCurvatureScale(scale, density);
        return ok(null);
    },
};

function pickedVertex(): { g: SketchGeometry; c: Spline; index: number; at: Pt } | null {
    const vtx = useSplineView.getState().vertex;
    const g = useSketcher.getState().geometry;
    const c = vtx ? curveOf(g, vtx.curve) : undefined;
    const solved = c?.kind === 'spline' ? solvedSpline(g, c) : null;
    const at = solved ? splinePolygon(solved)[vtx!.index] : undefined;
    return at && c?.kind === 'spline' ? { g, c, index: vtx!.index, at } : null;
}

export const splinePolygonForm: ToolDef = {
    id: 'sk-spline-polygon',
    label: 'Spline polygon',
    icon: 'spline',
    hint: 'a control polygon vertex of a spline',
    panel: true,
    width: 280,
    fields: () => [
        { key: 'x', label: 'X coordinate', kind: 'number', unit: 'mm', section: 'Parameters' },
        { key: 'y', label: 'Y coordinate', kind: 'number', unit: 'mm', section: 'Parameters' },
    ],
    defaults: () => {
        const p = pickedVertex();
        return p ? { x: fmt(p.at[0]), y: fmt(p.at[1]) } : ({} as Values);
    },
    top: () => (pickedVertex() ? null : <p className="tb-note">Click a vertex of a spline&apos;s control polygon first (Display control polygon).</p>),
    extra: () => {
        const p = pickedVertex();
        return p ? (
            <div className="sp-row">
                <button type="button" className="sk-small" disabled={!p.c.spacing} title="Re-parameterises (smooths) the spline after dragging its control polygon"
                    onClick={() => {
                        const g = useSketcher.getState().geometry;
                        const k = curveOf(g, p.c.id);
                        if (k?.kind === 'spline') {
                            replaceGeometry({ ...g, curves: g.curves.map((x) => (x.id === k.id ? { ...k, spacing: undefined } : x)) });
                        }
                    }}>
                    Relax spline
                </button>
            </div>
        ) : null;
    },
    apply: async (v) => {
        const p = pickedVertex();
        if (!p) {
            return ok('Click a control polygon vertex first.');
        }
        try {
            const to: Pt = [num(v, 'x', 'X coordinate'), num(v, 'y', 'Y coordinate')];
            const r = movePolygonVertex(p.g, p.c, p.index, to);
            if ('error' in r) {
                return ok(r.error);
            }
            const solved = solveWithTargets(r.g, r.targets);
            if (!solved || solved.miss > 1e-6) {
                return ok('Relations on the spline do not let it take that shape.');
            }
            return ok(replaceGeometry(solved.geometry));
        } catch (e) {
            return ok(e instanceof Error ? e.message : String(e));
        }
    },
};

// ---- The Spline Tools commands -------------------------------------------------------------------------------------

/** The selected curves (and the curves of selected points), not those of text, equation curves or blocks. */
function selectedCurves(kinds?: SketchCurve['kind'][]): string[] {
    const s = useSketcher.getState();
    const g = s.geometry;
    const ids = new Set<string>();
    for (const x of s.selection) {
        if (x.type === 'curve' && curveOf(g, x.id)) {
            ids.add(x.id);
        }
    }
    return [...ids].filter((id) => !kinds || kinds.includes(curveOf(g, id)!.kind));
}

const say = (message: string) => useSketcher.setState({ message });

/** Convert spline types: splines become style splines and style splines splines (each the same curve). */
export function convertSelected(to?: 'spline' | 'styleSpline'): string | null {
    let g = useSketcher.getState().geometry;
    const ids = selectedCurves(['spline', 'styleSpline']).filter((id) => !to || curveOf(g, id)!.kind !== to);
    if (!ids.length) {
        return 'Select a spline or a style spline to convert.';
    }
    for (const id of ids) {
        if (ownerOf(g, id)) {
            return 'Splines of text, equation curves and blocks are converted with their item: dissolve or explode it first.';
        }
        const r = curveOf(g, id)!.kind === 'spline' ? splineToStyle(g, id) : styleToSpline(g, id);
        if (typeof r === 'string') {
            return r;
        }
        g = r;
    }
    return replaceGeometry(g);
}

const instant = (id: string, label: string, icon: string, hint: string, run: () => void): ToolDef => ({ id, label, icon, hint, instant: run });

function showFor(kind: 'combs' | 'inflections' | 'minRadius', kinds?: SketchCurve['kind'][]) {
    return () => {
        const ids = selectedCurves(kinds);
        if (!ids.length) {
            say(kind === 'combs' ? 'Select the curves to show curvature combs on.' : 'Select a spline (or another curve) first.');
            return;
        }
        toggleShown(kind, ids);
        if (kind === 'combs' && useSplineView.getState().combs.some((id) => ids.includes(id))) {
            window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'sk-curvature-scale' }));
        }
    };
}

export const splineTools: ToolDef[] = [
    instant('sk-add-tangency', 'Add tangency control', 'spline', 'a handle at a new point on the spline: click where it goes', () => {
        const ids = selectedCurves(['spline']);
        startAddControl('tangency', ids[0] ?? null);
    }),
    instant('sk-add-curvature', 'Add curvature control', 'spline', 'a curvature pointer at a new point on the spline: click where it goes', () => {
        const ids = selectedCurves(['spline']);
        startAddControl('curvature', ids[0] ?? null);
    }),
    instant('sk-show-combs', 'Show curvature combs', 'spline', 'slope and curvature of the selected curves', showFor('combs')),
    instant('sk-show-inflections', 'Show inflection points', 'spline', 'where the selected curves change from turning one way to the other', showFor('inflections')),
    instant('sk-show-min-radius', 'Show minimum radius', 'spline', 'the tightest radius of the selected curves', showFor('minRadius')),
    {
        id: 'sk-show-handles', label: 'Show spline handles', icon: 'spline', hint: 'the handles of the selected spline, to drag',
        instant: () => useSplineView.setState((s) => ({ handlesHidden: !s.handlesHidden })),
        active: () => !useSplineView.getState().handlesHidden && useSplineView.getState().options.handles,
    },
    instant('sk-show-polygon', 'Display control polygon', 'spline', 'the control polygon of the selected splines, to drag', () => {
        const ids = selectedCurves(['spline']);
        if (!ids.length) {
            say('Select a spline to show its control polygon.');
            return;
        }
        togglePolygon(ids);
    }),
    instant('sk-convert-spline', 'Convert spline types', 'style-spline', 'a spline to the style spline of the same curve, and back', () => {
        const error = convertSelected();
        if (error) {
            say(error);
        }
    }),
];

/** The tool ids of the Spline tools toolbar flyout, after Fit and Simplify. */
export const SPLINE_TOOL_IDS = splineTools.map((t) => t.id);

/** The spline forms opened by id (sk-pm-spline, sk-pm-styleSpline) and by the commands. */
export const splineForms: ToolDef[] = [splineForm, styleSplineForm, curvatureScaleForm, splinePolygonForm];

// ---- Right-click entries ---------------------------------------------------------------------------------------------

/** The spline entries of the right-click menu for one picked curve. */
export function splineMenuEntries(g: SketchGeometry, picks: Pick[], openTool: (id: string) => void): MenuEntry[] {
    const curves = picks.filter((p) => p.type === 'curve').map((p) => curveOf(g, p.id)).filter((c): c is SketchCurve => !!c);
    if (curves.length !== 1 || ownerOf(g, curves[0].id)) {
        return [];
    }
    const c = curves[0];
    const v = useSplineView.getState();
    const id = c.id;
    const entries: MenuEntry[] = [
        { label: 'Show curvature combs', icon: 'spline', checked: v.combs.includes(id), onSelect: () => toggleShown('combs', [id]) },
        ...(v.combs.length ? [{ label: 'Modify curvature scale', icon: 'spline', onSelect: () => openTool('sk-curvature-scale') }] : []),
    ];
    if (c.kind === 'spline' || c.kind === 'styleSpline') {
        entries.push(
            { label: 'Show inflection points', icon: 'spline', checked: v.inflections.includes(id), onSelect: () => toggleShown('inflections', [id]) },
            { label: 'Show minimum radius', icon: 'spline', checked: v.minRadius.includes(id), onSelect: () => toggleShown('minRadius', [id]) },
        );
    }
    if (c.kind === 'spline') {
        entries.push(
            { label: 'Display control polygon', icon: 'spline', checked: polygonShown(id), onSelect: () => togglePolygon([id]) },
            { label: 'Add tangency control', icon: 'spline', onSelect: () => startAddControl('tangency', id) },
            { label: 'Add curvature control', icon: 'spline', onSelect: () => startAddControl('curvature', id) },
            { label: 'Insert spline point', icon: 'spline', onSelect: () => startInsertPoint(id) },
            ...(!closedSpline(c) ? [{ label: 'Convert to style spline', icon: 'style-spline', onSelect: () => convertOne(id) }] : []),
        );
    }
    if (c.kind === 'styleSpline') {
        entries.push(
            { label: 'Insert control vertex', icon: 'style-spline', onSelect: () => startInsertPoint(id) },
            { label: 'Convert to spline', icon: 'spline', onSelect: () => convertOne(id) },
        );
    }
    return entries;
}

function convertOne(id: string): void {
    useSketcher.setState({ selection: [{ type: 'curve', id }] });
    const error = convertSelected();
    if (error) {
        say(error);
    }
}

// ---- Spline settings of Sketch settings ------------------------------------------------------------------------------

export const SPLINE_OPTION_FIELDS: Field[] = [
    { key: 'splineHandles', label: 'Enable spline tangency and curvature handles', kind: 'check', section: 'Splines' },
    { key: 'splinePolygon', label: 'Show spline control polygon by default', kind: 'check', section: 'Splines' },
    { key: 'splineBounding', label: 'Show curvature comb bounding curve', kind: 'check', section: 'Splines' },
];

export function splineOptionValues(): Values {
    const o = useSplineView.getState().options;
    return { splineHandles: o.handles, splinePolygon: o.polygon, splineBounding: o.bounding };
}

export function applySplineOptions(v: Values): void {
    const o: SplineOptions = {
        handles: v.splineHandles === undefined ? DEFAULT_SPLINE_OPTIONS.handles : !!v.splineHandles,
        polygon: v.splinePolygon === undefined ? DEFAULT_SPLINE_OPTIONS.polygon : !!v.splinePolygon,
        bounding: v.splineBounding === undefined ? DEFAULT_SPLINE_OPTIONS.bounding : !!v.splineBounding,
    };
    setSplineOptions(o);
}
