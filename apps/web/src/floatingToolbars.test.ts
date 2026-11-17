import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyPatch, defaultSettings, normaliseSettings } from '@jarvis/core/settings';
import {
    cleanFloating, defaultPlace, estimatedSize, floatCandidates, floatKey, floatListEntries, floatTargetOf, loadFloating, moveFloating, openFloats,
    placeAt, resetFloating, resolvePlace, setFloating, setToolbarsLocked, toolbarFloatEntries, turnFloating, useFloatingToolbars, withFloating,
    withPlace, withTurn, type FloatingSet,
} from './floatingToolbars';
import { FloatChoices } from './floatingOptions';
import { FloatingBar, FloatingToolbars, viewToolbarsMenu } from './FloatingToolbar';
import type { MenuEntry } from './menus';
import { arrangeToolbars, type ArrangedToolbar } from './toolbarLayout';
import { modeGroups, ToolbarOptions } from './toolbarOptions';
import { setToolbarPrefs, useToolbarArrangement } from './toolbarStore';
import { draftOf, draftPatch } from './optionsDraft';
import { readToolbarsBlob, startToolbarSync, toolbarsBlob, toolbarsNow } from './toolbarSync';
import { useOptions, viewOf } from './options';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

// What an earlier visit stored, there before the app starts: a floating Relations toolbar and a damaged entry.
const stored = vi.hoisted(() => {
    const map = new Map([['jarvis.toolbars.floating', JSON.stringify({
        floating: { 'sketch/relations': { open: true, place: { x: 30, y: 20, right: true } }, 'nope/x': { open: true }, 'part/view': 'x' },
    })]]);
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k),
    };
    return map;
});

