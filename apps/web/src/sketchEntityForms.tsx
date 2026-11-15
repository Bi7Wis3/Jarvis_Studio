// PropertyManagers of a selected line, circle, arc or point (SolidWorks Line Properties, Circle, Arc and Point
// PropertyManagers): Existing relations (with the entity's status, each relation deletable), Add relations (only
// those that fit), Options (For construction; Infinite length for lines) and Parameters (Additional parameters for
// lines). A click on the entity opens its form; the form follows the selection while it is open. A typed value is
// put in on Enter, on leaving the Parameters, or on OK, solved and as one undo step.

import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { curveOf, isDimension, solverReady } from './solver';
import {
    addRelationToSelection, commitGeometry, deleteConstraints, describe, replaceGeometry, selectConstraint, setHighlight, useSketcher,
    type Selected,
} from './sketcher';
import { constraintRefs, type Pick } from './sketchGeometry';
import { definedEntities } from './sketchStatus';
import { ADD_RELATIONS, entityLabel, fittingRelations } from './sketchRelationForms';
import { relationName } from './sketchRelationNames';
import { PmSection } from './sketchPm';
import { FieldInput } from './toolForm';
import { valueText } from './numberText';
import { makeEndless } from './sketchInfinite';
import { useToolSession } from './toolSession';
import { editEntity, entityOf, entityValues, solveEntityEdit, type EntityKind, type Numbers } from './sketchEntityParams';
import { ENTITY_FORM_IDS } from './sketchEntityOpen';

const isPick = (x: Selected): x is Pick & Selected => x.type !== 'constraint';

// ---- Existing relations and Add relations (shared with the other entity forms) ---------------------------------

/** Fully defined, under defined or over defined, as the Information line of Existing relations says. */
function statusOf(g: SketchGeometry, id: string, defined: Set<string> | null, conflicting: string[]): string | null {
    if (g.constraints.some((c) => conflicting.includes(c.id) && constraintRefs(c).includes(id))) {
        return 'Over defined';
    }
    return defined ? (defined.has(id) ? 'Fully defined' : 'Under defined') : null;
}

