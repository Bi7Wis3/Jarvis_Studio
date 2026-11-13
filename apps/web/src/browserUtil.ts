// Shared bits of the browser panel: remembered panel state and context menu placement.

import type { MouseEvent } from 'react';
import type { MenuEntry } from './menus';

/** Stable empty list for store selectors: a fresh [] each time would re-render forever. */
export const NONE: string[] = [];

export const STORAGE_KEY = 'jarvis.browser';

export function load(key: string, fallback: string): string {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

export function store(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: the panel just forgets its state
    }
}

export type Menu = { x: number; y: number; items: MenuEntry[] } | null;

export function menuAt(event: MouseEvent, items: MenuEntry[]): Menu {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget.getBoundingClientRect();
    // Right-click opens at the pointer; a ⋯ button opens under itself.
    return event.type === 'contextmenu'
        ? { x: event.clientX, y: event.clientY, items }
        : { x: target.left, y: target.bottom + 2, items };
}
