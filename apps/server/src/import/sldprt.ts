// SolidWorks parts (*.sldprt): the solid bodies held in the file's Parasolid data (sldprt/readSldprt.ts), exact, in mm
// and Y up as SolidWorks has them. The feature history is SolidWorks' own and is not read.

import type { ImportResult } from './types.js';
import { readSldprt as readParasolid } from './sldprt/readSldprt.js';

export function readSldprt(bytes: Uint8Array): ImportResult {
    const read = readParasolid(bytes);
    return {
        bodies: read.bodies.map((body) => ({ shape: body.shape, ...(body.name ? { name: body.name } : {}), ...(body.colour ? { color: body.colour } : {}) })),
        warnings: read.warnings,
        ...(read.thumbnail ? { thumbnail: read.thumbnail } : {}),
        up: 'y',
    };
}
