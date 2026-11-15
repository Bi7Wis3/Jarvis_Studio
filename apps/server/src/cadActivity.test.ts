import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, type Part, type Project } from '@jarvis/core';
import type { CadActivity } from '@jarvis/core/cadActivity';
import type { KernelActivity } from './cad/activity.js';
import { CadActivityFeed, cadActivity, type ShownKeys } from './cadActivity.js';

const shown: ShownKeys = {
    // TestPart and its instance share one design, so one mesh.
    parts: new Map([['k-test', ['p1', 'p1b']], ['k-nut', ['p2']]]),
    names: new Map([['p1', 'TestPart'], ['p1b', 'TestPart'], ['p2', 'Nut']]),
};

const thread = { index: 16, id: 'thread1', name: 'Thread1', op: 'thread', ordinal: 2, count: 7 };

describe('cad activity for browsers', () => {
    it('calls a mesh job of a shown key a rebuild, and lists the parts whose new result is coming', () => {
        const kernel: KernelActivity = {
            job: { kind: 'mesh', partId: 'p1', partName: 'TestPart', key: 'k-test', id: 3, startedAt: 100, phase: 'building', step: thread },
            queue: [{ kind: 'mesh', partId: 'p2', key: 'k-nut' }, { kind: 'query', partId: 'p2' }],
            last: null,
        };
        expect(cadActivity(kernel, shown, 500)).toEqual({
            job: { kind: 'rebuild', partId: 'p1', partName: 'TestPart', parts: ['p1', 'p1b'], phase: 'building', step: thread, startedAt: 100 },
            queued: 2,
            building: ['p1', 'p1b', 'p2'],
            last: null,
            at: 500,
        } satisfies CadActivity);
    });

    it('calls other mesh jobs a mesh, and a preview that makes the shown key a preview that rebuilds the part', () => {
        const other = cadActivity({
            job: { kind: 'mesh', partId: 'p1', key: 'k-fine', id: 1, startedAt: 0, phase: 'meshing' },
            queue: [{ kind: 'preview', partId: 'p2', partName: 'Nut', key: 'k-nut' }],
            last: { kind: 'export', id: 0, ok: false, endedAt: 50, ms: 40 },
        }, shown, 60);
        expect(other.job).toMatchObject({ kind: 'mesh', partId: 'p1', partName: 'TestPart', parts: [] });
        expect(other.building).toEqual(['p2']);
        expect(other.last).toEqual({ kind: 'export', parts: [], ok: false, endedAt: 50, ms: 40 });
    });

    it('is sent when the kernel or the project changes, and only when it changed', () => {
        let listener: ((a: KernelActivity) => void) | null = null;
        let activity: KernelActivity = { job: null, queue: [], last: null };
        const kernel = { activity: () => activity, onActivity: (l: (a: KernelActivity) => void) => { listener = l; return () => undefined; } };
        const part = (id: string, name: string): Part => ({ id, name } as Part);
        let project: Project = { name: 'P', parts: [part('p1', 'TestPart')], view: DEFAULT_VIEW };
        let keyed = 0;
        const meshes = {
            keyFor: (p: Part, of: Project) => { keyed++; return `${p.id}@${of.parts.length}`; },
            getQuality: () => 'normal' as const,
        };
        const sent: CadActivity[] = [];
        const feed = new CadActivityFeed(kernel, meshes, () => project, (a) => sent.push(a), () => 1);

        activity = { job: { kind: 'mesh', key: 'p1@1', id: 1, startedAt: 0, phase: 'building' }, queue: [], last: null };
        listener!(activity);
        listener!(activity);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ job: { kind: 'rebuild', partId: 'p1', partName: 'TestPart' }, building: ['p1'] });
        expect(keyed).toBe(1); // keys are worked out once per project

        // The project changed under the job: the part now shows another key, so this job no longer makes its result.
        project = { ...project, parts: [...project.parts, part('p2', 'Nut')] };
        feed.refresh();
        expect(sent).toHaveLength(2);
        expect(sent[1]).toMatchObject({ job: { kind: 'mesh', parts: [] }, building: [] });
    });
});
