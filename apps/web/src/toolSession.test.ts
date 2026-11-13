import { describe, expect, it } from 'vitest';
import { clearToolSession, publishToolSession, useToolSession } from './toolSession';

describe('tool session', () => {
    it('is cleared only by the form that published it', () => {
        const a = Symbol('a');
        const b = Symbol('b');
        const set = () => undefined;
        publishToolSession(a, { toolId: 'move', values: { pos0: '1' }, ctx: null, set });
        publishToolSession(b, { toolId: 'rotate', values: { rot0: '0' }, ctx: null, set });
        clearToolSession(a);
        expect(useToolSession.getState().toolId).toBe('rotate');
        clearToolSession(b);
        expect(useToolSession.getState()).toMatchObject({ toolId: null, values: {}, set: null, owner: null });
    });
});
