// What the CAD kernel is doing, as the server last said (CadActivity in core), and what the logo, the activity chip
// and the trees show of it. Elapsed time ticks here from the start time sent, so the server sends nothing per second.

import { create } from 'zustand';
import { IDLE_CAD, type CadActivity, type CadJob, type CadJobKind } from '@jarvis/core/cadActivity';

interface KernelActivityState {
    activity: CadActivity;
    /** This browser's clock minus the server's, ms. */
    skew: number;
    /** Browser clock, ticked while something is shown that changes with time. */
    now: number;
}

export const useKernelActivity = create<KernelActivityState>(() => ({ activity: IDLE_CAD, skew: 0, now: Date.now() }));

/** A job shorter than this never shows as busy, so quick model queries and cached rebuilds do not flicker. */
export const BUSY_AFTER_MS = 300;
/** How long the flash of a result landing and the red pulse of a failed build last. */
export const LANDED_MS = 900;
export const FAILED_MS = 2400;
/** Below this a finished job does not flash: nothing was shown as busy. */
const FLASH_AFTER_MS = BUSY_AFTER_MS;

const TICK_MS = 250;
let ticker: number | undefined;

/** The `cad` message from the server. */
export function setKernelActivity(message: CadActivity & { type?: string }, now = Date.now()): void {
    const { type: _type, ...activity } = message;
    useKernelActivity.setState({ activity, skew: now - activity.at, now });
    tick();
}

/** Keeps `now` ticking while the display changes with time. */
function tick(): void {
    const { activity, skew, now } = useKernelActivity.getState();
    const live = cadDisplay(activity, skew, now).look !== 'idle' || !!activity.job || activity.queued > 0;
    if (live && ticker === undefined) {
        ticker = window.setInterval(() => {
            useKernelActivity.setState({ now: Date.now() });
            tick();
        }, TICK_MS);
    } else if (!live && ticker !== undefined) {
        window.clearInterval(ticker);
        ticker = undefined;
    }
}

export type CadLook = 'idle' | 'building' | 'meshing' | 'waiting' | 'landed' | 'failed';

export interface CadDisplay {
    look: CadLook;
    /** The job shown as running, when busy. */
    job: CadJob | null;
    /** Steps done and the steps this build runs, for the outer ring (null: no steps to show). */
    steps: { done: number; count: number } | null;
    /** What the logo's caption says (null: nothing from the kernel). */
    caption: string | null;
    /** The line under the logo: part, step, i/n and seconds so far. */
    line: string | null;
    queued: number;
}

const BUILDING: Record<CadJobKind, string> = {
    rebuild: 'Rebuilding', preview: 'Previewing', mesh: 'Building', export: 'Exporting', props: 'Measuring', query: 'Reading model', import: 'Importing',
};

