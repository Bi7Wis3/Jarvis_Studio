import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import { DEFAULT_PRINT, effectivePart, type Part, type Vec3 } from '@jarvis/core';
import { instanceTransforms } from '@jarvis/core/geometry';
import { combineContext, type CadKernel, type MeshData } from './cad/kernel.js';
import { combineProps, type Mat3, type MassProps, type Placement } from './cad/props.js';
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

/** World placements of every copy of a part: its own position and rotation, then its repeat copies. */
function placements(part: Part): Placement[] {
    const [rx, ry, rz] = part.rotation.map((d) => MathUtils.degToRad(d));
    const local = new Matrix4().compose(new Vector3(...part.position),
        new Quaternion().setFromEuler(new Euler(rx, ry, rz, 'XYZ')), new Vector3(1, 1, 1));
    return instanceTransforms(part).map((instance) => {
        const e = instance.clone().multiply(local).elements; // column-major
        return {
            rotation: [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]],
            translation: [e[12], e[13], e[14]],
        };
    });
}

/** Two decimals, or three significant figures below 1 (small masses and moments). */
const n2 = (n: number): string => {
    const a = Math.abs(n);
    return a < 1e-9 ? '0' : a >= 1 ? String(Math.round(n * 100) / 100) : String(Number(n.toPrecision(3)));
};
const vec = (v: readonly number[]): string => v.map(n2).join(', ');
const scaleMat = (m: Mat3, k: number): Mat3 => m.map((row) => row.map((v) => v * k)) as Mat3;
const sig = (n: number): number => Number(n.toPrecision(6));
const sigVec = (v: readonly number[]): number[] => v.map((x) => (Math.abs(x) < 1e-9 ? 0 : sig(x)));
const massText = (grams: number): string => (grams >= 1000 ? `${n2(grams / 1000)} kg` : `${n2(grams)} g`);

/** Default density (PLA), g/cm³. */
export const DEFAULT_DENSITY = 1.24;

interface PartReport {
    id: string;
    name: string;
    copies: number;
    note?: string;
    props?: MassProps;
}

