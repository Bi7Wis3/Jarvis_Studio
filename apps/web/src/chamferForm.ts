// Chamfer type in the form (SolidWorks: Equal distance, Distance distance, Angle distance), loaded from and saved to
// the feature's size / distance2 / angle, so editing a chamfer keeps and shows what it is.

import type { Feature } from '@jarvis/core';
import { valueText } from './numberText';

type Values = Record<string, string | boolean | string[]>;
type Chamfer = Extract<Feature, { op: 'chamfer' }>;

export type ChamferType = 'equal' | 'distances' | 'angle';

export const CHAMFER_TYPES: { value: ChamferType; label: string }[] = [
    { value: 'equal', label: 'Equal distance' },
    { value: 'distances', label: 'Distance distance' },
    { value: 'angle', label: 'Angle distance' },
];

const text = valueText;

export function chamferTypeValues(f: Chamfer | null): Values {
    const type: ChamferType = f?.angle !== undefined ? 'angle' : f?.distance2 !== undefined ? 'distances' : 'equal';
    return { ctype: type, d2: text(f?.distance2 ?? f?.size ?? 1), angle: text(f?.angle ?? 45) };
}

/** distance2 and angle for the chosen type; the other one is null, which removes it on an edit. */
export function chamferTypeFields(v: Values): { distance2: number | null; angle: number | null } {
    if (v.ctype === 'distances') {
        const d2 = Number(v.d2);
        if (!(Number.isFinite(d2) && d2 > 0)) {
            throw new Error('Distance 2 must be greater than 0.');
        }
        return { distance2: d2, angle: null };
    }
    if (v.ctype === 'angle') {
        const angle = Number(v.angle);
        if (!(Number.isFinite(angle) && angle > 0 && angle < 90)) {
            throw new Error('Angle must be between 0 and 90 degrees.');
        }
        return { distance2: null, angle };
    }
    return { distance2: null, angle: null };
}
