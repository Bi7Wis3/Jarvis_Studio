// Toolbars the user arranges (SolidWorks: Tools > Customize, Toolbars and Commands tabs). Per mode (part, sketch,
// assembly) each toolbar can be shown or hidden, and has its own tools in its own order, an icon size, text under
// the icons or not, and variants as one flyout button or as separate buttons. The tool lists stay in toolDefs.tsx
// (the groups): an arrangement only selects and orders tools of its mode. Pure, so it can be tested.

import { toolbarItems, type ToolbarItem } from './toolFamilies';
import type { ToolDef, ToolGroup } from './toolDefs';

export type ToolbarMode = 'part' | 'sketch' | 'assembly';
export type IconSize = 'small' | 'medium' | 'large';
export type FamilyStyle = 'flyout' | 'separate';
/** Tooltips: the name with what the tool does and its key, the name only, or none (SolidWorks: large, small, off). */
export type TipStyle = 'full' | 'name' | 'off';

export const TOOLBAR_MODES: { value: ToolbarMode; label: string }[] = [
    { value: 'part', label: 'Part' }, { value: 'sketch', label: 'Sketch' }, { value: 'assembly', label: 'Assembly' },
];

/** One toolbar's choices; anything left out is the default. */
export interface ToolbarPrefs {
    hidden?: boolean;
    /** The tools shown, by id, in order, once changed from the default. */
    tools?: string[];
    /** The default list when `tools` was set: a tool added to the toolbar's defaults later is shown too. */
    base?: string[];
    size?: IconSize;
    labels?: boolean;
    families?: FamilyStyle;
    tips?: TipStyle;
}

/** Every toolbar's choices, by toolbarKey. */
export type ToolbarArrangement = Record<string, ToolbarPrefs>;

export const toolbarKey = (mode: ToolbarMode, toolbarId: string): string => `${mode}/${toolbarId}`;

/** A toolbar as the bar draws it: its group with the tools chosen, and its display choices. */
export interface ArrangedToolbar extends ToolGroup {
    key: string;
    hidden: boolean;
    size: IconSize;
    labels: boolean;
    families: FamilyStyle;
    tips: TipStyle;
    /** Whether anything differs from the default. */
    customised: boolean;
}

/** Every tool the mode's toolbars have by default, once each, in toolbar order: what a toolbar can be given. */
export function modeTools(groups: readonly ToolGroup[]): ToolDef[] {
    const seen = new Map<string, ToolDef>();
    for (const group of groups) {
        for (const tool of group.tools) {
            if (!seen.has(tool.id)) {
                seen.set(tool.id, tool);
            }
        }
    }
    return [...seen.values()];
}

/**
 * The ids a toolbar shows: the default list until it was changed; then the chosen ids that still exist, with tools
 * added to the defaults since then put in after the tool before them in the defaults (else first).
 */
export function arrangedIds(defaults: readonly string[], known: ReadonlySet<string>, prefs?: ToolbarPrefs): string[] {
    if (!prefs?.tools) {
        return [...defaults];
    }
    const out = [...new Set(prefs.tools.filter((id) => known.has(id)))];
    const base = new Set(prefs.base ?? defaults);
    defaults.forEach((id, i) => {
        if (base.has(id) || out.includes(id)) {
            return;
        }
        const before = defaults.slice(0, i).reverse().find((d) => out.includes(d));
        out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, id);
    });
    return out;
}

/** The mode's toolbars with their arrangement applied (hidden ones included, flagged). */
export function arrangeToolbars(mode: ToolbarMode, groups: readonly ToolGroup[], arrangement: ToolbarArrangement): ArrangedToolbar[] {
    const tools = new Map(modeTools(groups).map((t) => [t.id, t]));
    const known = new Set(tools.keys());
    return groups.map((group) => {
        const key = toolbarKey(mode, group.id);
        const prefs = arrangement[key];
        const ids = arrangedIds(group.tools.map((t) => t.id), known, prefs);
        return {
            ...group,
            tools: ids.map((id) => tools.get(id)!),
            key,
            hidden: !!prefs?.hidden,
            size: prefs?.size ?? 'medium',
            labels: !!prefs?.labels,
            families: prefs?.families ?? 'flyout',
            tips: prefs?.tips ?? 'full',
            customised: !!prefs && Object.keys(prefs).length > 0,
        };
    });
}

