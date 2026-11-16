// Pictures shown while a part's real mesh is still being made (MeshService.update). When a modelled thread has to be
// built again (it takes many seconds), a draft comes first: the part with the threads from the edited step on shown as
// their quick ridges, as a tool preview shows them. And when the real mesh itself takes a while, a coarse mesh of the
// same solid comes before it. Each picture replaces only a lesser one of the same real mesh, never the other way round.

import type { Feature, Part } from '@jarvis/core';

/** How far along a picture is: the real mesh beats its coarse mesh, which beats the draft, and so on. */
export const RANK = { coarseDraft: 1, draft: 2, coarse: 3, final: 4 } as const;

/** What a part was last built from, to see which of its steps the kernel still has (build.ts keeps every step). */
export interface BuiltSpec {
    base: string;
    steps: string[];
}

/** The part as the kernel builds it, step by step, names aside (renaming a step rebuilds nothing). */
export function builtSpec(part: Pick<Part, 'shape' | 'features'>, settings: unknown): BuiltSpec {
    return {
        base: JSON.stringify([part.shape, settings]),
        steps: (part.features ?? []).map(({ name: _name, ...step }) => JSON.stringify(step)),
    };
}

/**
 * The part as its draft is built: every thread from the first step that differs from `built` on is shown as its
 * ridges, which takes a moment. Null when no modelled thread has to be built again (a thread before the change comes
 * from the kernel's cache, and a cosmetic one is quick anyway).
 */
export function draftPart<P extends Pick<Part, 'shape' | 'features'>>(part: P, settings: unknown, built: BuiltSpec | undefined): P | null {
    const now = builtSpec(part, settings);
    const features = part.features ?? [];
    let first = !built || built.base !== now.base ? 0 : now.steps.findIndex((step, i) => built.steps[i] !== step);
    if (first < 0) {
        first = features.length;
    }
    const slow = (f: Feature): boolean => f.op === 'thread' && !f.suppressed && !f.cosmetic && !f.preview;
    if (!features.some((f, i) => i >= first && slow(f))) {
        return null;
    }
    // As preview.ts's quickThreads marks them, so a draft the form's preview made already is found by its key.
    return { ...part, features: features.map((f, i) => (i >= first && f.op === 'thread' && !f.suppressed ? { ...f, preview: true } : f)) };
}

const LIMIT = 200;

/** The best picture so far of each real mesh still being made, and what each part shows. */
export class MeshStages {
    private best = new Map<string, { key: string; rank: number; solid: string }>();
    private shows = new Map<string, { final: string; rank: number; solid: string | null }>();

    /** The best picture of the real mesh `final` so far, or null. */
    bestFor(final: string): { key: string; rank: number; solid: string } | null {
        return this.best.get(final) ?? null;
    }

    /** A picture of `final` (of the solid `solid`) is ready; false if it is not better than one had already. */
    offer(final: string, key: string, rank: number, solid: string): boolean {
        const had = this.best.get(final);
        if (had && had.rank >= rank) {
            return false;
        }
        this.best.delete(final);
        this.best.set(final, { key, rank, solid });
        while (this.best.size > LIMIT) {
            this.best.delete(this.best.keys().next().value!);
        }
        return true;
    }

    /** The real mesh is there: its pictures are no longer needed. */
    done(final: string): void {
        this.best.delete(final);
    }

    /** Notes what a part shows now: a picture of `final` at `rank` (`final` itself at RANK.final), of solid `solid`. */
    show(partId: string, final: string, rank: number, solid: string | null): void {
        this.shows.set(partId, { final, rank, solid });
    }

    /**
     * Whether a part waiting for `final` should show a picture of it at `rank`, of `solid`: one it shows for the same
     * real mesh must be a lesser one, and a coarse picture never replaces a mesh of the same solid (the display
     * quality changing).
     */
    better(partId: string, final: string, rank: number, solid: string): boolean {
        const now = this.shows.get(partId);
        if (!now) {
            return true;
        }
        if (now.final === final) {
            return now.rank < rank;
        }
        return now.solid !== solid;
    }
}
