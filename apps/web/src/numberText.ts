/** Decimals kept in a value the app works out itself (drags, picks, conversions): 0.000001 mm. Typed values are kept as typed. */
export const VALUE_DECIMALS = 6;
/** Decimals shown in readouts and labels in the view. */
export const SHOWN_DECIMALS = 4;

/** Rounds to `decimals`; never gives -0. */
export function roundTo(n: number, decimals = VALUE_DECIMALS): number {
    const scale = 10 ** decimals;
    return Math.round(n * scale) / scale + 0;
}

/** A worked-out value as form text: full precision, no trailing zeros. */
export const valueText = (n: number): string => String(roundTo(n));

/** A value for a label or readout in the view: up to four decimals, no trailing zeros. */
export const shownText = (n: number): string => String(roundTo(n, SHOWN_DECIMALS));

/** The smallest of 1, 2, 5 times a power of ten that is at least `x` (never below the value precision). */
export function niceStep(x: number): number {
    const least = 10 ** -VALUE_DECIMALS;
    if (!(x > least)) {
        return least;
    }
    const power = 10 ** Math.floor(Math.log10(x));
    // A hair of slack: 0.0001 / 10 ** -4 is not exactly 1.
    const m = x / power - 1e-9;
    return roundTo((m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power);
}

/** Adds `count` steps to the number in a field's text; null when the text is not a plain number. */
export function stepText(text: string, step: number, count: number, min?: number, max?: number): string | null {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) {
        return null;
    }
    let next = n + count * step;
    if (min !== undefined) {
        next = Math.max(min, next);
    }
    if (max !== undefined) {
        next = Math.min(max, next);
    }
    return valueText(next);
}
