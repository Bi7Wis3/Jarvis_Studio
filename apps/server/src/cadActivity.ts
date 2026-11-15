// What browsers are told the CAD kernel is doing (CadActivity in core), from the kernel's own account
// (cad/activity.ts): a mesh job whose key is the one a part is shown with is that part's rebuild, and the parts of the
// jobs running and waiting are the ones whose new result is still coming.

import { partsAtTimeline, type Project } from '@jarvis/core';
import type { CadActivity, CadJobInfo } from '@jarvis/core/cadActivity';
import type { KernelActivity, KernelJobLabel } from './cad/activity.js';
import type { CadKernel } from './cad/kernel.js';
import type { MeshService } from './meshes.js';

/** The parts each mesh key is shown for, and the parts' names. */
export interface ShownKeys {
    parts: Map<string, string[]>;
    names: Map<string, string>;
}

function info(label: KernelJobLabel, shown: ShownKeys): CadJobInfo {
    const parts = label.key ? shown.parts.get(label.key) ?? [] : [];
    const partId = label.partId ?? parts[0];
    const partName = label.partName ?? (partId !== undefined ? shown.names.get(partId) : undefined);
    return {
        kind: label.kind === 'mesh' ? (parts.length ? 'rebuild' : 'mesh') : label.kind,
        ...(partId !== undefined ? { partId } : {}),
        ...(partName !== undefined ? { partName } : {}),
        parts,
    };
}

export function cadActivity(kernel: KernelActivity, shown: ShownKeys, at: number): CadActivity {
    const { job, queue, last } = kernel;
    const waiting = queue.map((label) => info(label, shown));
    const running = job ? info(job, shown) : null;
    const building = [...new Set([...(running?.parts ?? []), ...waiting.flatMap((w) => w.parts)])];
    return {
        job: job && running ? { ...running, phase: job.phase, ...(job.step ? { step: job.step } : {}), startedAt: job.startedAt } : null,
        queued: queue.length,
        building,
        last: last && { ...info(last, shown), ok: last.ok, endedAt: last.endedAt, ms: last.ms },
        at,
    };
}

/** Keeps browsers told what the kernel is doing: on every change of the kernel's activity, and of the project. */
export class CadActivityFeed {
    private shown: { project: Project; quality: string; keys: ShownKeys } | null = null;
    private told = '';

    constructor(
        private readonly kernel: Pick<CadKernel, 'activity' | 'onActivity'>,
        private readonly meshes: Pick<MeshService, 'keyFor' | 'getQuality'>,
        private readonly project: () => Project,
        private readonly send: (activity: CadActivity) => void,
        private readonly now: () => number = Date.now,
    ) {
        kernel.onActivity(() => this.refresh());
    }

    current(): CadActivity {
        return cadActivity(this.kernel.activity(), this.shownKeys(), this.now());
    }

    /** Sends the activity if it changed (the project changed, so another part may be the one being built). */
    refresh(): void {
        const activity = this.current();
        const json = JSON.stringify({ ...activity, at: 0 });
        if (json !== this.told) {
            this.told = json;
            this.send(activity);
        }
    }

    /** Keys the parts are shown with now, worked out again only when the project or the display quality changes. */
    private shownKeys(): ShownKeys {
        const project = this.project();
        const quality = this.meshes.getQuality();
        if (this.shown?.project !== project || this.shown.quality !== quality) {
            const parts = new Map<string, string[]>();
            for (const part of partsAtTimeline(project)) {
                const key = this.meshes.keyFor(part, project);
                parts.set(key, [...(parts.get(key) ?? []), part.id]);
            }
            const names = new Map(project.parts.map((p) => [p.id, p.name]));
            this.shown = { project, quality, keys: { parts, names } };
        }
        return this.shown.keys;
    }
}
