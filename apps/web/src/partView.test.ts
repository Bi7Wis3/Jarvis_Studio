import { describe, expect, it } from 'vitest';
import { partLook, type ViewState } from './partView';

const part = (partView: ViewState['partView']): ViewState => ({ workspace: 'part', activePart: 'a', partView, focus: null });

describe('partLook', () => {
    it('isolated shows only the edited part', () => {
        expect(partLook('a', part('isolated'))).toBe('normal');
        expect(partLook('b', part('isolated'))).toBe('hidden');
    });

    it('in context shows the other parts faintly', () => {
        expect(partLook('a', part('inContext'))).toBe('normal');
        expect(partLook('b', part('inContext'))).toBe('dimmed');
    });

    it('the assembly shows everything, dimming all but the focused part', () => {
        const s: ViewState = { workspace: 'assembly', activePart: 'a', partView: 'isolated', focus: null };
        expect(partLook('b', s)).toBe('normal');
        expect(partLook('b', { ...s, focus: 'a' })).toBe('dimmed');
        expect(partLook('a', { ...s, focus: 'a' })).toBe('normal');
    });
});
