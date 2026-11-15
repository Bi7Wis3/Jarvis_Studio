import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry } from '@jarvis/core';
import { cadChip, cadChipText, useCadDisplay } from './kernelActivity';
import './kernelActivity.css';
import { draftPrompt, useStudio } from './state';

const STATE_ICONS = { running: '◌', done: '✓', stopped: '■', failed: '✕' } as const;

/** How long a finished command stays listed before it fades away; failures stay longer so they are noticed. */
const LINGER_MS: Record<ActivityEntry['state'], number> = { running: Infinity, done: 3000, stopped: 3000, failed: 20000 };
const FADE_MS = 600;

/** Commands still worth showing, with the ones about to go marked as leaving. Rechecks itself while any are pending. */
function useVisibleEntries(entries: ActivityEntry[]): { entry: ActivityEntry; leaving: boolean }[] {
    // When each turn reached its current state, as seen by this browser.
    const since = useRef(new Map<number, { state: ActivityEntry['state']; at: number }>());
    const [now, setNow] = useState(() => Date.now());
    for (const entry of entries) {
        const seen = since.current.get(entry.turn);
        if (!seen || seen.state !== entry.state) {
            // Entries already finished when this tab loaded count as long gone.
            since.current.set(entry.turn, { state: entry.state, at: seen || entry.state === 'running' ? Date.now() : 0 });
        }
    }
    const visible = entries
        .map((entry) => ({ entry, age: now - since.current.get(entry.turn)!.at }))
        .filter(({ entry, age }) => age < LINGER_MS[entry.state] + FADE_MS)
        .map(({ entry, age }) => ({ entry, leaving: age >= LINGER_MS[entry.state] }));
    const pending = visible.some(({ entry }) => entry.state !== 'running');
    useEffect(() => {
        if (!pending) {
            return;
        }
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, [pending]);
    return visible;
}

function ago(at: number): string {
    const seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 60) {
        return 'now';
    }
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** Top right: what is happening in the background, and the commands sent to Jarvis. */
export function Activity() {
    const { status, detail, speaking, meshes, activity, connected } = useStudio();
    const [open, setOpen] = useState(true);
    const visible = useVisibleEntries(activity);
    const keys = Object.values(meshes.keys);
    const building = keys.filter((k) => k === null).length;
    const failed = Object.keys(meshes.errors).length;
    const jarvis = !connected ? 'offline' : status === 'working' && detail ? detail.replace(/_/g, ' ') : status;
    // While the kernel works: the part, step and i/n it is on, and the jobs waiting (kernelActivity.ts).
    const cad = useCadDisplay();
    const chip = connected ? cadChip(cad) : null;
    const busy = chip?.doing ?? chip?.waiting ?? null;
    // An idle assistant gives up its place in the chip to the kernel's work, which needs the room.
    const quiet = !!busy && connected && status === 'idle';

    return (
        <aside className={`activity ${open ? '' : 'closed'}`} aria-label="Activity">
            <button type="button" className="activity-status" onClick={() => setOpen(!open)} title={open ? 'Hide commands' : 'Show commands'}>
                <span className={`pulse ${status !== 'idle' ? 'busy' : ''}`} />
                {!quiet && (
                    <>
                        <span>Jarvis <b>{jarvis}</b></span>
                        <span className="sep">·</span>
                    </>
                )}
                <span className="activity-cad" title={cadChipText(cad) ?? (failed ? Object.values(meshes.errors).join('\n') : undefined)}>
                    CAD <b className={busy ? 'busy' : failed ? 'warn' : ''}>
                        {busy ?? (building ? `building ${building}` : failed ? `${failed} failed` : `${keys.length} ok`)}
                    </b>
                </span>
                {chip?.doing && chip.waiting && <span className="activity-queued">· {chip.waiting}</span>}
                {speaking && (
                    <>
                        <span className="sep">·</span>
                        <span>speaking</span>
                    </>
                )}
            </button>
            {open && visible.length > 0 && (
                <ol>
                    {[...visible].reverse().slice(0, 8).map(({ entry, leaving }) => (
                        <li key={entry.turn} className={`${entry.state} ${leaving ? 'leaving' : ''}`}>
                            <span className="state" title={entry.state}>{STATE_ICONS[entry.state]}</span>
                            <button type="button" className="text" onClick={() => draftPrompt(entry.text)} title={`Edit and resend: ${entry.text}`}>
                                {entry.images > 0 && <span className="pics">▣{entry.images > 1 ? entry.images : ''}</span>}
                                {entry.text}
                            </button>
                            <span className="when">{ago(entry.at)}</span>
                        </li>
                    ))}
                </ol>
            )}
        </aside>
    );
}