/** Seconds so far, whole: "7 s", "1 min 12 s". */
export function secondsText(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** What the logo shows of the kernel's work at browser time `now`. */
export function cadDisplay(activity: CadActivity, skew: number, now: number): CadDisplay {
    const { job, queued, last } = activity;
    const elapsed = job ? now - (job.startedAt + skew) : 0;
    if (job && elapsed >= BUSY_AFTER_MS) {
        const meshing = job.phase === 'meshing';
        const step = job.step;
        const parts = [
            job.partName,
            meshing ? 'meshing' : step ? `${step.name} · ${step.ordinal}/${step.count}` : 'starting',
            secondsText(elapsed),
        ].filter(Boolean);
        return {
            look: meshing ? 'meshing' : 'building',
            job,
            steps: step ? { done: meshing ? step.count : step.ordinal - 1, count: step.count } : null,
            caption: meshing ? 'Meshing' : BUILDING[job.kind],
            line: parts.join(' · '),
            queued,
        };
    }
    // A job that has only just started does not count yet: what was shown before stays.
    if (queued > 0) {
        return { look: 'waiting', job: null, steps: null, caption: 'Waiting', line: `${queued} waiting`, queued };
    }
    if (last) {
        const since = now - (last.endedAt + skew);
        if (!last.ok && since < FAILED_MS) {
            return {
                look: 'failed', job: null, steps: null, caption: 'Build failed',
                line: [last.partName, `failed after ${secondsText(last.ms)}`].filter(Boolean).join(' · '), queued,
            };
        }
        if (last.ok && since < LANDED_MS && last.ms >= FLASH_AFTER_MS && last.kind !== 'query' && last.kind !== 'props') {
            return {
                look: 'landed', job: null, steps: null, caption: 'Updated',
                line: [last.partName, `done in ${secondsText(last.ms)}`].filter(Boolean).join(' · '), queued,
            };
        }
    }
    return { look: 'idle', job: null, steps: null, caption: null, line: null, queued };
}

/**
 * The activity chip's CAD text while the kernel is busy: what it is doing ("building TestPart · Thread1 (17/22)") and
 * how many jobs wait ("2 queued"), apart so the count stays in view when the first is cut short; null when not busy.
 */
export function cadChip(display: CadDisplay): { doing: string | null; waiting: string | null } | null {
    const { job, queued } = display;
    const waiting = queued ? `${queued} queued` : null;
    if (display.look === 'building' || display.look === 'meshing') {
        const verb = display.look === 'meshing' ? 'meshing' : BUILDING[job!.kind].toLowerCase().replace('rebuilding', 'building');
        const step = display.look === 'building' && job!.step ? ` · ${job!.step.name} (${job!.step.ordinal}/${job!.step.count})` : '';
        return { doing: `${verb}${job!.partName ? ` ${job!.partName}` : ''}${step}`, waiting };
    }
    return display.look === 'waiting' ? { doing: null, waiting } : null;
}

/** The chip's CAD text in one ("building TestPart · Thread1 (17/22) · 2 queued"), or null when not busy. */
export function cadChipText(display: CadDisplay): string | null {
    const chip = cadChip(display);
    return chip && [chip.doing, chip.waiting].filter(Boolean).join(' · ');
}

/** The step of part `partId` being rebuilt for its shown result, when it shows as busy. */
export function busyStep(display: CadDisplay, partId: string): string | null {
    const job = display.look === 'building' ? display.job : null;
    return job?.step && job.parts.includes(partId) ? job.step.id : null;
}

/** Whether part `partId`'s shown result is being rebuilt (running or waiting), once that shows as busy. */
export function partRebuilding(activity: CadActivity, display: CadDisplay, partId: string): boolean {
    return (display.look === 'building' || display.look === 'meshing' || display.look === 'waiting')
        && activity.building.includes(partId);
}

/** The display now, re-rendering as it changes. */
export function useCadDisplay(): CadDisplay {
    return useKernelActivity((s) => cadDisplayMemo(s.activity, s.skew, s.now));
}

export function useBusyStep(partId: string): string | null {
    return useKernelActivity((s) => busyStep(cadDisplayMemo(s.activity, s.skew, s.now), partId));
}

export function usePartRebuilding(partId: string): boolean {
    return useKernelActivity((s) => partRebuilding(s.activity, cadDisplayMemo(s.activity, s.skew, s.now), partId));
}

// One display per state, so selectors return the same object until something changes.
let memo: { activity: CadActivity; skew: number; now: number; display: CadDisplay } | null = null;

function cadDisplayMemo(activity: CadActivity, skew: number, now: number): CadDisplay {
    if (memo?.activity !== activity || memo.skew !== skew || memo.now !== now) {
        const display = cadDisplay(activity, skew, now);
        // Keep the old object while nothing shown changed (the seconds only change once a second).
        memo = { activity, skew, now, display: memo && JSON.stringify(memo.display) === JSON.stringify(display) ? memo.display : display };
    }
    return memo.display;
}
