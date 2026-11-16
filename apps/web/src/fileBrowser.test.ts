import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowser, Rows, rowWindow, typeName } from './fileBrowser';
import {
    crumbs, dateText, goUp, keyAction, openFolder, refreshFolder, setFileFetch, setShowAll, sizeText, toggleQuick, togglePin,
    useFileBrowser, visibleEntries, type FileEntry, type Listing, type Places, type QuickFilter,
} from './fileBrowserState';
import { quickFilters } from './importTool';

const HOME = '/home/me';
const folder = (name: string): FileEntry => ({ name, kind: 'folder', size: 0, modified: 0 });
const file = (name: string, format?: string): FileEntry => ({ name, kind: 'file', size: 2048, modified: Date.UTC(2026, 0, 2, 3, 4), ...(format ? { format } : {}) });
const ENTRIES = [folder('Brackets'), folder('Wheels'), file('arm 2.step', 'step'), file('arm 10.stp', 'step'), file('base.stl', 'stl'),
    file('cover.SLDPRT', 'sldprt'), file('notes.txt')];
const FILTERS: QuickFilter[] = [
    { id: 'step', label: 'STEP', formats: ['step'] }, { id: 'stl', label: 'STL', formats: ['stl'] }, { id: 'sldprt', label: 'SolidWorks', formats: ['sldprt'] },
];
const listing = (path: string, entries = ENTRIES): Listing => ({
    path, home: HOME, parent: path === HOME ? null : path.slice(0, path.lastIndexOf('/')) || '/', entries, skipped: 0,
});
const names = (entries: FileEntry[]) => entries.map((e) => e.name);

/** A fake server: listings by path, the places, and every request made. */
function fakeServer(folders: Record<string, FileEntry[]>) {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    let places: Places = { home: HOME, standard: [{ id: 'home', name: 'Home', path: HOME }], favourites: [], recent: [], last: HOME };
    const answer = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });
    setFileFetch(async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        calls.push({ url, method: init?.method ?? 'GET', body });
        const u = new URL(url, 'http://studio');
        if (u.pathname === '/api/files/list') {
            const path = u.searchParams.get('path') || (u.searchParams.get('last') ? places.last : HOME);
            return folders[path] ? answer(200, listing(path, folders[path])) : answer(404, { error: `${path} does not exist.` });
        }
        if (u.pathname === '/api/files/places') {
            if (body?.favourites) {
                places = { ...places, favourites: body.favourites as string[] };
            }
            return answer(200, places);
        }
        return answer(404, {});
    });
    return { calls, setLast: (last: string) => { places = { ...places, last }; } };
}

