import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_PRINT, type Vec3 } from '@jarvis/core';
import type { CadKernel, MeshData } from './cad/kernel.js';
import { exportStl } from './exportStl.js';
import type { MeshService } from './meshes.js';
import { EXPORTS_DIR } from './paths.js';
import { slug, type ProjectStore } from './store.js';
import type { HostTool } from './tools.js';

/** What the tools below need from the running server. */
export interface Host {
    /** Asks the open browser for a JPEG of the viewport once its animations have settled. */
    capture: () => Promise<Buffer>;
    /** Offers a file under /api/exports to the open browser as a download. */
    download: (filename: string) => void;
    meshes: MeshService;
    kernel: CadKernel;
}

/** Axis-aligned size of a mesh in the part's frame, rotated into the world, in mm. */
function meshSize(mesh: MeshData): Vec3 {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
        for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], mesh.positions[i + a]);
            max[a] = Math.max(max[a], mesh.positions[i + a]);
        }
    }
    return [0, 1, 2].map((a) => Math.round((max[a] - min[a]) * 10) / 10) as Vec3;
}

/** Whether a part of this size fits the bed in some orientation (sorted sides against sorted bed). */
function fitsBed(size: Vec3, bed: Vec3): boolean {
    const s = [...size].sort((a, b) => a - b);
    const b = [...bed].sort((a, c) => a - c);
    return s.every((v, i) => v <= b[i]);
}

export function createHostTools(store: ProjectStore, host: Host): HostTool[] {
    return [
        {
            name: 'view_screenshot',
            description: 'Returns an image of the 3D viewport as the user sees it now (callout labels are not included). '
                + 'Use it to check your own modelling work. Set the camera with view_set first for another angle.',
            schema: {},
            run: async () => {
                const image = await host.capture();
                return { text: 'Current viewport:', image: { data: image.toString('base64'), mimeType: 'image/jpeg' } };
            },
        },
        {
            name: 'cad_check',
            description: 'Waits for the CAD kernel to build every part, then reports build errors (a feature that '
                + 'failed, by name), each part\'s real size, and whether printed parts fit the printer bed. '
                + 'Call it after building or editing features, before the screenshot.',
            schema: {},
            run: async () => {
                const project = store.get();
                await host.meshes.ready(project);
                const status = host.meshes.current();
                const bed = (project.print ?? DEFAULT_PRINT).bed;
                const lines = project.parts.map((part) => {
                    const mesh = host.meshes.meshFor(part, project);
                    const size = mesh ? meshSize(mesh) : null;
                    const notes = [
                        status.errors[part.id] ? `ERROR ${status.errors[part.id]}` : null,
                        size ? `${size.join(' x ')} mm` : 'not built',
                        size && !fitsBed(size, bed) ? `TOO BIG for the ${bed.join('x')} bed` : null,
                    ].filter(Boolean);
                    return `${part.id}: ${notes.join('; ')}`;
                });
                const errors = Object.keys(status.errors).length;
                return { text: `${errors ? `${errors} part(s) failed to build.` : 'All parts built.'}\n${lines.join('\n')}` };
            },
        },
        {
            name: 'export_stl',
            description: 'Exports parts as binary STL (mm, Z up) and offers them to the user as downloads. '
                + 'By default every part, one file per part, each as placed in the assembly '
                + '(the user orients them in the slicer). combined: one file with all of them.',
            schema: {
                partIds: z.array(z.string()).min(1).optional().describe('Only these parts'),
                combined: z.boolean().optional(),
            },
            run: async ({ partIds, combined }) => {
                const project = store.get();
                await host.meshes.ready(project);
                const ids: string[] = partIds ?? project.parts.map((p) => p.id);
                if (ids.length === 0) {
                    throw new Error('Nothing to export: the project has no parts');
                }
                const meshFor = (part: (typeof project.parts)[number]) => host.meshes.meshFor(part, project);
                const files: [string, Buffer][] = combined || ids.length === 1
                    ? [[`${slug(project.name)}${ids.length === 1 && !combined ? `-${ids[0]}` : ''}.stl`, exportStl(project, meshFor, ids)]]
                    : ids.map((id) => [`${slug(project.name)}-${id}.stl`, exportStl(project, meshFor, [id])]);
                mkdirSync(EXPORTS_DIR, { recursive: true });
                for (const [filename, stl] of files) {
                    writeFileSync(join(EXPORTS_DIR, filename), stl);
                    host.download(filename);
                }
                const missing = ids.filter((id) => {
                    const part = project.parts.find((p) => p.id === id);
                    return part && !host.meshes.meshFor(part, project);
                });
                return {
                    text: `Saved ${files.map(([f]) => f).join(', ')} to ${EXPORTS_DIR} and sent to the browser.`
                        + (missing.length ? ` These had no CAD solid and used the preview shape: ${missing.join(', ')}.` : ''),
                };
            },
        },
        {
            name: 'export_step',
            description: 'Exports the whole assembly as a STEP file (real solids with names and colours, for Fusion, '
                + 'FreeCAD, SolidWorks or Onshape) and offers it as a download.',
            schema: {},
            run: async () => {
                const project = store.get();
                const step = await host.kernel.step(project);
                const filename = `${slug(project.name)}.step`;
                mkdirSync(EXPORTS_DIR, { recursive: true });
                writeFileSync(join(EXPORTS_DIR, filename), step);
                host.download(filename);
                return { text: `Saved ${filename} (${Math.round(step.length / 1024)} KB) to ${EXPORTS_DIR} and sent it to the browser.` };
            },
        },
    ];
}
