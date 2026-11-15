// Rename by two slow clicks on a tree item's name (SolidWorks FeatureManager): a click on the name of the item that
// is already the one selected starts renaming it, unless a second click follows quickly (a double-click).

import { useEffect, useRef } from 'react';

/** Longer than a double-click: the second click of a double-click comes sooner. */
const SLOW_MS = 550;

export function useSlowRename(start: (key: string) => void) {
    const timer = useRef<number | null>(null);
    const armed = useRef<string | null>(null);
    const cancel = () => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
        }
    };
    useEffect(() => cancel, []);
    return {
        /** Pointer down on an item: `alone` is whether it was already the only item selected. */
        down: (key: string, alone: boolean) => {
            armed.current = alone ? key : null;
        },
        /** The click that follows: on the name, without modifier keys. */
        click: (key: string, event: { target: EventTarget; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
            cancel();
            const onName = event.target instanceof Element && !!event.target.closest('.ft-name');
            if (armed.current === key && onName && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                timer.current = window.setTimeout(() => {
                    timer.current = null;
                    start(key);
                }, SLOW_MS);
            }
            armed.current = null;
        },
        cancel,
    };
}