/** Existing relations of the selected entities (status, highlight, delete) and the relations that fit them. */
export function EntityRelations() {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const context = useSketcher((s) => s.context);
    const conflicting = useSketcher((s) => s.conflicting);
    const dof = useSketcher((s) => s.dof);
    const [note, setNote] = useState<string | null>(null);
    const picks = selection.filter(isPick);
    const ids = new Set(picks.map((p) => p.id));
    const fits = useMemo(() => fittingRelations(g, picks), [g, selection]);
    // Each entity's state is probed again only when the relations change, not while something is dragged (as the
    // sketch colours are, sketchShapes.tsx).
    const structure = useMemo(() => JSON.stringify([g.curves.map(({ id, kind }) => [id, kind]),
        g.constraints.map((c) => (isDimension(c) && c.driven ? { ...c, value: 0 } : c)), g.points.map((p) => [p.id, p.fixed])]), [g]);
    const probed = useMemo(() => (solverReady() && dof > 0 ? definedEntities(g) : null), [structure, dof > 0]);
    const defined = dof === 0 ? new Set(ids) : probed;
    const existing = g.constraints.filter((c) => !isDimension(c) && constraintRefs(c).some((r) => ids.has(r)));
    useEffect(() => () => setHighlight([]), []);
    return (
        <>
            <PmSection title="Existing relations">
                {!existing.length && <p className="tb-note">None.</p>}
                <div className="sk-list" aria-label="Relations">
                    {existing.map((c) => (
                        <div
                            key={c.id}
                            className={`sk-row ${selection.some((x) => x.id === c.id) ? 'on' : ''}`}
                            onMouseEnter={() => setHighlight(constraintRefs(c))}
                            onMouseLeave={() => setHighlight([])}
                            onClick={() => selectConstraint(c.id, true)}
                        >
                            <span className="sk-row-text">
                                <b>{relationName(c, context)}</b>
                                <small>{constraintRefs(c).map((r) => entityLabel(g, r)).join(', ')}{c.suppressed ? ' · suppressed' : ''}</small>
                            </span>
                            <button
                                type="button"
                                className="sk-row-x"
                                title="Delete"
                                aria-label={`Delete ${describe(g, c.id)}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    deleteConstraints([c.id]);
                                }}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
                {picks.map((p) => {
                    const status = statusOf(g, p.id, defined, conflicting);
                    return status && <p key={p.id} className="tb-note">{picks.length > 1 ? `${entityLabel(g, p.id)}: ` : ''}{status}</p>;
                })}
            </PmSection>
            <PmSection title="Add relations">
                {!fits.length && <p className="tb-note">No relation fits this selection.</p>}
                <div className="sk-relation-buttons">
                    {ADD_RELATIONS.filter((r) => fits.includes(r.tool)).map((r) => (
                        <button key={r.tool} type="button" className="sk-small" onClick={() => setNote(addRelationToSelection(r.tool))}>
                            {r.label}
                        </button>
                    ))}
                </div>
                {note && <p className="tb-note">{note}</p>}
            </PmSection>
        </>
    );
}

// ---- Parameters ----------------------------------------------------------------------------------------------

const vec = (key: string, label: string): Field => ({ key, label, kind: 'vec', unit: 'mm', axes: ['X', 'Y', ''] });
const number = (key: string, label: string, unit = 'mm'): Field => ({ key, label, kind: 'number', unit });

interface EntitySpec {
    kind: EntityKind;
    label: string;
    icon: string;
    noun: string;
    params: (endless: boolean) => Field[];
    more?: Field[];
}

const SPECS: EntitySpec[] = [
    {
        kind: 'line', label: 'Line properties', icon: 'line', noun: 'line',
        // An infinite line has no length; its angle and points still set it.
        params: (endless) => [...(endless ? [] : [number('length', 'Length')]), number('angle', 'Angle', 'deg')],
        more: [vec('start', 'Start'), vec('end', 'End'), vec('delta', 'Delta')],
    },
    { kind: 'circle', label: 'Circle', icon: 'circle', noun: 'circle', params: () => [vec('centre', 'Centre'), number('radius', 'Radius')] },
    {
        kind: 'arc', label: 'Arc', icon: 'arc', noun: 'arc',
        params: () => [vec('centre', 'Centre'), vec('start', 'Start'), vec('end', 'End'), number('radius', 'Radius'), number('angle', 'Angle', 'deg')],
    },
    { kind: 'point', label: 'Point', icon: 'sk-point', noun: 'point', params: () => [number('x', 'X'), number('y', 'Y')] },
];

/** Values typed and not yet put in, for the entity the open form shows. */
export const usePending = create<{ subject: string | null; edits: Record<string, string>; note: string | null }>(() => ({ subject: null, edits: {}, note: null }));

/** The entity of this kind the selection is (exactly one entity), or null. */
function subjectOf(kind: EntityKind): string | null {
    const s = useSketcher.getState();
    const picks = s.selection.filter(isPick);
    return picks.length === 1 ? entityOf(s.geometry, kind, picks[0]) : null;
}

/** Puts the typed values in (solved, one undo step); returns why not, or null. */
export function applyPending(kind: EntityKind): string | null {
    const { subject, edits } = usePending.getState();
    const id = subjectOf(kind);
    const typed = Object.entries(edits).filter(([, text]) => text.trim() !== '');
    usePending.setState({ edits: {} });
    if (!id || id !== subject || !typed.length) {
        return null;
    }
    const g = useSketcher.getState().geometry;
    const now = entityValues(g, kind, id);
    if (!now) {
        return null;
    }
    const next: Numbers = {};
    for (const [key, text] of typed) {
        const n = Number(text);
        if (!Number.isFinite(n)) {
            return fail(`${text} is not a number.`);
        }
        // A value left as it shows is not an edit (the typed text may round what is there).
        if (Math.abs(n - now[key]) > 1e-12 && valueText(now[key]) !== text.trim()) {
            next[key] = n;
        }
    }
    if (!Object.keys(next).length) {
        return null;
    }
    if (!solverReady()) {
        return fail('The solver is still loading; try again in a moment.');
    }
    const edit = editEntity(g, kind, id, next);
    const solved = typeof edit === 'string' ? edit : solveEntityEdit(edit);
    if (typeof solved === 'string') {
        return fail(solved);
    }
    if (!commitGeometry(solved)) {
        return fail(useSketcher.getState().message ?? 'Not applied.');
    }
    usePending.setState({ note: null });
    return null;
}

function fail(text: string): string {
    usePending.setState({ note: text });
    return text;
}

/** For construction: the entity to construction geometry or back. */
function setConstruction(g: SketchGeometry, id: string, on: boolean): void {
    replaceGeometry({ ...g, curves: g.curves.map((c) => (c.id === id ? { ...c, construction: on || undefined } : c)) });
}

function EntityPm({ spec, api }: { spec: EntitySpec; api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const pending = usePending();
    const id = useMemo(() => subjectOf(spec.kind), [g, selection]);
    const formId = ENTITY_FORM_IDS[spec.kind];
    useEffect(() => {
        usePending.setState({ subject: id, edits: {}, note: null });
    }, [id]);
    useEffect(() => () => usePending.setState({ subject: null, edits: {}, note: null }), []);
    // Nothing selected any more (a click on empty space, Esc): the form closes, as in SolidWorks.
    useEffect(() => {
        if (selection.some(isPick)) {
            return;
        }
        const timer = window.setTimeout(() => {
            if (!useSketcher.getState().selection.some(isPick) && useToolSession.getState().toolId === formId) {
                api.run(async () => ({ text: '', isError: false }));
            }
        }, 0);
        return () => window.clearTimeout(timer);
    }, [selection]);
    const curve = id && spec.kind !== 'point' ? curveOf(g, id) : undefined;
    const now = id ? entityValues(g, spec.kind, id) : null;
    const endless = curve?.kind === 'line' && !!curve.endless;
    const values: Values = {};
    for (const f of [...spec.params(endless), ...(spec.more ?? [])]) {
        for (const key of f.kind === 'vec' ? [`${f.key}0`, `${f.key}1`] : [f.key]) {
            values[key] = pending.edits[key] ?? (now ? valueText(now[key]) : '');
        }
    }
    const change = (key: string, value: Values[string]) => {
        usePending.setState((p) => ({ edits: { ...p.edits, [key]: String(value) } }));
        // A spin button (not typing in the field) puts the value in at once.
        if (!(document.activeElement instanceof HTMLInputElement)) {
            applyPending(spec.kind);
        }
    };
    const fields = (list: Field[]) => (
        <div
            className="pm-fields"
            onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
                    e.preventDefault();
                    e.stopPropagation();
                    applyPending(spec.kind);
                }
            }}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    applyPending(spec.kind);
                }
            }}
        >
            {list.map((f) => <FieldInput key={f.key} field={f} values={values} change={change} spin />)}
        </div>
    );
    return (
        <>
            {!selection.some(isPick) && <p className="tb-note">Select a {spec.noun} in the view.</p>}
            {selection.some(isPick) && <EntityRelations />}
            {curve && (
                <PmSection title="Options">
                    <label className="tb-check">
                        <input type="checkbox" checked={!!curve.construction} onChange={() => setConstruction(g, curve.id, !curve.construction)} />
                        <span>For construction</span>
                    </label>
                    {curve.kind === 'line' && (
                        <label className="tb-check" title={endless ? 'An infinite line cannot be made finite again: trim it to give it ends.' : undefined}>
                            <input
                                type="checkbox"
                                checked={endless}
                                disabled={endless}
                                onChange={() => {
                                    const r = makeEndless(g, curve.id);
                                    usePending.setState({ note: 'error' in r ? r.error : commitGeometry(r) ? null : useSketcher.getState().message });
                                }}
                            />
                            <span>Infinite length</span>
                        </label>
                    )}
                </PmSection>
            )}
            {now && (
                <PmSection title="Parameters">
                    {fields(spec.params(endless))}
                    {pending.note && <p className="tb-note">{pending.note}</p>}
                </PmSection>
            )}
            {now && spec.more && <PmSection title="Additional parameters" open={false}>{fields(spec.more)}</PmSection>}
            {!id && selection.some(isPick) && <p className="tb-note">Parameters show when one {spec.noun} is selected.</p>}
        </>
    );
}

function entityForm(spec: EntitySpec): ToolDef {
    return {
        id: ENTITY_FORM_IDS[spec.kind],
        label: spec.label,
        icon: spec.icon,
        hint: `the selected ${spec.noun}`,
        panel: true,
        width: 300,
        top: (api) => <EntityPm spec={spec} api={api} />,
        apply: async (): Promise<Result> => {
            const error = applyPending(spec.kind);
            if (error) {
                return { text: error, isError: true };
            }
            // OK: done with this entity (SolidWorks clears the selection with the PropertyManager).
            useSketcher.setState({ selection: [] });
            return { text: '', isError: false };
        },
    };
}

/** Line properties, Circle, Arc and Point, opened by id (sk-pm-<kind>) when such an entity is clicked. */
export const entityForms: ToolDef[] = SPECS.map(entityForm);
