// File > Import of a .jarvis-sw.json (tools/solidworks/JarvisHistoryExport.vbs): a SolidWorks part becomes a part with
// its own sketches and features (features.ts); where a feature cannot be rebuilt, or rebuilds differently from
// SolidWorks, the part continues from SolidWorks' own body read from the SLDPRT next to the JSON (an Imported step
// that replaces the body). The rebuilt part is then measured against SolidWorks' mass properties. An assembly becomes
// one part per component, placed as SolidWorks had it, a part used several times as instances of one part.

import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Euler, Matrix4 } from 'three';
import { z } from 'zod';
import { DEFAULT_PRINT, type Feature, type FeatureFolder, type Part, type Project, type Vec3 } from '@jarvis/core';
import type { ImportedMates, ImportStep } from '@jarvis/core/imported';
import type { CadKernel, MassProps } from '../../cad/kernel.js';
import type { ProjectStore } from '../../store.js';
import { createTools, type StudioTool } from '../../tools.js';
import { saveImportAsset } from '../assets.js';
import type { ImportJobResult } from '../job.js';
import type { ImportReport, ImportRequest } from '../project.js';
import { parseSwDocument, SW_HISTORY_SUFFIX, type SwBox, type SwComponent, type SwDocument, type SwMass } from './format.js';
import { mapPart, type MappedPart, type Skipped } from './features.js';
import { clean, MM, mm, rigidOf, type Convention } from './math.js';

type Kernel = Pick<CadKernel, 'properties' | 'importFile'>;

const DEFAULT_COLOR = '#9aa3b5';
/** Volumes agree when within this share of SolidWorks' (0.001 %). */
const VOLUME_TOLERANCE = 1e-5;
/** At most this many builds to find where a rebuild first differs. */
const MAX_PROBES = 120;

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const fmt = (v: number, digits = 3): string => String(Math.round(v * 10 ** digits) / 10 ** digits);
const percent = (diff: number): string => `${fmt(diff * 100, Math.abs(diff) < 1e-4 ? 6 : 4)} %`;

// ---- Files next to the JSON -----------------------------------------------------------------------------------

/** A file in `dir` by name, matching its case loosely (Windows names; Linux disk). */
async function findIn(dir: string, name: string): Promise<string | null> {
    const direct = join(dir, name);
    if (existsSync(direct)) return direct;
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    return hit ? join(dir, hit) : null;
}

/** The SolidWorks file a .jarvis-sw.json describes, next to it. */
async function sourceFile(jsonPath: string | undefined, doc: SwDocument, jsonName: string): Promise<string | null> {
    if (!jsonPath) return null;
    const dir = dirname(jsonPath);
    const fromDoc = doc.document?.file ? await findIn(dir, basename(doc.document.file.replace(/\\/g, '/'))) : null;
    if (fromDoc) return fromDoc;
    const base = jsonName.slice(0, -SW_HISTORY_SUFFIX.length);
    return await findIn(dir, `${base}.SLDPRT`);
}

// ---- Building and measuring -----------------------------------------------------------------------------------

