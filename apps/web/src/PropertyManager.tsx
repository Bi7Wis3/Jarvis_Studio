// The property manager: a feature's form shown in the left panel in place of the feature tree while the feature is
// created or edited (SolidWorks style), with OK and Cancel at the top and the fields in collapsible sections.

import { useMemo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import type { Part, SketchRegion } from '@jarvis/core';
import { Icon } from './icons';
import { nextFeatureName } from './featureNames';
import { pickedRegions, regionAt, regionsOf, useRegionPick } from './regionPick';
import { useSketcher } from './sketcher';
import { FieldInput, useToolForm } from './toolForm';
import { finishTool, sketchEditTarget, sketchSteps, type Ctx, type Field, type ToolDef, type Values } from './toolDefs';
import type { Pt } from './sketchMath';

/** Whether the property manager is showing, and the element in the left panel it is drawn into. */
export const usePropertyManager = create<{ open: boolean; slot: HTMLElement | null }>(() => ({ open: false, slot: null }));

/**
 * Every tool form opens in the property manager, in the left panel, in both workspaces and while sketching: nothing
 * floats under the toolbar. (The arguments are kept for callers; the rule no longer depends on them.)
 */
export function usesPanel(_tool: ToolDef, _workspace: 'part' | 'assembly', _sketching: boolean): boolean {
    return true;
}

const shortName = (name: string | undefined, fallback: string) => name?.split(' · ')[0] || fallback;

function partOf(ctx: Ctx, id: string | null | undefined): Part | undefined {
    return id ? ctx.project?.parts.find((p) => p.id === id) : undefined;
}

/** The finish tool's names: the step it creates or edits, and the sketch whose regions are picked. */
function finishNames(ctx: Ctx, values: Values): { name: string; sketch: string } {
    const target = sketchEditTarget();
    if (target?.feature) {
        const f = target.feature;
        const ref = 'sketchRef' in f ? f.sketchRef : undefined;
        const step = ref ? partOf(ctx, target.partId)?.features?.find((s) => s.id === ref) : undefined;
        return { name: shortName(f.name, 'Feature'), sketch: shortName(step?.name ?? f.name, 'Sketch') };
    }
    if (target?.base) {
        const name = partOf(ctx, target.partId)?.name ?? 'Base body';
        return { name, sketch: name };
    }
    const owner = partOf(ctx, useSketcher.getState().partId);
    const features = !owner || values.result === 'new' ? [] : owner.features;
    const sketch = nextFeatureName(features, { op: 'sketch' });
    if (values.op === 'sketch') {
        return { name: sketch, sketch };
    }
    const cut = values.op === 'cut' || values.result === 'cut';
    return { name: nextFeatureName(features, { op: values.op === 'revolve' ? 'revolve' : 'extrude', mode: cut ? 'cut' : 'add' }), sketch };
}

/** The header name: the edited step's name, or the name a new step will get (Boss-Extrude2). */
function featureName(tool: ToolDef, ctx: Ctx, values: Values): string {
    if (tool.id === finishTool.id) {
        return finishNames(ctx, values).name;
    }
    if (ctx.edit?.feature) {
        return shortName(ctx.edit.feature.name, tool.label);
    }
    if (ctx.edit && tool.shapes) {
        return partOf(ctx, ctx.edit.partId)?.name ?? tool.label;
    }
    if (tool.op && ctx.part) {
        return nextFeatureName(ctx.part.features, { op: tool.op, mode: values.mode === 'cut' ? 'cut' : 'add' });
    }
    return tool.label;
}

function subtitle(tool: ToolDef, ctx: Ctx): string {
    if (tool.id === finishTool.id) {
        return sketchEditTarget() ? 'Edit sketch' : 'Exit sketch';
    }
    return ctx.edit && tool.id !== 'no-edit' ? `Edit ${tool.label.toLowerCase()}` : tool.label;
}

/** Consecutive fields with the same section, in order; fields without one form a first untitled group. */
function groupFields(fields: Field[]): { title: string | null; fields: Field[] }[] {
    const groups: { title: string | null; fields: Field[] }[] = [];
    for (const field of fields) {
        const title = field.section ?? null;
        const last = groups[groups.length - 1];
        if (last && last.title === title) {
            last.fields.push(field);
        } else {
            groups.push({ title, fields: [field] });
        }
    }
    return groups;
}

function Section(props: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
    const { title, open, onToggle, children } = props;
    return (
        <section className={`pm-section ${open ? 'open' : ''}`}>
            <button type="button" className="pm-section-head" onClick={onToggle} aria-expanded={open}>
                <span>{title}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
            </button>
            {open && <div className="pm-section-body">{children}</div>}
        </section>
    );
}

/** The regions picked for the feature, one row each; picking happens in the viewport. */
function SelectedContours({ tool, ctx, values }: { tool: ToolDef; ctx: Ctx; values: Values }) {
    const picks = useRegionPick((s) => s.picked);
    const geometry = useSketcher((s) => s.geometry);
    const sketcher = tool.regionPick === 'sketcher';
    const step = sketcher ? undefined : sketchSteps(ctx.part).find((f) => f.id === values.sketch);
    const regions = useMemo<SketchRegion[] | undefined>(
        () => (sketcher ? regionsOf(geometry) : step?.sketch.regions),
        [sketcher, geometry, step?.sketch.regions],
    );
    const sketchName = sketcher ? finishNames(ctx, values).sketch : shortName(step?.name, String(values.sketch ?? 'Sketch'));
    const rows: { key: string; label: string; keep: (p: Pt) => boolean }[] = [];
    if (regions) {
        for (const i of pickedRegions(regions, picks)) {
            rows.push({ key: `r${i}`, label: `${sketchName}-Region<${i + 1}>`, keep: (p) => regionAt(regions, p) !== i });
        }
    }
    // Picks that fall in no known region (a sketch without stored regions): one row each.
    picks.forEach((pick, i) => {
        if (!regions || regionAt(regions, pick) < 0) {
            rows.push({ key: `p${i}`, label: `${sketchName}-Area<${i + 1}>`, keep: (p) => p !== pick });
        }
    });
    return (
        <ul className="pm-contours" aria-label="Selected contours">
            {rows.length === 0 && <li className="pm-contours-all">Whole sketch</li>}
            {rows.map((row) => (
                <li key={row.key}>
                    <span>{row.label}</span>
                    <button
                        type="button"
                        onClick={() => useRegionPick.setState((s) => ({ picked: s.picked.filter(row.keep) }))}
                        title="Remove from the selection"
                        aria-label={`Remove ${row.label}`}
                    >
                        ×
                    </button>
                </li>
            ))}
        </ul>
    );
}

function picksRegions(tool: ToolDef, ctx: Ctx, values: Values): boolean {
    if (tool.regionPick === 'sketcher') {
        return values.op !== 'sketch' && sketchEditTarget()?.feature?.op !== 'sketch';
    }
    return tool.regionPick === 'step' && !!ctx.part && !!values.sketch;
}

export function PropertyManager({ tool, ctx, onClose }: { tool: ToolDef; ctx: Ctx; onClose: () => void }) {
    const form = useToolForm(tool, ctx, onClose);
    const { values, result, busy, missingPart, fields, change, api, submit } = form;
    const [closed, setClosed] = useState<Set<string>>(() => new Set());
    const toggle = (title: string) => setClosed((c) => {
        const next = new Set(c);
        if (!next.delete(title)) {
            next.add(title);
        }
        return next;
    });
    const name = featureName(tool, ctx, values);

    return (
        <div className="pm tb-popup" role="dialog" aria-label={`${subtitle(tool, ctx)}: ${name}`}>
            <form
                ref={form.form}
                onSubmit={submit}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        onClose();
                    }
                }}
            >
                <div className="pm-head">
                    <Icon name={tool.icon} size={18} />
                    <span className="pm-title">
                        <b title={name}>{name}</b>
                        <span>{subtitle(tool, ctx)}{tool.needsPart && ctx.part ? ` · ${ctx.part.name}` : ''}</span>
                    </span>
                </div>
                <div className="pm-actions">
                    {!tool.noApply && (
                        <button
                            type="submit"
                            className={`pm-ok ${busy ? 'busy' : ''}`}
                            disabled={busy || missingPart}
                            title={busy ? 'Working…' : 'OK (Enter)'}
                            aria-label="OK"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                        </button>
                    )}
                    <button type="button" className="pm-cancel" onClick={onClose} title="Cancel (Esc)" aria-label="Cancel">
                        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                </div>
                {result && <pre className={`tb-result ${result.isError ? 'error' : ''}`}>{result.text}</pre>}
                <div className="pm-body">
                    {missingPart ? <p className="tb-note">Select a part in the viewport or the project tree.</p> : (
                        <>
                            {tool.top?.(api, ctx)}
                            {groupFields(fields).map((group, i) => {
                                const inputs = group.fields.map((f) => <FieldInput key={f.key} field={f} values={values} change={change} spin />);
                                return group.title ? (
                                    <Section key={group.title} title={group.title} open={!closed.has(group.title)} onToggle={() => toggle(group.title!)}>
                                        {inputs}
                                    </Section>
                                ) : <div key={`plain-${i}`} className="pm-fields">{inputs}</div>;
                            })}
                            {picksRegions(tool, ctx, values) && (
                                <Section title="Selected contours" open={!closed.has('contours')} onToggle={() => toggle('contours')}>
                                    <SelectedContours tool={tool} ctx={ctx} values={values} />
                                </Section>
                            )}
                            {tool.extra?.(api, ctx)}
                        </>
                    )}
                </div>
            </form>
        </div>
    );
}
