// The app's own file browser (File > Import, Open and Save As): folder listings and the preview pictures files carry,
// for the owner's home folder only and read only (writing a .jarvis file is jarvisFile.ts, with the same rules). Every
// path is resolved through its symlinks first and refused when it ends up outside home.

import { promises as fs, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { readContainer } from './import/sldprt/container.js';
import { importerFor } from './import/registry.js';
import { EXTENSION as JARVIS_EXTENSION, thumbnailOf } from './jarvisFormat.js';

export interface FileEntry {
    name: string;
    kind: 'folder' | 'file';
    /** Bytes (0 for folders). */
    size: number;
    /** Last modified, ms since 1970. */
    modified: number;
    /** The import format of a file, by its extension (see import/registry.ts). */
    format?: string;
    /** The file carries a preview picture (by its type; whether it really has one shows when it is asked for). */
    preview?: true;
    /** A symbolic link (to a place inside home). */
    link?: true;
}

export interface FolderListing {
    /** The folder, resolved. */
    path: string;
    home: string;
    /** The folder above, or null at home. */
    parent: string | null;
    /** Folders first, then files, each in natural order (2 before 10, case ignored). */
    entries: FileEntry[];
    /** Entries left out: hidden ones (unless asked for), files the studio cannot import (unless all are asked for), links out of home. */
    skipped: number;
}

/** A path refused or not found; `status` is the HTTP status the routes answer with. */
export class FileAccessError extends Error {
    constructor(message: string, readonly status: 400 | 403 | 404) {
        super(message);
    }
}

/** The largest folder listed: entries past it are counted in `skipped`. */
export const MAX_ENTRIES = 50_000;
/**
 * Files of these types carry a preview picture (SolidWorks parts, assemblies and drawings: the PreviewPNG stream; the
 * studio's own files: thumbnail.png).
 */
const PREVIEW_TYPES = new Set(['.sldprt', '.sldasm', '.slddrw', JARVIS_EXTENSION]);
/** Larger files are not read for their preview. */
const MAX_PREVIEW_FILE = 256 * 1024 * 1024;
/**
 * Entries are stat'ed this many at a time, synchronously, with a turn of the event loop between batches: for metadata
 * the system has cached that is several times quicker than the thread pool (3,700 entries: 40 ms against 200 ms).
 */
const STAT_BATCH = 400;

let realHome: string | null = null;

/** The owner's home folder, resolved. */
export async function homeFolder(): Promise<string> {
    realHome ??= await fs.realpath(homedir());
    return realHome;
}

export const inside = (path: string, home: string): boolean => path === home || path.startsWith(home.endsWith(sep) ? home : home + sep);

/** Whether a name is hidden (Unix: a leading dot). */
export const isHidden = (name: string): boolean => name.startsWith('.');

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then natural order of the names; names equal but for case keep a fixed order. */
export function compareEntries(a: Pick<FileEntry, 'name' | 'kind'>, b: Pick<FileEntry, 'name' | 'kind'>): number {
    if (a.kind !== b.kind) {
        return a.kind === 'folder' ? -1 : 1;
    }
    return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

const describe = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));

/**
 * The real path of `path` (absolute, or ~ for home; '' is home itself), refused outside home. Throws FileAccessError.
 */
export async function resolveInHome(path: string, home: string, want?: 'folder' | 'file'): Promise<{ path: string; stats: Stats }> {
    const given = path.trim() === '' ? home : path.startsWith('~') ? join(home, path.slice(1)) : path;
    if (!isAbsolute(given) || given.includes('\0')) {
        throw new FileAccessError('Give an absolute path.', 400);
    }
    let real: string;
    try {
        real = await fs.realpath(resolve(given));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new FileAccessError(code === 'ENOENT' || code === 'ENOTDIR' ? `${given} does not exist.` : `${given} cannot be read (${describe(error)}).`,
            code === 'EACCES' ? 403 : 404);
    }
    if (!inside(real, home)) {
        throw new FileAccessError('Only files in your home folder can be opened here.', 403);
    }
    const stats = await fs.stat(real).catch((error: unknown) => {
        throw new FileAccessError(`${given} cannot be read (${describe(error)}).`, 403);
    });
    if (want === 'folder' && !stats.isDirectory()) {
        throw new FileAccessError(`${basename(real)} is not a folder.`, 400);
    }
    if (want === 'file' && !stats.isFile()) {
        throw new FileAccessError(`${basename(real)} is not a file.`, 400);
    }
    return { path: real, stats };
}

