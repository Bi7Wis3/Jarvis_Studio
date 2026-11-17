// The app's own file browser, drawn in a left-panel form in place of the system's file dialog (which is slow to open
// and not ours): places, a breadcrumb path, the folder's entries (a virtual list: only the rows in view are drawn),
// a name filter and quick filters by type, and the selected file's preview picture, size and date. Folders and files
// come from the local server, home folder only (apps/server/src/files.ts). File > Import and Open use it to pick a file;
// File > Save As (jarvisFileForms.tsx) puts a file name field under the list and asks before replacing a file.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
    baseName, crumbs, dateText, forgetRecent, goUp, joinPath, keyAction, loadPlaces, openFolder, pickedOf, refreshFolder,
    setHidden, setShowAll, sizeText, toggleQuick, togglePin, useFileBrowser, visibleEntries,
    type FileEntry, type KeyAction, type PickedFile, type QuickFilter,
} from './fileBrowserState';
import './fileBrowser.css';

export type { PickedFile, QuickFilter } from './fileBrowserState';

/** Row height in the list (px), and the rows in view (with the form's options still in reach below). */
const ROW = 21;
const ROWS = 10;
/** Rows drawn above and below the ones in view, so a quick scroll shows no gap. */
const OVERSCAN = 6;
/** Recent folders shown before "More". */
const RECENT_SHOWN = 5;

const FILL = { fill: 'currentColor', fillOpacity: 0.22 } as const;