const VIEW = { width: 1600, height: 900 };
const sketchBars = (): ArrangedToolbar[] => arrangeToolbars('sketch', modeGroups('sketch'), {});
const bar = (id: string, toolbars = sketchBars()) => toolbars.find((t) => t.id === id)!;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const labelOf = (e: MenuEntry) => (typeof e === 'object' && 'label' in e ? e.label : typeof e === 'object' ? `[${e.header}]` : '---');
type Item = Extract<MenuEntry, { onSelect: () => void }>;
const find = (entries: MenuEntry[], label: string) => entries.find((e) => labelOf(e) === label) as Item;
const sub = (entries: MenuEntry[], label: string) => entries.find((e) => labelOf(e) === label) as Extract<MenuEntry, { items: MenuEntry[] }>;
/** After every promise waiting now has run (the timers are faked, this is not). */
const settled = () => new Promise<void>((resolve) => (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(resolve));

afterEach(() => {
    resetFloating();
});

describe('what can float', () => {
    it('every toolbar of the mode, and every pulldown group in it with the tools the toolbar has of it', () => {
        const toolbars = sketchBars();
        const candidates = floatCandidates(toolbars);
        // Each toolbar first, then its groups.
        expect(candidates.filter((c) => !c.family).map((c) => c.key)).toEqual(toolbars.map((t) => `sketch/${t.id}`));
        const relations = candidates.find((c) => c.key === 'sketch/relations/relation')!;
        expect(relations.label).toBe('Add relation');
        // Add relation: every relation as its own button.
        expect(relations.tools.map((t) => t.id)).toEqual(bar('relations').tools.filter((t) => t.id.startsWith('sk-c-')).map((t) => t.id));
        expect(relations.tools.length).toBeGreaterThan(8);
        const draw = candidates.filter((c) => c.toolbar.id === 'draw' && c.family).map((c) => c.family!.id);
        expect(draw).toEqual(expect.arrayContaining(['line', 'rectangle', 'slot', 'circle', 'arc']));
        expect(candidates.find((c) => c.key === 'sketch/draw/rectangle')!.tools.map((t) => t.id))
            .toEqual(['sk-rect', 'sk-centerRect', 'sk-rect3', 'sk-centerRect3', 'sk-parallelogram']);
        // Only open ones with tools are drawn.
        expect(openFloats(toolbars, { 'sketch/draw/rectangle': { open: true }, 'sketch/draw': { open: false, place: { x: 1, y: 1 } } })
            .map((c) => c.key)).toEqual(['sketch/draw/rectangle']);
    });
});

describe('where a floating toolbar is', () => {
    const size = { width: 300, height: 50 };

    it('is measured from the nearest edges, so it keeps to them when the window changes size', () => {
        expect(placeAt(100, 80, size, VIEW)).toEqual({ x: 100, y: 80 });
        const nearRight = placeAt(1250, 800, size, VIEW);
        expect(nearRight).toEqual({ x: 50, y: 50, right: true, bottom: true });
        expect(resolvePlace(nearRight, size, VIEW)).toEqual({ left: 1250, top: 800 });
        // A smaller window: still 50 from the right and bottom edges.
        expect(resolvePlace(nearRight, size, { width: 1000, height: 600 })).toEqual({ left: 650, top: 500 });
        // Top-left ones stay put.
        expect(resolvePlace({ x: 100, y: 80 }, size, { width: 1000, height: 600 })).toEqual({ left: 100, top: 80 });
    });

    it('is kept inside the window, its top-left corner first when it does not fit', () => {
        expect(resolvePlace({ x: 1500, y: 880 }, size, VIEW)).toEqual({ left: 1300, top: 850 });
        expect(resolvePlace({ x: -40, y: -10 }, size, VIEW)).toEqual({ left: 0, top: 0 });
        expect(resolvePlace({ x: 20, y: 20, right: true }, { width: 2000, height: 50 }, VIEW)).toEqual({ left: 0, top: 20 });
    });

    it('opens at a default place right of the left panel, staggered per mode, and comes back where it was', () => {
        let set: FloatingSet = {};
        set = withFloating(set, 'sketch/relations', true);
        set = withFloating(set, 'sketch/draw/line', true);
        set = withFloating(set, 'part/view', true);
        expect(set['sketch/relations'].place).toEqual(defaultPlace(0));
        expect(set['sketch/draw/line'].place).toEqual(defaultPlace(1));
        expect(set['part/view'].place).toEqual(defaultPlace(0));
        set = withPlace(set, 'sketch/relations', { x: 40, y: 60, bottom: true });
        set = withFloating(set, 'sketch/relations', false);
        expect(set['sketch/relations']).toEqual({ open: false, place: { x: 40, y: 60, bottom: true } });
        set = withFloating(set, 'sketch/relations', true);
        expect(set['sketch/relations']).toEqual({ open: true, place: { x: 40, y: 60, bottom: true } });
    });

    it('turns between a row and a column with its top-left corner where it was, then kept inside the window', () => {
        let set: FloatingSet = { 'sketch/relations': { open: true, place: { x: 50, y: 40, right: true, bottom: true } } };
        const row = estimatedSize(bar('relations'), 20, false);
        const at = resolvePlace(set['sketch/relations'].place!, row, VIEW);
        set = withTurn(set, 'sketch/relations', at.left, at.top);
        expect(set['sketch/relations']).toEqual({ open: true, vertical: true, place: { x: at.left, y: at.top } });
        const column = estimatedSize(bar('relations'), 20, true);
        expect(column.height).toBeGreaterThan(column.width);
        const turned = resolvePlace(set['sketch/relations'].place!, column, VIEW);
        expect(turned.left).toBe(at.left);
        // Too tall to stay where it was: moved up into the window.
        expect(turned.top).toBe(Math.max(0, VIEW.height - column.height));
        expect(withTurn(set, 'sketch/relations', 10, 20)['sketch/relations']).toEqual({ open: true, place: { x: 10, y: 20 } });
    });

    it('has the size of the main toolbar buttons it holds', () => {
        const relations = bar('relations');
        expect(estimatedSize(relations, 3, false)).toEqual({ width: 3 * 28 + 2 * 2 + 8 + 2, height: 19 + 28 + 8 + 2 });
        expect(estimatedSize({ ...relations, size: 'large' }, 3, true)).toEqual({ width: 46, height: 19 + 3 * 36 + 2 * 2 + 8 + 2 });
    });
});

describe('kept per mode', () => {
    it('loads what an earlier visit kept, leaving out damaged entries', () => {
        // As read when the app started (the tests above have changed it since).
        expect(useFloatingToolbars.getInitialState()).toEqual({ floating: { 'sketch/relations': { open: true, place: { x: 30, y: 20, right: true } } }, locked: false });
        expect(cleanFloating({ 'sketch/a/b': { open: true, place: { x: 'x', y: 2 } }, 'sketch/a': { vertical: true }, 'sketch/c': {}, 'x/y': { open: true } }))
            .toEqual({ 'sketch/a/b': { open: true }, 'sketch/a': { open: false, vertical: true } });
        expect(cleanFloating([1])).toEqual({});
        stored.set('jarvis.toolbars.floating', '{not json');
        expect(loadFloating()).toEqual({ floating: {}, locked: false });
    });

    it('survives a reload: open, place and orientation of each mode, and the lock', () => {
        setFloating('sketch/relations/relation', true);
        moveFloating('sketch/relations/relation', { x: 12, y: 34, right: true });
        turnFloating('sketch/relations/relation', 400, 300);
        setFloating('part/view', true);
        setFloating('assembly/view', true);
        setFloating('assembly/view', false);
        setToolbarsLocked(true);
        const kept = loadFloating();
        expect(kept).toEqual(useFloatingToolbars.getState());
        expect(kept.floating).toEqual({
            'sketch/relations/relation': { open: true, place: { x: 400, y: 300 }, vertical: true },
            'part/view': { open: true, place: defaultPlace(0) },
            'assembly/view': { open: false, place: defaultPlace(0) },
        });
        expect(kept.locked).toBe(true);
        resetFloating();
        expect(stored.has('jarvis.toolbars.floating')).toBe(false);
    });
});

describe('the settings file', () => {
    it('keeps the toolbars as plain data that loads back the same; older settings files have none yet', () => {
        const state = {
            arrangement: { 'sketch/draw': { tools: ['sk-rect'], base: ['sk-line', 'sk-rect'], size: 'small' as const }, 'part/view': { hidden: true } },
            floating: { 'sketch/relations/relation': { open: true, place: { x: 12, y: 34, right: true }, vertical: true } },
            locked: true,
        };
        const saved = normaliseSettings({ toolbars: toolbarsBlob(state) });
        expect(readToolbarsBlob(saved.toolbars)).toEqual(state);
        expect(readToolbarsBlob(normaliseSettings({}).toolbars)).toBeNull();
        expect(readToolbarsBlob({ v: 1, arrangement: [{ key: 'a', size: 'huge' }, 7], floating: [{ key: 'sketch/x', open: 'yes' }], locked: 1 }))
            .toEqual({ arrangement: {}, floating: {}, locked: false });
    });

    it('takes saved toolbars at start, saves a change after a moment, and puts back a reset category', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const puts: Record<string, unknown>[] = [];
        let server = defaultSettings();
        vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
            const patch = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
            puts.push(patch);
            // As the server does: categories merged into the saved ones (settings.ts, applyPatch).
            server = applyPatch(server, patch);
            return { ok: true, status: 200, json: async () => viewOf(server) };
        });
        try {
            startToolbarSync();
            const saved = toolbarsBlob({ arrangement: { 'part/view': { hidden: true } }, floating: { 'part/view': { open: true, place: { x: 5, y: 6 } } }, locked: false });
            server = normaliseSettings({ toolbars: saved });
            useOptions.setState({ settings: viewOf(server), loaded: true });
            expect(useToolbarArrangement.getState().arrangement).toEqual({ 'part/view': { hidden: true } });
            expect(useFloatingToolbars.getState().floating).toEqual({ 'part/view': { open: true, place: { x: 5, y: 6 } } });
            expect(puts).toEqual([]);
            // A toolbar floated here: one save, a moment later, with every toolbar.
            setFloating('sketch/relations/relation', true);
            moveFloating('sketch/relations/relation', { x: 70, y: 80 });
            expect(puts).toEqual([]);
            await vi.advanceTimersByTimeAsync(500);
            // The answer has come back.
            await settled();
            expect(puts.length).toBe(1);
            expect(readToolbarsBlob(server.toolbars)).toEqual(toolbarsNow());
            // A toolbar back to its defaults is gone from the file too (lists are replaced, not merged).
            setToolbarPrefs('part/view', null);
            await vi.advanceTimersByTimeAsync(500);
            await settled();
            expect(puts.length).toBe(2);
            expect(readToolbarsBlob(server.toolbars)!.arrangement).toEqual({});
            // The Options page, opened before that, does not save its older copy of the toolbars over it.
            const before = viewOf({ ...server, toolbars: saved as unknown as Record<string, unknown> });
            expect(draftPatch(draftOf(before), viewOf(server)).toolbars).toBeUndefined();
            // The category reset on the server: every toolbar back to its defaults here too.
            server = normaliseSettings({ ...server, toolbars: {} });
            useOptions.setState({ settings: viewOf(server) });
            expect(toolbarsNow()).toEqual({ arrangement: {}, floating: {}, locked: false });
            // An older settings file, with no toolbars yet: this browser's are saved into it when it loads.
            useOptions.setState({ loaded: false });
            setFloating('assembly/view', true);
            const before2 = puts.length;
            useOptions.setState({ settings: viewOf(normaliseSettings({ ...server, toolbars: {} })), loaded: true });
            await settled();
            expect(puts.length).toBe(before2 + 1);
            expect(readToolbarsBlob(server.toolbars)!.floating).toEqual({ 'assembly/view': { open: true, place: defaultPlace(0) } });
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
            useOptions.setState({ loaded: false });
            useToolbarArrangement.setState({ arrangement: {} });
        }
    });
});

