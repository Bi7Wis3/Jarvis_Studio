// The floating toolbars of the mode the app is in (floatingToolbars.ts): each a slim title bar to drag it by, with its
// name, a switch between a row and a column, and × to dock it; under it the tools as plain buttons, drawn by the main
// toolbar's own button (Toolbar.tsx), so they look and work the same. Kept inside the window as it changes size.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
    estimatedSize, floatListEntries, lockEntry, LOCKED_TIP, moveFloating, openFloats, placeAt, resolvePlace, setFloating, toolbarsMenu,
    turnFloating, useFloatingToolbars, defaultPlace, type FloatCandidate, type FloatState, type Size,
} from './floatingToolbars';
import { ContextMenu, type MenuEntry } from './menus';
import { useSketcher } from './sketcher';
import { useStudio } from './state';
import type { ToolDef } from './toolDefs';
import { arrangeToolbars, type ArrangedToolbar, type ToolbarMode } from './toolbarLayout';
import { modeGroups } from './toolbarOptions';
import { useToolbarArrangement } from './toolbarStore';
import './floatingToolbars.css';

/** The main toolbar's button for a tool, with the display choices of the toolbar it comes from. */
export type RenderButton = (tool: ToolDef, toolbar: ArrangedToolbar) => ReactNode;

const windowSize = (): Size => (typeof window === 'undefined' ? { width: 1600, height: 900 } : { width: window.innerWidth, height: window.innerHeight });

