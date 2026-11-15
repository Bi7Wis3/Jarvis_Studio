import { DEFAULT_PRINT, effectivePart, partsAtTimeline, type MeshStatus, type Part, type Project } from '@jarvis/core';
import { viewPart } from '@jarvis/core/visibility';
import { CadBuildError, combineContext, meshKey, type CadKernel, type CombineContext, type MeshData } from './cad/kernel.js';
import { qualityKey, type MeshQuality } from './cad/meshQuality.js';

const MAX_ENCODED = 500;

/**
 * Wire format of /api/mesh2/:key, read by apps/web/src/meshes.ts: uint32 counts [positions, indices, edges], then
 * positions, normals, indices, edges, triFace (indices / 3 entries), segEdge (edges / 6 entries).
 */
function encode(mesh: MeshData): Buffer {
    const counts = new Uint32Array([mesh.positions.length, mesh.indices.length, mesh.edges.length]);
    return Buffer.concat([
        Buffer.from(counts.buffer),
        Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
        Buffer.from(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength),
        Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
        Buffer.from(mesh.edges.buffer, mesh.edges.byteOffset, mesh.edges.byteLength),
        Buffer.from(mesh.triFace.buffer, mesh.triFace.byteOffset, mesh.triFace.byteLength),
        Buffer.from(mesh.segEdge.buffer, mesh.segEdge.byteOffset, mesh.segEdge.byteLength),
    ]);
}

/**
 * Wire format of /api/mesh3/:key: uint32 counts [positions, indices, edges, faces, edge ordinals, cosmetic, json bytes],
 * then positions, normals, indices, edges, triFace (indices / 3), segEdge (edges / 6), faceBody (faces), edgeBody (edge
 * ordinals), cosmetic (line segment pairs), cosmeticBody (cosmetic / 6), and UTF-8 JSON { bodies } padded to 4 bytes.
 */
export function encodeMesh3(mesh: MeshData): Buffer {
    const faceBody = mesh.faceBody ?? new Uint32Array(0);
    const edgeBody = mesh.edgeBody ?? new Uint32Array(0);
    const cosmetic = mesh.cosmetic ?? new Float32Array(0);
    const cosmeticBody = mesh.cosmeticBody ?? new Uint32Array(cosmetic.length / 6);
    const json = Buffer.from(JSON.stringify({ bodies: mesh.bodies ?? [] }), 'utf8');
    const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const counts = new Uint32Array([mesh.positions.length, mesh.indices.length, mesh.edges.length, faceBody.length, edgeBody.length,
        cosmetic.length, padded.length]);
    const view = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    return Buffer.concat([
        view(counts), view(mesh.positions), view(mesh.normals), view(mesh.indices), view(mesh.edges), view(mesh.triFace), view(mesh.segEdge),
        view(faceBody), view(edgeBody), view(cosmetic), view(cosmeticBody), padded,
    ]);
}

/** The part as the view builds it: thread steps hidden in the view stay plain (visibility.ts). */
function shownPart(original: Part, parts: Part[], project: Project): Part {
    return viewPart(effectivePart(original, parts), original.instanceOf ?? original.id, project.view);
}

/**
 * Keeps real kernel meshes in step with the project: every time the model changes, parts whose geometry
 * changed are rebuilt, and browsers are told which mesh key each part now has.
 */
export class MeshService {
    private meshes = new Map<string, MeshData>();
    private encoded = new Map<string, Buffer>();
    private encoded3 = new Map<string, Buffer>();
    private status: MeshStatus = { keys: {}, errors: {} };
    private generation = 0;
    /** Keys whose mesh is only the partial solid up to a failed feature, with the error. */
    private failed = new Map<string, string>();
    /** Display quality of the meshes the view gets (Options > Display); exports always use fine. */
    private quality: MeshQuality = 'normal';

    constructor(private kernel: CadKernel, private changed: (status: MeshStatus) => void) {}

    getQuality(): MeshQuality {
        return this.quality;
    }

    /** Changes the display quality: every part shown is meshed again at it, and browsers get the new keys. */
    setQuality(quality: MeshQuality, project: Project): void {
        if (quality !== this.quality) {
            this.quality = quality;
            this.update(project);
        }
    }

    /** The key of a part's mesh at a quality (the view's when not given). */
    private key(part: Pick<Part, 'shape' | 'features'>, print: NonNullable<Project['print']>, context?: CombineContext,
        quality: MeshQuality = this.quality): string {
        return qualityKey(meshKey(part, print, context), quality);
    }

    current(): MeshStatus {
        return this.status;
    }

    /** Encoded mesh for the HTTP route, or null if unknown. */
    get(key: string): Buffer | null {
        let buffer = this.encoded.get(key) ?? null;
        const mesh = this.meshes.get(key);
        if (!buffer && mesh) {
            buffer = encode(mesh);
            this.encoded.set(key, buffer);
            if (this.encoded.size > MAX_ENCODED) {
                this.encoded.delete(this.encoded.keys().next().value!);
            }
        }
        return buffer;
    }

    /** Encoded mesh in the /api/mesh3 format (with its bodies and cosmetic thread marks), or null if unknown. */
    get3(key: string): Buffer | null {
        let buffer = this.encoded3.get(key) ?? null;
        const mesh = this.meshes.get(key);
        if (!buffer && mesh) {
            buffer = encodeMesh3(mesh);
            this.encoded3.set(key, buffer);
            if (this.encoded3.size > MAX_ENCODED) {
                this.encoded3.delete(this.encoded3.keys().next().value!);
            }
        }
        return buffer;
    }

