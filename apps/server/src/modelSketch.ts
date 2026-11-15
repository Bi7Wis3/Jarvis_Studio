// POST /api/sketch-model: model geometry for an open sketch, from the body as it is before the sketch's step.

import { z } from 'zod';
import { DEFAULT_PRINT, effectivePart, type Project } from '@jarvis/core';
import type { ModelQuery, ModelSketch, PlaneFrame3 } from '@jarvis/core/projection';
import { combineContext, type CadKernel } from './cad/kernel.js';

const vec = z.tuple([z.number(), z.number(), z.number()]);
const facePick = z.object({ at: vec, normal: vec.optional() });

const body = z.object({
    partId: z.string(),
    /** How many of the part's steps come before the sketch (all of them for a new sketch). */
    steps: z.number().int().min(0),
    frame: z.object({ origin: vec, u: vec, v: vec, n: vec }),
    query: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('edges') }),
        z.object({ kind: z.literal('convert'), edges: z.array(vec).max(500), faces: z.array(facePick).max(200) }),
        z.object({ kind: z.literal('section'), faces: z.array(facePick).max(200) }),
        z.object({ kind: z.literal('silhouette'), external: z.boolean() }),
        z.object({ kind: z.literal('pierce'), edges: z.array(vec).max(500) }),
        z.object({ kind: z.literal('planeFaces') }),
    ]),
});

export type ModelSketchAnswer = { model: ModelSketch } | { error: string; status: number };

export async function modelSketchRequest(project: Project, input: unknown, kernel: Pick<CadKernel, 'project'>): Promise<ModelSketchAnswer> {
    const parsed = body.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), status: 400 };
    }
    const { partId, steps, frame, query } = parsed.data;
    const part = project.parts.find((p) => p.id === partId);
    if (!part) {
        return { error: `No part "${partId}".`, status: 404 };
    }
    const design = effectivePart(part, project.parts);
    const before = { shape: design.shape, features: (design.features ?? []).slice(0, steps) };
    try {
        const model = await kernel.project(before, project.print ?? DEFAULT_PRINT, frame as PlaneFrame3, query as ModelQuery,
            combineContext({ ...design, instanceOf: undefined, features: before.features }, project.parts));
        return { model };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e), status: 422 };
    }
}
