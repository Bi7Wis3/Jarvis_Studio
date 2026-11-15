// Fit Spline and Simplify Spline in the left panel (SolidWorks Spline Tools). Fit Spline: the curves to fit (sketch
// curves of any kind, or model edges), Delete geometry (or keep them as construction, the spline Constrained,
// Unconstrained or Fixed), Tolerance, and the actual deviation. Simplify Spline: Tolerance, or Smooth step by step (Previous steps back), with the number of points of the
// original and the simplified spline and the deviation reached.

import { useEffect, useState } from 'react';
import type { FitResult } from '@jarvis/core/curveFit';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { commitGeometry, useSketcher } from './sketcher';
import { curveOf } from './solver';
import { ownerOf } from './sketchItems';
import { CurveList } from './sketchTextForm';
import { MAX_FIT_POINTS, applyFit, applySimplify, fitChain, simplifySpline, smoothStep, splineOf, type FitKeep } from './sketchSplineFit';
import { clearExtras, useSketchExtras } from './sketchExtrasState';
import { splinePoints } from '@jarvis/core/curves';
import { valueText } from './numberText';
import './sketchExtras.css';

type Pt = [number, number];
const fmt = valueText;
const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });

const ghostOf = (fit: FitResult): Pt[][] => [[fit.points[0] as Pt, ...(splinePoints(fit.points, fit.closed, 16, fit.handles) as Pt[])]];
const count = (fit: FitResult) => (fit.closed ? fit.points.length - 1 : fit.points.length);

// ---- Fit Spline --------------------------------------------------------------------------------------------------

function FitReport({ api }: { api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
    const key = JSON.stringify([api.values.entities, api.values.tolerance]);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            const ids = Array.isArray(api.values.entities) ? (api.values.entities as string[]) : [];
            if (!ids.length) {
                setNote(null);
                useSketchExtras.setState({ preview: [] });
                return;
            }
            const fit = fitChain(g, ids, Number(api.values.tolerance));
            if (typeof fit === 'string') {
                setNote({ text: fit, warn: true });
                useSketchExtras.setState({ preview: [] });
                return;
            }
            useSketchExtras.setState({ preview: ghostOf(fit) });
            setNote({
                text: `Actual deviation ${fmt(fit.deviation)} mm, ${count(fit)} spline points`
                    + (fit.within ? '.' : `: ${MAX_FIT_POINTS} points is the most, so the tolerance is not reached.`),
                warn: !fit.within,
            });
        }, 250);
        return () => window.clearTimeout(timer);
    }, [key, g]);
    useEffect(() => () => clearExtras(), []);
    return note ? <p className={`tb-note ${note.warn ? 'sx-warn' : ''}`}>{note.text}</p> : null;
}

const fitSplineTool: ToolDef = {
    id: 'sk-fit-spline',
    label: 'Fit spline',
    icon: 'fit-spline',
    hint: 'one spline in place of a chain of curves or model edges, within a tolerance',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'delete', label: 'Delete geometry', kind: 'check', section: 'Parameters' },
        { key: 'keep', label: 'The spline', kind: 'select', section: 'Parameters', show: (v) => !v.delete,
            options: [
                { value: 'constrained', label: 'Constrained (follows the curves when they change)' },
                { value: 'unconstrained', label: 'Unconstrained (free to move and dimension)' },
                { value: 'fixed', label: 'Fixed' },
            ] },
        { key: 'tolerance', label: 'Tolerance', kind: 'number', unit: 'mm', min: 0, step: 0.001, section: 'Tolerance' },
    ] satisfies Field[],
    defaults: () => {
        const s = useSketcher.getState();
        const ids = s.selection.filter((x) => x.type === 'curve' && curveOf(s.geometry, x.id) && !ownerOf(s.geometry, x.id)).map((x) => x.id);
        return { entities: ids, delete: true, keep: 'constrained', tolerance: '0.01' };
    },
    top: (api) => (
        <CurveList api={api} valueKey="entities" label="Entities to fit (end to end)" empty="Click here, then the sketch curves or model edges in the view" models
            accept={(g, id) => (ownerOf(g, id) ? 'Text, equation curves and blocks cannot be fitted.' : curveOf(g, id) ? null : 'Pick sketch curves.')} />
    ),
    extra: (api) => (
        <>
            <FitReport api={api} />
            <p className="tb-note">A closed chain gives a closed spline. Kept geometry turns into construction geometry. Model edges come into the sketch as locked curves.</p>
        </>
    ),
    apply: async (v) => {
        const ids = Array.isArray(v.entities) ? (v.entities as string[]) : [];
        const g = useSketcher.getState().geometry;
        const fit = fitChain(g, ids, Number(v.tolerance));
        if (typeof fit === 'string') {
            return ok(fit);
        }
        const keep: FitKeep = v.delete ? 'delete' : v.keep === 'fixed' ? 'fixed' : v.keep === 'constrained' ? 'constrained' : 'unconstrained';
        const r = applyFit(g, ids, fit, keep, Number(v.tolerance));
        if (!commitGeometry(r.g)) {
            return ok(useSketcher.getState().message ?? 'Not applied.');
        }
        useSketcher.setState({ selection: [{ type: 'curve', id: r.id }], message: `Fitted: ${count(fit)} points, at most ${fmt(fit.deviation)} mm off.` });
        return ok(null);
    },
};

