// Tool previews: run a form's tool calls on a scratch copy of the project and build the parts they change, so the
// browser can show the result before it is applied. Nothing here touches the real project, its file or its undo.

import { z } from 'zod';
import { partsAtTimeline, type Part, type Project } from '@jarvis/core';
import type { MeshService } from './meshes.js';
import { ProjectStore } from './store.js';
import { createTools } from './tools.js';

/** Model-editing tools a preview may run. Everything else (files, exports, undo, view) is refused. */
export const PREVIEW_TOOLS: ReadonlySet<string> = new Set([
    'parts_add', 'parts_instance', 'parts_update', 'features_add', 'features_update', 'features_reorder',
]);

const MAX_CALLS = 20;

export interface PreviewCall {
    name: string;
    args: Record<string, unknown>;
}

export interface PreviewResult {
    /** Parts that are new or changed, as they would be. */
    parts: Part[];
    keys: Record<string, string>;
    errors: Record<string, string>;
    /** A tool call that failed (validation, a missing part): nothing is previewed. */
    error?: string;
}

/** A request that is not a preview: an unknown or disallowed tool, or a malformed body. */
export class PreviewRejected extends Error {}

function parseCalls(input: unknown): PreviewCall[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CALLS) {
        throw new PreviewRejected(`Expected 1 to ${MAX_CALLS} tool calls.`);
    }
    return input.map((call) => {
        const { name, args } = (call ?? {}) as { name?: unknown; args?: unknown };
        if (typeof name !== 'string' || !PREVIEW_TOOLS.has(name)) {
            throw new PreviewRejected(`"${String(name)}" cannot be previewed.`);
        }
        if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
            throw new PreviewRejected(`Arguments of ${name} must be an object.`);
        }
        return { name, args: (args ?? {}) as Record<string, unknown> };
    });
}

/** Runs `calls` against a copy of `project` and builds the meshes of the parts they change. */
export async function runPreview(
    project: Project,
    input: unknown,
    meshes: Pick<MeshService, 'preview' | 'keyFor'>,
): Promise<PreviewResult> {
    const calls = parseCalls(input);
    const scratch = ProjectStore.scratch(project);
    const tools = createTools(scratch);
    for (const call of calls) {
        const tool = tools.find((t) => t.name === call.name)!;
        const parsed = z.object(tool.schema).safeParse(call.args);
        if (!parsed.success) {
            return { parts: [], keys: {}, errors: {}, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
        }
        try {
            tool.run(parsed.data);
        } catch (e) {
            return { parts: [], keys: {}, errors: {}, error: e instanceof Error ? e.message : String(e) };
        }
    }

    const next = scratch.get();
    const before = new Map(partsAtTimeline(project).map((p) => [p.id, p]));
    // Changed: the part itself, or the design it builds (an instance of a changed part, a combine that uses one).
    const changed = partsAtTimeline(next).filter((part) => {
        const old = before.get(part.id);
        return !old || JSON.stringify(old) !== JSON.stringify(part) || meshes.keyFor(old, project) !== meshes.keyFor(part, next);
    });
    const keys: Record<string, string> = {};
    const errors: Record<string, string> = {};
    // One at a time: the kernel runs one job at a time anyway, and identical instances then share one build.
    for (const part of changed) {
        const { key, error } = await meshes.preview(part, next);
        if (key) {
            keys[part.id] = key;
        }
        if (error) {
            errors[part.id] = error;
        }
    }
    return { parts: changed, keys, errors };
}
