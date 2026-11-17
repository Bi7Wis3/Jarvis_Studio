import { describe, expect, it } from 'vitest';
import { markColor } from './bodyView';

describe('hidden thread marks', () => {
    it('stand out from the part: dark on a light part, light on a dark one', () => {
        expect(markColor('#dfe7f5')).toBe('#141414');
        expect(markColor('#c0c0c0')).toBe('#141414');
        expect(markColor('#1a1a1a')).toBe('#f0f0f0');
        expect(markColor('#2e4a8a')).toBe('#f0f0f0');
        expect(markColor('not a colour')).toBe('#141414');
    });
});
