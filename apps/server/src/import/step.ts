// STEP (AP203, AP214, AP242 geometry) through OpenCascade's STEPControl_Reader. The reader converts the file's
// units to millimetres. This OpenCascade build has no XCAF reader (STEPCAFControl_Reader), so product names, colours
// and the assembly structure are not read: every solid becomes a body of its own, placed as in the file.

import { cast, getOC, type Shape3D } from 'replicad';
import type { ImportOptions } from '@jarvis/core/imported';
import { looseGeometry } from './solids.js';
import type { ImportResult } from './types.js';

let files = 0;

export function readStep(bytes: Uint8Array, options: ImportOptions): ImportResult {
    const oc = getOC();
    const fs = (oc as unknown as { FS: { writeFile(p: string, d: Uint8Array): void; unlink(p: string): void } }).FS;
    const file = `/import-${process.pid}-${++files}.step`;
    fs.writeFile(file, bytes);
    const reader = new oc.STEPControl_Reader();
    const progress = new oc.Message_ProgressRange();
    try {
        oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
        // Customize curve tolerance: the reader's precision (mode 1) instead of the file's own (mode 0).
        if (options.tolerance && options.tolerance > 0) {
            oc.Interface_Static.SetIVal('read.precision.mode', 1);
            oc.Interface_Static.SetRVal('read.precision.val', options.tolerance);
        } else {
            oc.Interface_Static.SetIVal('read.precision.mode', 0);
        }
        const status = reader.ReadFile(file) as unknown;
        if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
            throw new Error('the file could not be read as STEP (it is damaged, or not a STEP file)');
        }
        const roots = reader.NbRootsForTransfer();
        reader.TransferRoots(progress);
        if (reader.NbShapes() === 0) {
            throw new Error(roots ? 'the STEP file holds no geometry the studio can read' : 'the STEP file is empty');
        }
        const whole = cast(reader.OneShape()) as Shape3D;
        try {
            return looseGeometry(whole, options);
        } finally {
            whole.delete();
        }
    } finally {
        progress.delete();
        reader.delete();
        try {
            fs.unlink(file);
        } catch {
            // never written
        }
    }
}
