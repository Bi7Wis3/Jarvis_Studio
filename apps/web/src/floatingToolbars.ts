// Floating toolbars (SolidWorks: drag a toolbar away from the window border to float it; it gets a title bar, and a
// double-click on that docks it back). Here any toolbar, and any pulldown group of one (Add relation, Rectangle...),
// can also be opened as a toolbar of its own that floats over the view, its tools as plain buttons. The main toolbar
// keeps them too. Per mode (part, sketch, assembly) each floating toolbar keeps whether it is open, where it is and
// whether it runs across or down; "Lock toolbars" (SolidWorks: Lock CommandManager and toolbars) freezes them all.
// Kept in this browser's local storage as a quick cache and in the settings file (toolbarSync.ts).

import { create } from 'zustand';
import type { MenuEntry } from './menus';
import type { ToolDef } from './toolDefs';
import { toolbarItems, type ToolFamily } from './toolFamilies';
import { ICON_SIZES, LABEL_MAX_W, type ArrangedToolbar, type ToolbarMode } from './toolbarLayout';

/**
 * Where a floating toolbar is: `x` from the window's left edge to its left side, or with `right` from the right edge to
 * its right side; `y` likewise from the top, or the bottom. Measured from the nearest edges, so a toolbar keeps to
 * them when the window changes size.
 */
export interface FloatPlace {
    x: number;
    y: number;
    right?: boolean;
    bottom?: boolean;
}

export interface FloatState {
    open: boolean;
    /** Kept when it is closed, so it opens again where it was. */
    place?: FloatPlace;
    vertical?: boolean;
}

/** Every floating toolbar's state, by floatKey. */
export type FloatingSet = Record<string, FloatState>;

export interface Size {
    width: number;
    height: number;
}

/** A toolbar's key is its arrangement key (mode/toolbar); a pulldown group's adds the group: mode/toolbar/group. */
export const floatKey = (toolbar: Pick<ArrangedToolbar, 'key'>, family?: Pick<ToolFamily, 'id'> | null): string =>
    family ? `${toolbar.key}/${family.id}` : toolbar.key;

const modeOfKey = (key: string): string => key.split('/')[0];

/** What can float in a mode: each toolbar, and each pulldown group in it. */
export interface FloatCandidate {
    key: string;
    label: string;
    icon: string;
    /** The toolbar it is or belongs to: its icon size, text and tooltips are the floating toolbar's too. */
    toolbar: ArrangedToolbar;
    family: ToolFamily | null;
    tools: ToolDef[];
}

/** The pulldown groups of a toolbar (variants sharing one button), with the tools the toolbar has of each. */
export function toolbarGroups(toolbar: Pick<ArrangedToolbar, 'tools'>): { family: ToolFamily; tools: ToolDef[] }[] {
    return toolbarItems(toolbar.tools).flatMap((item) => ('family' in item ? [item] : []));
}

export function floatCandidates(toolbars: readonly ArrangedToolbar[]): FloatCandidate[] {
    return toolbars.flatMap((toolbar) => [
        { key: floatKey(toolbar), label: toolbar.label, icon: toolbar.icon, toolbar, family: null, tools: toolbar.tools },
        ...toolbarGroups(toolbar).map(({ family, tools }) => ({
            key: floatKey(toolbar, family), label: family.label, icon: tools[0].icon, toolbar, family, tools,
        })),
    ]);
}

/** The floating toolbars to draw: open, and with tools left on them. */
export function openFloats(toolbars: readonly ArrangedToolbar[], floating: FloatingSet): FloatCandidate[] {
    return floatCandidates(toolbars).filter((c) => floating[c.key]?.open && c.tools.length > 0);
}

// ---- Placing (pure: the window's size is passed in) -------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/** The toolbar's top-left corner in the window: kept inside it (its top-left first, where it does not fit). */
export function resolvePlace(place: FloatPlace, size: Size, view: Size): { left: number; top: number } {
    const left = place.right ? view.width - place.x - size.width : place.x;
    const top = place.bottom ? view.height - place.y - size.height : place.y;
    return { left: clamp(left, 0, view.width - size.width), top: clamp(top, 0, view.height - size.height) };
}

/** The place of a toolbar with its top-left corner at (left, top), measured from the edges nearest to it. */
export function placeAt(left: number, top: number, size: Size, view: Size): FloatPlace {
    const right = left + size.width / 2 > view.width / 2;
    const bottom = top + size.height / 2 > view.height / 2;
    return {
        x: Math.round(right ? view.width - left - size.width : left),
        y: Math.round(bottom ? view.height - top - size.height : top),
        ...(right ? { right: true } : {}),
        ...(bottom ? { bottom: true } : {}),
    };
}

/** Where a toolbar floated for the first time goes: right of the left panel, under the main toolbar, staggered. */
export function defaultPlace(order: number): FloatPlace {
    const step = 30 * (order % 8);
    return { x: 252 + step, y: 104 + step };
}

