// Reading a file to import from this machine's disk instead of an upload: File > Import's own file browser sends the
// path (home folder only), the assistant's import_file tool any absolute path.

import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { CadKernel } from '../cad/kernel.js';
import { homeFolder, resolveInHome } from '../files.js';
import type { ProjectStore } from '../store.js';
import { importIntoProject, type ImportReport, type ImportRequest } from './project.js';

export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

/** The bytes of the file at an absolute path, with its name; refuses folders, missing and too large files. */
export async function readImportFile(full: string): Promise<{ filename: string; bytes: Uint8Array }> {
    const stats = await fs.stat(full).catch(() => null);
    if (!stats?.isFile()) {
        throw new Error(`There is no file at ${full}`);
    }
    if (stats.size > MAX_IMPORT_BYTES) {
        throw new Error(`${basename(full)} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
    }
    return { filename: basename(full), bytes: new Uint8Array(await fs.readFile(full)) };
}

/**
 * Imports the file at `path` (resolved through links, and only inside the home folder) as an upload of it would be:
 * the same job, options and report. Throws FileAccessError for a path refused or not found.
 */
export async function importFromPath(store: ProjectStore, kernel: Pick<CadKernel, 'importFile'>, path: string,
    request: Omit<ImportRequest, 'filename' | 'bytes'> = {}, home?: string): Promise<ImportReport & { path: string }> {
    const file = await resolveInHome(path, home ?? await homeFolder(), 'file');
    const { filename, bytes } = await readImportFile(file.path);
    return { ...await importIntoProject(store, kernel as CadKernel, { ...request, filename, bytes }), path: file.path };
}
