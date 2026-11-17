// Helix and Spiral, as SolidWorks' Helix/Spiral PropertyManager: a curve step made from a sketch holding one circle
// (Defined by, constant or variable pitch with its table, reverse direction, start angle, clockwise, taper). The curve
// is drawn in the view as it stands (HelixCurves.tsx) while the form is open; sweeps take it as their path.

import { useEffect, useState } from 'react';
import type { Feature } from '@jarvis/core';
import type { HelixStep } from '@jarvis/core/helix';
import {
    circleSketches, DEFINED_BY, derivedPatch, draftHelix, helixFeature, helixStatus, helixValues, isVariable, joinRow, OWN_SKETCH,
    rowInputs, sketchDiameter, splitRow, tableFromConstant, type HelixValues, type RowCells,
} from './helixForm';
import { useSketcher } from './sketcher';
import { useTreePicks } from './treeSelection';
import { attempt, fullPart, saveFeature, type Ctx, type PopupApi, type ToolDef, type Values } from './toolDefs';
import './helix.css';

const opts = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

const editedHelix = (ctx: Ctx): HelixStep | null => (ctx.edit?.feature?.op === 'helix' ? ctx.edit.feature as HelixStep : null);

/** The part's steps as stored (the viewport copy may be cut back by the rollback bar). */
const stepsOf = (ctx: Ctx): Feature[] => (ctx.part ? fullPart(ctx.part.id)?.features ?? ctx.part.features ?? [] : []);

/** Which of pitch, revolutions and height Defined by types (the other is worked out). */
const TYPED: Record<string, string[]> = {
    pitchRevolution: ['pitch', 'revolutions'], heightRevolution: ['height', 'revolutions'], heightPitch: ['height', 'pitch'],
    spiral: ['pitch', 'revolutions'],
};

