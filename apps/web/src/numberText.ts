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

/** How values are shown (Options > Units and precision); the values themselves always keep full precision. */
export interface ShownPrecision {
    length: number;
    angle: number;
    angleUnit: 'deg' | 'dm' | 'dms' | 'rad';
    /** Decimals a number field shows while it is not being edited; null: as it is. */
    form: number | null;
}

const shown: ShownPrecision = { length: SHOWN_DECIMALS, angle: SHOWN_DECIMALS, angleUnit: 'deg', form: null };

export function setShownPrecision(next: Partial<ShownPrecision>): void {
    Object.assign(shown, next);
}

export const shownPrecision = (): ShownPrecision => ({ ...shown });

/** A value for a label or readout in the view: up to the set decimals (four by default), no trailing zeros. */
export const shownText = (n: number): string => String(roundTo(n, shown.length));

/** An angle in degrees as the view's dimensions show it: degrees, degrees and minutes, with seconds, or radians. */
export function angleText(degrees: number): string {
    const d = shown.angle;
    if (shown.angleUnit === 'rad') {
        return `${roundTo((degrees * Math.PI) / 180, d)} rad`;
    }
    if (shown.angleUnit === 'deg') {
        return `${roundTo(degrees, d)}°`;
    }
    const sign = degrees < 0 ? '−' : '';
    // The smallest unit carries the decimals; carries roll up (59.99995' at 4 decimals is 1°).
    const seconds = shown.angleUnit === 'dms';
    const unit = seconds ? 3600 : 60;
    const total = roundTo(Math.abs(degrees) * unit, d);
    const whole = Math.floor(total / unit + 1e-9);
    let rest = roundTo(total - whole * unit, d);
    if (!seconds) {
        return `${sign}${whole}°${rest}'`;
    }
    const minutes = Math.floor(rest / 60 + 1e-9);
    rest = roundTo(rest - minutes * 60, d);
    return `${sign}${whole}°${minutes}'${rest}"`;
}

/** A number field's text while it is not being edited: rounded to the set decimals, else as it is. */
export function formShownText(text: string): string {
    const n = Number(text);
    if (shown.form === null || text.trim() === '' || !Number.isFinite(n)) {
        return text;
    }
    return String(roundTo(n, shown.form));
}

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