describe('opening one', () => {
    it('a right-click on a toolbar floats it; on a pulldown, its group too; then every toolbar and group, and the lock', () => {
        const toolbars = sketchBars();
        const entries = toolbarFloatEntries(toolbars, { toolbarId: 'relations', familyId: 'relation' }, { floating: {}, locked: false });
        expect(entries.map(labelOf)).toEqual(['Float as toolbar', 'Float this group as a toolbar', 'Floating toolbars', 'Lock toolbars', '---']);
        find(entries, 'Float this group as a toolbar').onSelect();
        expect(useFloatingToolbars.getState().floating['sketch/relations/relation']?.open).toBe(true);
        // On the empty part of a toolbar, or a plain button: the toolbar only.
        expect(toolbarFloatEntries(toolbars, { toolbarId: 'draw' }).map(labelOf)).toEqual(['Float as toolbar', 'Floating toolbars', 'Lock toolbars', '---']);
        // Locked: nothing can be floated or docked.
        const locked = toolbarFloatEntries(toolbars, { toolbarId: 'draw' }, { floating: {}, locked: true });
        expect(find(locked, 'Float as toolbar').disabled).toBe(true);
        expect(find(locked, 'Lock toolbars').checked).toBe(true);
    });

    it('finds the toolbar and pulldown right-clicked from the marks on the main toolbar', () => {
        const element = (attrs: Record<string, string>) => ({
            closest: (selector: string) => {
                const name = selector.slice(1, -1);
                return attrs[name] ? { getAttribute: () => attrs[name] } : null;
            },
        });
        expect(floatTargetOf(element({ 'data-toolbar': 'relations', 'data-family': 'relation' }) as unknown as EventTarget))
            .toEqual({ toolbarId: 'relations', familyId: 'relation' });
        expect(floatTargetOf(element({ 'data-toolbar': 'draw' }) as unknown as EventTarget)).toEqual({ toolbarId: 'draw' });
        expect(floatTargetOf(null)).toEqual({});
    });

    it('View > Toolbars lists every toolbar and pulldown group of the mode, floating ones ticked', () => {
        setFloating('sketch/relations', true);
        setFloating('sketch/draw/rectangle', true);
        const menu = viewToolbarsMenu('sketch') as Extract<MenuEntry, { items: MenuEntry[] }>;
        expect(menu.label).toBe('Toolbars');
        const items = menu.items;
        const names = sketchBars().map((t) => t.label);
        for (const name of names) {
            expect(find(items, name).checked).toBe(name === 'Relations');
        }
        const draw = sub(items, 'Draw groups');
        expect(draw.items.map(labelOf)).toEqual(expect.arrayContaining(['Line', 'Rectangle', 'Slot', 'Circle', 'Arc']));
        expect((find(draw.items, 'Rectangle')).checked).toBe(true);
        expect((find(draw.items, 'Line')).checked).toBe(false);
        expect(labelOf(items[items.length - 1])).toBe('Lock toolbars');
        // Ticking one floats it, ticking a floating one docks it.
        find(draw.items, 'Rectangle').onSelect();
        expect(useFloatingToolbars.getState().floating['sketch/draw/rectangle'].open).toBe(false);
        // The part mode lists its own toolbars.
        const part = (viewToolbarsMenu('part') as Extract<MenuEntry, { items: MenuEntry[] }>).items;
        expect(part.filter((e) => typeof e === 'object' && 'checked' in e).map(labelOf).slice(0, 3)).toEqual(['Sketch', 'Features', 'Reference geometry']);
    });

    // Server rendering shows a store as it was at start: the Relations toolbar floating since the earlier visit.
    it('Options > Toolbars has a Floating choice for the toolbar and each group, and Lock toolbars', () => {
        const ticks = (html: string) => [...html.matchAll(/<input type="checkbox" class="tbo-float"( checked="")?/g)].map((m) => !!m[1]);
        const relations = renderToStaticMarkup(createElement(FloatChoices, { toolbar: bar('relations') }));
        expect(text(relations)).toContain(' Floating The whole toolbar Add relation ');
        expect(ticks(relations)).toEqual([true, false]);
        const draw = renderToStaticMarkup(createElement(FloatChoices, { toolbar: bar('draw') }));
        expect(text(draw)).toContain(' Floating The whole toolbar Line Rectangle ');
        expect(ticks(draw).length).toBe(1 + floatCandidates([bar('draw')]).filter((c) => c.family).length);
        expect(ticks(draw).every((on) => !on)).toBe(true);
        const options = renderToStaticMarkup(createElement(ToolbarOptions, { mode: 'sketch' }));
        expect(text(options)).toContain('Lock toolbars');
        // The Relations toolbar is marked as floating.
        expect(text(options)).toContain(' Relations floating ');
        expect(text(options)).not.toContain(' Draw floating ');
    });
});