const TITLE_H = 19;
const PAD = 4;
const GAP = 2;
const BORDER = 2;
/** The narrowest a vertical toolbar is: room for its title bar's two buttons. */
const MIN_W = 46;

/** A floating toolbar's size from its buttons, until it has been measured on the page (matches floatingToolbars.css). */
export function estimatedSize(toolbar: Pick<ArrangedToolbar, 'size' | 'labels'>, count: number, vertical: boolean): Size {
    const button = ICON_SIZES[toolbar.size].button;
    const wide = toolbar.labels ? LABEL_MAX_W : button;
    const high = toolbar.labels ? button + 12 : button;
    const run = (each: number) => count * each + Math.max(0, count - 1) * GAP + 2 * PAD + BORDER;
    return vertical
        ? { width: Math.max(MIN_W, wide + 2 * PAD + BORDER), height: TITLE_H + run(high) }
        : { width: Math.max(MIN_W, run(wide)), height: TITLE_H + high + 2 * PAD + BORDER };
}

// ---- Changes (pure: each returns the new set) -----------------------------------------------------------------

/** Opened (where it was last, else at the next default place for its mode) or closed (its place kept). */
export function withFloating(floating: FloatingSet, key: string, open: boolean): FloatingSet {
    const was = floating[key];
    if (!open) {
        if (!was) {
            return floating;
        }
        const { [key]: _gone, ...rest } = floating;
        return was.place || was.vertical ? { ...rest, [key]: { ...was, open: false } } : rest;
    }
    const order = Object.entries(floating).filter(([k, s]) => s.open && modeOfKey(k) === modeOfKey(key)).length;
    return { ...floating, [key]: { ...was, open: true, place: was?.place ?? defaultPlace(order) } };
}

export function withPlace(floating: FloatingSet, key: string, place: FloatPlace): FloatingSet {
    const was = floating[key];
    return was ? { ...floating, [key]: { ...was, place } } : floating;
}

/** Turned from a row to a column or back, its top-left corner staying where it is (the window then keeps it inside). */
export function withTurn(floating: FloatingSet, key: string, left: number, top: number): FloatingSet {
    const was = floating[key];
    if (!was) {
        return floating;
    }
    const { vertical: _v, ...rest } = was;
    return { ...floating, [key]: { ...rest, place: { x: Math.round(left), y: Math.round(top) }, ...(was.vertical ? {} : { vertical: true }) } };
}

// ---- Kept (local storage; the settings file through toolbarSync.ts) --------------------------------------------

const KEY = 'jarvis.toolbars.floating';
const MAX_PX = 100000;

const number = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), -MAX_PX, MAX_PX) : null);

/** One toolbar's state, if it is well formed. */
export function cleanFloatState(raw: unknown): FloatState | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const v = raw as Record<string, unknown>;
    const out: FloatState = { open: v.open === true };
    const place = v.place && typeof v.place === 'object' ? v.place as Record<string, unknown> : null;
    const x = number(place?.x);
    const y = number(place?.y);
    if (x !== null && y !== null) {
        out.place = { x, y, ...(place!.right === true ? { right: true } : {}), ...(place!.bottom === true ? { bottom: true } : {}) };
    }
    if (v.vertical === true) {
        out.vertical = true;
    }
    return out.open || out.place || out.vertical ? out : null;
}

/** Keeps only well-formed entries with a key of the form mode/toolbar or mode/toolbar/group. */
export function cleanFloating(raw: unknown): FloatingSet {
    const out: FloatingSet = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return out;
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const state = /^(part|sketch|assembly)(\/[^/]+){1,2}$/.test(key) ? cleanFloatState(value) : null;
        if (state) {
            out[key] = state;
        }
    }
    return out;
}

export interface FloatingStore {
    floating: FloatingSet;
    /** Lock toolbars: none can be floated, docked, moved or turned. */
    locked: boolean;
}

export function loadFloating(): FloatingStore {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
        return { floating: cleanFloating(raw?.floating), locked: raw?.locked === true };
    } catch {
        return { floating: {}, locked: false };
    }
}

export function saveFloating(state: FloatingStore): void {
    try {
        if (Object.keys(state.floating).length || state.locked) {
            localStorage.setItem(KEY, JSON.stringify({ floating: state.floating, ...(state.locked ? { locked: true } : {}) }));
        } else {
            localStorage.removeItem(KEY);
        }
    } catch {
        // Private mode or no storage: it lasts for this visit only.
    }
}

export const useFloatingToolbars = create<FloatingStore>(() => loadFloating());

function update(change: Partial<FloatingStore>): void {
    useFloatingToolbars.setState(change);
    saveFloating(useFloatingToolbars.getState());
}

export function setFloating(key: string, open: boolean): void {
    update({ floating: withFloating(useFloatingToolbars.getState().floating, key, open) });
}

export function moveFloating(key: string, place: FloatPlace): void {
    update({ floating: withPlace(useFloatingToolbars.getState().floating, key, place) });
}

export function turnFloating(key: string, left: number, top: number): void {
    update({ floating: withTurn(useFloatingToolbars.getState().floating, key, left, top) });
}

