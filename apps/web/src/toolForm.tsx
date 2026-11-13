// The form behind a tool: its values, apply and result, shared by the floating popup and the property manager.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchPreview, LatestOnly, toPreview, type PreviewResponse, type ToolCall } from './preview';
import { useRegionPick } from './regionPick';
import { captureToolCalls, clearPreview, setPreview } from './state';
import type { Ctx, Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { clearToolSession, publishToolSession } from './toolSession';
import { PickList, PositionTarget, usePickBoxes } from './PickList';

const PREVIEW_DELAY_MS = 250;

/**
 * Live preview of a tool with `preview` set: after the values (or picked regions, or the project) change, the
 * calls its apply would make are captured instead of sent and shown in the 3D view as they would turn out.
 * Returns the reason the latest preview failed, if it did. The preview is cleared when the form closes.
 */
function useToolPreview(tool: ToolDef, ctx: Ctx, values: Values, enabled: boolean, busy: boolean) {
    const picks = useRegionPick((s) => s.picked);
    const [note, setNote] = useState<string | null>(null);
    const latest = useRef({ values, ctx });
    latest.current = { values, ctx };
    const queue = useRef<LatestOnly<ToolCall[], PreviewResponse> | null>(null);
    const sent = useRef<{ calls: string; project: Ctx['project'] } | null>(null);

    useEffect(() => {
        if (!enabled) {
            return;
        }
        let shown = false;
        const q = new LatestOnly<ToolCall[], PreviewResponse>(fetchPreview, (response) => {
            const failure = response.error ?? Object.values(response.errors)[0] ?? null;
            setNote(failure);
            if (response.error) {
                // The calls themselves failed: the committed model stays in view.
                clearPreview();
            } else {
                setPreview(toPreview(response));
            }
            shown = true;
        }, (error) => setNote(error instanceof Error ? error.message : String(error)));
        queue.current = q;
        return () => {
            q.close();
            queue.current = null;
            sent.current = null;
            if (shown) {
                clearPreview();
            }
        };
    }, [enabled]);

    useEffect(() => {
        if (!enabled || busy) {
            return;
        }
        const timer = setTimeout(() => {
            const { values: v, ctx: c } = latest.current;
            let calls: ToolCall[] = [];
            try {
                if (tool.previewCalls) {
                    calls = tool.previewCalls(v, c);
                } else {
                    const captured = captureToolCalls(() => tool.apply!(v, c));
                    calls = captured.calls;
                    void Promise.resolve(captured.result).catch(() => undefined);
                }
            } catch {
                calls = [];
            }
            if (calls.length === 0) {
                // Invalid input: no new preview, and none still on its way.
                queue.current?.cancel();
                sent.current = null;
                return;
            }
            const key = JSON.stringify(calls);
            if (sent.current?.calls === key && sent.current.project === c.project) {
                return;
            }
            sent.current = { calls: key, project: c.project };
            queue.current?.push(calls);
        }, PREVIEW_DELAY_MS);
        return () => clearTimeout(timer);
    }, [enabled, busy, values, picks, ctx.part, ctx.project, ctx.edit?.feature]);

    /** Drops previews still to come, e.g. when the real call is sent. */
    const hold = () => {
        queue.current?.cancel();
        sent.current = null;
    };
    return { note, hold };
}

/**
 * Publishes the open form to the tool session store (for the 3D drag handles) and clears it on close. The
 * session's setter applies a patch key by key through the tool's onChange, as typing each value would.
 */
function useToolSessionPublish(tool: ToolDef, ctx: Ctx, values: Values, setValues: (v: Values) => void) {
    const [owner] = useState(() => Symbol(tool.id));
    const latest = useRef({ values, ctx });
    latest.current = { values, ctx };
    const [set] = useState(() => (patch: Values) => {
        let next = latest.current.values;
        for (const [key, value] of Object.entries(patch)) {
            next = { ...next, [key]: value };
            next = { ...next, ...(tool.onChange?.(key, next, latest.current.ctx) ?? {}) };
        }
        // Several patches can arrive before React renders: each builds on the last.
        latest.current = { ...latest.current, values: next };
        setValues(next);
    });
    useEffect(() => {
        publishToolSession(owner, { toolId: tool.id, values, ctx, set });
    }, [values, ctx, tool.id]);
    useEffect(() => () => clearToolSession(owner), []);
}

export function useToolForm(tool: ToolDef, ctx: Ctx, onClose: () => void) {
    const [values, setValues] = useState<Values>(() => tool.defaults?.(ctx) ?? {});
    const [result, setResult] = useState<Result | null>(null);
    const [busy, setBusy] = useState(false);
    const form = useRef<HTMLFormElement>(null);
    const missingPart = !!tool.needsPart && !ctx.part;
    const fields = missingPart ? [] : (tool.fields?.(ctx) ?? []).filter((f) => !f.show || f.show(values));
    // The preview stays in view until the form closes after OK, by when the real state has arrived (the server
    // sends the new project and mesh keys before the tool's answer), so the view never falls back to the old model.
    const preview = useToolPreview(tool, ctx, values, !!(tool.preview || tool.previewCalls) && !!tool.apply && !missingPart, busy);

    useEffect(() => {
        form.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=color]), select, .tb-apply, .pm-ok')?.focus();
    }, []);

    const change = (key: string, value: Values[string]) => {
        const next = { ...values, [key]: value };
        setValues({ ...next, ...(tool.onChange?.(key, next, ctx) ?? {}) });
    };
    useToolSessionPublish(tool, ctx, values, setValues);
    usePickBoxes(tool, ctx, fields, values, setValues);
    const run = (call: () => Promise<Result>, close = true) => {
        preview.hold();
        setBusy(true);
        void call().then((r) => {
            setBusy(false);
            if (!r.isError && close && !tool.keepOpen) {
                onClose();
            } else {
                setResult(r.isError || tool.keepOpen ? r : null);
            }
        });
    };
    const api: PopupApi = { values, set: (patch: Values) => setValues((v) => ({ ...v, ...patch })), run };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (tool.apply && !busy && !missingPart) {
            run(() => tool.apply!(values, ctx));
        }
    };
    const shown = result ?? (preview.note ? { text: `Preview: ${preview.note}`, isError: true } : null);
    return { values, result: shown, busy, form, missingPart, fields, change, api, submit };
}

