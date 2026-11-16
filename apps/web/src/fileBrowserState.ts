// The app's own file browser (fileBrowser.tsx), its state and rules kept apart from the drawing so they can be tested:
// the folder shown (from the server's /api/files routes, home folder only), the name filter and the quick filters by
// type (SolidWorks Open dialog: any combination; none on shows every type the tool reads), the selection and what each
// key does, and the places (Home, Desktop, Documents, Downloads, pinned and recent folders).

import { create } from 'zustand';

export interface FileEntry {
    name: string;
    kind: 'folder' | 'file';
    size: number;
    modified: number;
    /** The format the studio reads the file as (import registry), when it reads it. */
    format?: string;
    /** The file carries a preview picture. */
    preview?: true;
    link?: true;
}

export interface Listing {
    path: string;
    home: string;
    parent: string | null;
    entries: FileEntry[];
    skipped: number;
}

export interface Place {
    id: string;
    name: string;
    path: string;
}

export interface Places {
    home: string;
    standard: Place[];
    favourites: string[];
    recent: string[];
    last: string;
}

/** A quick filter button: the formats it shows. */
export interface QuickFilter {
    id: string;
    label: string;
    /** The tooltip (the type's full name). */
    title?: string;
    formats: string[];
}

/** A file chosen in the browser. */
export interface PickedFile {
    path: string;
    name: string;
    size: number;
    modified: number;
    format?: string;
}

export interface BrowserView {
    query: string;
    /** Quick filters on (ids); none: every file the listing holds. */
    quick: string[];
}

// ---- Rules ---------------------------------------------------------------------------------------------------------

/** The entries shown: names containing the filter text (case ignored), files of the quick filters' formats. */
export function visibleEntries(entries: FileEntry[], view: BrowserView, filters: QuickFilter[]): FileEntry[] {
    const text = view.query.trim().toLowerCase();
    const formats = new Set(filters.filter((f) => view.quick.includes(f.id)).flatMap((f) => f.formats));
    return entries.filter((e) => (!text || e.name.toLowerCase().includes(text))
        && (e.kind === 'folder' || formats.size === 0 || (!!e.format && formats.has(e.format))));
}

