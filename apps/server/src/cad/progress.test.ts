import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRINT, type Feature, type Shape } from '@jarvis/core';
import { KernelTracker, type KernelActivity, type KernelJobLabel, type KernelJobs } from './activity.js';
import { CadKernel } from './kernel.js';
import { ProgressMailbox, ProgressReporter, type WorkerProgress } from './progress.js';

const step = (id: string, op = 'fillet') => ({ id, name: id.toUpperCase(), op });

describe('worker progress', () => {
    it('posts the first report at once, then at most one each 250 ms, and the start of meshing at once', () => {
        let t = 1000;
        const posted: WorkerProgress[] = [];
        const box = new ProgressMailbox();
        const reporter = new ProgressReporter((p) => posted.push(p), box, () => t);
        reporter.begin(7);
        expect(posted).toEqual([{ id: 7, n: 1, phase: 'building' }]);
        // Steps 0-2 come from the prefix cache; step 3 is the first one built of 6.
        reporter.step(2, step('a'), 3, 6, 1);
        t += 10;
        reporter.step(3, step('b'), 3, 6, 1);
        t += 10;
        reporter.step(4, step('c', 'thread'), 3, 6, 1);
        expect(posted).toHaveLength(1);
        // Not posted, but the mailbox has the step being built, for the kernel to read during a long step.
        expect(box.read()).toMatchObject({ id: 7, phase: 'building', step: { index: 4, id: 'c', name: 'C', op: 'thread', ordinal: 2, count: 3 } });
        t += 240;
        reporter.step(5, step('d'), 3, 6, 1);
        expect(posted.at(-1)).toMatchObject({ step: { id: 'd', ordinal: 3, count: 3 } });
        expect(posted).toHaveLength(2);
        t += 5;
        reporter.meshing();
        expect(posted).toHaveLength(3);
        expect(posted.at(-1)).toMatchObject({ phase: 'meshing', step: { id: 'd' } });
        // Sequence numbers only go up within a job.
        expect(posted.map((p) => p.n)).toEqual([1, 4, 5]);
    });

    it('leaves out the builds of parts a combine step uses', () => {
        const posted: WorkerProgress[] = [];
        const reporter = new ProgressReporter((p) => posted.push(p), null, () => 0, 0);
        reporter.begin(1);
        reporter.step(0, step('combine1', 'combine'), 0, 2, 1);
        reporter.step(0, step('other'), 0, 5, 2);
        expect(posted.map((p) => p.step?.id)).toEqual([undefined, 'combine1']);
    });

    it('names each part of a job that builds several', () => {
        const posted: WorkerProgress[] = [];
        const reporter = new ProgressReporter((p) => posted.push(p), null, () => 0, 0);
        reporter.begin(2);
        reporter.step(0, step('a'), 0, 1, 0);
        reporter.part('p2', 'Bracket');
        expect(posted.at(-1)).toEqual({ id: 2, n: 3, phase: 'building', part: { id: 'p2', name: 'Bracket' } });
    });

    it('shares the latest report through the mailbox, and refuses a torn read', () => {
        const box = new ProgressMailbox();
        expect(box.read()).toBeNull();
        box.write({ id: 3, n: 4, phase: 'meshing' });
        // The other side sees the same memory.
        const other = new ProgressMailbox(box.buffer);
        expect(other.read()).toEqual({ id: 3, n: 4, phase: 'meshing' });
        // A write in progress (odd sequence) is not read.
        Atomics.add(new Int32Array(box.buffer, 0, 1), 0, 1);
        expect(other.read()).toBeNull();
    });
});

