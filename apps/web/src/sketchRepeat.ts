// Enter in an idle sketch repeats the last command (SolidWorks keyboard shortcuts: "Enter: Repeats the last
// command"); it never leaves the sketch. The last command is the last draw, modify, relation or 2D-to-3D tool
// opened or switched on: a form opens again, a tool such as Line or Dimension is switched on again. Toggles and
// one-off actions (show handles, dynamic mirror, rebuild) are not repeated.

import { SKETCH_GROUPS, type Ctx, type ToolDef, type UiSettings } from './toolDefs';
import { useSketcher, type SketchTool } from './sketcher';

const REPEATABLE_GROUPS = ['draw', 'modify', 'constrain', '2d-to-3d'];

let repeatable: ToolDef[] | null = null;
const tools = (): ToolDef[] => (repeatable ??= SKETCH_GROUPS.filter((g) => REPEATABLE_GROUPS.includes(g.id)).flatMap((g) => g.tools));

let last: string | null = null;
const NO_CTX: Ctx = { part: null, project: null, edit: null };

const settingsWith = (sketchTool: SketchTool): UiSettings => ({ grid: false, edges: false, perspective: false, showOthers: false, sketchTool });

/** Whether `tool` is the button of the sketcher tool `on`: on with it, off with Select (a toggle is on either way). */
function switchesOn(tool: ToolDef, on: SketchTool, ctx: Ctx): boolean {
    return on !== 'select' && !!tool.active?.(ctx, settingsWith(on)) && !tool.active(ctx, settingsWith('select'));
}

/** A toolbar tool was run in the sketch (its form opened, or its instant action done). */
export function noteSketchCommand(tool: ToolDef, ctx: Ctx = NO_CTX): void {
    const s = useSketcher.getState();
    if (!s.active || !tools().some((t) => t.id === tool.id)) {
        return;
    }
    if (tool.instant && !tool.popupIf?.(ctx) && !switchesOn(tool, s.tool, ctx)) {
        return;
    }
    last = tool.id;
}

/** The tool id Enter repeats, or null before any command. */
export function lastSketchCommand(): string | null {
    return last;
}

/** For tests: forget the last command. */
export function forgetSketchCommand(): void {
    last = null;
}

// A sketcher tool switched on some other way (a shortcut, a menu, the Line tool a new sketch starts with) is the last
// command too, unless the last one noted is already that tool (Horizontal dimension switches Dimension on).
useSketcher.subscribe((s, prev) => {
    if (!s.active || s.tool === prev.tool || s.tool === 'select') {
        return;
    }
    const known = last ? tools().find((t) => t.id === last) : undefined;
    if (known && switchesOn(known, s.tool, NO_CTX)) {
        return;
    }
    const tool = tools().find((t) => switchesOn(t, s.tool, NO_CTX));
    if (tool) {
        last = tool.id;
    }
});
