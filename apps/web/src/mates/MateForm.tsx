// The Mate PropertyManager (Standard tab) in the left panel: Mate selections (Entities to Mate, or the common and
// component references of Multiple mate mode), the mate types the selection takes, Mate alignment, the distance or
// angle with Flip dimension, and Options. The components move as the mate would put them, as a see-through preview.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Part } from '@jarvis/core';
import { MATE_LABELS, type DistanceEnd, type MateType } from '@jarvis/core/mates';
import { Icon } from '../icons';
import { valueText } from '../numberText';
import { clearPreview, runTool, setPreview, useStudio } from '../state';
import type { Result, ToolDef } from '../toolDefs';
import { applyCall, formPlan, previewPlan } from './mateForm';
import { itemLabels, itemsOfMate, resetMateForm, useMateForm, type MateBox } from './mateState';
import './mates.css';

const TYPES: MateType[] = ['coincident', 'parallel', 'perpendicular', 'tangent', 'concentric', 'lock', 'distance', 'angle'];
const END_NAMES: Record<DistanceEnd, string> = { centre: 'Centre', min: 'Min', max: 'Max' };

function Section(props: { title: string; children: ReactNode }) {
    const [open, setOpen] = useState(true);
    return (
        <section className={`pm-section ${open ? 'open' : ''}`}>
            <button type="button" className="pm-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span>{props.title}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
            </button>
            {open && <div className="pm-section-body">{props.children}</div>}
        </section>
    );
}