function useViewport(): Size {
    const [view, setView] = useState(windowSize);
    useEffect(() => {
        const update = () => setView((old) => {
            const next = windowSize();
            return old.width === next.width && old.height === next.height ? old : next;
        });
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);
    return view;
}

interface Drag {
    id: number;
    /** From the pointer to the toolbar's top-left corner. */
    dx: number;
    dy: number;
    x0: number;
    y0: number;
    left: number;
    top: number;
    moved: boolean;
}

export interface FloatingBarProps {
    entry: FloatCandidate;
    state: FloatState;
    locked: boolean;
    view: Size;
    button: RenderButton;
    /** The mode's toolbars, for the list in its right-click menu. */
    toolbars: readonly ArrangedToolbar[];
}

/** One floating toolbar. */
export function FloatingBar({ entry, state, locked, view, button, toolbars }: FloatingBarProps) {
    const vertical = !!state.vertical;
    const root = useRef<HTMLDivElement | null>(null);
    const [measured, setMeasured] = useState<{ vertical: boolean; size: Size } | null>(null);
    const size = measured && measured.vertical === vertical ? measured.size : estimatedSize(entry.toolbar, entry.tools.length, vertical);
    const [drag, setDrag] = useState<Drag | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

    useLayoutEffect(() => {
        const element = root.current;
        if (!element) {
            return;
        }
        const read = () => setMeasured((old) => {
            const next = { vertical, size: { width: element.offsetWidth, height: element.offsetHeight } };
            return old && old.vertical === vertical && old.size.width === next.size.width && old.size.height === next.size.height ? old : next;
        });
        read();
        const observer = new ResizeObserver(read);
        observer.observe(element);
        return () => observer.disconnect();
    }, [vertical]);

    const at = drag ? { left: drag.left, top: drag.top } : resolvePlace(state.place ?? defaultPlace(0), size, view);
    const atRight = at.left + size.width / 2 > view.width / 2;
    const atBottom = at.top + size.height / 2 > view.height / 2;
    const dock = () => setFloating(entry.key, false);
    const turn = () => turnFloating(entry.key, at.left, at.top);
    const toolbar = entry.toolbar;
    const name = entry.family ? `${entry.label} (${toolbar.label})` : entry.label;

    const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || locked || (event.target as Element).closest('button')) {
            return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDrag({
            id: event.pointerId, dx: event.clientX - at.left, dy: event.clientY - at.top, x0: event.clientX, y0: event.clientY,
            left: at.left, top: at.top, moved: false,
        });
    };
    const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!drag || event.pointerId !== drag.id) {
            return;
        }
        const next = resolvePlace({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }, size, view);
        setDrag({ ...drag, ...next, moved: drag.moved || Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) > 2 });
    };
    const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!drag || event.pointerId !== drag.id) {
            return;
        }
        if (drag.moved) {
            moveFloating(entry.key, placeAt(drag.left, drag.top, size, view));
        }
        setDrag(null);
    };

    const menuItems = (): MenuEntry[] => [
        { header: name },
        { label: 'Horizontal', checked: !vertical, disabled: locked, title: locked ? LOCKED_TIP : 'Its tools in a row', onSelect: () => vertical && turn() },
        { label: 'Vertical', checked: vertical, disabled: locked, title: locked ? LOCKED_TIP : 'Its tools in a column', onSelect: () => !vertical && turn() },
        { label: 'Dock', disabled: locked, title: locked ? LOCKED_TIP : 'Close this floating toolbar; the main toolbar keeps its tools', onSelect: dock },
        'separator',
        { label: 'Floating toolbars', icon: 'toolbars', items: floatListEntries(toolbars) },
        lockEntry(),
    ];

    return (
        <>
            <div
                ref={root}
                className={`fltb ${vertical ? 'vertical' : ''} ${locked ? 'locked' : ''} ${drag?.moved ? 'dragging' : ''} ${atRight ? 'at-right' : ''} ${atBottom ? 'at-bottom' : ''}`}
                style={{ left: at.left, top: at.top }}
                role="toolbar"
                aria-label={name}
                aria-orientation={vertical ? 'vertical' : 'horizontal'}
                data-float={entry.key}
                onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY });
                }}
            >
                <div
                    className="fltb-title"
                    title={locked ? `${name} · ${LOCKED_TIP}` : `${name} · drag to move it, double-click to dock it`}
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                    onDoubleClick={(event) => {
                        if (!locked && !(event.target as Element).closest('button')) {
                            dock();
                        }
                    }}
                >
                    <span className="fltb-name">{entry.label}</span>
                    <button
                        type="button"
                        className="fltb-turn"
                        disabled={locked}
                        onClick={turn}
                        aria-label={vertical ? 'Turn into a row' : 'Turn into a column'}
                        title={locked ? LOCKED_TIP : vertical ? 'Turn into a row (horizontal)' : 'Turn into a column (vertical)'}
                    >
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                            {vertical ? <rect x="0.75" y="3.25" width="8.5" height="3.5" rx="1" /> : <rect x="3.25" y="0.75" width="3.5" height="8.5" rx="1" />}
                        </svg>
                    </button>
                    <button
                        type="button"
                        className="fltb-close"
                        disabled={locked}
                        onClick={dock}
                        aria-label={`Dock ${entry.label}`}
                        title={locked ? LOCKED_TIP : 'Dock: close this floating toolbar (the main toolbar keeps its tools)'}
                    >
                        ×
                    </button>
                </div>
                <div className={`tb-group g-${toolbar.id} tb-${toolbar.size} ${toolbar.labels ? 'tb-labels' : ''}`} role="group" aria-label={entry.label}>
                    {entry.tools.map((tool) => button(tool, toolbar))}
                </div>
            </div>
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
        </>
    );
}

/** Every open floating toolbar of the mode whose toolbars are given. */
export function FloatingToolbars({ toolbars, button }: { toolbars: readonly ArrangedToolbar[]; button: RenderButton }) {
    const floating = useFloatingToolbars((s) => s.floating);
    const locked = useFloatingToolbars((s) => s.locked);
    const view = useViewport();
    const shown = useMemo(() => openFloats(toolbars, floating), [toolbars, floating]);
    return (
        <>
            {shown.map((entry) => (
                <FloatingBar key={entry.key} entry={entry} state={floating[entry.key]} locked={locked} view={view} button={button} toolbars={toolbars} />
            ))}
        </>
    );
}

/** The mode the toolbar is in now: sketching, else the workspace. */
export function toolbarModeNow(): ToolbarMode {
    return useSketcher.getState().active ? 'sketch' : useStudio.getState().workspace;
}

/** View > Toolbars for the mode the app is in now (the view's right-click menu). */
export function viewToolbarsMenu(mode: ToolbarMode = toolbarModeNow()): MenuEntry {
    return toolbarsMenu(mode, arrangeToolbars(mode, modeGroups(mode), useToolbarArrangement.getState().arrangement));
}
