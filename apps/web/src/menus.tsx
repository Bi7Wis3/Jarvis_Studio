// Small shared UI pieces for the browser panel and the File menu: context menus, inline inputs, tool calls.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';
import { runTool, useStudio } from './state';
import './browser.css';

/**
 * One line of a context menu. `icon`: the toolbar icon of the same command; `title`: the tooltip (for a disabled
 * entry, why it cannot be used now); `checked`: a setting that is on. `items` makes a submenu, `header` a greyed
 * heading naming what was clicked.
 */
export type MenuEntry =
    | {
        label: string; onSelect: () => void; hint?: string; danger?: boolean; disabled?: boolean; icon?: string; title?: string;
        checked?: boolean;
    }
    | { label: string; items: MenuEntry[]; icon?: string; title?: string; disabled?: boolean }
    | { header: string }
    | 'separator';

/** Shows a short message in the app's error bubble, like server errors. */
export function showError(message: string): void {
    useStudio.setState({ error: message });
    window.setTimeout(() => {
        if (useStudio.getState().error === message) {
            useStudio.setState({ error: null });
        }
    }, 8000);
}

/** Runs a server tool and surfaces a failure in the error bubble. */
export async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const result = await runTool(name, args);
    if (result.isError) {
        showError(result.text);
    }
    return result;
}

/** Calls onClose on a pointer press outside `ref` or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, active = true): void {
    useEffect(() => {
        if (!active) {
            return;
        }
        const onDown = (event: PointerEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [ref, onClose, active]);
}

/**
 * A floating menu at a screen point (right-click or a ⋯ button), kept inside the window. It is rendered on the
 * page body: inside a panel with a backdrop blur, a fixed position would be measured from that panel, not the window.
 * Esc or a press outside it (and outside its submenus) closes it.
 */
export function ContextMenu(props: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
    const { onClose } = props;
    useEffect(() => {
        const onDown = (event: PointerEvent) => {
            if (!(event.target as Element | null)?.closest?.('.ctx-menu')) {
                onClose();
            }
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [onClose]);
    return <MenuBox {...props} />;
}

/** The menu's box at (x, y), or for a submenu beside the entry that opened it (`beside`: that entry's rectangle). */
function MenuBox(props: { x: number; y: number; items: MenuEntry[]; onClose: () => void; beside?: DOMRect }) {
    const { x, y, items, onClose, beside } = props;
    const box = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ x, y });
    const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
    useLayoutEffect(() => {
        const rect = box.current?.getBoundingClientRect();
        if (!rect) {
            return;
        }
        if (beside) {
            // Right of the entry, else left of it when the window ends first.
            const right = beside.right + 2;
            setPos({
                x: right + rect.width + 8 <= window.innerWidth ? right : Math.max(4, beside.left - rect.width - 2),
                y: Math.max(4, Math.min(beside.top - 4, window.innerHeight - rect.height - 8)),
            });
        } else {
            setPos({
                x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)),
                y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)),
            });
        }
    }, [x, y, beside]);
    // A column for icons and ticks when any entry has one, so the labels line up.
    const lead = items.some((item) => typeof item === 'object' && !('header' in item) && (item.icon || ('checked' in item && item.checked !== undefined)));
    const subItems = sub ? items[sub.index] : null;
    return (
        <>
            {createPortal(
                <div ref={box} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
                    {items.map((item, i) => {
                        if (item === 'separator') {
                            return <div key={i} className="ctx-sep" role="separator" />;
                        }
                        if ('header' in item) {
                            return <div key={i} className="ctx-head" role="presentation">{item.header}</div>;
                        }
                        const disabled = !!item.disabled;
                        const icon = lead && (
                            <span className="ctx-icon" aria-hidden="true">
                                {'checked' in item && item.checked !== undefined
                                    ? (item.checked ? '✓' : '')
                                    : item.icon ? <Icon name={item.icon} size={15} /> : null}
                            </span>
                        );
                        if ('items' in item) {
                            return (
                                <button
                                    key={i}
                                    type="button"
                                    role="menuitem"
                                    aria-haspopup="menu"
                                    aria-expanded={sub?.index === i}
                                    aria-disabled={disabled || undefined}
                                    className={`${disabled ? 'off' : ''} ${sub?.index === i ? 'open' : ''}`}
                                    title={item.title}
                                    onPointerEnter={(e) => !disabled && setSub({ index: i, rect: e.currentTarget.getBoundingClientRect() })}
                                    onClick={(e) => !disabled && setSub({ index: i, rect: e.currentTarget.getBoundingClientRect() })}
                                >
                                    {icon}
                                    <span className="ctx-label">{item.label}</span>
                                    <span className="hint">▸</span>
                                </button>
                            );
                        }
                        return (
                            <button
                                key={i}
                                type="button"
                                role={'checked' in item && item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                                aria-checked={'checked' in item && item.checked !== undefined ? item.checked : undefined}
                                aria-disabled={disabled || undefined}
                                className={`${item.danger ? 'danger' : ''} ${disabled ? 'off' : ''}`}
                                title={item.title}
                                onPointerEnter={() => setSub(null)}
                                onClick={() => {
                                    if (disabled) {
                                        return;
                                    }
                                    onClose();
                                    item.onSelect();
                                }}
                            >
                                {icon}
                                <span className="ctx-label">{item.label}</span>
                                {item.hint && <span className="hint">{item.hint}</span>}
                            </button>
                        );
                    })}
                </div>,
                document.body,
            )}
            {sub && subItems && typeof subItems === 'object' && 'items' in subItems && (
                <MenuBox x={sub.rect.right} y={sub.rect.top} items={subItems.items} onClose={onClose} beside={sub.rect} />
            )}
        </>
    );
}

/** Text field that edits in place: Enter or leaving the field commits, Escape cancels. */
export function InlineInput(props: {
    value: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
    label: string;
    className?: string;
    style?: CSSProperties;
}) {
    const { value, onCommit, onCancel, label, className, style } = props;
    const [text, setText] = useState(value);
    const done = useRef(false);
    const finish = (commit: boolean) => {
        if (done.current) {
            return;
        }
        done.current = true;
        const next = text.trim();
        if (commit && next && next !== value) {
            onCommit(next);
        } else {
            onCancel();
        }
    };
    return (
        <input
            className={`inline-input ${className ?? ''}`}
            style={style}
            autoFocus
            onFocus={(event) => event.target.select()}
            value={text}
            maxLength={80}
            aria-label={label}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                    finish(true);
                } else if (event.key === 'Escape') {
                    finish(false);
                }
            }}
            onBlur={() => finish(true)}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        />
    );
}

/** Is the user typing in a field (so global shortcuts leave the key alone)? An empty text field does not count. */
export function typingInField(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) {
        return false;
    }
    if (el instanceof HTMLInputElement) {
        return el.value !== '';
    }
    return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