export interface ListOptions {
    /** Show hidden entries (a leading dot). */
    hidden?: boolean;
    /** Show every file, not only the ones the studio can import. */
    all?: boolean;
    /** The format of a file name, or null when it cannot be opened; the importer registry by default. */
    formatOf?: (name: string) => string | null;
}

/** A file the studio reads: one it imports (its format), or its own project file ('jarvis'). */
const importFormat = (name: string): string | null => importerFor(name)?.format
    ?? (name.toLowerCase().endsWith(JARVIS_EXTENSION) ? 'jarvis' : null);

async function inBatches<T, R>(items: T[], run: (item: T) => R): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += STAT_BATCH) {
        if (i > 0) {
            await new Promise((done) => setImmediate(done));
        }
        out.push(...items.slice(i, i + STAT_BATCH).map(run));
    }
    return out;
}

/**
 * Lists a folder in home. Hidden entries and files of other types are dropped by name before anything is read, so only
 * the entries shown are stat'ed. Links are followed and kept only when they lead to a place inside home.
 */
export async function listFolder(path: string, home: string, options: ListOptions = {}): Promise<FolderListing> {
    const formatOf = options.formatOf ?? importFormat;
    const folder = await resolveInHome(path, home, 'folder');
    let dirents: Dirent[];
    try {
        dirents = await fs.readdir(folder.path, { withFileTypes: true });
    } catch (error) {
        throw new FileAccessError(`${folder.path} cannot be read (${describe(error)}).`, 403);
    }
    let skipped = 0;
    const wanted: { dirent: Dirent; format: string | null }[] = [];
    for (const dirent of dirents) {
        const format = dirent.isDirectory() ? null : formatOf(dirent.name);
        // A link's kind is known only once it is followed; a plain file of another type is dropped here.
        const dropped = (!options.hidden && isHidden(dirent.name)) || (!options.all && dirent.isFile() && !format)
            || !(dirent.isFile() || dirent.isDirectory() || dirent.isSymbolicLink());
        if (dropped) {
            skipped++;
        } else {
            wanted.push({ dirent, format });
        }
    }
    const entries = (await inBatches(wanted, ({ dirent, format }): FileEntry | null => {
        const full = join(folder.path, dirent.name);
        try {
            if (dirent.isSymbolicLink() && !inside(realpathSync(full), home)) {
                return null;
            }
            const stats = statSync(full);
            const kind = stats.isDirectory() ? 'folder' : stats.isFile() ? 'file' : null;
            if (!kind || (kind === 'file' && !format && !options.all)) {
                return null;
            }
            return {
                name: dirent.name, kind, size: kind === 'file' ? stats.size : 0, modified: Math.round(stats.mtimeMs),
                ...(kind === 'file' && format ? { format } : {}),
                ...(kind === 'file' && PREVIEW_TYPES.has(extname(dirent.name).toLowerCase()) ? { preview: true as const } : {}),
                ...(dirent.isSymbolicLink() ? { link: true as const } : {}),
            };
        } catch {
            // Broken links, entries removed meanwhile, no permission.
            return null;
        }
    })).filter((e): e is FileEntry => !!e);
    skipped += wanted.length - entries.length;
    entries.sort(compareEntries);
    if (entries.length > MAX_ENTRIES) {
        skipped += entries.length - MAX_ENTRIES;
        entries.length = MAX_ENTRIES;
    }
    return { path: folder.path, home, parent: folder.path === home ? null : dirname(folder.path), entries, skipped };
}

// ---- Preview pictures ------------------------------------------------------------------------------------------

