// Brings a file into the open project (File > Import, the import_file tool): the original is kept as an asset, the
// CAD worker reads it and stores its bodies, then each part gets an Imported step (SolidWorks: Imported1, or
// STL Graphics1 for a graphics body) through the history tools, so it is one undoable change like any other.

import { z } from 'zod';
import type { Feature, Part, Project } from '@jarvis/core';
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions, type ImportStep } from '@jarvis/core/imported';
import { saveAsset } from '../assets.js';
import type { CadKernel } from '../cad/kernel.js';
import type { ProjectStore } from '../store.js';
import { createTools, type StudioTool } from '../tools.js';
import { readImportAsset, saveImportAsset } from './assets.js';
import type { ImportedPart, ImportJobResult } from './job.js';
import { extensionOf, importerFor, unsupported } from './registry.js';

export interface ImportRequest {
    filename: string;
    bytes: Uint8Array;
    options?: ImportOptions;
    /** 'new' (default): new part(s); else the id of the part the bodies are added to. */
    target?: string;
    /** The id of an Imported step of the target part to replace with this file (Edit feature). */
    replace?: string;
}

export interface ImportReport {
    text: string;
    warnings: string[];
    /** The parts made or changed, and the step ids added (or replaced). */
    parts: string[];
    steps: string[];
    result: ImportJobResult;
}

/** The colour new parts get when the file gives none (as File > New part). */
const DEFAULT_COLOR = '#9aa3b5';

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

/** SolidWorks names: Imported1 for solid bodies, STL Graphics1 for a graphics body alone. */
function stepName(features: readonly Pick<Feature, 'name'>[] | undefined, part: ImportedPart, format: string): string {
    const base = part.solids ? 'Imported' : `${format.toUpperCase()} Graphics`;
    let n = 0;
    for (const f of features ?? []) {
        const match = f.name?.startsWith(base) ? /^(\d+)$/.exec(f.name.slice(base.length)) : null;
        if (match) {
            n = Math.max(n, Number(match[1]));
        }
    }
    return `${base}${n + 1}`;
}

function stepOf(part: ImportedPart, file: ImportStep['file'], options: ImportOptions, name: string): ImportStep & { name: string } {
    return {
        op: 'import', name, file,
        ...(part.brep ? { brep: part.brep } : {}),
        ...(part.mesh ? { mesh: part.mesh } : {}),
        bodies: part.bodies,
        options,
    };
}

function describe(part: ImportedPart): string {
    const what = [
        part.solids ? `${plural(part.solids, 'solid body', 'solid bodies')} (${fmt(part.volume)} mm³)` : '',
        part.facets ? `a graphics body of ${plural(part.facets, 'facet')}` : '',
    ].filter(Boolean).join(' and ');
    const size = part.box ? `, ${[0, 1, 2].map((k) => fmt(part.box![1][k] - part.box![0][k])).join(' x ')} mm` : '';
    return `${what}${size}`;
}

function call(tools: StudioTool[], name: string, args: unknown): string {
    const tool = tools.find((t) => t.name === name)!;
    return tool.run(z.object(tool.schema).parse(args));
}

function uniqueName(project: Project, base: string): string {
    let name = base;
    for (let n = 2; project.parts.some((p) => p.name === name); n++) {
        name = `${base} ${n}`;
    }
    return name;
}

/** Only the options that apply to the file's format, with defaults filled in. */
export function effectiveOptions(filename: string, options: ImportOptions = {}): ImportOptions {
    const mesh = !!importerFor(filename)?.mesh;
    const all = { ...DEFAULT_IMPORT_OPTIONS, ...options };
    return {
        up: all.up, repair: all.repair, bodiesAsParts: all.bodiesAsParts,
        ...(mesh ? { meshAs: all.meshAs, unit: all.unit, ...(all.meshAs === 'solid' ? { groupFacets: all.groupFacets } : {}) } : { knit: all.knit }),
        ...(options.tolerance ? { tolerance: options.tolerance } : {}),
    };
}

/**
 * Reads the file and adds its bodies to the project. With `replace` and no bytes, the step's own original file is
 * read again (with new options).
 */
