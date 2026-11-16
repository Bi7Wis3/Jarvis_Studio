// The file formats the studio imports, by extension. Each importer turns a file's bytes into an ImportResult
// (types.ts); the readers are loaded on first use, in the CAD worker.
//
// To add a format, add one line to IMPORTERS. A SolidWorks part reader `readSldprt(bytes): ImportResult` in
// ./sldprt.ts plugs in as:
//     { format: 'sldprt', extensions: ['sldprt'], label: 'SolidWorks part (*.sldprt)', read: async (b) => (await import('./sldprt.js')).readSldprt(b) },

import type { ImportOptions } from '@jarvis/core/imported';
import type { Importer, ImportResult } from './types.js';

export const IMPORTERS: Importer[] = [
    { format: 'step', extensions: ['step', 'stp'], label: 'STEP AP203/AP214 (*.step, *.stp)', read: async (b, o) => (await import('./step.js')).readStep(b, o) },
    { format: 'stl', extensions: ['stl'], label: 'STL mesh (*.stl)', mesh: true, read: async (b, o) => (await import('./stl.js')).readStl(b, o) },
    { format: 'sldprt', extensions: ['sldprt'], label: 'SolidWorks part (*.sldprt)', read: async (b) => (await import('./sldprt.js')).readSldprt(b) },
    { format: 'iges', extensions: ['igs', 'iges'], label: 'IGES (*.igs, *.iges)', read: async (b, o) => (await import('./iges/readIges.js')).readIges(b, o) },
];

export const extensionOf = (filename: string): string => /\.([^./\\]+)$/.exec(filename)?.[1]?.toLowerCase() ?? '';

/** The importer for a file name, or null when the studio cannot read that type. */
export function importerFor(filename: string): Importer | null {
    const extension = extensionOf(filename);
    return IMPORTERS.find((i) => i.extensions.includes(extension)) ?? null;
}

/** What the Import form offers: one entry per format. */
export function importFormats(): { format: string; extensions: string[]; label: string; mesh: boolean }[] {
    return IMPORTERS.map((i) => ({ format: i.format, extensions: i.extensions, label: i.label, mesh: !!i.mesh }));
}

export function unsupported(filename: string): string {
    const known = IMPORTERS.flatMap((i) => i.extensions.map((e) => `.${e}`)).join(', ');
    return `${filename}: the studio cannot import this type of file (it reads ${known})`;
}

export async function readFile(filename: string, bytes: Uint8Array, options: ImportOptions): Promise<ImportResult & { importer: Importer }> {
    const importer = importerFor(filename);
    if (!importer) {
        throw new Error(unsupported(filename));
    }
    return { ...(await importer.read(bytes, options)), importer };
}