export function setToolbarsLocked(locked: boolean): void {
    update({ locked });
}

/** Every floating toolbar closed and forgotten, and the lock off (Reset all toolbars). */
export function resetFloating(): void {
    update({ floating: {}, locked: false });
}

/** Replaces the whole state (settings loaded from the server). */
export function replaceFloating(state: FloatingStore): void {
    update({ floating: state.floating, locked: state.locked });
}

// ---- Menus ------------------------------------------------------------------------------------------------------

export const LOCKED_TIP = 'Toolbars are locked: clear Lock toolbars to float, dock or move them';

/** What a right-click on the main toolbar landed on: a toolbar, and a pulldown in it. */
export interface FloatTarget {
    toolbarId?: string;
    familyId?: string;
}

/** The toolbar and pulldown under a right-click (Toolbar.tsx marks them with data-toolbar and data-family). */
export function floatTargetOf(target: EventTarget | null): FloatTarget {
    const element = target as Element | null;
    const toolbarId = element?.closest?.('[data-toolbar]')?.getAttribute('data-toolbar') ?? undefined;
    const familyId = element?.closest?.('[data-family]')?.getAttribute('data-family') ?? undefined;
    return { ...(toolbarId ? { toolbarId } : {}), ...(familyId ? { familyId } : {}) };
}

interface MenuState {
    floating: FloatingSet;
    locked: boolean;
}

const nowState = (): MenuState => useFloatingToolbars.getState();

function floatEntry(c: FloatCandidate, s: MenuState, label = c.label): MenuEntry {
    const on = !!s.floating[c.key]?.open;
    return {
        label,
        checked: on,
        disabled: s.locked,
        title: s.locked ? LOCKED_TIP
            : on ? 'Floating: click to dock it (the main toolbar keeps its tools)' : `${c.label}: ${c.tools.map((t) => t.label).join(', ')}`,
        onSelect: () => setFloating(c.key, !on),
    };
}

/**
 * Every toolbar of the mode and every pulldown group in it, floating ones ticked (SolidWorks: View > Toolbars, and the
 * window border's right-click Toolbars list): the toolbars first, then a submenu of groups per toolbar that has any.
 */
export function floatListEntries(toolbars: readonly ArrangedToolbar[], s: MenuState = nowState()): MenuEntry[] {
    const candidates = floatCandidates(toolbars);
    const out: MenuEntry[] = [{ header: 'Float as a toolbar' }, ...candidates.filter((c) => !c.family).map((c) => floatEntry(c, s))];
    for (const toolbar of toolbars) {
        const groups = candidates.filter((c) => c.family && c.toolbar === toolbar);
        if (groups.length) {
            const floatingCount = groups.filter((c) => s.floating[c.key]?.open).length;
            out.push({
                label: `${toolbar.label} groups`,
                icon: toolbar.icon,
                title: floatingCount ? `${floatingCount} floating` : 'Pulldown groups of this toolbar, each as a toolbar of its own',
                items: [{ header: `Pulldown groups of ${toolbar.label}` }, ...groups.map((c) => floatEntry(c, s))],
            });
        }
    }
    return out;
}

export const lockEntry = (s: MenuState = nowState()): MenuEntry => ({
    label: 'Lock toolbars',
    checked: s.locked,
    title: s.locked ? 'Locked: floating toolbars stay where they are, docked ones stay docked' : 'Keep every toolbar where it is',
    onSelect: () => setToolbarsLocked(!s.locked),
});

/** The View menu's Toolbars submenu: the list above, and Lock toolbars. */
export function toolbarsMenu(mode: ToolbarMode, toolbars: readonly ArrangedToolbar[], s: MenuState = nowState()): MenuEntry {
    const names: Record<ToolbarMode, string> = { part: 'part', sketch: 'sketch', assembly: 'assembly' };
    return {
        label: 'Toolbars',
        icon: 'toolbars',
        title: `Float any ${names[mode]} toolbar, or a pulldown group of one, as a toolbar of its own`,
        items: [...floatListEntries(toolbars, s), 'separator', lockEntry(s)],
    };
}

/**
 * The floating entries of the main toolbar's right-click menu: float the toolbar right-clicked and, on a pulldown, its
 * group; then every toolbar and group, and Lock toolbars.
 */
export function toolbarFloatEntries(toolbars: readonly ArrangedToolbar[], target: FloatTarget, s: MenuState = nowState()): MenuEntry[] {
    const toolbar = toolbars.find((t) => t.id === target.toolbarId);
    const candidates = toolbar ? floatCandidates([toolbar]) : [];
    const whole = candidates.find((c) => !c.family);
    const group = target.familyId ? candidates.find((c) => c.family?.id === target.familyId) : undefined;
    return [
        ...(whole ? [floatEntry(whole, s, 'Float as toolbar')] : []),
        ...(group ? [floatEntry(group, s, 'Float this group as a toolbar')] : []),
        { label: 'Floating toolbars', icon: 'toolbars', items: floatListEntries(toolbars, s) },
        lockEntry(s),
        'separator',
    ];
}