beforeEach(() => {
    useFileBrowser.setState({ listing: null, loading: false, error: null, query: '', quick: [], showAll: false, hidden: false, selected: null, places: null });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('file browser rules', () => {
    it('filters by name, case ignored, and by quick filters in any combination; folders stay', () => {
        expect(names(visibleEntries(ENTRIES, { query: 'ARM', quick: [] }, FILTERS))).toEqual(['arm 2.step', 'arm 10.stp']);
        expect(names(visibleEntries(ENTRIES, { query: '', quick: ['stl'] }, FILTERS))).toEqual(['Brackets', 'Wheels', 'base.stl']);
        expect(names(visibleEntries(ENTRIES, { query: '', quick: ['stl', 'sldprt'] }, FILTERS))).toEqual(['Brackets', 'Wheels', 'base.stl', 'cover.SLDPRT']);
        // No quick filter: every file the listing holds (other files only come with Show all files).
        expect(visibleEntries(ENTRIES, { query: '', quick: [] }, FILTERS)).toHaveLength(ENTRIES.length);
        expect(names(visibleEntries(ENTRIES, { query: 'a', quick: ['step'] }, FILTERS))).toEqual(['Brackets', 'arm 2.step', 'arm 10.stp']);
    });

    it('moves the selection with the keys, opens folders and picks files with Enter, goes up with Backspace', () => {
        const here = listing(`${HOME}/parts`);
        expect(keyAction('ArrowDown', ENTRIES, null, here)).toEqual({ type: 'select', name: 'Brackets' });
        expect(keyAction('ArrowUp', ENTRIES, null, here)).toEqual({ type: 'select', name: 'notes.txt' });
        expect(keyAction('ArrowDown', ENTRIES, 'Wheels', here)).toEqual({ type: 'select', name: 'arm 2.step' });
        expect(keyAction('ArrowDown', ENTRIES, 'notes.txt', here)).toEqual({ type: 'select', name: 'notes.txt' });
        expect(keyAction('ArrowUp', ENTRIES, 'Brackets', here)).toEqual({ type: 'select', name: 'Brackets' });
        expect(keyAction('End', ENTRIES, 'Brackets', here)).toEqual({ type: 'select', name: 'notes.txt' });
        expect(keyAction('Home', ENTRIES, 'base.stl', here)).toEqual({ type: 'select', name: 'Brackets' });
        expect(keyAction('PageDown', ENTRIES, 'Brackets', here, 3)).toEqual({ type: 'select', name: 'arm 10.stp' });
        expect(keyAction('PageUp', ENTRIES, 'arm 10.stp', here, 10)).toEqual({ type: 'select', name: 'Brackets' });
        expect(keyAction('Enter', ENTRIES, 'Wheels', here)).toEqual({ type: 'open', path: `${HOME}/parts/Wheels` });
        expect(keyAction('Enter', ENTRIES, 'base.stl', here)).toEqual({ type: 'pick', entry: ENTRIES[4] });
        expect(keyAction('Enter', ENTRIES, null, here)).toEqual({ type: 'select', name: 'Brackets' });
        expect(keyAction('Backspace', ENTRIES, null, here)).toEqual({ type: 'up' });
        expect(keyAction('Backspace', ENTRIES, null, listing(HOME))).toBeNull();
        expect(keyAction('ArrowDown', [], null, here)).toBeNull();
        expect(keyAction('x', ENTRIES, null, here)).toBeNull();
    });

    it('shows the path from home, sizes, dates and types in words', () => {
        expect(crumbs(`${HOME}/Desktop/3D Printer`, HOME)).toEqual([
            { name: 'Home', path: HOME }, { name: 'Desktop', path: `${HOME}/Desktop` }, { name: '3D Printer', path: `${HOME}/Desktop/3D Printer` },
        ]);
        expect(crumbs(HOME, HOME)).toEqual([{ name: 'Home', path: HOME }]);
        expect(sizeText(512)).toBe('512 bytes');
        expect(sizeText(222720)).toBe('218 KB');
        expect(sizeText(3.5 * 1024 * 1024)).toBe('3.5 MB');
        expect(dateText(new Date(2020, 7, 26, 9, 5).getTime())).toBe('2020-08-26 09:05');
        expect(typeName(file('a.SLDPRT', 'sldprt'))).toBe('SolidWorks part');
        expect(typeName(file('notes.txt'))).toBe('TXT file');
        expect(typeName(folder('x'))).toBe('Folder');
    });

    it('offers a quick filter per format the server reads, in the SolidWorks order, IGES when there is one', () => {
        const formats = [
            { format: 'step', extensions: ['step', 'stp'], label: 'STEP', mesh: false }, { format: 'stl', extensions: ['stl'], label: 'STL', mesh: true },
            { format: 'sldprt', extensions: ['sldprt'], label: 'SolidWorks part', mesh: false }, { format: 'iges', extensions: ['igs', 'iges'], label: 'IGES', mesh: false },
        ];
        expect(quickFilters(formats).map((f) => f.label)).toEqual(['STEP', 'IGES', 'STL', 'SolidWorks']);
        expect(quickFilters(formats.slice(0, 3)).map((f) => f.id)).toEqual(['step', 'stl', 'sldprt']);
        expect(quickFilters(null)).toEqual([]);
    });
});

describe('file browser state', () => {
    it('opens at the last folder, goes up with the folder left selected, and drops answers overtaken by newer ones', async () => {
        const server = fakeServer({ [HOME]: [folder('parts')], [`${HOME}/parts`]: ENTRIES, [`${HOME}/parts/Wheels`]: [file('hub.stl', 'stl')] });
        server.setLast(`${HOME}/parts`);
        await refreshFolder();
        expect(server.calls[0].url).toContain('last=1');
        expect(useFileBrowser.getState().listing?.path).toBe(`${HOME}/parts`);
        useFileBrowser.setState({ query: 'arm', selected: 'arm 2.step' });
        await openFolder(`${HOME}/parts/Wheels`);
        // A new folder: no filter text, nothing selected.
        expect(useFileBrowser.getState()).toMatchObject({ query: '', selected: null });
        await goUp();
        expect(useFileBrowser.getState()).toMatchObject({ selected: 'Wheels', listing: { path: `${HOME}/parts` } });
        // Two requests at once: the later one wins whatever order the answers come in.
        const slow = openFolder(HOME);
        const fast = openFolder(`${HOME}/parts/Wheels`);
        await Promise.all([slow, fast]);
        expect(useFileBrowser.getState().listing?.path).toBe(`${HOME}/parts/Wheels`);
        // A folder that is gone: an error, the folder shown stays.
        expect(await openFolder(`${HOME}/gone`)).toBe(false);
        expect(useFileBrowser.getState()).toMatchObject({ error: `${HOME}/gone does not exist.`, listing: { path: `${HOME}/parts/Wheels` } });
    });

    it('asks for every file with Show all files, toggles quick filters, pins folders, and remembers where it was', async () => {
        vi.useFakeTimers();
        const server = fakeServer({ [HOME]: ENTRIES });
        await openFolder(HOME);
        await setShowAll(true);
        expect(server.calls.at(-1)?.url).toContain('all=1');
        toggleQuick('stl');
        toggleQuick('step');
        expect(useFileBrowser.getState().quick).toEqual(['stl', 'step']);
        toggleQuick('stl');
        expect(useFileBrowser.getState().quick).toEqual(['step']);
        toggleQuick(null);
        expect(useFileBrowser.getState().quick).toEqual([]);
        useFileBrowser.setState({ places: { home: HOME, standard: [], favourites: [`${HOME}/a`], recent: [], last: HOME } });
        await togglePin(HOME);
        expect(server.calls.at(-1)?.body).toEqual({ favourites: [`${HOME}/a`, HOME] });
        await togglePin(`${HOME}/a`);
        expect(useFileBrowser.getState().places?.favourites).toEqual([HOME]);
        // The folder shown is saved as the one to open at next time, once it settles.
        expect(server.calls.some((c) => c.body && 'last' in (c.body as object))).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(server.calls.filter((c) => c.body && 'last' in (c.body as object)).map((c) => c.body)).toEqual([{ last: HOME }]);
    });

    it('draws only the rows in view of a long folder', () => {
        const many = Array.from({ length: 5000 }, (_, i) => file(`part ${i}.stl`, 'stl'));
        const draw = (top: number) => renderToStaticMarkup(createElement(Rows, {
            shown: many, window: rowWindow(top, many.length), index: 2, onSelect: () => {}, onOpen: () => {},
        }));
        let html = draw(0);
        const rows = html.match(/role="option"/g) ?? [];
        expect(rows.length).toBeGreaterThan(10);
        expect(rows.length).toBeLessThan(30);
        expect(html).toContain('part 0.stl');
        expect(html).not.toContain('part 4999.stl');
        // The box is as tall as all the rows, so the scroll bar is right.
        expect(html).toContain(`height:${5000 * 21}px`);
        expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
        // Scrolled to the end: the last rows, placed at their own height.
        html = draw(5000 * 21 - 10 * 21);
        expect(html).toContain('part 4999.stl');
        expect(html).not.toContain('part 0.stl');
        expect(html).toContain(`top:${4999 * 21}px`);
        expect(rowWindow(5000 * 21 - 10 * 21, 5000).last).toBe(5000);
    });

    it('draws the places, path bar, filters and list of the form', () => {
        const html = renderToStaticMarkup(createElement(FileBrowser, { filters: FILTERS, onSelect: () => {}, onPick: () => {}, footer: 'System dialog' }));
        for (const text of ['Places', 'Up one folder', 'Pin this folder', 'Filter this folder by name', 'All types', 'STEP', 'SolidWorks',
            'role="listbox"', 'Show all files', 'Hidden', 'System dialog']) {
            expect(html, text).toContain(text);
        }
    });
});
