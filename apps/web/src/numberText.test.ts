import { describe, expect, it } from 'vitest';
import { niceStep, roundTo, shownText, stepText, valueText } from './numberText';
import { round } from './sketchMath';

describe('number text', () => {
    it('keeps worked-out values to a millionth of a millimetre, without float noise or trailing zeros', () => {
        expect(valueText(0.0001)).toBe('0.0001');
        expect(valueText(12.3000004)).toBe('12.3');
        expect(valueText(10.0000015)).toBe('10.000002');
        expect(valueText(0.1 + 0.2)).toBe('0.3');
        expect(valueText(-0.0000001)).toBe('0');
        expect(roundTo(1.23456789, 4)).toBe(1.2346);
        expect(shownText(69.28203230275509)).toBe('69.282');
    });

    it('steps a field by its increment from whatever value is in it', () => {
        expect(stepText('0.1', 0.5, 1)).toBe('0.6');
        expect(stepText('0.1', 0.5, -1, 0)).toBe('0');
        expect(stepText('0.123', 0.05, 1)).toBe('0.173');
        expect(stepText('359', 5, 1, 0, 360)).toBe('360');
        expect(stepText('', 0.5, 1)).toBeNull();
        expect(stepText('2*3', 0.5, 1)).toBeNull();
    });

    it('picks round drag steps for a zoom level', () => {
        expect(niceStep(0.6)).toBe(1);
        expect(niceStep(0.13)).toBe(0.2);
        expect(niceStep(0.0003)).toBe(0.0005);
        expect(niceStep(0.01)).toBe(0.01);
        expect(niceStep(0)).toBe(0.000001);
    });

    it('rounds sketch values to a millionth by default, cleanly', () => {
        expect(String(round(12.3))).toBe('12.3');
        expect(round(10.00005)).toBe(10.00005);
        expect(round(10.0000004)).toBe(10);
        expect(round(7.3, 0.5)).toBe(7.5);
        expect(String(round(0.30000000000000004, 0.01))).toBe('0.3');
    });
});