describe('kernel tracker', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const label: KernelJobLabel = { kind: 'mesh', partId: 'p1', partName: 'TestPart', key: 'k1' };

    it('keeps the job running, its progress, the queue and how the last job ended', async () => {
        vi.useFakeTimers();
        let t = 5000;
        const jobs: KernelJobs = { current: null, queue: [] };
        const tracker = new KernelTracker(() => jobs, () => t);
        const heard: KernelActivity[] = [];
        tracker.subscribe((a) => heard.push(a));

        jobs.current = { id: 1, label };
        jobs.queue = [{ kind: 'query', partId: 'p2' }];
        tracker.changed();
        tracker.changed();
        await Promise.resolve();
        expect(heard).toHaveLength(1);
        expect(heard[0]).toEqual({
            job: { ...label, id: 1, startedAt: 5000, phase: 'building' },
            queue: [{ kind: 'query', partId: 'p2' }],
            last: null,
        });

        const thread = { index: 16, id: 'thread1', name: 'Thread1', op: 'thread', ordinal: 2, count: 7 };
        tracker.progress({ id: 1, n: 2, phase: 'building', step: thread });
        // An older report arriving late, and one of another job, change nothing.
        tracker.progress({ id: 1, n: 1, phase: 'building' });
        tracker.progress({ id: 9, n: 5, phase: 'meshing' });
        await Promise.resolve();
        expect(tracker.activity().job).toMatchObject({ phase: 'building', step: thread });

        // While the worker is inside a long step it posts nothing: the tracker reads the mailbox itself.
        tracker.mailbox.write({ id: 1, n: 3, phase: 'meshing', step: thread });
        await vi.advanceTimersByTimeAsync(300);
        expect(heard.at(-1)?.job).toMatchObject({ phase: 'meshing' });

        t = 9000;
        jobs.current = null;
        tracker.finished(1, false);
        await Promise.resolve();
        expect(heard.at(-1)).toMatchObject({
            job: null,
            last: { kind: 'mesh', partId: 'p1', id: 1, ok: false, endedAt: 9000, ms: 4000 },
        });
    });

    it('counts a job that vanishes without a result (crash, timeout) as failed', async () => {
        vi.useFakeTimers();
        const jobs: KernelJobs = { current: { id: 4, label }, queue: [] };
        const tracker = new KernelTracker(() => jobs, () => 100);
        const heard: KernelActivity[] = [];
        tracker.subscribe((a) => heard.push(a));
        tracker.changed();
        await Promise.resolve();
        jobs.current = null;
        await vi.advanceTimersByTimeAsync(300);
        expect(heard.at(-1)).toMatchObject({ job: null, last: { id: 4, ok: false } });
    });
});

describe('kernel activity', () => {
    it('reports the job running, the step it builds and its meshing, then idle', async () => {
        const kernel = CadKernel.start();
        try {
            const heard: KernelActivity[] = [];
            kernel.onActivity((a) => heard.push(a));
            const features: Feature[] = [
                { id: 'fillet1', name: 'Fillet1', op: 'fillet', radius: 4, edges: 'vertical' },
                { id: 'shell1', name: 'Shell1', op: 'shell', thickness: 2, open: ['top'] },
                { id: 'hole1', name: 'Hole1', op: 'hole', spec: { kind: 'counterbore', size: 'M3' }, position: [0, -15, 0], direction: [0, 1, 0] },
            ];
            const part = { id: 'p1', name: 'Block', shape: { kind: 'box', size: [80, 30, 50] } as Shape, features };
            const first = kernel.mesh(part, DEFAULT_PRINT);
            const second = kernel.properties(part, DEFAULT_PRINT);
            expect(kernel.activity().queue.length + (kernel.activity().job ? 1 : 0)).toBe(2);
            await Promise.all([first, second]);
            await new Promise((r) => setTimeout(r, 20));
            const jobs = heard.flatMap((a) => (a.job ? [a.job] : []));
            expect(jobs[0]).toMatchObject({ kind: 'mesh', partId: 'p1', partName: 'Block', phase: 'building' });
            expect(jobs[0].key).toMatch(/^[0-9a-f]+/);
            expect(heard.some((a) => a.queue.length === 1)).toBe(true);
            expect(jobs.some((j) => j.phase === 'meshing')).toBe(true);
            expect(jobs.some((j) => j.kind === 'props')).toBe(true);
            expect(heard.at(-1)).toMatchObject({ job: null, queue: [], last: { kind: 'props', ok: true } });
            expect(kernel.activity().job).toBeNull();
        } finally {
            await kernel.close();
        }
    }, 120_000);
});