/** The buttons of a toolbar: families as one flyout button each, or every tool on its own. */
export function arrangedItems(toolbar: Pick<ArrangedToolbar, 'tools' | 'families'>): ToolbarItem[] {
    return toolbar.families === 'separate' ? toolbar.tools.map((tool) => ({ tool })) : toolbarItems(toolbar.tools);
}

// ---- Changes (each returns the toolbar's new choices) --------------------------------------------------------

/** Clean choices: what equals the default is left out, so a reset toolbar stores nothing. */
function tidyPrefs(prefs: ToolbarPrefs): ToolbarPrefs {
    const out: ToolbarPrefs = {};
    if (prefs.hidden) out.hidden = true;
    if (prefs.tools) {
        out.tools = prefs.tools;
        out.base = prefs.base;
    }
    if (prefs.size && prefs.size !== 'medium') out.size = prefs.size;
    if (prefs.labels) out.labels = true;
    if (prefs.families === 'separate') out.families = 'separate';
    if (prefs.tips && prefs.tips !== 'full') out.tips = prefs.tips;
    return out;
}

/** The toolbar showing `ids` (the default list again drops the custom one). */
export function withTools(prefs: ToolbarPrefs | undefined, defaults: readonly string[], ids: readonly string[]): ToolbarPrefs {
    const same = ids.length === defaults.length && ids.every((id, i) => id === defaults[i]);
    const { tools: _tools, base: _base, ...rest } = prefs ?? {};
    return tidyPrefs(same ? rest : { ...rest, tools: [...ids], base: [...defaults] });
}

export function withOption<K extends 'hidden' | 'size' | 'labels' | 'families' | 'tips'>(prefs: ToolbarPrefs | undefined, key: K,
    value: ToolbarPrefs[K]): ToolbarPrefs {
    return tidyPrefs({ ...prefs, [key]: value });
}

/** `id` added at `at` (default: the end); a tool already on the toolbar is not added twice. */
export function addedTool(ids: readonly string[], id: string, at = ids.length): string[] {
    if (ids.includes(id)) {
        return [...ids];
    }
    const out = [...ids];
    out.splice(Math.max(0, Math.min(at, out.length)), 0, id);
    return out;
}

export const removedTool = (ids: readonly string[], index: number): string[] => ids.filter((_, i) => i !== index);

/** The tool at `from` put where the tool at `to` is (the others shift up or down). */
export function movedTool(ids: readonly string[], from: number, to: number): string[] {
    const out = [...ids];
    if (from < 0 || from >= out.length) {
        return out;
    }
    const [id] = out.splice(from, 1);
    out.splice(Math.max(0, Math.min(to, out.length)), 0, id);
    return out;
}

// ---- Width, to decide which toolbars collapse into menus (matches toolbar.css) ------------------------------

export const ICON_SIZES: Record<IconSize, { button: number; icon: number }> = {
    small: { button: 24, icon: 15 },
    medium: { button: 28, icon: 18 },
    large: { button: 36, icon: 24 },
};
const BUTTON_GAP = 2;
const GROUP_PAD = 9;
const ARROW_W = 12;
/** Text under an icon: about this much per letter, cut off at the most. */
const LABEL_CHAR_W = 5.4;
export const LABEL_MAX_W = 64;

/** A button's width: its icon's, or wider for the text under it. */
export function buttonWidth(tool: Pick<ToolDef, 'label'>, size: IconSize, labels: boolean): number {
    const button = ICON_SIZES[size].button;
    return labels ? Math.max(button, Math.min(LABEL_MAX_W, tool.label.length * LABEL_CHAR_W + 8)) : button;
}

/** A toolbar's width with every button showing. */
export function toolbarWidth(toolbar: Pick<ArrangedToolbar, 'tools' | 'families' | 'size' | 'labels'>, shown?: (family: ToolbarItem) => ToolDef): number {
    const items = arrangedItems(toolbar);
    if (items.length === 0) {
        return 0;
    }
    const widths = items.map((item) => ('family' in item
        ? buttonWidth(shown?.(item) ?? item.tools[0], toolbar.size, toolbar.labels) + ARROW_W
        : buttonWidth(item.tool, toolbar.size, toolbar.labels)));
    return widths.reduce((a, b) => a + b, 0) + (items.length - 1) * BUTTON_GAP + GROUP_PAD;
}

