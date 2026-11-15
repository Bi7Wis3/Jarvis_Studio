// The Equation Driven Curve PropertyManager in the left panel: Explicit (y as a function of x from x1 to x2) or
// Parametric (x(t) and y(t) from t1 to t2), angles in radians. It is built as a spline fitted to the equation; the
// form shows how many points that took and how far the spline is from the equation at most.

import { useEffect, useState } from 'react';
import type { SketchEquationCurve, SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { commitGeometry, useSketcher } from './sketcher';
import { ownerOf } from './sketchItems';
import { buildEquation, equationCurve, fitEquation, MAX_EQUATION_POINTS } from './sketchEquation';
import { clearExtras, useSketchExtras } from './sketchExtrasState';
import { valueText } from './numberText';
import './sketchExtras.css';

const fmt = valueText;
const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });

function selectedEquation(g: SketchGeometry): SketchEquationCurve | null {
    for (const x of useSketcher.getState().selection) {
        const owner = ownerOf(g, x.id);
        if (owner?.kind === 'equation') {
            return g.equations?.find((e) => e.id === owner.id) ?? null;
        }
    }
    return null;
}

function valuesOf(e: SketchEquationCurve | null): Values {
    return e
        ? { id: e.id, type: e.type, x: e.x ?? '', y: e.y, from: e.from, to: e.to, tolerance: fmt(e.tolerance), construction: !!e.construction,
            lockFrom: e.lockFrom !== false, lockTo: e.lockTo !== false }
        : { id: '', type: 'explicit', x: '50*cos(t)', y: '10*sin(x/5)', from: '0', to: '50', tolerance: '0.000001', construction: false, lockFrom: true, lockTo: true };
}

function itemOf(v: Values): SketchEquationCurve {
    const tolerance = Number(v.tolerance);
    // A curve that was moved or turned (by relations on its ends) stays where it was put.
    const was = useSketcher.getState().geometry.equations?.find((e) => e.id === v.id);
    return {
        ...(was?.offset ? { offset: was.offset } : {}),
        ...(was?.angle ? { angle: was.angle } : {}),
        ...(v.lockFrom === false ? { lockFrom: false as const } : {}),
        ...(v.lockTo === false ? { lockTo: false as const } : {}),
        id: String(v.id || `eq${Date.now().toString(36)}`), type: v.type === 'parametric' ? 'parametric' : 'explicit',
        ...(v.type === 'parametric' ? { x: String(v.x ?? '') } : {}), y: String(v.y ?? ''), from: String(v.from ?? ''), to: String(v.to ?? ''),
        tolerance: Number.isFinite(tolerance) ? tolerance : NaN, curves: [], points: [], ...(v.construction ? { construction: true } : {}),
    };
}

/** The ghost of the curve and what the spline fit came to. */
function EquationGhost({ api }: { api: PopupApi }) {
    const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
    const key = JSON.stringify(api.values);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            const item = itemOf(api.values);
            const c = equationCurve(item);
            if (typeof c === 'string') {
                setNote({ text: c, warn: true });
                useSketchExtras.setState({ preview: [] });
                return;
            }
            useSketchExtras.setState({ preview: [Array.from({ length: 401 }, (_, k) => c.f(c.from + ((c.to - c.from) * k) / 400))] });
            setNote({ text: 'Fitting the spline…', warn: false });
            fitTimer = window.setTimeout(() => report(item), 450);
        }, 150);
        let fitTimer = 0;
        const report = (item: SketchEquationCurve) => {
            const fit = fitEquation(item);
            if (typeof fit === 'string') {
                setNote({ text: fit, warn: true });
                return;
            }
            const n = fit.closed ? fit.points.length - 1 : fit.points.length;
            setNote({
                text: `A spline fit: ${n} points, at most ${fmt(fit.deviation)} mm from the equation`
                    + (fit.within ? '.' : `; ${MAX_EQUATION_POINTS} points is the most, so the tolerance is not reached.`),
                warn: !fit.within,
            });
        };
        return () => {
            window.clearTimeout(timer);
            window.clearTimeout(fitTimer);
        };
    }, [key]);
    useEffect(() => () => clearExtras(), []);
    return note ? <p className={`tb-note ${note.warn ? 'sx-warn' : ''}`}>{note.text}</p> : null;
}

const explicit = (v: Values) => v.type !== 'parametric';
const parametric = (v: Values) => v.type === 'parametric';

export const equationCurveTool: ToolDef = {
    id: 'sk-equation-curve',
    label: 'Equation driven curve',
    icon: 'equation-curve',
    hint: 'y(x), or x(t) and y(t), built as a spline within a tolerance',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'type', label: 'Equation type', kind: 'select', section: 'Equation type',
            options: [{ value: 'explicit', label: 'Explicit: y(x)' }, { value: 'parametric', label: 'Parametric: x(t), y(t)' }] },
        { key: 'y', label: 'y =', kind: 'text', section: 'Parameters', show: explicit },
        { key: 'x', label: 'x(t) =', kind: 'text', section: 'Parameters', show: parametric },
        { key: 'y', label: 'y(t) =', kind: 'text', section: 'Parameters', show: parametric },
        { key: 'from', label: 'x1', kind: 'text', section: 'Parameters', show: explicit },
        { key: 'to', label: 'x2', kind: 'text', section: 'Parameters', show: explicit },
        { key: 'from', label: 't1', kind: 'text', section: 'Parameters', show: parametric },
        { key: 'to', label: 't2', kind: 'text', section: 'Parameters', show: parametric },
        { key: 'lockFrom', label: 'Lock the start on the curve (unlocked: drag it along the curve)', kind: 'check', section: 'Parameters' },
        { key: 'lockTo', label: 'Lock the end on the curve (unlocked: drag it along the curve)', kind: 'check', section: 'Parameters' },
        { key: 'tolerance', label: 'Largest deviation of the spline', kind: 'number', unit: 'mm', min: 0, step: 0.000001, section: 'Spline fit' },
        { key: 'construction', label: 'For construction', kind: 'check', section: 'Options' },
    ] satisfies Field[],
    defaults: () => valuesOf(selectedEquation(useSketcher.getState().geometry)),
    top: () => (
        <p className="tb-note">
            Functions: sin, cos, tan, sec, cosec, cotan, arcsin, arccos, atn, abs, exp, log (natural), sqr (square root), int, sgn; ^ for powers; pi.
            Angles are radians. The curve is built as a spline through points of the equation. It is rigid: relations and dimensions on its two end points move and turn it.
        </p>
    ),
    extra: (api) => <EquationGhost api={api} />,
    apply: async (v) => {
        const item = itemOf(v);
        const built = buildEquation(useSketcher.getState().geometry, item);
        if (typeof built === 'string') {
            return ok(built);
        }
        if (!commitGeometry(built.g)) {
            return ok(useSketcher.getState().message ?? 'Not applied.');
        }
        useSketcher.setState({
            selection: [],
            message: built.fit.within ? null : `The spline is ${fmt(built.fit.deviation)} mm from the equation at most (${MAX_EQUATION_POINTS} points is the limit).`,
        });
        return ok(null);
    },
};
