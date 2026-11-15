// Defects found by trying the app for real (scripts/ui-audit), shown at module level: view orientation and menus.
// Each `it.fails` passes while the defect is there; fixing it makes the test fail, and it then becomes a plain `it`.

import { describe, expect, it, vi } from 'vitest';
import { sketchSpaceMenu, type SketchMenuActions } from '../contextMenus';
import type { MenuEntry } from '../menus';
import { VIEWS } from '../toolDefs';
import { EMPTY_GEOMETRY } from '../sketchGeometry';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const labels = (items: MenuEntry[]): string[] => items.map((i) => (i === 'separator' ? '—' : 'header' in i ? `[${i.header}]` : i.label));
const actions = new Proxy({}, { get: () => () => undefined }) as SketchMenuActions;

describe('view orientation (SOLIDWORKS_REFERENCE E3: Front, Back, Left, Right, Top, Bottom, Isometric, ..., Normal To)', () => {
    it('the Views list has a Bottom view', () => {
        expect(VIEWS.map((v) => v.id)).toContain('bottom');
    });

    it('in an open 2D sketch, the right-click menu on empty space offers Normal to (normal to the sketch)', () => {
        const items = sketchSpaceMenu({ stage: 'draw', tool: 'select', geometry: EMPTY_GEOMETRY, draft: 0, selection: [], lastUsed: {} }, actions);
        expect(labels(items)).toContain('Normal to');
    });
});
