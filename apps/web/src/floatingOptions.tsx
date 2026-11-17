// Options > Toolbars (toolbarOptions.tsx): per toolbar whether it, or a pulldown group of it, floats as a toolbar of
// its own, and Lock toolbars for all of them (floatingToolbars.ts).

import { floatCandidates, LOCKED_TIP, setFloating, setToolbarsLocked, useFloatingToolbars } from './floatingToolbars';
import type { ArrangedToolbar } from './toolbarLayout';

/** The Floating choice of one toolbar: the toolbar itself, and each of its pulldown groups. */
export function FloatChoices({ toolbar }: { toolbar: ArrangedToolbar }) {
    const floating = useFloatingToolbars((s) => s.floating);
    const locked = useFloatingToolbars((s) => s.locked);
    const choices = floatCandidates([toolbar]);
    return (
        <div className="tb-field">
            <span>Floating</span>
            <span className="tbo-float-list" role="group" aria-label={`${toolbar.label}: floating`}>
                {choices.map((c) => (
                    <label
                        key={c.key}
                        className="tb-check"
                        title={locked ? LOCKED_TIP : c.family ? `${c.label} as a toolbar of its own: ${c.tools.map((t) => t.label).join(', ')}`
                            : 'The whole toolbar as a floating toolbar too'}
                    >
                        <input
                            type="checkbox"
                            className="tbo-float"
                            checked={!!floating[c.key]?.open}
                            disabled={locked}
                            onChange={(event) => setFloating(c.key, event.target.checked)}
                        />
                        <span>{c.family ? c.label : 'The whole toolbar'}</span>
                    </label>
                ))}
            </span>
        </div>
    );
}

/** "floating" beside a toolbar's name when it or one of its groups floats. */
export function FloatMark({ toolbar }: { toolbar: ArrangedToolbar }) {
    const count = useFloatingToolbars((s) => floatCandidates([toolbar]).filter((c) => s.floating[c.key]?.open).length);
    return count ? <em className="tbo-changed" title={`${count} floating toolbar${count > 1 ? 's' : ''} from this one`}>floating</em> : null;
}

/** Lock toolbars (SolidWorks: Lock CommandManager and toolbars). */
export function LockToolbars() {
    const locked = useFloatingToolbars((s) => s.locked);
    return (
        <label className="tb-check" title="Floating toolbars cannot be moved, turned or docked, and no toolbar can be floated">
            <input type="checkbox" className="tbo-lock" checked={locked} onChange={(event) => setToolbarsLocked(event.target.checked)} />
            <span>Lock toolbars: floating ones stay where they are, docked ones stay docked</span>
        </label>
    );
}
