// What an importer gives back: the bodies of a file as OpenCascade shapes or meshes, in millimetres, in the file's
// own axes (the import job turns them to Y up and stores them; see job.ts).

import type { Shape3D } from 'replicad';
import type { ImportOptions } from '@jarvis/core/imported';

export interface ImportedBody {
    /** A solid, or a compound of solids, in mm. */
    shape?: Shape3D;
    /** A graphics body: triangle corners (x, y, z, three per triangle) in mm. */
    mesh?: Float32Array;
    name?: string;
    /** '#rrggbb'. */
    color?: string;
}

export interface ImportResult {
    bodies: ImportedBody[];
    /** What did not come across, or was repaired, in plain words for the form. */
    warnings: string[];
    /** A preview picture the file carries (PNG). */
    thumbnail?: Uint8Array;
    /** The file's up axis when the format fixes it (SolidWorks parts: Y); otherwise the form's choice applies. */
    up?: 'y' | 'z';
}

/** Reads one file format. Runs in the CAD worker, with OpenCascade loaded. */
export interface Importer {
    /** Short format name stored with the step: 'step', 'stl'. */
    format: string;
    /** Lower-case file extensions, without the dot. */
    extensions: string[];
    /** For the file picker and the form, e.g. 'STEP AP203/AP214 (*.step, *.stp)'. */
    label: string;
    /** True for mesh formats, whose form offers Import as and Unit. */
    mesh?: boolean;
    read(bytes: Uint8Array, options: ImportOptions): ImportResult | Promise<ImportResult>;
}