const GLYPHS: Record<string, { color?: string; body: ReactNode }> = {
    folder: { color: '#e8c36a', body: <path d="M2 5.5h7l2 2.5h11v12H2z" {...FILL} /> },
    part: { color: '#b9c7dc', body: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...FILL} /><path d="M4 7.5L12 12l8-4.5M12 12v9" /></> },
    exact: { color: '#6fd58a', body: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...FILL} /><path d="M4 7.5L12 12l8-4.5M12 12v9" /></> },
    mesh: { color: '#8fc7ff', body: <><path d="M3 19L12 4l9 15z" {...FILL} /><path d="M7.5 11.5h9M12 19l-4.5-7.5M12 19l4.5-7.5" /></> },
    project: { color: '#35e0ff', body: <><path d="M4 7.5L12 3l8 4.5v9L12 21l-8-4.5z" {...FILL} /><path d="M8 9.5l4 2.3 4-2.3M12 11.8V16" /></> },
    file: { color: '#8a94a6', body: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></> },
    up: { body: <path d="M12 19V5M6 11l6-6 6 6" /> },
    star: { body: <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" /> },
    home: { body: <><path d="M4 11l8-7 8 7" /><path d="M6 9.5V20h12V9.5" /></> },
    desktop: { body: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6M12 16v4" /></> },
    documents: { body: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></> },
    downloads: { body: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v3h16v-3" /></> },
    recent: { body: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></> },
    pinned: { color: '#e8c36a', body: <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" {...FILL} /> },
};

function Glyph({ name, size = 14 }: { name: string; size?: number }) {
    const glyph = GLYPHS[name] ?? GLYPHS.file;
    return (
        <svg className="fb-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={glyph.color ? { color: glyph.color } : undefined}>
            {glyph.body}
        </svg>
    );
}

const glyphOf = (entry: FileEntry): string => (entry.kind === 'folder' ? 'folder' : entry.format === 'sldprt' ? 'part'
    : entry.format === 'stl' ? 'mesh' : entry.format === 'jarvis' ? 'project' : entry.format ? 'exact' : 'file');

const TYPE_NAMES: Record<string, string> = {
    step: 'STEP file', iges: 'IGES file', stl: 'STL mesh', sldprt: 'SolidWorks part', jarvis: 'Jarvis Studio project',
};

/** A file's type in words: its format's, else its extension's. */
export function typeName(entry: Pick<FileEntry, 'name' | 'kind' | 'format'>): string {
    if (entry.kind === 'folder') {
        return 'Folder';
    }
    if (entry.format) {
        return TYPE_NAMES[entry.format] ?? `${entry.format.toUpperCase()} file`;
    }
    const ext = /\.([^.]+)$/.exec(entry.name)?.[1];
    return ext ? `${ext.toUpperCase()} file` : 'File';
}

let placesOpen = true;
let fileOpen = true;

function Section(props: { title: string; open: boolean; onToggle: () => void; children: ReactNode; extra?: ReactNode }) {
    return (
        <section className={`pm-section fb-section ${props.open ? 'open' : ''}`}>
            <button type="button" className="pm-section-head" onClick={props.onToggle} aria-expanded={props.open}>
                <span>{props.title}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
            </button>
            {props.open && <div className="pm-section-body">{props.children}</div>}
        </section>
    );
}

function PlaceRow({ glyph, path, here, onOpen, onRemove, removeLabel }: {
    glyph: string; path: string; here: boolean; onOpen: () => void; onRemove: () => void; removeLabel: string;
}) {
    return (
        <li className={here ? 'here' : ''}>
            <button type="button" className="fb-place" onClick={onOpen} title={path}>
                <Glyph name={glyph} size={13} />
                <span>{baseName(path)}</span>
            </button>
            <button type="button" className="fb-x" onClick={onRemove} title={removeLabel} aria-label={`${removeLabel}: ${baseName(path)}`}>×</button>
        </li>
    );
}

/** Home, Desktop, Documents, Downloads, the pinned folders and the folders last imported from. */
function PlacesList({ here, go }: { here: string | null; go: (path: string) => void }) {
    const places = useFileBrowser((s) => s.places);
    const [more, setMore] = useState(false);
    if (!places) {
        return <p className="fb-note">Reading the places…</p>;
    }
    const recent = places.recent.filter((r) => !places.favourites.includes(r));
    return (
        <>
            <div className="fb-standard">
                {places.standard.map((p) => (
                    <button type="button" key={p.id} className={p.path === here ? 'here' : ''} onClick={() => go(p.path)} title={p.path}>
                        <Glyph name={p.id} size={13} />
                        <span>{p.name}</span>
                    </button>
                ))}
            </div>
            {places.favourites.length > 0 && (
                <ul className="fb-places" aria-label="Pinned folders">
                    {places.favourites.map((f) => (
                        <PlaceRow key={f} glyph="pinned" path={f} here={f === here} onOpen={() => go(f)} onRemove={() => void togglePin(f)} removeLabel="Unpin" />
                    ))}
                </ul>
            )}
            {recent.length > 0 && (
                <ul className="fb-places" aria-label="Recent folders">
                    {recent.slice(0, more ? recent.length : RECENT_SHOWN).map((r) => (
                        <PlaceRow key={r} glyph="recent" path={r} here={r === here} onOpen={() => go(r)} onRemove={() => void forgetRecent(r)}
                            removeLabel="Remove from recent folders" />
                    ))}
                </ul>
            )}
            {recent.length > RECENT_SHOWN && (
                <button type="button" className="fb-more" onClick={() => setMore(!more)}>{more ? 'Fewer' : `${recent.length - RECENT_SHOWN} more recent`}</button>
            )}
        </>
    );
}

/** The selected entry: its preview picture when it carries one, its name, size, type and date. */
function EntryInfo({ entry, path }: { entry: FileEntry; path: string }) {
    const [broken, setBroken] = useState<string | null>(null);
    const src = `/api/files/preview?path=${encodeURIComponent(path)}&m=${entry.modified}`;
    return (
        <div className="fb-info">
            {entry.preview && broken !== src && <img src={src} alt={`Preview of ${entry.name}`} onError={() => setBroken(src)} />}
            <div>
                <b title={path}>{entry.name}</b>
                <span>{typeName(entry)}{entry.kind === 'file' ? ` · ${sizeText(entry.size)}` : ''}</span>
                <span>{dateText(entry.modified)}</span>
            </div>
        </div>
    );
}

/** The rows to draw for a list scrolled `top` px down: those in view and a few on either side (`last` not included). */
export function rowWindow(top: number, count: number): { first: number; last: number } {
    return { first: Math.max(0, Math.floor(top / ROW) - OVERSCAN), last: Math.min(count, Math.ceil(top / ROW) + ROWS + OVERSCAN) };
}

/** The list's rows in a box as tall as all of them; only those in the window are drawn, each at its own height. */
export function Rows({ shown, window: { first, last }, index, onSelect, onOpen }: {
    shown: FileEntry[]; window: { first: number; last: number }; index: number; onSelect: (e: FileEntry) => void; onOpen: (e: FileEntry) => void;
}) {
    return (
        <div className="fb-rows" style={{ height: shown.length * ROW }}>
            {shown.slice(first, last).map((e, k) => {
                const i = first + k;
                return (
                    <div
                        key={e.name}
                        id={`fb-row-${i}`}
                        role="option"
                        aria-selected={i === index}
                        className={`fb-row ${i === index ? 'on' : ''} ${e.kind === 'file' && !e.format ? 'other' : ''}`}
                        style={{ top: i * ROW, height: ROW }}
                        onClick={() => onSelect(e)}
                        onDoubleClick={() => onOpen(e)}
                        title={e.name}
                    >
                        <Glyph name={glyphOf(e)} />
                        <span className="fb-name">{e.name}</span>
                        {e.kind === 'file' && <span className="fb-size">{sizeText(e.size)}</span>}
                    </div>
                );
            })}
        </div>
    );
}

export interface FileBrowserProps {
    /** Quick filter buttons, one per type. */
    filters: QuickFilter[];
    /** The selected file changed (null: a folder or nothing is selected). */
    onSelect: (file: PickedFile | null) => void;
    /** A file was double clicked, or Enter pressed on it. */
    onPick: (file: PickedFile) => void;
    /** While the tool works: nothing can be picked. */
    disabled?: boolean;
    /** Under the list, before the selected file's details (e.g. a link to the system dialog). */
    footer?: ReactNode;
}

export function FileBrowser({ filters, onSelect, onPick, disabled, footer }: FileBrowserProps) {
    const listing = useFileBrowser((s) => s.listing);
    const loading = useFileBrowser((s) => s.loading);
    const error = useFileBrowser((s) => s.error);
    const query = useFileBrowser((s) => s.query);
    const quick = useFileBrowser((s) => s.quick);
    const showAll = useFileBrowser((s) => s.showAll);
    const hidden = useFileBrowser((s) => s.hidden);
    const selected = useFileBrowser((s) => s.selected);
    const favourites = useFileBrowser((s) => s.places?.favourites);
    const [open, setOpen] = useState({ places: placesOpen, file: fileOpen });
    const [top, setTop] = useState(0);
    const list = useRef<HTMLDivElement>(null);
    const filter = useRef<HTMLInputElement>(null);
    const callbacks = useRef({ onSelect, onPick });
    callbacks.current = { onSelect, onPick };
    const shown = listing ? visibleEntries(listing.entries, { query, quick }, filters) : [];
    const index = selected === null ? -1 : shown.findIndex((e) => e.name === selected);
    const entry = index >= 0 ? shown[index] : null;

    // A new form starts with nothing selected; the folder last shown is there at once and read again behind it.
    useEffect(() => {
        useFileBrowser.setState({ selected: null });
        void loadPlaces();
        void refreshFolder();
    }, []);

    // The form hears of the selected file whenever it changes (it starts without one: what an earlier form left
    // selected is cleared above, not sent).
    const sent = useRef<string | null>(null);
    const started = useRef(false);
    const file = entry?.kind === 'file' && listing ? pickedOf(listing, entry) : null;
    useEffect(() => {
        if (!started.current) {
            started.current = true;
            return;
        }
        if ((file?.path ?? null) !== sent.current) {
            sent.current = file?.path ?? null;
            callbacks.current.onSelect(file);
        }
    });

    // A new folder shows from its top, or with the folder just left in view.
    useEffect(() => {
        const box = list.current;
        if (box) {
            box.scrollTop = index >= 0 ? Math.max(0, index * ROW - (ROWS / 2) * ROW) : 0;
            setTop(box.scrollTop);
        }
    }, [listing?.path]);

    const reveal = (i: number) => {
        const box = list.current;
        if (!box) {
            return;
        }
        if (i * ROW < box.scrollTop) {
            box.scrollTop = i * ROW;
        } else if ((i + 1) * ROW > box.scrollTop + box.clientHeight) {
            box.scrollTop = (i + 1) * ROW - box.clientHeight;
        }
    };
    const go = (path: string) => void openFolder(path);
    const pick = (e: FileEntry) => {
        if (listing && e.kind === 'file' && !disabled) {
            callbacks.current.onPick(pickedOf(listing, e));
        }
    };
    const act = (action: KeyAction) => {
        if (action.type === 'select') {
            useFileBrowser.setState({ selected: action.name });
            reveal(shown.findIndex((e) => e.name === action.name));
        } else if (action.type === 'open') {
            go(action.path);
        } else if (action.type === 'pick') {
            pick(action.entry);
        } else {
            void goUp();
        }
    };
    const onKey = (event: KeyboardEvent, inFilter: boolean) => {
        if (inFilter && (event.key === 'Home' || event.key === 'End' || (event.key === 'Backspace' && query))) {
            return;
        }
        if (event.key === 'Escape' && query) {
            // As in SolidWorks' name filter: Esc clears the text (and leaves the form open).
            event.preventDefault();
            event.stopPropagation();
            useFileBrowser.setState({ query: '' });
            return;
        }
        const action = keyAction(event.key, shown, selected, listing, ROWS - 1);
        if (action || event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (action) {
                act(action);
            }
        } else if (!inFilter && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // Typing in the list filters it.
            event.preventDefault();
            useFileBrowser.setState({ query: query + event.key });
            filter.current?.focus();
        }
    };

    const here = listing?.path ?? null;
    const pinned = !!here && !!favourites?.includes(here);
    const toggle = (key: 'places' | 'file') => setOpen((o) => {
        const next = { ...o, [key]: !o[key] };
        placesOpen = next.places;
        fileOpen = next.file;
        return next;
    });
    const hiddenCount = listing ? listing.entries.length - shown.length : 0;

    return (
        <div className={`fb ${disabled ? 'disabled' : ''}`}>
            <Section title="Places" open={open.places} onToggle={() => toggle('places')}>
                <PlacesList here={here} go={go} />
            </Section>
            <Section title="File" open={open.file} onToggle={() => toggle('file')}>
                <div className="fb-bar">
                    <button type="button" className="fb-tool" onClick={() => void goUp()} disabled={!listing?.parent} title="Up one folder (Backspace)" aria-label="Up one folder">
                        <Glyph name="up" />
                    </button>
                    <nav className="fb-crumbs" aria-label="Folder path">
                        {listing && crumbs(listing.path, listing.home).map((c, i, all) => (
                            <span key={c.path}>
                                {i > 0 && <span className="fb-sep">›</span>}
                                <button type="button" className={i === all.length - 1 ? 'here' : ''} onClick={() => go(c.path)} title={c.path}>{c.name}</button>
                            </span>
                        ))}
                    </nav>
                    <button type="button" className={`fb-tool ${pinned ? 'on' : ''}`} onClick={() => here && void togglePin(here)} disabled={!here}
                        title={pinned ? 'Unpin this folder from Places' : 'Pin this folder to Places'} aria-pressed={pinned} aria-label="Pin this folder">
                        <Glyph name="star" />
                    </button>
                </div>
                <label className="tb-input fb-filter">
                    <input
                        ref={filter}
                        type="text"
                        placeholder="Filter this folder by name"
                        aria-label="Filter by name"
                        spellCheck={false}
                        value={query}
                        onChange={(event) => useFileBrowser.setState({ query: event.target.value })}
                        onKeyDown={(event) => onKey(event, true)}
                    />
                    {query && (
                        <button type="button" className="fb-clear" onClick={() => useFileBrowser.setState({ query: '' })} title="Clear the filter (Esc)" aria-label="Clear the filter">×</button>
                    )}
                </label>
                <div className="fb-quick" role="group" aria-label="Quick filter">
                    <button type="button" className={quick.length === 0 ? 'on' : ''} aria-pressed={quick.length === 0} onClick={() => toggleQuick(null)}
                        title={showAll ? 'Every file' : 'Every type this tool reads'}>All types</button>
                    {filters.map((f) => (
                        <button type="button" key={f.id} className={quick.includes(f.id) ? 'on' : ''} aria-pressed={quick.includes(f.id)} onClick={() => toggleQuick(f.id)}
                            title={`${f.title ?? f.label}: on with others, shows those types too`}>{f.label}</button>
                    ))}
                </div>
                <div
                    ref={list}
                    className={`fb-list ${loading ? 'loading' : ''}`}
                    role="listbox"
                    aria-label={listing ? `Files in ${baseName(listing.path)}` : 'Files'}
                    aria-activedescendant={index >= 0 ? `fb-row-${index}` : undefined}
                    tabIndex={0}
                    style={{ height: ROW * ROWS }}
                    onScroll={(event) => setTop(event.currentTarget.scrollTop)}
                    onKeyDown={(event) => onKey(event, false)}
                >
                    <Rows
                        shown={listing ? shown : []}
                        window={rowWindow(top, shown.length)}
                        index={index}
                        onSelect={(e) => useFileBrowser.setState({ selected: e.name })}
                        onOpen={(e) => (e.kind === 'folder' && listing ? go(joinPath(listing.path, e.name)) : pick(e))}
                    />
                    {!listing && <p className="fb-empty">{loading ? 'Reading the folder…' : ''}</p>}
                    {listing && shown.length === 0 && (
                        <p className="fb-empty">{listing.entries.length ? 'Nothing here matches the filters.' : showAll ? 'This folder is empty.' : 'No files this tool reads here.'}</p>
                    )}
                </div>
                <div className="fb-status">
                    <label><input type="checkbox" checked={showAll} onChange={(event) => void setShowAll(event.target.checked)} /> Show all files</label>
                    <label><input type="checkbox" checked={hidden} onChange={(event) => void setHidden(event.target.checked)} /> Hidden</label>
                    <span className="fb-count" title={hiddenCount ? `${hiddenCount} more hidden by the filters` : undefined}>
                        {listing ? `${shown.length} item${shown.length === 1 ? '' : 's'}` : ''}
                    </span>
                </div>
                {error && <p className="fb-error" role="alert">{error}</p>}
                {entry && listing && <EntryInfo entry={entry} path={joinPath(listing.path, entry.name)} />}
                {footer}
            </Section>
        </div>
    );
}
