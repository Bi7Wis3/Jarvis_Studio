import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolDef, ToolGroup } from './toolDefs';
import {
    addedTool, arrangedIds, arrangedItems, arrangeToolbars, modeTools, movedTool, removedTool, toolbarKey, toolbarWidth, withOption, withTools,
    type ToolbarArrangement,
} from './toolbarLayout';
import { cleanArrangement, loadArrangement, resetArrangement, setToolbarPrefs, useToolbarArrangement } from './toolbarStore';

const tool = (id: string): ToolDef => ({ id, label: id, icon: id });
const group = (id: string, ids: string[]): ToolGroup => ({ id, label: id, icon: id, tools: ids.map(tool) });
const GROUPS = [
    group('sketch', ['sk-select', 'sk-finish']),
    group('draw', ['sk-line', 'sk-centerline', 'sk-rect', 'sk-centerRect', 'sk-circle']),
    group('modify', ['sk-trim', 'sk-extend', 'sk-offset']),
];
const ids = (a: ToolbarArrangement, at = 1) => arrangeToolbars('sketch', GROUPS, a)[at].tools.map((t) => t.id);
const shape = (a: ToolbarArrangement, at = 1) => arrangedItems(arrangeToolbars('sketch', GROUPS, a)[at])
    .map((item) => ('family' in item ? `${item.family.id}(${item.tools.map((t) => t.id).join(',')})` : item.tool.id));

describe('toolbar arrangement', () => {
    it('without choices every toolbar shows its default tools, medium icons, no text, variants in flyouts', () => {
        const bars = arrangeToolbars('sketch', GROUPS, {});
        expect(bars.map((b) => [b.key, b.hidden, b.size, b.labels, b.families, b.tips, b.customised]))
            .toEqual(GROUPS.map((g) => [`sketch/${g.id}`, false, 'medium', false, 'flyout', 'full', false]));
        expect(ids({})).toEqual(['sk-line', 'sk-centerline', 'sk-rect', 'sk-centerRect', 'sk-circle']);
        expect(shape({})).toEqual(['line(sk-line,sk-centerline)', 'rectangle(sk-rect,sk-centerRect)', 'sk-circle']);
    });

    it('reorders, removes and adds tools of the mode, from any of its toolbars', () => {
        const defaults = GROUPS[1].tools.map((t) => t.id);
        let list = movedTool(defaults, 4, 0);
        list = removedTool(list, list.indexOf('sk-centerRect'));
        list = addedTool(list, 'sk-trim', 1);
        // Already there: not twice.
        expect(addedTool(list, 'sk-trim')).toEqual(list);
        const prefs = withTools(undefined, defaults, list);
        const a = { [toolbarKey('sketch', 'draw')]: prefs };
        expect(ids(a)).toEqual(['sk-circle', 'sk-trim', 'sk-line', 'sk-centerline', 'sk-rect']);
        expect(arrangeToolbars('sketch', GROUPS, a)[1].customised).toBe(true);
        // Moving them back to the default order stores nothing.
        expect(withTools(prefs, defaults, defaults)).toEqual({});
    });

    it('a tool added to the defaults later still shows, after the tool before it; tools that no longer exist go', () => {
        const prefs = { tools: ['sk-rect', 'sk-line', 'sk-gone'], base: ['sk-line', 'sk-rect'] };
        const known = new Set(['sk-line', 'sk-arc', 'sk-rect', 'sk-point']);
        // sk-arc follows sk-line and sk-point follows sk-rect, wherever the user put those.
        expect(arrangedIds(['sk-line', 'sk-arc', 'sk-rect', 'sk-point'], known, prefs)).toEqual(['sk-rect', 'sk-point', 'sk-line', 'sk-arc']);
        // A default tool the user removed stays removed.
        expect(arrangedIds(['sk-line', 'sk-rect'], known, { tools: ['sk-rect'], base: ['sk-line', 'sk-rect'] })).toEqual(['sk-rect']);
        // New first in the defaults, with nothing before it: first.
        expect(arrangedIds(['sk-point', 'sk-line'], known, { tools: ['sk-line'], base: ['sk-line'] })).toEqual(['sk-point', 'sk-line']);
    });

    it('hides and shows a toolbar, and keeps icon size, text and variant style per toolbar', () => {
        let prefs = withOption(undefined, 'hidden', true);
        prefs = withOption(prefs, 'size', 'large');
        prefs = withOption(prefs, 'labels', true);
        prefs = withOption(prefs, 'families', 'separate');
        prefs = withOption(prefs, 'tips', 'name');
        const bar = arrangeToolbars('sketch', GROUPS, { 'sketch/draw': prefs })[1];
        expect([bar.hidden, bar.size, bar.labels, bar.families, bar.tips]).toEqual([true, 'large', true, 'separate', 'name']);
        expect(shape({ 'sketch/draw': prefs })).toEqual(['sk-line', 'sk-centerline', 'sk-rect', 'sk-centerRect', 'sk-circle']);
        // The other toolbars keep their defaults.
        expect(arrangeToolbars('sketch', GROUPS, { 'sketch/draw': prefs })[2].customised).toBe(false);
        // Back to the defaults: nothing is stored.
        let back = withOption(prefs, 'hidden', false);
        back = withOption(back, 'size', 'medium');
        back = withOption(back, 'labels', false);
        back = withOption(back, 'tips', 'full');
        expect(withOption(back, 'families', 'flyout')).toEqual({});
    });

    it('a toolbar is wider with large icons, text under them, or variants as separate buttons', () => {
        const bar = (a: ToolbarArrangement) => arrangeToolbars('sketch', GROUPS, a)[1];
        const plain = toolbarWidth(bar({}));
        expect(plain).toBe(40 + 40 + 28 + 2 * 2 + 9);
        expect(toolbarWidth(bar({ 'sketch/draw': { size: 'large' } }))).toBeGreaterThan(plain);
        expect(toolbarWidth(bar({ 'sketch/draw': { size: 'small' } }))).toBeLessThan(plain);
        expect(toolbarWidth(bar({ 'sketch/draw': { labels: true } }))).toBeGreaterThan(plain);
        expect(toolbarWidth(bar({ 'sketch/draw': { families: 'separate' } }))).toBe(5 * 28 + 4 * 2 + 9);
    });

    it('a tool on several toolbars counts once among the tools of the mode', () => {
        const groups = [...GROUPS, group('view', ['sk-select', 'view-fit'])];
        expect(modeTools(groups).map((t) => t.id)).toEqual([
            'sk-select', 'sk-finish', 'sk-line', 'sk-centerline', 'sk-rect', 'sk-centerRect', 'sk-circle', 'sk-trim', 'sk-extend', 'sk-offset', 'view-fit',
        ]);
    });
});