export async function importIntoProject(store: ProjectStore, kernel: CadKernel, request: ImportRequest): Promise<ImportReport> {
    const target = request.target && request.target !== 'new' ? store.get().parts.find((p) => p.id === request.target) : null;
    if (request.target && request.target !== 'new' && !target) {
        throw new Error(`No part with id "${request.target}"`);
    }
    if (target?.instanceOf) {
        throw new Error(`${target.name} is an instance of ${target.instanceOf}; import into ${target.instanceOf} instead`);
    }
    const found = request.replace ? target?.features?.find((f) => f.id === request.replace) : undefined;
    if (request.replace && found?.op !== 'import') {
        throw new Error(`${request.replace} is not an Imported step of ${target?.name ?? 'the part'}`);
    }
    const replacing = found?.op === 'import' ? found : undefined;
    const again = !!replacing && !request.bytes.length;
    const filename = again ? replacing!.file.name : request.filename;
    const bytes = again ? new Uint8Array(readImportAsset(replacing!.file.asset)) : request.bytes;
    const importer = importerFor(filename);
    if (!importer) {
        throw new Error(unsupported(filename));
    }
    if (!bytes.length) {
        throw new Error(`${filename} is empty`);
    }
    const options = effectiveOptions(filename, request.options);
    // Into one part, every body stays in that part.
    const job = { filename, bytes, options: target ? { ...options, bodiesAsParts: false } : options };
    const asset = saveImportAsset(bytes, extensionOf(filename) || importer.format);
    const result = await kernel.importFile(job);
    const thumbnail = result.thumbnail?.length ? saveAsset(Buffer.from(result.thumbnail), 'image/png') : undefined;
    const file: ImportStep['file'] = { name: filename, format: result.format, asset, ...(thumbnail ? { thumbnail } : {}) };
    const tools = createTools(store);
    const project = store.get();
    const steps: string[] = [];
    let parts: string[] = [];
    if (replacing && target) {
        const [first] = result.parts;
        // A name the studio gave (Imported1, STL Graphics1) follows what the step now holds; one given by hand stays.
        const others = target.features?.filter((f) => f.id !== replacing.id);
        const fresh = stepName(others, first, result.format);
        const given = replacing.name && !/^(Imported|[A-Z0-9]+ Graphics)\d+$/.test(replacing.name);
        const sameKind = replacing.name?.replace(/\d+$/, '') === fresh.replace(/\d+$/, '');
        const step = stepOf(first, file, job.options, replacing.name && (given || sameKind) ? replacing.name : fresh);
        call(tools, 'features_update', {
            partId: target.id,
            updates: [{
                id: replacing.id, name: step.name, file: step.file, brep: step.brep ?? null, mesh: step.mesh ?? null, bodies: step.bodies ?? null,
                options: step.options,
            }],
        });
        parts = [target.id];
        steps.push(replacing.id);
    } else if (target) {
        const [first] = result.parts;
        const answer = call(tools, 'features_add', { partId: target.id, features: [stepOf(first, file, job.options, stepName(target.features, first, result.format))] });
        parts = [target.id];
        steps.push(...(/: ([^:]+)\.$/.exec(answer)?.[1]?.split(', ') ?? []));
    } else {
        const base = filename.replace(/\.[^.]+$/, '').trim() || 'Imported part';
        const draft: Project = { ...project, parts: [...project.parts] };
        const specs = result.parts.map((part, i) => {
            const own = result.parts.length > 1 ? part.bodies[0]?.name ?? `${base} ${i + 1}` : part.bodies[0]?.name && part.bodies.length === 1 ? part.bodies[0].name : base;
            const name = uniqueName(draft, own);
            draft.parts.push({ name } as Part);
            const color = part.bodies.find((b) => b.color)?.color ?? DEFAULT_COLOR;
            return {
                name, shape: { kind: 'empty' }, position: [0, 0, 0], material: { color, metalness: 0, roughness: 0.6 },
                features: [stepOf(part, file, job.options, stepName([], part, result.format))],
            };
        });
        const answer = call(tools, 'parts_add', { parts: specs });
        parts = /: (.+)\.$/.exec(answer)?.[1]?.split(', ') ?? [];
        for (const id of parts) {
            const step = store.get().parts.find((p) => p.id === id)?.features?.[0];
            if (step) {
                steps.push(step.id);
            }
        }
    }
    if (result.parts.some((p) => p.solids > 1)) {
        // The kernel's fillet, chamfer, shell and draft work on a part of one solid only.
        result.warnings.push('Fillets, chamfers, shells and drafts need a part with a single solid body: import with '
            + '"Import multiple bodies as parts" to work on these bodies one by one');
    }
    const names = parts.map((id) => store.get().parts.find((p) => p.id === id)?.name ?? id);
    const lines = result.parts.map((part, i) => `${names[i] ?? names[0]}: ${describe(part)}`);
    const verb = again ? `Read ${filename} again for ${replacing!.name ?? replacing!.id}`
        : replacing ? `Replaced ${replacing.name ?? replacing.id} with ${filename}` : `Imported ${filename}`;
    const text = [`${verb} (${result.format.toUpperCase()}${result.up === 'z' ? ', Z up turned to Y up' : ''}).`, ...lines,
        ...result.warnings.map((w) => `Note: ${w}.`)].join('\n');
    return { text, warnings: result.warnings, parts, steps, result };
}