/** The preview a file carries (PNG), or null. Only the preview's own stream is unpacked, never the solid. */
export function previewOf(name: string, bytes: Uint8Array): Uint8Array | null {
    if (!PREVIEW_TYPES.has(extname(name).toLowerCase())) {
        return null;
    }
    if (extname(name).toLowerCase() === JARVIS_EXTENSION) {
        return thumbnailOf(bytes);
    }
    try {
        const png = readContainer(bytes, (stream) => stream === 'PreviewPNG').streams.get('PreviewPNG');
        return png && png.length > 8 && png[0] === 0x89 && png[1] === 0x50 ? png : null;
    } catch {
        return null;
    }
}

interface Cached {
    modified: number;
    size: number;
    png: Uint8Array | null;
}

/**
 * Preview pictures by path, kept while the file's modified time and size stay the same (the newest `max` of them).
 * `read` is the file reader (replaceable for tests).
 */
export class PreviewCache {
    private cache = new Map<string, Cached>();

    constructor(private readonly max = 300, private readonly read: (path: string) => Promise<Uint8Array> = async (p) => new Uint8Array(await fs.readFile(p))) {}

    get size(): number {
        return this.cache.size;
    }

    /** The preview of a file in home (resolved and checked here), or null when it carries none. */
    async get(path: string, home: string): Promise<Uint8Array | null> {
        const file = await resolveInHome(path, home, 'file');
        const modified = file.stats.mtimeMs;
        const kept = this.cache.get(file.path);
        if (kept && kept.modified === modified && kept.size === file.stats.size) {
            // Newest last: the oldest is the first one dropped.
            this.cache.delete(file.path);
            this.cache.set(file.path, kept);
            return kept.png;
        }
        const png = PREVIEW_TYPES.has(extname(file.path).toLowerCase()) && file.stats.size <= MAX_PREVIEW_FILE
            ? previewOf(file.path, await this.read(file.path)) : null;
        this.cache.delete(file.path);
        this.cache.set(file.path, { modified, size: file.stats.size, png });
        while (this.cache.size > this.max) {
            this.cache.delete(this.cache.keys().next().value!);
        }
        return png;
    }
}

// ---- Places --------------------------------------------------------------------------------------------------------

export interface Place {
    id: string;
    name: string;
    path: string;
}

/** The desktop, documents and downloads folders as the desktop names them (~/.config/user-dirs.dirs), else the usual names. */
async function userDirs(home: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const text = await fs.readFile(join(home, '.config', 'user-dirs.dirs'), 'utf8').catch(() => '');
    for (const match of text.matchAll(/^XDG_(DESKTOP|DOCUMENTS|DOWNLOAD)_DIR="([^"\n]*)"/gm)) {
        const path = match[2].replace(/^\$HOME/, home);
        if (isAbsolute(path) && resolve(path) !== home) {
            out[match[1]] = resolve(path);
        }
    }
    return out;
}

/** Home, Desktop, Documents and Downloads: the ones that exist. */
export async function standardPlaces(home: string): Promise<Place[]> {
    const xdg = await userDirs(home);
    const candidates: Place[] = [
        { id: 'home', name: 'Home', path: home },
        { id: 'desktop', name: 'Desktop', path: xdg.DESKTOP ?? join(home, 'Desktop') },
        { id: 'documents', name: 'Documents', path: xdg.DOCUMENTS ?? join(home, 'Documents') },
        { id: 'downloads', name: 'Downloads', path: xdg.DOWNLOAD ?? join(home, 'Downloads') },
    ];
    const found = await Promise.all(candidates.map(async (place) => {
        try {
            return { ...place, path: (await resolveInHome(place.path, home, 'folder')).path };
        } catch {
            return null;
        }
    }));
    return found.filter((p): p is Place => !!p);
}

/** The folders of a list that are still there (in home), resolved; the others are left out. */
export async function existingFolders(paths: string[], home: string): Promise<string[]> {
    const found = await Promise.all(paths.map((p) => resolveInHome(p, home, 'folder').then((f) => f.path, () => null)));
    return found.filter((p, i): p is string => !!p && found.indexOf(p) === i);
}