/** A selection box: its entries, the active one outlined; a click on it makes it take the next picks. */
function SelectionBox({ box, label, parts }: { box: MateBox; label: string; parts: readonly Part[] }) {
    const items = useMateForm((s) => s.items);
    const multiple = useMateForm((s) => s.multiple);
    const active = useMateForm((s) => s.active === box || (!s.multiple && box === 'entities'));
    const labels = itemLabels(items, parts);
    const rows = items.map((item, index) => ({ item, index })).filter((r) => r.item.box === box);
    return (
        <div className="tb-field pm-pick">
            <span>{label}</span>
            <ul
                className={`pm-contours pm-pick-list ${active ? 'active' : ''}`}
                onClick={() => multiple && useMateForm.setState({ active: box })}
                aria-label={label}
            >
                {rows.length === 0 && <li className="pm-contours-all">{box === 'common' ? 'Pick one entity' : 'Pick in the view or the tree'}</li>}
                {rows.map(({ item, index }) => (
                    <li
                        key={index}
                        onMouseEnter={() => useMateForm.setState({ hover: index })}
                        onMouseLeave={() => useMateForm.setState({ hover: null })}
                        title={item.exact ? labels[index] : `${labels[index]} (its exact shape is being read)`}
                    >
                        <span>{labels[index]}{item.exact ? '' : ' …'}</span>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                useMateForm.setState((s) => ({ items: s.items.filter((i) => i !== item), hover: null }));
                            }}
                            title="Remove from the selection"
                            aria-label={`Remove ${labels[index]}`}
                        >
                            ×
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Loads the edited mate into the form when it opens; clears the form and its preview when it closes. */
function useFormLife(): void {
    useEffect(() => {
        const { editing } = useMateForm.getState();
        const mate = editing ? useStudio.getState().history?.assembly?.mates.find((m) => m.id === editing) : undefined;
        useMateForm.setState(mate ? {
            open: true, name: mate.name, items: itemsOfMate(mate), type: mate.type, alignment: mate.alignment ?? null,
            value: mate.value !== undefined ? valueText(mate.value) : null, flip: mate.flip ?? null, lockRotation: !!mate.lockRotation,
            alignAxes: !!mate.alignAxes, ends: mate.ends ?? ['centre', 'centre'],
        } : { open: true, editing: null });
        return () => {
            resetMateForm();
            clearPreview();
        };
    }, []);
}

export function MateForm() {
    useFormLife();
    const form = useMateForm();
    const parts = useStudio((s) => s.history?.parts) ?? [];
    const assembly = useStudio((s) => s.history?.assembly);
    // Not on hover or box changes: only what changes the mates.
    const plan = useMemo(() => formPlan(form, parts, assembly), [form.items, form.type, form.alignment, form.value, form.flip, form.lockRotation,
        form.alignAxes, form.ends, form.multiple, form.name, form.editing, parts, assembly]);
    const preview = useMemo(() => (plan.mates.length ? previewPlan(plan, parts, assembly, form.editing) : null), [plan, parts, assembly, form.editing]);

    useEffect(() => {
        const moved = preview ? Object.entries(preview.result.placements) : [];
        if (!moved.length) {
            clearPreview();
            return;
        }
        const shown = Object.fromEntries(moved.flatMap(([id, placement]) => {
            const part = parts.find((p) => p.id === id);
            return part ? [[id, { ...part, ...placement }]] : [];
        }));
        setPreview({ parts: shown, keys: {}, changes: {}, errors: {}, error: null });
    }, [preview]);

    const shownMate = plan.mates[0];
    const set = (patch: Partial<typeof form>) => useMateForm.setState(patch);
    const states = preview?.states ?? [];
    const bad = states.find((s) => s.state === 'error') ?? states.find((s) => s.state === 'warning');
    const alignment = form.alignment ?? shownMate?.alignment ?? null;
    const isValue = plan.type === 'distance' || plan.type === 'angle';
    const shownValue = form.value ?? (shownMate?.value !== undefined ? valueText(shownMate.value) : '');
    const flipped = form.flip ?? shownMate?.flip ?? false;

    return (
        <div className="mt-form">
            <label className="tb-field">
                <span>Name</span>
                <span className="tb-input">
                    <input
                        value={form.name || (plan.mates.length === 1 ? shownMate.name : '')}
                        placeholder={plan.type ? MATE_LABELS[plan.type] : 'Mate'}
                        onChange={(e) => set({ name: e.target.value })}
                        disabled={plan.mates.length > 1}
                        aria-label="Mate name"
                    />
                </span>
            </label>
            <Section title="Mate selections">
                {form.multiple ? (
                    <>
                        <SelectionBox box="common" label="Common reference" parts={parts} />
                        <SelectionBox box="components" label="Component references" parts={parts} />
                    </>
                ) : <SelectionBox box="entities" label="Entities to mate" parts={parts} />}
                {!form.editing && (
                    <label className="tb-check">
                        <input
                            type="checkbox"
                            checked={form.multiple}
                            onChange={(e) => set({
                                multiple: e.target.checked, active: e.target.checked ? 'common' : 'entities',
                                items: e.target.checked ? form.items.map((i, k) => ({ ...i, box: k === 0 ? 'common' : 'components' }))
                                    : form.items.slice(0, 2).map((i) => ({ ...i, box: 'entities' })),
                            })}
                        />
                        <span>Multiple mate mode</span>
                    </label>
                )}
                {form.note && <p className="tb-note pm-pick-note">{form.note}</p>}
            </Section>
            <Section title="Standard mates">
                <div className="mt-types" role="radiogroup" aria-label="Mate type">
                    {TYPES.map((t) => {
                        const ok = plan.valid.includes(t);
                        return (
                            <button
                                key={t}
                                type="button"
                                role="radio"
                                aria-checked={plan.type === t}
                                className={plan.type === t ? 'on' : ''}
                                disabled={!ok}
                                onClick={() => set({ type: t, value: null, flip: null, alignment: null })}
                                title={ok ? MATE_LABELS[t] : `${MATE_LABELS[t]}: not for this selection`}
                            >
                                <Icon name={`mate-${t}`} size={16} />
                                <span>{MATE_LABELS[t]}</span>
                            </button>
                        );
                    })}
                </div>
                {plan.lockRotation && (
                    <label className="tb-check">
                        <input type="checkbox" checked={form.lockRotation} onChange={(e) => set({ lockRotation: e.target.checked })} />
                        <span>Lock rotation</span>
                    </label>
                )}
                {plan.alignAxes && (
                    <label className="tb-check">
                        <input type="checkbox" checked={form.alignAxes} onChange={(e) => set({ alignAxes: e.target.checked })} />
                        <span>Align axes</span>
                    </label>
                )}
                {isValue && (
                    <label className="tb-field">
                        <span>{plan.type === 'angle' ? 'Angle' : 'Distance'}</span>
                        <span className="tb-input">
                            <input
                                type="number"
                                step="any"
                                min={0}
                                value={shownValue}
                                onChange={(e) => set({ value: e.target.value })}
                                aria-label={plan.type === 'angle' ? 'Angle' : 'Distance'}
                            />
                            <em>{plan.type === 'angle' ? 'deg' : 'mm'}</em>
                        </span>
                    </label>
                )}
                {isValue && plan.flip && (
                    <label className="tb-check">
                        <input type="checkbox" checked={flipped} onChange={(e) => set({ flip: e.target.checked })} />
                        <span>Flip dimension</span>
                    </label>
                )}
                {plan.ends && (
                    <div className="tb-field">
                        <span>Measured</span>
                        <span className="mt-ends">
                            {[0, 1].map((k) => (
                                <select
                                    key={k}
                                    value={form.ends[k]}
                                    onChange={(e) => set({ ends: (k === 0 ? [e.target.value, form.ends[1]] : [form.ends[0], e.target.value]) as [DistanceEnd, DistanceEnd] })}
                                    aria-label={`Where the distance is measured on entity ${k + 1}`}
                                    title="Centre: from the axis or centre; Min: the nearest side; Max: the farthest side"
                                >
                                    {(['centre', 'min', 'max'] as DistanceEnd[]).map((end) => <option key={end} value={end}>{END_NAMES[end]}</option>)}
                                </select>
                            ))}
                        </span>
                    </div>
                )}
                {plan.alignment && (
                    <div className="tb-field">
                        <span>Alignment</span>
                        <span className="mt-align" role="radiogroup" aria-label="Mate alignment">
                            {(['aligned', 'antiAligned'] as const).map((a) => (
                                <button
                                    key={a}
                                    type="button"
                                    role="radio"
                                    aria-checked={alignment === a}
                                    className={alignment === a ? 'on' : ''}
                                    onClick={() => set({ alignment: a })}
                                    title={a === 'aligned'
                                        ? (plan.type === 'tangent' ? 'Aligned: touching from the inside' : 'Aligned: the normals or axes point the same way')
                                        : (plan.type === 'tangent' ? 'Anti-aligned: touching from the outside' : 'Anti-aligned: the normals or axes point opposite ways')}
                                >
                                    <Icon name={a === 'aligned' ? 'aligned' : 'anti-aligned'} size={16} />
                                    <span>{a === 'aligned' ? 'Aligned' : 'Anti-aligned'}</span>
                                </button>
                            ))}
                        </span>
                    </div>
                )}
            </Section>
            <Section title="Options">
                {!form.editing && (
                    <>
                        <label className="tb-check">
                            <input type="checkbox" checked={form.newFolder} onChange={(e) => set({ newFolder: e.target.checked })} />
                            <span>Add to new folder</span>
                        </label>
                        {form.multiple && (
                            <label className="tb-check">
                                <input type="checkbox" checked={form.multiFolder} onChange={(e) => set({ multiFolder: e.target.checked })} />
                                <span>Create multi-mate folder</span>
                            </label>
                        )}
                        <label className="tb-check" title="Moves the components to where the mate puts them, without adding the mate">
                            <input type="checkbox" checked={form.positionOnly} onChange={(e) => set({ positionOnly: e.target.checked })} />
                            <span>Use for positioning only</span>
                        </label>
                    </>
                )}
            </Section>
            {(plan.problem || bad) && (
                <p className={`tb-note mt-state ${bad?.state === 'error' ? 'error' : bad ? 'warning' : ''}`}>
                    {plan.problem ?? (bad?.state === 'error' ? `It cannot be solved as it is: ${bad.message}` : bad?.message)}
                </p>
            )}
        </div>
    );
}

/** OK: adds the mates (or only positions the parts), or saves the edited mate. */
async function applyMate(): Promise<Result> {
    const form = useMateForm.getState();
    const history = useStudio.getState().history;
    if (!history) {
        return { text: 'Not connected to the server.', isError: true };
    }
    const plan = formPlan(form, history.parts, history.assembly);
    const call = applyCall(form, plan, history.assembly);
    if (!call) {
        return { text: plan.problem ?? 'Pick two entities to mate.', isError: true };
    }
    return runTool(call.name, call.args);
}

export const mateTool: ToolDef = {
    id: 'mate',
    label: 'Mate',
    icon: 'mate',
    hint: 'join two parts: faces, edges, vertices, planes, axes, origins',
    panel: true,
    top: () => <MateForm />,
    apply: () => applyMate(),
};

/** Opens the Mate form on a stored mate (Edit mate in the tree). */
export function editMate(id: string): void {
    const form = useMateForm.getState();
    if (form.open) {
        const mate = useStudio.getState().history?.assembly?.mates.find((m) => m.id === id);
        if (mate) {
            useMateForm.setState({
                editing: id, name: mate.name, items: itemsOfMate(mate), type: mate.type, alignment: mate.alignment ?? null,
                value: mate.value !== undefined ? valueText(mate.value) : null, flip: mate.flip ?? null, lockRotation: !!mate.lockRotation,
                alignAxes: !!mate.alignAxes, ends: mate.ends ?? ['centre', 'centre'], multiple: false, active: 'entities',
            });
        }
        return;
    }
    useMateForm.setState({ editing: id });
    window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: mateTool.id }));
}

/** Opens a new Mate form (from the tree or a component's menu). */
export function openMateForm(): void {
    if (!useMateForm.getState().open) {
        window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: mateTool.id }));
    }
}