describe('keeping the arrangement', () => {
    const stored = new Map<string, string>();
    beforeEach(() => {
        stored.clear();
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: (k: string) => stored.get(k) ?? null,
            setItem: (k: string, v: string) => void stored.set(k, v),
            removeItem: (k: string) => void stored.delete(k),
        };
        resetArrangement();
    });

    it('survives a reload: what is set is read back the same from storage', () => {
        setToolbarPrefs('sketch/draw', { tools: ['sk-rect'], base: ['sk-line', 'sk-rect'], size: 'small', labels: true, tips: 'off' });
        setToolbarPrefs('part/view', { hidden: true });
        expect(loadArrangement()).toEqual(useToolbarArrangement.getState().arrangement);
        expect(loadArrangement()).toEqual({
            'sketch/draw': { tools: ['sk-rect'], base: ['sk-line', 'sk-rect'], size: 'small', labels: true, tips: 'off' },
            'part/view': { hidden: true },
        });
        // Reset of one toolbar removes its entry; of all, the stored key.
        setToolbarPrefs('part/view', null);
        expect(Object.keys(loadArrangement())).toEqual(['sketch/draw']);
        resetArrangement();
        expect(stored.size).toBe(0);
    });

    it('a damaged entry is ignored, not trusted', () => {
        expect(cleanArrangement({ a: { hidden: 'yes', size: 'huge', tools: [1, 2], labels: true }, b: 7, c: null })).toEqual({ a: { labels: true } });
        expect(cleanArrangement([1, 2])).toEqual({});
        stored.set('jarvis.toolbars', '{not json');
        expect(loadArrangement()).toEqual({});
    });
});