/** Steps a number field's text value up or down; leaves expressions it cannot read alone. */
function stepped(value: string, field: Field, sign: number): string | null {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n)) {
        return null;
    }
    const step = field.step ?? 1;
    const next = Math.round((n + sign * step) / step) * step;
    return String(Math.round((field.min !== undefined ? Math.max(field.min, next) : next) * 1e6) / 1e6);
}

export function FieldInput(props: { field: Field; values: Values; change: (key: string, value: Values[string]) => void; spin?: boolean }) {
    const { field, values, change, spin } = props;
    const value = values[field.key];
    const unit = field.unit && <em>{field.unit}</em>;
    switch (field.kind) {
        case 'pick':
            return <PickList field={field} values={values} change={change} />;
        case 'check':
            return (
                <label className="tb-check">
                    <input type="checkbox" checked={!!value} onChange={(e) => change(field.key, e.target.checked)} />
                    <span>{field.label}</span>
                </label>
            );
        case 'select':
            return (
                <label className="tb-field">
                    <span>{field.label}</span>
                    <span className="tb-input">
                        <select value={value as string} onChange={(e) => change(field.key, e.target.value)}>
                            {field.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {unit}
                    </span>
                </label>
            );
        case 'multi': {
            const list = value as string[];
            return (
                <div className="tb-field">
                    <span>{field.label}</span>
                    <span className="tb-chips">
                        {field.options!.map((o) => (
                            <button
                                key={o.value}
                                type="button"
                                data-order={field.key === 'sections' && list.includes(o.value) ? list.indexOf(o.value) + 1 : undefined}
                                className={list.includes(o.value) ? 'on' : ''}
                                aria-pressed={list.includes(o.value)}
                                onClick={() => change(field.key, list.includes(o.value)
                                    ? list.filter((v) => v !== o.value) : [...list, o.value])}
                            >
                                {o.label}
                            </button>
                        ))}
                    </span>
                </div>
            );
        }
        case 'color':
            return (
                <label className="tb-field">
                    <span>{field.label}</span>
                    <span className="tb-input tb-color">
                        <input type="color" value={value as string} onChange={(e) => change(field.key, e.target.value)} />
                        <input
                            value={value as string}
                            onChange={(e) => change(field.key, e.target.value)}
                            pattern="#[0-9a-fA-F]{6}"
                            aria-label={`${field.label} hex`}
                        />
                    </span>
                </label>
            );
        case 'range':
            return (
                <label className="tb-field">
                    <span>{field.label}</span>
                    <span className="tb-range">
                        <input
                            type="range"
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={value as string}
                            onChange={(e) => change(field.key, e.target.value)}
                        />
                        <output>{Number(value).toFixed(2)}</output>
                    </span>
                </label>
            );
        case 'vec': {
            const axes = field.axes ?? ['X', 'Y', 'Z'];
            const inputs = (
                <div className="tb-field">
                    <span>{field.label}{field.unit && <i>{field.unit}</i>}</span>
                    <span className="tb-vec">
                        {axes.map((axis, i) => axis && (
                            <label key={i} className={`axis-${'xyz'[i]}`}>
                                <b>{axis}</b>
                                <input
                                    type="number"
                                    step="any"
                                    value={values[`${field.key}${i}`] as string}
                                    onChange={(e) => change(`${field.key}${i}`, e.target.value)}
                                    aria-label={`${field.label} ${axis}`}
                                />
                            </label>
                        ))}
                    </span>
                </div>
            );
            return field.pickable ? <PositionTarget field={field}>{inputs}</PositionTarget> : inputs;
        }
        default: {
            const number = field.kind !== 'text';
            const nudge = (sign: number) => {
                const next = stepped(String(value ?? ''), field, sign);
                if (next !== null) {
                    change(field.key, next);
                }
            };
            return (
                <label className="tb-field">
                    <span>{field.label}</span>
                    <span className="tb-input">
                        <input
                            type={number ? 'number' : 'text'}
                            step={field.step ?? 'any'}
                            min={field.min}
                            value={value as string}
                            onChange={(e) => change(field.key, e.target.value)}
                        />
                        {unit}
                        {spin && number && (
                            <span className="pm-spin">
                                <button type="button" tabIndex={-1} onClick={() => nudge(1)} aria-label={`Increase ${field.label}`}>
                                    <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M1 4l3-3 3 3" /></svg>
                                </button>
                                <button type="button" tabIndex={-1} onClick={() => nudge(-1)} aria-label={`Decrease ${field.label}`}>
                                    <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" /></svg>
                                </button>
                            </span>
                        )}
                    </span>
                </label>
            );
        }
    }
}