    /** Kernel mesh of a part as it is now, with every thread modelled (at the view's quality unless given; exports ask for
     * fine); null if it is not built (yet). */
    meshFor(part: Part, project: Project, quality: MeshQuality = this.quality): MeshData | null {
        const context = combineContext(part, project.parts);
        return this.meshes.get(this.key(effectivePart(part, project.parts), project.print ?? DEFAULT_PRINT, context, quality)) ?? null;
    }

    /** Waits until every part of the project has a mesh (or an error) at a quality, for exports and checks. */
    async ready(project: Project, quality: MeshQuality = this.quality): Promise<void> {
        const print = project.print ?? DEFAULT_PRINT;
        await Promise.all(project.parts.map((part) => this.build(effectivePart(part, project.parts), print,
            combineContext(part, project.parts), quality).catch(() => undefined)));
    }

    update(project: Project): void {
        const generation = ++this.generation;
        const print = project.print ?? DEFAULT_PRINT;
        const keys: MeshStatus['keys'] = {};
        const errors: MeshStatus['errors'] = {};
        const pending: { part: Part; context?: CombineContext }[] = [];
        const shown = partsAtTimeline(project);
        // Instances build their source's design, so identical parts share one mesh. Combine steps key on the parts
        // they use (design and relative placement), so a change to those rebuilds the dependants too.
        for (const original of shown) {
            const part = shownPart(original, shown, project);
            const context = combineContext(original, shown);
            const key = this.key(part, print, context);
            if (this.meshes.has(key)) {
                keys[part.id] = key;
                const failure = this.failed.get(key);
                if (failure) {
                    errors[part.id] = failure;
                }
            } else {
                keys[part.id] = this.status.keys[part.id] ?? null;
                pending.push({ part, context });
            }
        }
        this.publish({ keys, errors });
        for (const { part, context } of pending) {
            this.build(part, print, context).then(
                (key) => {
                    if (generation === this.generation) {
                        this.publish({ keys: { ...this.status.keys, [part.id]: key }, errors: this.status.errors });
                    }
                },
                (error: unknown) => {
                    if (generation === this.generation) {
                        const reason = error instanceof Error ? error.message : String(error);
                        console.warn(`[cad] ${part.id}: ${reason}`);
                        const key = this.key(part, print, context);
                        const keys = this.meshes.has(key) ? { ...this.status.keys, [part.id]: key } : this.status.keys;
                        this.publish({ keys, errors: { ...this.status.errors, [part.id]: reason } });
                    }
                },
            );
        }
    }

    /** Mesh key a part of `project` builds to (instances share their source's design), without building it. */
    keyFor(part: Part, project: Project): string {
        const shown = partsAtTimeline(project);
        return this.key(shownPart(part, shown, project), project.print ?? DEFAULT_PRINT, combineContext(part, shown));
    }

    /**
     * Builds a part of a project that is not (yet) the real one, for tool previews. The mesh is served by key like
     * any other, but the published status is left alone. `key` is null when nothing could be built; a failed
     * feature still gives the partial solid with `error`.
     */
    async preview(part: Part, project: Project): Promise<{ key: string | null; error?: string; notes?: string[] }> {
        const shown = partsAtTimeline(project);
        const effective = shownPart(part, shown, project);
        const print = project.print ?? DEFAULT_PRINT;
        const context = combineContext(part, shown);
        try {
            const key = await this.build(effective, print, context);
            const failure = this.failed.get(key);
            const notes = this.meshes.get(key)?.notes;
            return { key, ...(failure ? { error: failure } : {}), ...(notes?.length ? { notes } : {}) };
        } catch (error) {
            const key = this.key(effective, print, context);
            return { key: this.meshes.has(key) ? key : null, error: error instanceof Error ? error.message : String(error) };
        }
    }

    private async build(part: Part, print: NonNullable<Project['print']>, context?: CombineContext,
        quality: MeshQuality = this.quality): Promise<string> {
        const key = this.key(part, print, context, quality);
        if (!this.meshes.has(key)) {
            try {
                this.remember(key, await this.kernel.mesh(part, print, context, quality));
            } catch (error) {
                // Show the solid up to the failing step, so a broken feature does not make the part vanish.
                if (error instanceof CadBuildError && error.partial) {
                    this.remember(key, error.partial);
                    this.failed.set(key, error.message);
                }
                throw error;
            }
        }
        return key;
    }

    private remember(key: string, mesh: MeshData): void {
        this.meshes.set(key, mesh);
        if (this.meshes.size > MAX_ENCODED) {
            this.meshes.delete(this.meshes.keys().next().value!);
        }
    }

    private publish(status: MeshStatus): void {
        // Where each part's reference steps found the model, from the mesh it shows now.
        const followed = Object.fromEntries(Object.entries(status.keys).flatMap(([id, key]) => {
            const found = key ? this.meshes.get(key)?.followed : undefined;
            return found ? [[id, found]] : [];
        }));
        this.status = Object.keys(followed).length ? { ...status, followed } : { keys: status.keys, errors: status.errors };
        this.changed(this.status);
    }
}
