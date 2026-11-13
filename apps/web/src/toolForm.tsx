// The form behind a tool: its values, apply and result, shared by the floating popup and the property manager.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Ctx, Field, PopupApi, Result, ToolDef, Values } from './toolDefs';

export function useToolForm(tool: ToolDef, ctx: Ctx, onClose: () => void) {
    const [values, setValues] = useState<Values>(() => tool.defaults?.(ctx) ?? {});
    const [result, setResult] = useState<Result | null>(null);
    const [busy, setBusy] = useState(false);
    const form = useRef<HTMLFormElement>(null);
    const missingPart = !!tool.needsPart && !ctx.part;
    const fields = missingPart ? [] : (tool.fields?.(ctx) ?? []).filter((f) => !f.show || f.show(values));

    useEffect(() => {
        form.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=color]), select, .tb-apply, .pm-ok')?.focus();
    }, []);

    const change = (key: string, value: Values[string]) => {
        const next = { ...values, [key]: value };
        setValues({ ...next, ...(tool.onChange?.(key, next, ctx) ?? {}) });
    };
    const run = (call: () => Promise<Result>, close = true) => {
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
    return { values, result, busy, form, missingPart, fields, change, api, submit };
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
            return (
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
