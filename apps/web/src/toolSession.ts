// The tool form that is open right now, for code outside the form (the 3D drag handles): its tool, values,
// context and a setter that goes through the form's own change path (onChange hooks, live preview).

import { create } from 'zustand';
import type { Ctx, Values } from './toolDefs';

export interface ToolSession {
    toolId: string | null;
    values: Values;
    ctx: Ctx | null;
    set: ((patch: Values) => void) | null;
    /** Identifies the form that published, so an old form closing does not clear a newer one. */
    owner: symbol | null;
}

export const useToolSession = create<ToolSession>(() => ({ toolId: null, values: {}, ctx: null, set: null, owner: null }));

export function publishToolSession(owner: symbol, session: Omit<ToolSession, 'owner'>): void {
    useToolSession.setState({ ...session, owner });
}

export function clearToolSession(owner: symbol): void {
    if (useToolSession.getState().owner === owner) {
        useToolSession.setState({ toolId: null, values: {}, ctx: null, set: null, owner: null });
    }
}

/**
 * Values a tool's form opens with instead of its defaults, set just before it is opened from elsewhere (a right-click
 * menu: Axis through a cylindrical face, Extrude of one sketch). Read as the form opens; it expires shortly after, so
 * a later opening of the same tool starts from the defaults again.
 */
let preset: { toolId: string; values: Values; until: number } | null = null;

export function presetToolValues(toolId: string, values: Values, ms = 1500): void {
    preset = { toolId, values, until: Date.now() + ms };
}

export function toolPreset(toolId: string): Values {
    return preset && preset.toolId === toolId && Date.now() <= preset.until ? preset.values : {};
}