// ---- Simplify Spline ---------------------------------------------------------------------------------------------

/** The simplified spline so far, and the steps before it (Previous). */
let steps: FitResult[] = [];

function SimplifyReport({ api }: { api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const [, redraw] = useState(0);
    const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
    const id = String(api.values.spline ?? '');
    const show = () => {
        const s = id ? splineOf(g, id) : null;
        const last = steps[steps.length - 1];
        if (!s || typeof s === 'string' || !last) {
            useSketchExtras.setState({ preview: [] });
            setNote(s && typeof s === 'string' ? { text: s, warn: true } : null);
            return;
        }
        const original = s.closed ? s.points.length - 1 : s.points.length;
        useSketchExtras.setState({ preview: ghostOf(last) });
        setNote({ text: `Points: ${original} in the original, ${count(last)} simplified; deviation reached ${fmt(last.deviation)} mm.`, warn: false });
        redraw((n) => n + 1);
    };
    useEffect(() => {
        const timer = window.setTimeout(() => {
            steps = [];
            const fit = id ? simplifySpline(g, id, Number(api.values.tolerance)) : null;
            if (fit && typeof fit !== 'string') {
                steps = [fit];
            } else if (typeof fit === 'string') {
                setNote({ text: fit, warn: true });
                useSketchExtras.setState({ preview: [] });
                return;
            }
            show();
        }, 250);
        return () => window.clearTimeout(timer);
    }, [id, api.values.tolerance, g]);
    useEffect(() => () => {
        steps = [];
        clearExtras();
    }, []);
    return (
        <>
            {id && (
                <div className="sx-row">
                    <button type="button" className="sx-small" title="Leave out every other point (down to the two ends)" onClick={() => {
                        const last = steps[steps.length - 1];
                        const next = last ? smoothStep(g, id, last) : null;
                        if (typeof next === 'string') {
                            setNote({ text: next, warn: true });
                        } else if (next) {
                            steps.push(next);
                            show();
                        }
                    }}>
                        Smooth
                    </button>
                    <button type="button" className="sx-small" disabled={steps.length < 2} onClick={() => {
                        steps.pop();
                        show();
                    }}>
                        Previous
                    </button>
                </div>
            )}
            {note && <p className={`tb-note ${note.warn ? 'sx-warn' : ''}`}>{note.text}</p>}
        </>
    );
}

const simplifySplineTool: ToolDef = {
    id: 'sk-simplify-spline',
    label: 'Simplify spline',
    icon: 'simplify-spline',
    hint: 'fewer spline points within a tolerance',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'tolerance', label: 'Tolerance', kind: 'number', unit: 'mm', min: 0, step: 0.001, section: 'Tolerance' },
    ] satisfies Field[],
    defaults: () => {
        const s = useSketcher.getState();
        const spline = s.selection.find((x) => x.type === 'curve' && curveOf(s.geometry, x.id)?.kind === 'spline' && !ownerOf(s.geometry, x.id));
        return { spline: spline?.id ?? '', tolerance: '0.01' } as Values;
    },
    top: (api) => (
        <PickSpline api={api} />
    ),
    extra: (api) => <SimplifyReport api={api} />,
    apply: async (v) => {
        const id = String(v.spline ?? '');
        const last = steps[steps.length - 1];
        if (!id || !last) {
            return ok('Pick the spline to simplify.');
        }
        const g = useSketcher.getState().geometry;
        const r = applySimplify(g, id, last);
        if (typeof r === 'string') {
            return ok(r);
        }
        return ok(commitGeometry(r) ? null : useSketcher.getState().message ?? 'Not applied.');
    },
};

function PickSpline({ api }: { api: PopupApi }) {
    const ids = api.values.spline ? [String(api.values.spline)] : [];
    const proxy: PopupApi = {
        ...api,
        values: { ...api.values, splineList: ids },
        set: (patch) => {
            const list = (patch.splineList as string[] | undefined) ?? [];
            api.set({ spline: list[list.length - 1] ?? '' });
        },
    };
    return (
        <CurveList api={proxy} valueKey="splineList" label="Spline to simplify" empty="Click here, then the spline in the view"
            accept={(g, id) => (curveOf(g, id)?.kind !== 'spline' ? 'Pick a spline.' : ownerOf(g, id) ? 'This spline belongs to an equation curve or a block.' : null)} />
    );
}

export const splineFitTools: ToolDef[] = [fitSplineTool, simplifySplineTool];