async function measure(kernel: Kernel, features: Feature[]): Promise<{ props: MassProps | null; error?: string }> {
    return kernel.properties({ shape: { kind: 'empty' }, features }, DEFAULT_PRINT);
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(Math.abs(b) * VOLUME_TOLERANCE, 1e-6);

export interface CheckResult {
    /** mm³ */
    volume: number | null;
    swVolume: number | null;
    box: { min: Vec3; max: Vec3 } | null;
    lines: string[];
    matches: boolean;
}

/** The rebuilt part against SolidWorks' volume and box. */
export function compare(props: MassProps | null, mass: SwMass | null, box: SwBox | null, tessBox: SwBox | null | undefined, what = 'The rebuilt part'): CheckResult {
    const lines: string[] = [];
    const swVolume = typeof mass?.volume === 'number' ? mass.volume * 1e9 : null;
    const volume = props?.volume ?? null;
    let matches = true;
    if (volume === null) {
        lines.push(`${what} has no solid to measure.`);
        matches = false;
    } else if (swVolume === null) {
        lines.push(`${what}: volume ${fmt(volume)} mm³ (the export holds no SolidWorks volume to compare with).`);
    } else {
        const diff = (volume - swVolume) / swVolume;
        if (close(volume, swVolume)) {
            lines.push(`Volume matches SolidWorks to 0.001 %: ${fmt(volume)} mm³ (SolidWorks ${fmt(swVolume)} mm³, difference ${percent(diff)}).`);
        } else {
            matches = false;
            lines.push(`Volume differs from SolidWorks: ${fmt(volume)} mm³ against ${fmt(swVolume)} mm³ (${diff > 0 ? '+' : ''}${percent(diff)}).`);
        }
    }
    if (props && (box || tessBox)) {
        // SolidWorks' own box encloses the solid (loosely); the box of its display triangles lies inside it.
        const outer = box ? { min: mm(box.min), max: mm(box.max) } : null;
        const inner = tessBox ? { min: mm(tessBox.min), max: mm(tessBox.max) } : null;
        const tol = 1e-3;
        let worst = 0;
        for (let k = 0; k < 3; k++) {
            const lo = props.bounds.min[k];
            const hi = props.bounds.max[k];
            const loOk = (!outer || lo >= outer.min[k] - tol) && (!inner || lo <= inner.min[k] + tol);
            const hiOk = (!outer || hi <= outer.max[k] + tol) && (!inner || hi >= inner.max[k] - tol);
            const ref = inner ?? outer!;
            if (!loOk) worst = Math.max(worst, Math.abs(lo - ref.min[k]));
            if (!hiOk) worst = Math.max(worst, Math.abs(hi - ref.max[k]));
        }
        const size = [0, 1, 2].map((k) => fmt(props.bounds.max[k] - props.bounds.min[k])).join(' x ');
        if (worst === 0) {
            lines.push(`Bounding box ${size} mm matches SolidWorks'.`);
        } else {
            matches = false;
            lines.push(`Bounding box ${size} mm differs from SolidWorks' by up to ${fmt(worst, 4)} mm.`);
        }
    }
    return { volume, swVolume, box: props?.bounds ?? null, lines, matches };
}

/** The studio feature a build error names (`feature "Name" (op): ...`). */
function failingFeature(error: string, features: Feature[]): number {
    const name = /^feature "(.+?)" \(\w+\)/.exec(error)?.[1];
    if (!name) return -1;
    return features.findIndex((f) => (f.name ?? f.id) === name || f.id === name);
}

interface Plan {
    features: Feature[];
    stop: Skipped | null;
    /** SolidWorks features after the stop (they are in its body). */
    after: Skipped[];
    /** What the per-feature comparison found. */
    lines: string[];
}

/**
 * Builds the mapped history, and finds where it first fails or first differs from SolidWorks (by the volume SolidWorks
 * measured after each feature). With `cut`, the history ends there.
 */
async function settle(kernel: Kernel, mapped: MappedPart, cut: boolean): Promise<Plan> {
    const lines: string[] = [];
    let features = mapped.features;
    let stop = mapped.stop;
    let after = [...mapped.after];
    const stopAt = (index: number, why: string): void => {
        const id = features[index]?.id;
        const owner = mapped.origins.find((o) => o.ids.includes(id));
        const first = owner ? features.findIndex((f) => owner.ids.includes(f.id)) : index;
        const later = mapped.origins.slice(owner ? mapped.origins.indexOf(owner) + 1 : 0)
            .filter((o) => o.ids.some((i) => features.findIndex((f) => f.id === i) > first))
            .map((o) => ({ name: o.name, type: o.type, why: 'in the SolidWorks body' }));
        const newStop = { name: owner?.name ?? features[index]?.name ?? '?', type: owner?.type ?? features[index]?.op ?? '?', why };
        after = [...later, ...(stop ? [stop, ...after] : after)];
        stop = newStop;
        features = features.slice(0, first);
    };
    const full = await measure(kernel, features);
    if (full.error) {
        const index = failingFeature(full.error, features);
        if (index >= 0) {
            const why = `the studio could not build it (${full.error.replace(/^feature "(.+?)" \(\w+\): /, '')})`;
            if (cut) stopAt(index, why);
            else lines.push(`${features[index].name}: ${why}.`);
        } else {
            lines.push(`The rebuild failed: ${full.error}.`);
        }
    }
    // SolidWorks' volume after each feature: the first that differs is where the rebuild goes wrong.
    const solid = mapped.origins.filter((o) => o.ids.length && !o.suppressed && typeof o.after?.volume === 'number');
    let probes = 0;
    for (const origin of solid) {
        const last = Math.max(...origin.ids.map((id) => features.findIndex((f) => f.id === id)));
        if (last < 0) continue;
        if (++probes > MAX_PROBES) break;
        const props = await measure(kernel, features.slice(0, last + 1));
        const want = origin.after!.volume! * 1e9;
        const got = props.props?.volume ?? 0;
        if (props.error || !close(got, want)) {
            const diff = want ? (got - want) / want : 0;
            const why = props.error
                ? `the studio could not build it (${props.error.replace(/^feature "(.+?)" \(\w+\): /, '')})`
                : `rebuilt, the volume after it is ${fmt(got)} mm³ where SolidWorks has ${fmt(want)} mm³ (${diff > 0 ? '+' : ''}${percent(diff)})`;
            if (cut) {
                stopAt(features.findIndex((f) => f.id === origin.ids[0]), why);
            } else {
                lines.push(`First difference from SolidWorks at ${origin.name}: ${why}.`);
            }
            break;
        }
    }
    if (probes && !lines.length) {
        lines.push(probes === 1 ? 'The volume after the rebuilt feature matches SolidWorks\'.' : `The volume after each of ${probes} rebuilt features matches SolidWorks'.`);
    }
    return { features, stop, after, lines };
}

// ---- One part ---------------------------------------------------------------------------------------------------

interface BuiltPart {
    name: string;
    features: Feature[];
    folders: FeatureFolder[];
    lines: string[];
    warnings: string[];
    check: CheckResult;
    props: MassProps | null;
    rebuilt: number;
    convention: Convention;
}

/** The SolidWorks body of the SLDPRT as an Imported step that replaces the body built so far. */
async function solidWorksBody(kernel: Kernel, file: string, name: string): Promise<ImportStep & { name: string }> {
    const bytes = new Uint8Array(await fs.readFile(file));
    const filename = basename(file);
    const result: ImportJobResult = await kernel.importFile({ filename, bytes, options: { up: 'y' } });
    const [part] = result.parts;
    if (!part?.brep) {
        throw new Error(`${filename} holds no solid the studio could read`);
    }
    const asset = saveImportAsset(bytes, 'sldprt');
    return {
        op: 'import', name, file: { name: filename, format: 'sldprt', asset }, brep: part.brep, bodies: part.bodies,
        options: { up: 'y' }, replaceBody: true,
    };
}

const freeId = (features: Feature[], base: string): string => {
    let id = base;
    for (let n = 2; features.some((f) => f.id === id); n++) id = `${base}-${n}`;
    return id;
};

const describeSkip = (s: Skipped): string => `${s.name} (${s.type}): ${s.why}`;

async function buildPart(kernel: Kernel, doc: SwDocument, jsonPath: string | undefined, jsonName: string): Promise<BuiltPart> {
    const mapped = mapPart(doc);
    const source = await sourceFile(jsonPath, doc, jsonName);
    const plan = await settle(kernel, mapped, !!source);
    const lines: string[] = [];
    const warnings: string[] = [];
    let features = plan.features;
    const rebuilt = mapped.origins.filter((o) => o.ids.length && features.some((f) => o.ids.includes(f.id))).length;
    if (plan.stop) {
        lines.push(`Rebuilt as studio features up to ${plan.stop.name}: ${plural(rebuilt, 'SolidWorks feature')} (sketches and planes included).`);
        lines.push(`${describeSkip(plan.stop)}.`);
        if (source) {
            try {
                const step = await solidWorksBody(kernel, source, 'Imported1');
                features = [...features, { ...step, id: freeId(features, 'imported1') }];
                lines.push(`From ${plan.stop.name} on, the part continues with SolidWorks' own body (Imported1, read from ${basename(source)}).`);
            } catch (error) {
                warnings.push(`SolidWorks' body could not be read from ${basename(source)}: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else {
            warnings.push(`The features from ${plan.stop.name} on are missing: ${jsonPath ? `${doc.document.file} was not found next to the JSON`
                : 'pick the .jarvis-sw.json in the Import form\'s file browser so the SLDPRT next to it can be read'}`);
        }
        if (plan.after.length) {
            const solid = plan.after.filter((s) => s.why === 'in the SolidWorks body').map((s) => s.name);
            if (solid.length) lines.push(`In SolidWorks' body, not as studio features: ${solid.join(', ')}.`);
        }
    } else {
        lines.push(`Rebuilt as studio features: ${plural(rebuilt, 'SolidWorks feature')} (sketches and planes included).`);
    }
    if (mapped.skipped.length) {
        lines.push(`Not brought across (they change no solid): ${mapped.skipped.map(describeSkip).join('; ')}.`);
    }
    const final = await measure(kernel, features);
    if (final.error) {
        warnings.push(`The part does not build completely: ${final.error}`);
    }
    const check = compare(final.props, doc.mass, doc.box, doc.tessBox);
    lines.push(...check.lines, ...plan.lines);
    const votes = mapped.votes;
    if (votes.some((v) => v === 'disagree')) {
        lines.push(`Extrude directions: the faces SolidWorks made disagreed with the rule in ${votes.filter((v) => v === 'disagree').length} of ${votes.length} (the faces were followed).`);
    }
    for (const note of mapped.notes) lines.push(`Note: ${note}.`);
    const kept = new Set(features.map((f) => f.id));
    const folders = mapped.folders.map((f) => ({ ...f, items: f.items.filter((i) => kept.has(i) || mapped.folders.some((g) => g.id === i)) }))
        .filter((f) => f.items.length);
    const name = (doc.document.file || jsonName).replace(/\.(sldprt|sldasm)$/i, '').replace(/\.jarvis-sw\.json$/i, '');
    return { name, features, folders, lines, warnings, check, props: final.props, rebuilt, convention: mapped.convention };
}

// ---- Into the project -----------------------------------------------------------------------------------------

function call(tools: StudioTool[], name: string, args: unknown): string {
    const tool = tools.find((t) => t.name === name)!;
    return tool.run(z.object(tool.schema).parse(args));
}

function uniqueName(names: Set<string>, base: string): string {
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
    names.add(name);
    return name;
}

const emptyResult = (warnings: string[]): ImportJobResult => ({ format: 'swhistory', parts: [], warnings, up: 'y' });

/** Imports a .jarvis-sw.json (a part or an assembly) as new parts. */
export async function importSwHistory(store: ProjectStore, kernel: Kernel, request: ImportRequest): Promise<ImportReport> {
    const doc = parseSwDocument(request.bytes);
    if (request.target && request.target !== 'new') {
        throw new Error('A SolidWorks history comes in as new parts: choose "A new part"');
    }
    return doc.kind === 'assembly'
        ? importAssembly(store, kernel, doc, request)
        : importPart(store, kernel, doc, request);
}

async function importPart(store: ProjectStore, kernel: Kernel, doc: SwDocument, request: ImportRequest): Promise<ImportReport> {
    const built = await buildPart(kernel, doc, request.path, request.filename);
    const names = new Set(store.get().parts.map((p) => p.name));
    const name = uniqueName(names, built.name);
    const tools = createTools(store);
    const answer = call(tools, 'parts_add', {
        parts: [{
            name, shape: { kind: 'empty' }, position: [0, 0, 0], material: { color: DEFAULT_COLOR, metalness: 0, roughness: 0.6 },
            features: built.features, ...(built.folders.length ? { folders: built.folders } : {}),
        }],
    });
    const parts = /: (.+)\.$/.exec(answer)?.[1]?.split(', ') ?? [];
    const steps = store.get().parts.find((p) => p.id === parts[0])?.features?.map((f) => f.id) ?? [];
    const text = [
        `Imported ${request.filename} (SolidWorks ${doc.exporter?.solidworks ?? ''} history of ${doc.document.file}) as the part ${name}.`.replace('  ', ' '),
        ...built.lines,
        ...built.warnings.map((w) => `Note: ${w}.`),
    ].join('\n');
    return { text, warnings: built.warnings, parts, steps, result: emptyResult(built.warnings) };
}

// ---- Assemblies -----------------------------------------------------------------------------------------------

interface Placed {
    component: SwComponent;
    /** Subassemblies it sits in, outermost first. */
    within: string[];
}

/** The part components of an assembly, subassemblies flattened (their components' transforms are the root's already). */
function flatten(components: SwComponent[], within: string[] = [], out: Placed[] = []): Placed[] {
    for (const c of components) {
        if (c.suppressed || c.suppression === 0) continue;
        if (/\.sldasm$/i.test(c.file) || c.children?.length) {
            flatten(c.children ?? [], [...within, c.name], out);
        } else {
            out.push({ component: c, within });
        }
    }
    return out;
}

/** Position and XYZ Euler rotation (degrees) of a component transform, as Part.position and Part.rotation apply them. */
export function placementOf(transform: number[] | null | undefined, convention: Convention = 'rows'): { position: Vec3; rotation: Vec3 } {
    const x = rigidOf(transform, convention);
    if (!x) return { position: [0, 0, 0], rotation: [0, 0, 0] };
    const m = new Matrix4().set(
        x.r[0][0], x.r[0][1], x.r[0][2], 0,
        x.r[1][0], x.r[1][1], x.r[1][2], 0,
        x.r[2][0], x.r[2][1], x.r[2][2], 0,
        0, 0, 0, 1,
    );
    const e = new Euler().setFromRotationMatrix(m, 'XYZ');
    return { position: x.t.map(clean) as Vec3, rotation: [e.x, e.y, e.z].map((r) => clean((r * 180) / Math.PI)) as Vec3 };
}

async function resolveComponent(dir: string | null, c: SwComponent): Promise<string | null> {
    if (!dir) return null;
    const rel = c.file.replace(/\\/g, '/');
    if (!/^[a-z]:\//i.test(rel) && !rel.startsWith('//')) {
        const direct = join(dir, rel);
        if (existsSync(direct)) return direct;
        const nested = await findIn(dirname(direct), basename(rel));
        if (nested) return nested;
    }
    return findIn(dir, basename(rel));
}

/** A component's .jarvis-sw.json: next to its SLDPRT, or where the assembly says the SLDPRT is. */
async function componentJson(dir: string, c: SwComponent, file: string | null): Promise<string | null> {
    const rel = c.file.replace(/\\/g, '/');
    const name = `${basename(file ?? rel).replace(/\.sldprt$/i, '')}${SW_HISTORY_SUFFIX}`;
    if (file) return findIn(dirname(file), name);
    if (!/^[a-z]:\//i.test(rel) && !rel.startsWith('//')) {
        const near = await findIn(dirname(join(dir, rel)), name);
        if (near) return near;
    }
    return findIn(dir, name);
}

async function importAssembly(store: ProjectStore, kernel: Kernel, doc: SwDocument, request: ImportRequest): Promise<ImportReport> {
    const dir = request.path ? dirname(request.path) : null;
    if (!dir) {
        throw new Error('An assembly needs the files next to it: pick the .jarvis-sw.json in the Import form\'s file browser instead of dropping it');
    }
    const placed = flatten(doc.components ?? []);
    if (!placed.length) {
        throw new Error(`${doc.document.file} has no part components to import`);
    }
    const lines: string[] = [];
    const warnings: string[] = [];
    // One studio part per SolidWorks file (and configuration); further uses are instances of it.
    const designs = new Map<string, { built: BuiltPart | null; file: string | null; count: number }>();
    const keyOf = (c: SwComponent, file: string | null) => `${(file ?? c.file).toLowerCase()}|${c.configuration ?? ''}`;
    const files = new Map<Placed, string | null>();
    for (const p of placed) {
        const file = await resolveComponent(dir, p.component);
        files.set(p, file);
        const key = keyOf(p.component, file);
        const known = designs.get(key);
        if (known) {
            known.count++;
            continue;
        }
        let built: BuiltPart | null = null;
        const json = await componentJson(dir, p.component, file);
        if (file || json) {
            try {
                if (json) {
                    const partDoc = parseSwDocument(new Uint8Array(await fs.readFile(json)));
                    built = await buildPart(kernel, partDoc, json, basename(json));
                } else if (file) {
                    const step = await solidWorksBody(kernel, file, 'Imported1');
                    const props = (await measure(kernel, [{ ...step, id: 'imported1' }])).props;
                    built = {
                        name: basename(file).replace(/\.sldprt$/i, ''), features: [{ ...step, replaceBody: undefined, id: 'imported1' }], folders: [],
                        lines: [`No ${SW_HISTORY_SUFFIX} next to it: SolidWorks' solid only.`], warnings: [], check: compare(props, null, null, null), props, rebuilt: 0, convention: 'rows',
                    };
                }
            } catch (error) {
                warnings.push(`${p.component.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else {
            warnings.push(`${p.component.name}: ${p.component.file} was not found next to the assembly`);
        }
        designs.set(key, { built, file, count: 1 });
    }

    // The transform layout the parts' standard planes showed (assemblies have no planes of their own in the export).
    const convention: Convention = [...designs.values()].find((d) => d.built?.rebuilt)?.built?.convention ?? 'rows';
    // Parts: the first use of each design carries it; the others are instances.
    const names = new Set(store.get().parts.map((p) => p.name));
    const specs: Record<string, unknown>[] = [];
    const sourceOf = new Map<string, number>();
    const instanceOf = new Map<number, number>();
    const componentOfSpec: string[] = [];
    for (const p of placed) {
        const key = keyOf(p.component, files.get(p) ?? null);
        const design = designs.get(key);
        if (!design?.built) continue;
        const { position, rotation } = placementOf(p.component.transform, convention);
        const name = uniqueName(names, p.component.name);
        const index = specs.length;
        const first = sourceOf.get(key);
        if (first === undefined) {
            sourceOf.set(key, index);
            specs.push({
                name, shape: { kind: 'empty' }, position, rotation, material: { color: DEFAULT_COLOR, metalness: 0, roughness: 0.6 },
                features: design.built.features, ...(design.built.folders.length ? { folders: design.built.folders } : {}),
                ...(p.within.length ? { description: `In SolidWorks inside ${p.within.join(' / ')}` } : {}),
            });
        } else {
            instanceOf.set(index, first);
            specs.push({ name, shape: { kind: 'empty' }, position, rotation, material: { color: DEFAULT_COLOR, metalness: 0, roughness: 0.6 } });
        }
        componentOfSpec.push(p.component.name);
    }
    if (!specs.length) {
        throw new Error(`none of the parts of ${doc.document.file} could be read${warnings.length ? `: ${warnings.join('; ')}` : ''}`);
    }
    const tools = createTools(store);
    const answer = call(tools, 'parts_add', { parts: specs });
    const parts = /: (.+)\.$/.exec(answer)?.[1]?.split(', ') ?? [];
    const components: Record<string, string> = {};
    componentOfSpec.forEach((c, i) => {
        if (parts[i]) components[c] = parts[i];
    });
    const mates: ImportedMates = {
        assembly: doc.document.file, source: request.filename, components, mates: doc.mates ?? [],
    };
    // Instances and the mates belong to the same change as the parts (one undo).
    store.mutate((draft: Project) => {
        for (const [index, first] of instanceOf) {
            const part = draft.parts.find((p: Part) => p.id === parts[index]);
            if (part && parts[first]) {
                part.instanceOf = parts[first];
                delete part.features;
            }
        }
        draft.importedMates = [...(draft.importedMates ?? []), mates];
    }, { undoable: false });

    // Check: every component's volume, and the box of all of them, against SolidWorks' assembly.
    let total = 0;
    let missing = 0;
    for (const p of placed) {
        const design = designs.get(keyOf(p.component, files.get(p) ?? null));
        if (design?.built?.props) total += design.built.props.volume;
        else missing++;
    }
    lines.push(`Imported ${request.filename} (SolidWorks assembly ${doc.document.file}): ${plural(specs.length, 'component')} as ${plural(specs.length - instanceOf.size, 'part')}`
        + `${instanceOf.size ? ` and ${plural(instanceOf.size, 'instance')}` : ''}, placed as in SolidWorks.`);
    const flattened = placed.filter((p) => p.within.length).length;
    if (flattened) lines.push(`${plural(flattened, 'component')} inside subassemblies were brought to the top level (the subassembly is named in each part's description).`);
    const swVolume = typeof doc.mass?.volume === 'number' ? doc.mass.volume * 1e9 : null;
    if (swVolume !== null) {
        const diff = swVolume ? (total - swVolume) / swVolume : 0;
        lines.push(close(total, swVolume)
            ? `Total volume matches SolidWorks to 0.001 %: ${fmt(total)} mm³.`
            : `Total volume ${fmt(total)} mm³ differs from SolidWorks' ${fmt(swVolume)} mm³ (${diff > 0 ? '+' : ''}${percent(diff)})${missing ? `; ${missing} components could not be read` : ''}.`);
    }
    const box = assemblyBox(placed, designs, files, keyOf, convention);
    if (box && doc.box) {
        const sw = { min: mm(doc.box.min), max: mm(doc.box.max) };
        const worst = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(box.min[k] - sw.min[k]), Math.abs(box.max[k] - sw.max[k])]));
        lines.push(`Bounding box ${[0, 1, 2].map((k) => fmt(box.max[k] - box.min[k])).join(' x ')} mm; SolidWorks' (an approximate box for assemblies) differs by up to ${fmt(worst, 4)} mm.`);
    }
    const mateTypes = new Map<string, number>();
    for (const m of doc.mates ?? []) {
        const t = MATE_NAMES[m.type ?? -1] ?? `type ${m.type}`;
        mateTypes.set(t, (mateTypes.get(t) ?? 0) + 1);
    }
    if (doc.mates?.length) {
        lines.push(`${plural(doc.mates.length, 'mate')} kept with the project for when the studio has mates (${[...mateTypes.entries()].map(([t, n]) => `${n} ${t}`).join(', ')}); the parts are fixed where SolidWorks placed them.`);
    }
    for (const [key, design] of designs) {
        if (!design.built) continue;
        const name = design.built.name;
        lines.push(`${name}${design.count > 1 ? ` (used ${design.count} times, as one part and its instances)` : ''}:`);
        lines.push(...design.built.lines.map((l) => `  ${l}`));
        warnings.push(...design.built.warnings.map((w) => `${name}: ${w}`));
        void key;
    }
    const text = [...lines, ...warnings.map((w) => `Note: ${w}.`)].join('\n');
    return { text, warnings, parts, steps: [], result: emptyResult(warnings) };
}

const MATE_NAMES: Record<number, string> = {
    0: 'coincident', 1: 'concentric', 2: 'perpendicular', 3: 'parallel', 4: 'tangent', 5: 'distance', 6: 'angle', 7: 'unknown',
    8: 'symmetric', 9: 'cam follower', 10: 'gear', 11: 'width', 12: 'lock to sketch', 13: 'rack and pinion', 15: 'path',
    16: 'lock', 17: 'screw', 18: 'linear coupler', 19: 'universal joint', 20: 'coordinate', 21: 'slot', 22: 'hinge', 23: 'slider',
    24: 'profile centre',
};

function assemblyBox(placed: Placed[], designs: Map<string, { built: BuiltPart | null }>, files: Map<Placed, string | null>,
    keyOf: (c: SwComponent, file: string | null) => string, convention: Convention): { min: Vec3; max: Vec3 } | null {
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const p of placed) {
        const b = designs.get(keyOf(p.component, files.get(p) ?? null))?.built?.props?.bounds;
        const x = rigidOf(p.component.transform, convention);
        if (!b || !x) continue;
        for (const cx of [b.min[0], b.max[0]]) {
            for (const cy of [b.min[1], b.max[1]]) {
                for (const cz of [b.min[2], b.max[2]]) {
                    const q: Vec3 = [0, 1, 2].map((k) => x.r[k][0] * cx + x.r[k][1] * cy + x.r[k][2] * cz + x.t[k]) as Vec3;
                    min = min ? min.map((v, k) => Math.min(v, q[k])) as Vec3 : [...q];
                    max = max ? max.map((v, k) => Math.max(v, q[k])) as Vec3 : [...q];
                }
            }
        }
    }
    return min && max ? { min, max } : null;
}

