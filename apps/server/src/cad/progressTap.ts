// Hook for the busy display: build.ts says which step of a history it is on (progress.ts reports it to the server).
// No imports, so build.ts can call it without a cycle.

/**
 * Called for every step of a build, cached ones included: `start` is the first one not taken from the prefix cache,
 * `total` the number of steps, `depth` the length of the combine stack (above 1: another part built for a combine).
 */
export const progressTap: {
    on: ((index: number, step: { id: string; name?: string; op: string }, start: number, total: number, depth: number) => void) | null;
} = { on: null };
