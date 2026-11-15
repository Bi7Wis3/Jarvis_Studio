import { describe, expect, it } from 'vitest';
import { IDLE_CAD, type CadActivity, type CadJob } from '@jarvis/core/cadActivity';
import { busyStep, cadChip, cadChipText, cadDisplay, FAILED_MS, LANDED_MS, partRebuilding, secondsText } from './kernelActivity';

const thread = { index: 16, id: 'thread1', name: 'Thread1', op: 'thread', ordinal: 17, count: 22 };
const job: CadJob = {
    kind: 'rebuild', partId: 'p3', partName: 'TestPart', parts: ['p3'], phase: 'building', step: thread, startedAt: 10_000,
};
const busy = (over: Partial<CadActivity> = {}): CadActivity => ({ ...IDLE_CAD, job, building: ['p3'], at: 10_000, ...over });
// The browser's clock runs 2 s ahead of the server's.
const skew = 2000;

describe('kernel activity display', () => {
    it('shows a build only once it has run a moment, so quick jobs do not flicker', () => {
        expect(cadDisplay(busy(), skew, 12_100).look).toBe('idle');
        const shown = cadDisplay(busy(), skew, 12_000 + 42_600);
        expect(shown).toMatchObject({ look: 'building', caption: 'Rebuilding', steps: { done: 16, count: 22 } });
        expect(shown.line).toBe('TestPart · Thread1 · 17/22 · 42 s');
    });

    it('fills the whole ring and sweeps while meshing', () => {
        const shown = cadDisplay(busy({ job: { ...job, phase: 'meshing' } }), skew, 12_000 + 75_000);
        expect(shown).toMatchObject({ look: 'meshing', caption: 'Meshing', steps: { done: 22, count: 22 } });
        expect(shown.line).toBe('TestPart · meshing · 1 min 15 s');
    });

    it('waits calmly when jobs are queued and none runs yet', () => {
        expect(cadDisplay({ ...IDLE_CAD, queued: 3, building: ['p1'] }, 0, 0)).toMatchObject({ look: 'waiting', caption: 'Waiting', queued: 3 });
    });

    it('flashes when a result lands and pulses red when a build fails, briefly', () => {
        const last = { kind: 'rebuild' as const, partId: 'p3', partName: 'TestPart', parts: ['p3'], ok: true, endedAt: 50_000, ms: 40_000 };
        const landed = { ...IDLE_CAD, last, at: 50_000 };
        expect(cadDisplay(landed, skew, 52_100)).toMatchObject({ look: 'landed', caption: 'Updated', line: 'TestPart · done in 40 s' });
        expect(cadDisplay(landed, skew, 52_000 + LANDED_MS).look).toBe('idle');
        // A quick job that never showed as busy does not flash, nor does a model query.
        expect(cadDisplay({ ...landed, last: { ...last, ms: 80 } }, skew, 52_100).look).toBe('idle');
        expect(cadDisplay({ ...landed, last: { ...last, kind: 'query' } }, skew, 52_100).look).toBe('idle');
        const failed = { ...landed, last: { ...last, ok: false, ms: 80 } };
        expect(cadDisplay(failed, skew, 52_100)).toMatchObject({ look: 'failed', caption: 'Build failed' });
        expect(cadDisplay(failed, skew, 52_000 + FAILED_MS).look).toBe('idle');
    });

    it('says in the chip what is building and how many wait', () => {
        const now = 12_000 + 5000;
        expect(cadChipText(cadDisplay(busy({ queued: 2 }), skew, now))).toBe('building TestPart · Thread1 (17/22) · 2 queued');
        expect(cadChipText(cadDisplay(busy({ job: { ...job, phase: 'meshing' } }), skew, now))).toBe('meshing TestPart');
        expect(cadChipText(cadDisplay(busy({ job: { ...job, kind: 'preview', parts: [] } }), skew, now))).toBe('previewing TestPart · Thread1 (17/22)');
        expect(cadChipText(cadDisplay({ ...IDLE_CAD, queued: 2 }, 0, 0))).toBe('2 queued');
        expect(cadChipText(cadDisplay(IDLE_CAD, 0, 0))).toBeNull();
        // Apart, so the count stays in view when the chip cuts the job's text short.
        expect(cadChip(cadDisplay(busy({ queued: 1 }), skew, now))).toEqual({ doing: 'building TestPart · Thread1 (17/22)', waiting: '1 queued' });
    });

    it('marks the step being rebuilt in the feature tree, and the parts being rebuilt in the assembly tree', () => {
        const activity = busy({ building: ['p3', 'p4'] });
        const shown = cadDisplay(activity, skew, 12_000 + 5000);
        expect(busyStep(shown, 'p3')).toBe('thread1');
        expect(busyStep(shown, 'p4')).toBeNull();
        // A preview is not the part's shown result.
        expect(busyStep(cadDisplay(busy({ job: { ...job, kind: 'preview', parts: [] } }), skew, 17_000), 'p3')).toBeNull();
        expect(partRebuilding(activity, shown, 'p4')).toBe(true);
        expect(partRebuilding(activity, cadDisplay(activity, skew, 12_100), 'p4')).toBe(false);
    });

    it('counts seconds whole, and minutes past one', () => {
        expect(secondsText(999)).toBe('0 s');
        expect(secondsText(72_400)).toBe('1 min 12 s');
    });
});
