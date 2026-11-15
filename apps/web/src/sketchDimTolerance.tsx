// Tolerance and precision of a sketch dimension (SolidWorks: Dimension PropertyManager > Tolerance/Precision): the
// tolerance type (None, Basic, Bilateral, Limit, Symmetric, MIN, MAX), the maximum and minimum variation, the digits
// shown for the value and the tolerance, and parentheses. Display only: the sketch is solved to the nominal value.

import type { DimensionTolerance, SketchConstraint } from '@jarvis/core';
import type { Field, Values } from './toolDefs';
import { shownText, valueText } from './numberText';

type Dim = Extract<SketchConstraint, { value: number }>;

export const TOLERANCE_TYPES: { value: DimensionTolerance['type']; label: string }[] = [
    { value: 'none', label: 'None' }, { value: 'basic', label: 'Basic' }, { value: 'bilateral', label: 'Bilateral' },
    { value: 'limit', label: 'Limit' }, { value: 'symmetric', label: 'Symmetric' }, { value: 'min', label: 'MIN' }, { value: 'max', label: 'MAX' },
];

const PRECISIONS = [{ value: '', label: 'As the app shows values' }, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: n ? `.${'1'.padStart(n, '0')}` : 'None (whole)' }))];

const varies = (v: Values) => v.tolType === 'bilateral' || v.tolType === 'limit' || v.tolType === 'symmetric';

/** The Tolerance/Precision fields of the Dimension PropertyManager. */
export const TOLERANCE_FIELDS: Field[] = [
    { key: 'tolType', label: 'Tolerance type', kind: 'select', options: TOLERANCE_TYPES, section: 'Tolerance/Precision' },
    { key: 'tolMax', label: 'Maximum variation', kind: 'text', section: 'Tolerance/Precision', show: varies },
    { key: 'tolMin', label: 'Minimum variation (under the value)', kind: 'text', section: 'Tolerance/Precision', show: (v) => varies(v) && v.tolType !== 'symmetric' },
    { key: 'precision', label: 'Unit precision', kind: 'select', options: PRECISIONS, section: 'Tolerance/Precision' },
    { key: 'tolPrecision', label: 'Tolerance precision', kind: 'select', options: PRECISIONS, section: 'Tolerance/Precision', show: varies },
    { key: 'parentheses', label: 'Show parentheses', kind: 'check', section: 'Tolerance/Precision', show: (v) => v.tolType === 'bilateral' || v.tolType === 'symmetric' },
];

export function toleranceValues(c: Dim): Values {
    const t = c.tolerance;
    return {
        tolType: t?.type ?? 'none', tolMax: valueText(t?.max ?? 0), tolMin: valueText(t?.min ?? 0),
        precision: t?.precision === undefined ? '' : String(t.precision), tolPrecision: t?.tolPrecision === undefined ? '' : String(t.tolPrecision),
        parentheses: !!t?.parentheses,
    };
}

/** The tolerance the form describes, or undefined for none at the app's precision; throws on a value that is not a number. */
export function toleranceOf(v: Values): DimensionTolerance | undefined {
    const type = (TOLERANCE_TYPES.some((t) => t.value === v.tolType) ? v.tolType : 'none') as DimensionTolerance['type'];
    const amount = (key: string, label: string): number => {
        const n = Number(String(v[key] ?? '0').trim() || '0');
        if (!Number.isFinite(n)) {
            throw new Error(`${label} must be a number.`);
        }
        return n;
    };
    const digits = (key: string): number | undefined => (v[key] === '' || v[key] === undefined ? undefined : Number(v[key]));
    const out: DimensionTolerance = { type };
    if (type === 'bilateral' || type === 'limit' || type === 'symmetric') {
        out.max = amount('tolMax', 'Maximum variation');
        if (type !== 'symmetric') {
            out.min = amount('tolMin', 'Minimum variation');
        }
        const tp = digits('tolPrecision');
        if (tp !== undefined) {
            out.tolPrecision = tp;
        }
    }
    const p = digits('precision');
    if (p !== undefined) {
        out.precision = p;
    }
    if (v.parentheses && (type === 'bilateral' || type === 'symmetric')) {
        out.parentheses = true;
    }
    return type === 'none' && out.precision === undefined ? undefined : out;
}

const fixed = (n: number, digits: number | undefined) => (digits === undefined ? shownText(n) : (n + 0).toFixed(digits));
const signed = (n: number, digits: number | undefined) => `${n < 0 ? '−' : '+'}${fixed(Math.abs(n), digits)}`;

/**
 * The label's parts: the value text (`base`, as the dimension shows it, with its number at the unit precision) and the
 * tolerance after it; limit: the upper and lower values instead. Plain text, for lists and tests.
 */
export function toleranceParts(c: Dim, base: string): { main: string; upper?: string; lower?: string; tail?: string; boxed?: boolean } {
    const t = c.tolerance;
    if (!t) {
        return { main: base };
    }
    const number = shownText(c.value);
    const at = (n: number) => base.replace(number, fixed(n, t.precision));
    const main = at(c.value);
    const tp = t.tolPrecision ?? t.precision;
    const wrap = (s: string) => (t.parentheses ? `(${s})` : s);
    switch (t.type) {
        case 'basic':
            return { main, boxed: true };
        case 'bilateral':
            return { main: wrap(main), upper: signed(t.max ?? 0, tp), lower: signed(-(t.min ?? 0), tp) };
        case 'limit':
            return { main: '', upper: at(c.value + (t.max ?? 0)), lower: at(c.value - (t.min ?? 0)) };
        case 'symmetric':
            return { main: wrap(`${main} ±${fixed(Math.abs(t.max ?? 0), tp)}`) };
        case 'min':
            return { main, tail: 'MIN' };
        case 'max':
            return { main, tail: 'MAX' };
        default:
            return { main };
    }
}

/** The label text in one line (lists, messages). */
export function toleranceText(c: Dim, base: string): string {
    const p = toleranceParts(c, base);
    if (p.upper !== undefined && !p.main) {
        return `${p.upper} / ${p.lower}`;
    }
    return [p.main, p.upper !== undefined ? `${p.upper} ${p.lower}` : '', p.tail ?? ''].filter(Boolean).join(' ');
}

/** The value of a dimension label in the view, with its tolerance (stacked for bilateral and limit, boxed for basic). */
export function DimensionValue({ c, text }: { c: Dim; text: string }) {
    const p = toleranceParts(c, text);
    if (!c.tolerance) {
        return <>{text}</>;
    }
    return (
        <span className="sk-dim-tol">
            {p.main && <span className={p.boxed ? 'sk-dim-basic' : undefined}>{p.main}</span>}
            {p.upper !== undefined && (
                <span className="sk-dim-stack">
                    <span>{p.upper}</span>
                    <span>{p.lower}</span>
                </span>
            )}
            {p.tail && <span>{p.tail}</span>}
        </span>
    );
}
