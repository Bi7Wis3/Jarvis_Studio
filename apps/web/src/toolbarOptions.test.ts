import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolbarOptions } from './toolbarOptions';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

// What an earlier visit stored, there before the app starts (server rendering shows a store's state at start).
vi.hoisted(() => {
    const stored = new Map([['jarvis.toolbars', JSON.stringify({ 'sketch/relations': { hidden: true } })]]);
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k),
    };
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Customize toolbars', () => {
    it('lists the toolbars of each mode, each with a tick that shows whether it is shown, as kept from the last visit', () => {
        const sketch = renderToStaticMarkup(createElement(ToolbarOptions, { mode: 'sketch' }));
        for (const name of ['Draw', 'Modify', 'Dimensions', 'Relations', 'View and snaps', '2D to 3D', 'History']) {
            expect(text(sketch)).toContain(` ${name} `);
        }
        const ticks = [...sketch.matchAll(/<input type="checkbox"( checked="")?\/>/g)].map((m) => !!m[1]);
        expect(ticks).toEqual([true, true, true, true, false, true, true, true]);
        expect(text(renderToStaticMarkup(createElement(ToolbarOptions, { mode: 'part' }))))
            .toContain(' Sketch Features Reference geometry Pattern Material View Inspect History ');
        expect(text(renderToStaticMarkup(createElement(ToolbarOptions, { mode: 'assembly' }))))
            .toContain(' Insert Transform Pattern Material View Export History ');
    });
});
