// Quick Snaps (SolidWorks): a single-operation snap that filters out the other sketch snaps for the next entity drawn
// (whether or not snapping is enabled); a double-click keeps it for further entities until another is chosen. The
// persistent per-kind switches below them are the Sketch Snaps (System Options > Relations/Snaps).

import { create } from 'zustand';
import type { MenuEntry } from './menus';
import { QUICK_SNAPS, type QuickSnap } from './snapping';

interface QuickSnapState {
    /** The quick snap in force, or null for the sketch snaps as set. */
    kind: QuickSnap | null;
    /** Kept for more entities (double-click), else only for the next one. */
    keep: boolean;
}

export const useQuickSnap = create<QuickSnapState>(() => ({ kind: null, keep: false }));

/** Chooses a quick snap: for the next entity, or kept (double-click). A click on a kept one goes back to the sketch snaps. */
export function chooseQuickSnap(kind: QuickSnap | null, keep = false): void {
    const s = useQuickSnap.getState();
    if (kind && !keep && s.kind === kind && s.keep) {
        useQuickSnap.setState({ kind: null, keep: false });
        return;
    }
    useQuickSnap.setState({ kind, keep: !!kind && keep });
}

/** Whether a quick snap is in force (it works with snapping off too). */
export const quickSnapOn = (): boolean => useQuickSnap.getState().kind !== null;

/** Whether the quick snap in force is `kind`. */
export const quickSnapIs = (kind: QuickSnap): boolean => useQuickSnap.getState().kind === kind;

/**
 * The snap kinds in force: only the quick snap's, when one is chosen; else the sketch snaps, without the grid when it
 * is hidden and "Snap only when grid is displayed" is on.
 */
export function snapKindsInForce(kinds: Partial<Record<QuickSnap, boolean>>, gridSnaps: boolean): Partial<Record<QuickSnap, boolean>> {
    const quick = useQuickSnap.getState().kind;
    if (quick) {
        return Object.fromEntries(QUICK_SNAPS.map(({ kind }) => [kind, kind === quick]));
    }
    return gridSnaps ? kinds : { ...kinds, grid: false };
}

/** An entity was finished: a single-use quick snap is spent. */
export function quickSnapUsed(): void {
    if (useQuickSnap.getState().kind && !useQuickSnap.getState().keep) {
        useQuickSnap.setState({ kind: null, keep: false });
    }
}

const LABELS: Partial<Record<QuickSnap, string>> = { aligned: 'Horizontal/vertical', length: 'Length (steps of the grid)', angle: 'Angle (snap angle)' };

/**
 * The Quick snaps buttons: click for the next entity, double-click to keep. Nothing above them changes with the
 * choice, so the second click of a double-click lands on the same button.
 */
export function QuickSnapButtons() {
    const { kind, keep } = useQuickSnap();
    return (
        <div className="sk-quick-snaps">
            <p className="tb-note">Click one for the next entity only; double-click to keep it.</p>
            <div className="sk-relation-buttons">
                {QUICK_SNAPS.map((q) => (
                    <button
                        key={q.kind}
                        type="button"
                        className={`sk-small ${kind === q.kind ? 'on' : ''}`}
                        aria-pressed={kind === q.kind}
                        title={kind === q.kind && keep ? 'Kept: click to go back to the sketch snaps' : 'Click: next entity only · double-click: keep'}
                        onClick={() => chooseQuickSnap(q.kind)}
                        onDoubleClick={() => chooseQuickSnap(q.kind, true)}
                    >
                        {LABELS[q.kind] ?? q.label}{kind === q.kind && keep ? ' (kept)' : ''}
                    </button>
                ))}
            </div>
            {kind
                ? <button type="button" className="sk-small" onClick={() => chooseQuickSnap(null)}>Back to the sketch snaps</button>
                : <p className="tb-note">None chosen: the sketch snaps below apply.</p>}
        </div>
    );
}

/** Quick snaps as a submenu of the sketch's right-click menu. */
export function quickSnapMenu(): MenuEntry {
    const { kind, keep } = useQuickSnap.getState();
    return {
        label: 'Quick snaps',
        icon: 'snap',
        items: [
            ...QUICK_SNAPS.map((q): MenuEntry => ({ label: LABELS[q.kind] ?? q.label, checked: kind === q.kind, onSelect: () => chooseQuickSnap(q.kind, keep && kind === q.kind) })),
            ...(kind ? ['separator' as const, { label: 'Back to the sketch snaps', onSelect: () => chooseQuickSnap(null) }] : []),
        ],
    };
}
