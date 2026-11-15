// How the 3D view draws the model: SolidWorks' display styles (View > Display: Shaded With Edges, Shaded, Hidden
// Lines Removed, Hidden Lines Visible, Wireframe), the whole model see-through, and how hidden edges are drawn
// (System Options > Display: Hidden edges displayed as Solid or Dashed). Kept with the Options page's display settings
// (optionsSync.ts saves and applies them); Shaded with edges against Shaded is the same switch as Show model edges.

import { create } from 'zustand';
import type { DisplayStyle } from '@jarvis/core/settings';
import { SEE_THROUGH } from './bodyView';
import { useStudio } from './state';

export type { DisplayStyle } from '@jarvis/core/settings';

export interface DisplayStyleSettings {
    style: DisplayStyle;
    /** The whole model drawn see-through, in the shaded styles. */
    seeThrough: boolean;
    /** Hidden edges in Hidden lines visible: dashed (as SolidWorks draws them by default) or solid, in grey. */
    hiddenEdges: 'dashed' | 'solid';
}

export const DEFAULT_DISPLAY: DisplayStyleSettings = { style: 'shadedEdges', seeThrough: false, hiddenEdges: 'dashed' };

/** The styles in SolidWorks' order, with the text the toolbar shows. */
export const DISPLAY_STYLES: { id: DisplayStyle; label: string; hint: string }[] = [
    { id: 'shadedEdges', label: 'Shaded with edges', hint: 'shaded, with the visible edges drawn' },
    { id: 'shaded', label: 'Shaded', hint: 'shaded, without edges' },
    { id: 'hiddenRemoved', label: 'Hidden lines removed', hint: 'edges only, without the ones behind the model' },
    { id: 'hiddenVisible', label: 'Hidden lines visible', hint: 'edges only, the ones behind the model in grey' },
    { id: 'wireframe', label: 'Wireframe', hint: 'all edges, the model see-through' },
];

export const useDisplayStyle = create<DisplayStyleSettings>(() => ({ ...DEFAULT_DISPLAY }));

/** The settings for this session; optionsSync.ts saves them with the Options page's display settings. */
export function setDisplay(patch: Partial<DisplayStyleSettings>): void {
    const now = useDisplayStyle.getState();
    if (Object.entries(patch).some(([key, value]) => now[key as keyof DisplayStyleSettings] !== value)) {
        useDisplayStyle.setState(patch);
    }
}

export const setDisplayStyle = (style: DisplayStyle): void => setDisplay({ style });
export const toggleSeeThrough = (): void => setDisplay({ seeThrough: !useDisplayStyle.getState().seeThrough });

// Show model edges (the Options page, the view menu's Edges) is Shaded with edges against Shaded.
const edgesOf = (style: DisplayStyle): boolean | null => (style === 'shadedEdges' ? true : style === 'shaded' ? false : null);
useDisplayStyle.subscribe((s, prev) => {
    const edges = edgesOf(s.style);
    if (s.style !== prev.style && edges !== null && useStudio.getState().edges !== edges) {
        useStudio.setState({ edges });
    }
});
useStudio.subscribe((s, prev) => {
    if (s.edges !== prev.edges && edgesOf(useDisplayStyle.getState().style) === !s.edges) {
        setDisplayStyle(s.edges ? 'shadedEdges' : 'shaded');
    }
});
if (edgesOf(useDisplayStyle.getState().style) === !useStudio.getState().edges) {
    setDisplayStyle(useStudio.getState().edges ? 'shadedEdges' : 'shaded');
}

/** How a part is drawn in a style. */
export interface PartLook {
    /** Faces: shaded; only hiding what is behind them, not drawn themselves (hidden line styles); or not at all. */
    faces: 'shaded' | 'hide' | 'none';
    /** Shaded faces drawn see-through. */
    seeThrough: boolean;
    /** Edges where they are seen: none, dark over the shading, or light lines on the background (line styles). */
    edges: 'none' | 'shaded' | 'lines';
    /** Edges behind the model: not drawn, or grey dashed or solid lines. */
    hidden: 'none' | 'dashed' | 'solid';
    /** The outline of curved faces where the view grazes them (a cylinder's sides), with the edges. */
    silhouettes: boolean;
}

/**
 * The look of a part in the 3D view. While sketching the faces never hide anything, so the sketch stays in view
 * (the line styles then show every edge); dimmed parts (the rest of the assembly while a part is edited) stay faint
 * shaded ghosts in every style.
 */
export function styleLook(settings: DisplayStyleSettings, { sketching = false, dimmed = false } = {}): PartLook {
    const { style, seeThrough, hiddenEdges } = settings;
    if (dimmed) {
        return { faces: 'shaded', seeThrough: false, edges: 'none', hidden: 'none', silhouettes: false };
    }
    switch (style) {
        case 'shadedEdges':
            return { faces: 'shaded', seeThrough, edges: 'shaded', hidden: 'none', silhouettes: true };
        case 'shaded':
            return { faces: 'shaded', seeThrough, edges: 'none', hidden: 'none', silhouettes: false };
        case 'hiddenRemoved':
        case 'hiddenVisible':
            return {
                faces: sketching ? 'none' : 'hide', seeThrough: false, edges: 'lines',
                hidden: style === 'hiddenVisible' && !sketching ? hiddenEdges : 'none', silhouettes: true,
            };
        case 'wireframe':
            return { faces: 'none', seeThrough: false, edges: 'lines', hidden: 'none', silhouettes: true };
    }
}

/** Opacity of the model in the see-through look: that of a see-through body (bodyView.tsx). */
export const SEE_THROUGH_OPACITY = SEE_THROUGH;

/**
 * Material settings for a part's faces in a look: `opacity` is what the part would have otherwise. Faces that only
 * hide write depth without colour; faces not drawn write neither (they stay pickable). Faces are pushed a hair back
 * so their own edges, which lie on them, are drawn in front.
 */
export function faceMaterial(look: PartLook, opacity: number): {
    colorWrite: boolean; depthWrite: boolean; transparent: boolean; opacity: number;
    polygonOffset: boolean; polygonOffsetFactor: number; polygonOffsetUnits: number;
} {
    const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    if (look.faces === 'hide') {
        return { colorWrite: false, depthWrite: true, transparent: false, opacity: 1, ...offset };
    }
    if (look.faces === 'none') {
        return { colorWrite: false, depthWrite: false, transparent: false, opacity: 1, ...offset };
    }
    const shown = look.seeThrough ? Math.min(opacity, SEE_THROUGH_OPACITY) : opacity;
    return { colorWrite: true, depthWrite: shown >= 1, transparent: shown < 1, opacity: shown, ...offset };
}
