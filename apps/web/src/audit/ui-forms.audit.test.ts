// Defects found by trying the forms for real in the running app (scripts/ui-audit), shown at module level.
// Each `it.fails` passes while the defect is there; fixing it makes the test fail, and it then becomes a plain `it`.

import { describe, expect, it, vi } from 'vitest';
import { ALL_TOOLS } from '../toolDefs';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

/** The app's own modules as text (Vite's raw import), test files left out. */
const SOURCES = import.meta.glob('../*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * Store selectors (zustand 5 on React 19) that build a new array on every call: useSyncExternalStore then sees a new
 * snapshot each render and React stops with "Maximum update depth exceeded". Seen in the app (r13-loopforms.mjs,
 * r12-whole2.mjs): opening Sketch picture, Insert block (a new sketch has no `pictures` or `blocks`) or Pierce point
 * logs "The result of getSnapshot should be cached to avoid an infinite loop" and "Uncaught Error: Maximum update
 * depth exceeded"; the page goes blank and no tool opens any more until the page is reloaded.
 */
function freshArraySelectors(): string[] {
    const found: string[] = [];
    for (const [path, text] of Object.entries(SOURCES).filter(([p]) => !p.includes('.test.'))) {
        const file = path.replace('../', '');
        text.split('\n').forEach((line, i) => {
            const m = /use[A-Z]\w*\(\(s\) => ([^;]*)\);/.exec(line);
            if (m && /(\?\? \[\]|\.filter\(|\.map\()/.test(m[1]) && !/\.(length|join\(|some\(|every\(|find\()/.test(m[1])) {
                found.push(`${file}:${i + 1}: ${line.trim()}`);
            }
        });
    }
    return found;
}

describe('entity PropertyManagers', () => {
    // Seen in the app (r2-view.mjs, step 8c2): selecting a circle with the Select tool opens no form; only ellipses,
    // partial ellipses, splines, style splines, parabolas and conics have one (sk-pm-<kind>). The help describes a
    // PropertyManager for a selected line (Line Properties: Existing/Add Relations, Options, Parameters, Additional
    // Parameters), circle (Center X/Y, Radius), arc (centre, start, end, Radius, Angle) and point (X, Y).
    it('a selected line, circle, arc and point each have a PropertyManager', () => {
        const ids = new Set(ALL_TOOLS.map((t) => t.id));
        expect(['sk-pm-line', 'sk-pm-circle', 'sk-pm-arc', 'sk-pm-point'].filter((id) => !ids.has(id))).toEqual([]);
    });
});

describe('forms that loop on open', () => {
    it('no store selector returns a new array on every call (Sketch picture, Insert block, Pierce point)', () => {
        expect(freshArraySelectors()).toEqual([]);
    });
});
