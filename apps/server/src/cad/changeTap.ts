// Hooks a preview build uses to see what its changed steps do (change.ts): the body before and after each step, and
// the tools the add and cut steps join or remove. No imports, so build.ts can call it without a cycle.

import type { Shape3D } from 'replicad';

/** Told about each step a build applies (not the ones it takes from the cache, nor suppressed ones). */
export interface StepWatch {
    /** Only steps from here on are rebuilt, so the watch sees them all. */
    from: number;
    enter(index: number, shape: Shape3D | null, state: { features: { op: string }[]; ghosts: unknown[] }): void;
    leave(index: number, shape: Shape3D | null, state: { ghosts: unknown[] }): void;
}

/** Called by build.ts for every tool an add or cut joins or removes, with the body as it was before. */
export const toolTap: { on: ((body: Shape3D | null, tool: Shape3D, mode: 'add' | 'cut') => void) | null } = { on: null };