export const joinPath = (folder: string, name: string): string => (folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`);

/** The path from home as breadcrumb steps: Home first. */
export function crumbs(path: string, home: string): { name: string; path: string }[] {
    const out = [{ name: 'Home', path: home }];
    if (path === home || !path.startsWith(`${home}/`)) {
        return out;
    }
    let at = home;
    for (const part of path.slice(home.length + 1).split('/').filter(Boolean)) {
        at = joinPath(at, part);
        out.push({ name: part, path: at });
    }
    return out;
}

/** The last part of a path (a folder's name). */
export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;

export type KeyAction =
    | { type: 'select'; name: string }
    | { type: 'open'; path: string }
    | { type: 'pick'; entry: FileEntry }
    | { type: 'up' };

/**
 * What a key does in the list: arrows, Home, End and Page Up/Down move the selection, Enter opens the selected folder
 * or picks the selected file, Backspace goes up a folder. Null: the key is not the list's.
 */
export function keyAction(key: string, shown: FileEntry[], selected: string | null, folder: Listing | null, page = 10): KeyAction | null {
    const at = selected === null ? -1 : shown.findIndex((e) => e.name === selected);
    const to = (i: number): KeyAction | null => (shown.length ? { type: 'select', name: shown[Math.max(0, Math.min(shown.length - 1, i))].name } : null);
    switch (key) {
        case 'ArrowDown':
            return to(at + 1);
        case 'ArrowUp':
            return to(at < 0 ? shown.length - 1 : at - 1);
        case 'Home':
            return to(0);
        case 'End':
            return to(shown.length - 1);
        case 'PageDown':
            return to(at < 0 ? page - 1 : at + page);
        case 'PageUp':
            return to(at - page);
        case 'Enter': {
            const entry = at >= 0 ? shown[at] : null;
            if (!entry) {
                return to(0);
            }
            return entry.kind === 'folder' && folder ? { type: 'open', path: joinPath(folder.path, entry.name) } : { type: 'pick', entry };
        }
        case 'Backspace':
            return folder?.parent ? { type: 'up' } : null;
        default:
            return null;
    }
}

export function sizeText(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = bytes / 1024;
    let u = 0;
    while (n >= 1024 && u < units.length - 1) {
        n /= 1024;
        u++;
    }
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** A date as 2026-11-16 14:03 (local time). */
export function dateText(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function pickedOf(listing: Listing, entry: FileEntry): PickedFile {
    return {
        path: joinPath(listing.path, entry.name), name: entry.name, size: entry.size, modified: entry.modified,
        ...(entry.format ? { format: entry.format } : {}),
    };
}

// ---- Store ---------------------------------------------------------------------------------------------------------

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface BrowserState extends BrowserView {
    listing: Listing | null;
    loading: boolean;
    error: string | null;
    /** Every file, not only those the tool reads. */
    showAll: boolean;
    /** Hidden entries (names with a leading dot). */
    hidden: boolean;
    /** The selected entry's name, in the folder shown. */
    selected: string | null;
    places: Places | null;
}

export const useFileBrowser = create<BrowserState>(() => ({
    listing: null, loading: false, error: null, query: '', quick: [], showAll: false, hidden: false, selected: null, places: null,
}));

let fetcher: Fetch = (url, init) => globalThis.fetch(url, init);

/** For tests: the server the browser talks to. */
export function setFileFetch(f: Fetch): void {
    fetcher = f;
}

let request = 0;
let lastSaved = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const errorOf = async (response: { status: number; json(): Promise<unknown> }): Promise<string> => {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    return typeof body?.error === 'string' ? body.error : `The server answered ${response.status}.`;
};

/** Remembers the folder the browser is in (where it opens next time), a moment after it settles. */
function rememberFolder(path: string): void {
    if (path === lastSaved) {
        return;
    }
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
        saveTimer = null;
        lastSaved = path;
        void fetcher('/api/files/places', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ last: path }) })
            .catch(() => undefined);
    }, 700);
}

/**
 * Shows a folder ('' with `last`: the one the browser was last in). `select`: an entry to select there (the folder just
 * left when going up). Answers that arrive after a newer request are dropped.
 */
export async function openFolder(path: string, options: { select?: string; last?: boolean } = {}): Promise<boolean> {
    const mine = ++request;
    const { hidden, showAll } = useFileBrowser.getState();
    useFileBrowser.setState({ loading: true });
    const query = new URLSearchParams({ path, ...(hidden ? { hidden: '1' } : {}), ...(showAll ? { all: '1' } : {}), ...(options.last ? { last: '1' } : {}) });
    try {
        const response = await fetcher(`/api/files/list?${query}`);
        if (mine !== request) {
            return false;
        }
        if (!response.ok) {
            useFileBrowser.setState({ loading: false, error: await errorOf(response) });
            return false;
        }
        const listing = await response.json() as Listing;
        if (mine !== request) {
            return false;
        }
        const same = useFileBrowser.getState().listing?.path === listing.path;
        useFileBrowser.setState({
            listing, loading: false, error: null,
            // A new folder starts with no filter text and nothing selected; the same one keeps them.
            ...(same ? {} : { query: '', selected: null }),
            ...(options.select !== undefined ? { selected: options.select } : {}),
        });
        if (same && !listing.entries.some((e) => e.name === useFileBrowser.getState().selected)) {
            useFileBrowser.setState({ selected: null });
        }
        rememberFolder(listing.path);
        return true;
    } catch {
        if (mine === request) {
            useFileBrowser.setState({ loading: false, error: 'The server is not answering.' });
        }
        return false;
    }
}

/** Shows the folder again (after a filter that the server applies changes, or to pick up new files). */
export const refreshFolder = (): Promise<boolean> => openFolder(useFileBrowser.getState().listing?.path ?? '', { last: !useFileBrowser.getState().listing });

/** Up one folder, with the folder left selected. */
export function goUp(): Promise<boolean> {
    const listing = useFileBrowser.getState().listing;
    return listing?.parent ? openFolder(listing.parent, { select: baseName(listing.path) }) : Promise.resolve(false);
}

export function setShowAll(on: boolean): Promise<boolean> {
    useFileBrowser.setState({ showAll: on });
    return refreshFolder();
}

export function setHidden(on: boolean): Promise<boolean> {
    useFileBrowser.setState({ hidden: on });
    return refreshFolder();
}

/** Turns a quick filter on or off; null: all of them off (every type the tool reads). */
export function toggleQuick(id: string | null): void {
    useFileBrowser.setState((s) => ({ quick: id === null ? [] : s.quick.includes(id) ? s.quick.filter((q) => q !== id) : [...s.quick, id] }));
}

export async function loadPlaces(): Promise<void> {
    try {
        const response = await fetcher('/api/files/places');
        if (response.ok) {
            useFileBrowser.setState({ places: await response.json() as Places });
        }
    } catch {
        // The places stay as they were.
    }
}

async function putPlaces(body: object): Promise<void> {
    try {
        const response = await fetcher('/api/files/places', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (response.ok) {
            useFileBrowser.setState({ places: await response.json() as Places });
        }
    } catch {
        // Not saved; the places stay as they were.
    }
}

/** Pins a folder under Places, or unpins it. */
export function togglePin(path: string): Promise<void> {
    const favourites = useFileBrowser.getState().places?.favourites ?? [];
    return putPlaces({ favourites: favourites.includes(path) ? favourites.filter((f) => f !== path) : [...favourites, path] });
}

/** Removes a folder from the recent ones. */
export const forgetRecent = (path: string): Promise<void> => putPlaces({ forget: path });