// ---- Fitting the toolbars into the band at the top --------------------------------------------------------

/** A toolbar's widths as drawn (measured in the page, or estimated until it has been). */
export interface BarWidths {
    id: string;
    /** Lower folds first; none: folds only after every toolbar that has one, from the end of the bar. */
    collapse?: number;
    /** With every button. */
    full: number;
    /** Folded into one menu button. */
    menu: number;
    /** Folded, with its name beside the icon. */
    named: number;
    /** Each button's share of `full`, the gap after it included, in order; the rest of `full` is the group's padding. */
    items: number[];
    /** The overflow button that lists the buttons left out. */
    more: number;
}

export type FitLayout =
    | { kind: 'hidden' }
    /** One menu for everything; the part's name only where it still fits. */
    | { kind: 'all'; showActive: boolean }
    | {
        kind: 'groups'; collapsed: Set<string>; named: Set<string>;
        /** The most important folded toolbar still shows its first `count` buttons, the rest behind an overflow button. */
        partial: { id: string; count: number } | null;
        showActive: boolean;
    };

const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);

/**
 * Which toolbars fold into menus so the bar fits `room`: none while all fit; else the least important first (by
 * `collapse`, then those without one from the end of the bar), only as many as needed. The most important one that had
 * to fold keeps the buttons that still fit; folded ones show their names where there is room; the part's name
 * (`reserved` wide) last. `fixed`: the bar's own padding and the workspace switch; `allMenu`: one menu for everything.
 */
export function fitToolbars(bars: readonly BarWidths[], fixed: number, room: number, reserved: number, allMenu: number): FitLayout {
    const collapsed = new Set<string>();
    const total = () => fixed + sum(bars.map((b) => (collapsed.has(b.id) ? b.menu : b.full)));
    const order = [
        ...bars.filter((b) => b.collapse !== undefined).sort((a, b) => a.collapse! - b.collapse!),
        ...bars.filter((b) => b.collapse === undefined).reverse(),
    ];
    const folded: BarWidths[] = [];
    for (const bar of order) {
        if (total() <= room) {
            break;
        }
        collapsed.add(bar.id);
        folded.push(bar);
    }
    if (total() > room) {
        return room >= fixed + allMenu ? { kind: 'all', showActive: room >= fixed + allMenu + reserved } : { kind: 'hidden' };
    }
    let used = total();
    let partial: { id: string; count: number } | null = null;
    const last = folded[folded.length - 1];
    if (last && last.items.length > 1) {
        const spare = room - used + last.menu;
        let width = last.full - sum(last.items) + last.more;
        let count = 0;
        while (count < last.items.length - 1 && width + last.items[count] <= spare) {
            width += last.items[count];
            count += 1;
        }
        // One button and the overflow say less than the named menu: at least two, or it stays folded.
        if (count >= 2) {
            partial = { id: last.id, count };
            collapsed.delete(last.id);
            used += width - last.menu;
        }
    }
    // A menu that shows only an icon hides what is in it: name the folded toolbars while there is room.
    const named = new Set<string>();
    for (const bar of bars.filter((b) => collapsed.has(b.id))) {
        if (used + bar.named - bar.menu <= room) {
            named.add(bar.id);
            used += bar.named - bar.menu;
        }
    }
    return { kind: 'groups', collapsed, named, partial, showActive: used + reserved <= room };
}

const MENU_W = 38;
const LABEL_GAP = 5;
const MENU_CHAR_W = 6.6;
const MORE_W = 20;

/** Widths from the CSS sizes, for the first frame before the toolbar has been measured. */
export function estimatedWidths(toolbar: ArrangedToolbar): BarWidths {
    const items = arrangedItems(toolbar).map((item, i, all) => ('family' in item
        ? buttonWidth(item.tools[0], toolbar.size, toolbar.labels) + ARROW_W
        : buttonWidth(item.tool, toolbar.size, toolbar.labels)) + (i < all.length - 1 ? BUTTON_GAP : 0));
    const menu = MENU_W + GROUP_PAD;
    return {
        id: toolbar.id, collapse: toolbar.collapse, full: toolbarWidth(toolbar), menu,
        named: menu + LABEL_GAP + (toolbar.short ?? toolbar.label).length * MENU_CHAR_W, items, more: MORE_W,
    };
}