describe('the floating toolbar', () => {
    const button = (tool: { id: string; label: string }, toolbar: ArrangedToolbar) =>
        createElement('button', { key: tool.id, className: 'tb-btn', 'data-tool': tool.id, 'data-size': toolbar.size }, tool.label);

    it('shows the group\'s tools as plain buttons of the main toolbar, under a title bar with a turn switch and ×', () => {
        const toolbars = sketchBars();
        const entry = floatCandidates(toolbars).find((c) => c.key === floatKey(bar('relations', toolbars), { id: 'relation' }))!;
        const html = renderToStaticMarkup(createElement(FloatingBar, {
            entry, state: { open: true, place: { x: 40, y: 30, right: true } }, locked: false, view: VIEW, button, toolbars,
        }));
        const tools = [...html.matchAll(/data-tool="([^"]+)"/g)].map((m) => m[1]);
        expect(tools).toEqual(entry.tools.map((t) => t.id));
        expect(html).toContain('data-size="medium"');
        expect(html).toContain('aria-label="Add relation (Relations)"');
        expect(html).toContain('aria-orientation="horizontal"');
        expect(html).toContain('class="tb-group g-relations tb-medium ');
        expect(html).toContain('aria-label="Turn into a column"');
        expect(html).toContain('aria-label="Dock Add relation"');
        // Placed from the right edge (40 from it), the size estimated until it is measured.
        const size = estimatedSize(entry.toolbar, entry.tools.length, false);
        expect(html).toContain(`left:${VIEW.width - 40 - size.width}px`);
        expect(html).toContain('top:30px');
        expect(html).not.toContain('disabled');
        const column = renderToStaticMarkup(createElement(FloatingBar, {
            entry, state: { open: true, vertical: true, place: { x: 40, y: 30 } }, locked: true, view: VIEW, button, toolbars,
        }));
        expect(column).toContain('aria-orientation="vertical"');
        expect(column).toContain('class="fltb vertical locked ');
        expect(column).toContain('aria-label="Turn into a row"');
        // Locked: it cannot be turned or docked.
        expect([...column.matchAll(/<button type="button" class="fltb-(turn|close)" disabled=""/g)].length).toBe(2);
    });

    it('comes back where it was in its mode only, after a reload', () => {
        const sketch = renderToStaticMarkup(createElement(FloatingToolbars, { toolbars: sketchBars(), button }));
        expect([...sketch.matchAll(/data-float="([^"]+)"/g)].map((m) => m[1])).toEqual(['sketch/relations']);
        const size = estimatedSize(bar('relations'), bar('relations').tools.length, false);
        expect(sketch).toContain(`left:${1600 - 30 - size.width}px;top:20px`);
        const part = renderToStaticMarkup(createElement(FloatingToolbars, { toolbars: arrangeToolbars('part', modeGroups('part'), {}), button }));
        expect(part).not.toContain('data-float');
    });
});
