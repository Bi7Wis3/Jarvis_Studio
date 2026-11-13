// Small shared UI pieces for the browser panel and the File menu: context menus, inline inputs, tool calls.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { runTool, useStudio } from './state';
import './browser.css';

export type MenuEntry =
    | { label: string; onSelect: () => void; hint?: string; danger?: boolean; disabled?: boolean }
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

/** A floating menu at a screen point (right-click or a ⋯ button), kept inside the window. */
export function ContextMenu(props: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
    const { x, y, items, onClose } = props;
    const box = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ x, y });
    useDismiss(box, onClose);
    useLayoutEffect(() => {
        const rect = box.current?.getBoundingClientRect();
        if (rect) {
            setPos({
                x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)),
                y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)),
            });
        }
    }, [x, y]);
    return (
        <div ref={box} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }}>
            {items.map((item, i) => (item === 'separator'
                ? <div key={i} className="ctx-sep" role="separator" />
                : (
                    <button
                        key={i}
                        type="button"
                        role="menuitem"
                        className={item.danger ? 'danger' : ''}
                        disabled={item.disabled}
                        onClick={() => {
                            onClose();
                            item.onSelect();
                        }}
                    >
                        <span>{item.label}</span>
                        {item.hint && <span className="hint">{item.hint}</span>}
                    </button>
                )))}
        </div>
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