/** Readable table and JSON numbers for mass_properties; density in g/cm³. */
export function massReport(reports: PartReport[], parts: Part[], density: number): string {
    const k = density / 1000; // g/mm³
    const lines: string[] = [`Mass properties, density ${n2(density)} g/cm³ (inertia in g·mm²).`];
    const json: Record<string, unknown> = { density, units: { length: 'mm', mass: 'g', inertia: 'g·mm²' }, parts: [] };
    for (const r of reports) {
        lines.push('', `${r.name} (${r.id})${r.copies > 1 ? `, ${r.copies} copies (figures for one)` : ''}`);
        const entry: Record<string, unknown> = { id: r.id, name: r.name, copies: r.copies };
        if (r.note) {
            lines.push(`  Note: ${r.note}`);
            entry.note = r.note;
        }
        const p = r.props;
        if (p) {
            const size = [0, 1, 2].map((a) => p.bounds.max[a] - p.bounds.min[a]);
            const inertia = scaleMat(p.inertia, k);
            lines.push(
                `  Mass: ${massText(p.volume * k)}`,
                `  Volume: ${n2(p.volume / 1000)} cm³ (${n2(p.volume)} mm³)`,
                `  Surface area: ${n2(p.area)} mm²`,
                `  Centre of mass (part frame): ${vec(p.centre)} mm`,
                `  Bounding box (part frame): ${size.map(n2).join(' x ')} mm, from ${vec(p.bounds.min)} to ${vec(p.bounds.max)}`,
                `  Principal moments at the centre of mass: ${p.principal.moments.map((m) => n2(m * k)).join(', ')} g·mm²`,
                ...p.principal.axes.map((a, i) => `    axis ${i + 1}: ${a.map((x) => n2(x)).join(', ')}`),
                `  Inertia tensor at the centre of mass (part axes): ${inertia.map((row) => `[${row.map(n2).join(', ')}]`).join(' ')} g·mm²`,
            );
            Object.assign(entry, {
                volume: sig(p.volume), area: sig(p.area), mass: sig(p.volume * k),
                centre: sigVec(p.centre), bounds: { min: sigVec(p.bounds.min), max: sigVec(p.bounds.max) },
                inertia: inertia.map(sigVec), principalMoments: sigVec(p.principal.moments.map((m) => m * k)),
                principalAxes: p.principal.axes.map(sigVec),
            });
        }
        (json.parts as unknown[]).push(entry);
    }
    const built = reports.filter((r) => r.props);
    const copies = built.reduce((s, r) => s + r.copies, 0);
    if (copies > 1) {
        const total = combineProps(built.map((r) => ({
            props: r.props!, placements: placements(parts.find((p) => p.id === r.id)!),
        })))!;
        const inertia = scaleMat(total.inertia, k);
        lines.push(
            '', `Total (${copies} bodies${built.length < reports.length ? `; ${reports.length - built.length} part(s) without a body left out` : ''})`,
            `  Mass: ${massText(total.volume * k)}`,
            `  Volume: ${n2(total.volume / 1000)} cm³ (${n2(total.volume)} mm³)`,
            `  Surface area: ${n2(total.area)} mm² (sum of the bodies)`,
            `  Centre of mass (world): ${vec(total.centre)} mm`,
            `  Principal moments at the centre of mass: ${total.principal.moments.map((m) => n2(m * k)).join(', ')} g·mm²`,
            `  Inertia tensor at the centre of mass (world axes): ${inertia.map((row) => `[${row.map(n2).join(', ')}]`).join(' ')} g·mm²`,
        );
        json.total = {
            bodies: copies, volume: sig(total.volume), area: sig(total.area), mass: sig(total.volume * k),
            centre: sigVec(total.centre), inertia: inertia.map(sigVec),
            principalMoments: sigVec(total.principal.moments.map((m) => m * k)), principalAxes: total.principal.axes.map(sigVec),
        };
    }
    return `${lines.join('\n')}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
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
            name: 'mass_properties',
            description: 'Mass properties of parts from the real CAD solid: mass, volume, surface area, centre of mass, '
                + 'bounding box and moments of inertia, per part and for all together (world frame, repeat copies '
                + 'included). density in g/cm³ (PLA 1.24 by default; PETG 1.27, ABS 1.04, aluminium 2.70, steel 7.85). '
                + 'Changes nothing.',
            schema: {
                partIds: z.array(z.string()).min(1).optional().describe('Only these parts (default: all)'),
                density: z.number().positive().max(30).optional().describe('g/cm³'),
            },
            run: async ({ partIds, density }: { partIds?: string[]; density?: number }) => {
                const project = store.get();
                const print = project.print ?? DEFAULT_PRINT;
                const ids = partIds ?? project.parts.map((p) => p.id);
                const unknown = ids.filter((id) => !project.parts.some((p) => p.id === id));
                if (unknown.length) {
                    throw new Error(`No part with id ${unknown.join(', ')}`);
                }
                if (ids.length === 0) {
                    throw new Error('The project has no parts');
                }
                const reports: PartReport[] = [];
                for (const id of ids) {
                    const part = project.parts.find((p) => p.id === id)!;
                    const copies = placements(part).length;
                    const { props, error } = await host.kernel.properties(effectivePart(part, project.parts), print,
                        combineContext(part, project.parts));
                    const note = !props
                        ? (error ? `it failed to build (${error}), so there is no body to measure` : 'it has no solid body yet (only sketches or references)')
                        : error ? `its history failed part way (${error}); figures are for the solid before that step` : undefined;
                    reports.push({ id, name: part.name, copies, props: props ?? undefined, ...(note ? { note } : {}) });
                }
                return { text: massReport(reports, project.parts, density ?? DEFAULT_DENSITY) };
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
