// Defects found by trying the model-based sketch tools for real (scripts/ui-audit), shown at module level.
// Each `it.fails` passes while the defect is there; fixing it makes the test fail, and it then becomes a plain `it`.

import { describe, expect, it } from 'vitest';
import type { Project } from '@jarvis/core';

describe('Close sketch to model', () => {
    // Seen in the app (r12-whole2.mjs, close): an open U whose ends lie on the edge of the face it is sketched on;
    // Close sketch to model says "The faces of the model are not read yet; try again in a moment." and its note shows
    // the server's answer "query.kind: Invalid discriminator value. Expected 'edges' | 'convert' | 'section' |
    // 'silhouette' | 'pierce'". The web asks for { kind: 'planeFaces' } (sketchModelContours.ts), core declares it
    // (projection.ts) and the kernel answers it (cad/project.ts), but the request schema of /api/sketch-model
    // (apps/server/src/modelSketch.ts) does not list it, so the faces never arrive. Selected contours that use model
    // edges read the same query.
    it('the sketch-model request takes the planeFaces query the web sends', async () => {
        const project = { parts: [{ id: 'p', name: 'P', shape: { kind: 'box', size: [10, 10, 10] }, position: [0, 0, 0], rotation: [0, 0, 0], features: [] }] } as unknown as Project;
        const kernel = { project: async () => ({ curves: [] }) as never };
        // The server module, loaded by path so the web typecheck does not take in the server's own sources.
        const where = '../../../server/src/modelSketch';
        const { modelSketchRequest } = await import(/* @vite-ignore */ where) as {
            modelSketchRequest: (project: Project, input: unknown, kernel: unknown) => Promise<{ error: string } | { model: unknown }>;
        };
        const r = await modelSketchRequest(project, {
            partId: 'p', steps: 0, frame: { origin: [0, 5, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] }, query: { kind: 'planeFaces' },
        }, kernel);
        expect('error' in r ? r.error : null).toBeNull();
    });
});