function Status({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const { shape, error } = draftHelix(api.values as HelixValues, stepsOf(ctx), ctx.edit?.feature?.id ?? null);
    return (
        <p className={`tb-note pm-status ${shape ? 'ok' : 'error'}`} role="status">
            {shape ? helixStatus(shape) : error}
        </p>
    );
}

/** Keeps the sketch in step with a sketch clicked in the view, when it holds a circle. */
function SketchPick({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const picked = useSketcher((s) => s.picked);
    const [seen] = useState(() => picked?.n ?? 0);
    useEffect(() => {
        const steps = stepsOf(ctx);
        if (picked && picked.n > seen && api.values.sketch !== picked.id && circleSketches(steps).some((f) => f.id === picked.id)) {
            const next = { ...(api.values as HelixValues), sketch: picked.id };
            api.set({ sketch: picked.id, ...derivedPatch(next, sketchDiameter(steps, picked.id)) } as Values);
        }
    }, [picked?.n]);
    return null;
}

const COLUMNS: { title: string; label: string }[] = [
    { title: 'Pitch, mm', label: 'P' },
    { title: 'Revolutions from the start', label: 'Rev' },
    { title: 'Height from the start, mm', label: 'H' },
    { title: 'Diameter, mm (empty: the row before\'s)', label: 'Dia' },
];

/** The variable pitch table (SolidWorks' region parameters): worked-out cells are shown, not typed. */
function PitchTable({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const [open, setOpen] = useState(true);
    const v = api.values as HelixValues;
    const rows = (v.rows as string[]) ?? [];
    const diameter = sketchDiameter(stepsOf(ctx), v.sketch);
    const update = (next: string[]) => {
        api.set({ rows: next, rowsTouched: true, ...derivedPatch({ ...v, rows: next }, diameter) } as Values);
    };
    const setCell = (i: number, k: number, text: string) => {
        const cells = splitRow(rows[i]);
        cells[k] = text;
        update(rows.map((r, j) => (j === i ? joinRow(cells) : r)));
    };
    const addRow = () => {
        const [p, rev, h] = splitRow(rows[rows.length - 1] ?? '').map(Number);
        const step = Number.isFinite(p) && p > 0 ? p : 1;
        const cells: RowCells = [String(step), String((Number.isFinite(rev) ? rev : 0) + 1), String((Number.isFinite(h) ? h : 0) + step), ''];
        update([...rows, joinRow(cells)]);
    };
    return (
        <section className={`pm-section ${open ? 'open' : ''}`}>
            <button type="button" className="pm-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span>Region parameters</span>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
            </button>
            {open && (
                <div className="pm-section-body">
                    <table className="hx-table" aria-label="Variable pitch">
                        <thead>
                            <tr>
                                <th />
                                {COLUMNS.map((c) => <th key={c.label} title={c.title}>{c.label}</th>)}
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, i) => {
                                const cells = splitRow(row);
                                const use = rowInputs(v.definedBy as string, i);
                                const typed = [use.pitch, use.revolutions, use.height, use.diameter];
                                return (
                                    <tr key={i}>
                                        <td className="hx-n">{i + 1}</td>
                                        {cells.map((text, k) => (
                                            <td key={k}>
                                                <input
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={i === 0 && k === 3 && diameter ? String(diameter) : text}
                                                    readOnly={!typed[k]}
                                                    tabIndex={typed[k] ? 0 : -1}
                                                    placeholder={k === 3 && i > 0 ? 'same' : undefined}
                                                    onChange={(e) => setCell(i, k, e.target.value)}
                                                    aria-label={`Row ${i + 1} ${COLUMNS[k].title}`}
                                                />
                                            </td>
                                        ))}
                                        <td>
                                            {i > 0 && rows.length > 2 && (
                                                <button type="button" title="Remove the row" aria-label={`Remove row ${i + 1}`}
                                                    onClick={() => update(rows.filter((_, j) => j !== i))}>×</button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <button type="button" className="hx-add" onClick={addRow}>Add a row</button>
                </div>
            )}
        </section>
    );
}

export const helixTool: ToolDef = {
    id: 'helix',
    label: 'Helix and spiral',
    icon: 'helix',
    op: 'helix',
    hint: 'a helix or spiral curve from a sketched circle, e.g. the path of a spring',
    needsPart: true,
    panel: true,
    // The model as it will be (a spring swept along the curve follows an edit), besides the curve drawn in HelixCurves.
    preview: true,
    width: 310,
    fields: (ctx) => {
        const steps = stepsOf(ctx);
        const editing = editedHelix(ctx);
        const at = editing ? steps.findIndex((f) => f.id === editing.id) : steps.length;
        const sketches = circleSketches(steps, at).map((f) => ({ value: f.id, label: f.name ?? f.id }));
        const own = editing?.sketch ? [{ value: OWN_SKETCH, label: 'Its own sketch' }] : [];
        const section = 'Parameters';
        const helix = (v: Values) => v.definedBy !== 'spiral';
        const constant = (v: Values) => !isVariable(v as HelixValues);
        const typed = (key: string) => (v: Values) => constant(v) && (TYPED[v.definedBy as string] ?? []).includes(key);
        const taper = (v: Values) => helix(v) && constant(v);
        return [
            { key: 'sketch', label: 'Sketch', kind: 'select', options: [{ value: '', label: 'None' }, ...own, ...sketches], section: 'Circle' },
            { key: 'definedBy', label: 'Type', kind: 'select', options: opts(DEFINED_BY), section: 'Defined by' },
            { key: 'pitchType', label: 'Pitch type', kind: 'select', section, show: helix,
                options: opts([['constant', 'Constant pitch'], ['variable', 'Variable pitch']]) },
            { key: 'height', label: 'Height', kind: 'number', unit: 'mm', min: 0, step: 1, section, show: typed('height') },
            { key: 'pitch', label: 'Pitch', kind: 'number', unit: 'mm', min: 0, step: 0.5, section, show: typed('pitch') },
            { key: 'revolutions', label: 'Revolutions', kind: 'number', min: 0, step: 1, section, show: typed('revolutions') },
            { key: 'reverse', label: 'Reverse direction', kind: 'check', section },
            { key: 'startAngle', label: 'Start angle', kind: 'number', unit: 'deg', step: 15, section },
            { key: 'direction', label: 'Direction', kind: 'select', section,
                options: opts([['clockwise', 'Clockwise'], ['counterclockwise', 'Counterclockwise']]) },
            { key: 'taper', label: 'Taper helix', kind: 'check', section: 'Taper helix', show: taper },
            { key: 'taperAngle', label: 'Angle', kind: 'number', unit: 'deg', min: 0, max: 89.999999, step: 1, section: 'Taper helix',
                show: (v) => taper(v) && !!v.taper },
            { key: 'taperOutward', label: 'Taper outward', kind: 'check', section: 'Taper helix', show: (v) => taper(v) && !!v.taper },
        ];
    },
    defaults: (ctx) => {
        const steps = stepsOf(ctx);
        const editing = editedHelix(ctx);
        if (editing) {
            const sketch = editing.sketchRef ?? '';
            return helixValues(editing, sketch, sketchDiameter(steps, sketch)) as Values;
        }
        // The sketch selected in the tree when it holds a circle, else the newest such sketch.
        const circles = circleSketches(steps);
        const picks = useTreePicks.getState();
        const chosen = picks.partId === (ctx.part?.instanceOf ?? ctx.part?.id) ? circles.filter((f) => picks.steps.has(f.id)).pop() : undefined;
        const sketch = (chosen ?? circles[circles.length - 1])?.id ?? '';
        return helixValues(null, sketch, sketchDiameter(steps, sketch)) as Values;
    },
    onChange: (key, values, ctx) => {
        const v = values as HelixValues;
        const diameter = sketchDiameter(stepsOf(ctx), v.sketch);
        if (key === 'pitchType' && v.pitchType === 'variable' && !v.rowsTouched) {
            const rows = tableFromConstant(v, diameter);
            return { rows, ...derivedPatch({ ...v, rows }, diameter) } as Values;
        }
        return derivedPatch(v, diameter) as Values;
    },
    top: (api, ctx) => <Status api={api} ctx={ctx} />,
    extra: (api, ctx) => (
        <>
            <SketchPick api={api} ctx={ctx} />
            {isVariable(api.values as HelixValues) && <PitchTable api={api} ctx={ctx} />}
        </>
    ),
    apply: (v, ctx) => attempt(async () => {
        const values = v as HelixValues;
        const { shape, error } = draftHelix(values, stepsOf(ctx), ctx.edit?.feature?.id ?? null);
        if (!shape) {
            throw new Error(error ?? 'The curve cannot be made.');
        }
        return saveFeature(ctx, helixFeature(values, !!ctx.edit?.feature));
    }),
};
