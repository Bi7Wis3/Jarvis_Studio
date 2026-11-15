import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normaliseSettings, shownStyle } from '@jarvis/core/settings';
import {
    DEFAULT_DISPLAY, DISPLAY_STYLES, faceMaterial, SEE_THROUGH_OPACITY, setDisplay, setDisplayStyle, styleLook, toggleSeeThrough,
    useDisplayStyle, type DisplayStyleSettings,
} from './displayStyle';
import { SEE_THROUGH } from './bodyView';
import { useStudio } from './state';

const settings = (patch: Partial<DisplayStyleSettings> = {}): DisplayStyleSettings => ({ ...DEFAULT_DISPLAY, ...patch });

describe('display styles', () => {
    it('lists the five SolidWorks styles, Shaded with edges first and by default', () => {
        expect(DISPLAY_STYLES.map((s) => s.label)).toEqual(['Shaded with edges', 'Shaded', 'Hidden lines removed', 'Hidden lines visible', 'Wireframe']);
        expect(DEFAULT_DISPLAY).toEqual({ style: 'shadedEdges', seeThrough: false, hiddenEdges: 'dashed' });
        expect(DEFAULT_SETTINGS.display).toMatchObject(DEFAULT_DISPLAY);
    });

    it('keeps them with the display settings, leniently read; Show model edges decides between the two shaded styles', () => {
        expect(normaliseSettings({ display: { style: 'wireframe', seeThrough: true, hiddenEdges: 'solid' } }).display)
            .toMatchObject({ style: 'wireframe', seeThrough: true, hiddenEdges: 'solid' });
        expect(normaliseSettings({ display: { style: 'cartoon', seeThrough: 'yes', hiddenEdges: 'dotted' } }).display).toMatchObject(DEFAULT_DISPLAY);
        // A settings file from before the styles, with the edges off: Shaded.
        expect(shownStyle(normaliseSettings({ display: { edges: false } }).display)).toBe('shaded');
        expect(shownStyle({ style: 'shaded', edges: true })).toBe('shadedEdges');
        expect(shownStyle({ style: 'hiddenVisible', edges: false })).toBe('hiddenVisible');
    });

    it('draws faces, edges, hidden edges and outlines as each style does', () => {
        expect(styleLook(settings({ style: 'shadedEdges' }))).toEqual({ faces: 'shaded', seeThrough: false, edges: 'shaded', hidden: 'none', silhouettes: true });
        expect(styleLook(settings({ style: 'shaded' }))).toMatchObject({ faces: 'shaded', edges: 'none', silhouettes: false });
        expect(styleLook(settings({ style: 'hiddenRemoved' }))).toEqual({ faces: 'hide', seeThrough: false, edges: 'lines', hidden: 'none', silhouettes: true });
        expect(styleLook(settings({ style: 'hiddenVisible' }))).toMatchObject({ faces: 'hide', edges: 'lines', hidden: 'dashed' });
        expect(styleLook(settings({ style: 'hiddenVisible', hiddenEdges: 'solid' }))).toMatchObject({ hidden: 'solid' });
        expect(styleLook(settings({ style: 'wireframe' }))).toMatchObject({ faces: 'none', edges: 'lines', hidden: 'none' });
    });

    it('makes the shaded styles see-through on request, the line styles never', () => {
        expect(styleLook(settings({ style: 'shadedEdges', seeThrough: true })).seeThrough).toBe(true);
        expect(styleLook(settings({ style: 'shaded', seeThrough: true })).seeThrough).toBe(true);
        expect(styleLook(settings({ style: 'hiddenRemoved', seeThrough: true })).seeThrough).toBe(false);
    });

    it('never hides the sketch behind the faces while sketching, and keeps dimmed parts faint ghosts', () => {
        expect(styleLook(settings({ style: 'hiddenVisible' }), { sketching: true })).toMatchObject({ faces: 'none', edges: 'lines', hidden: 'none' });
        expect(styleLook(settings({ style: 'shadedEdges' }), { sketching: true })).toMatchObject({ faces: 'shaded' });
        expect(styleLook(settings({ style: 'wireframe' }), { dimmed: true })).toEqual({ faces: 'shaded', seeThrough: false, edges: 'none', hidden: 'none', silhouettes: false });
    });

    it('gives the face material: hiding faces write depth only, faces not drawn write nothing, all pushed back', () => {
        const look = (patch: Partial<DisplayStyleSettings>) => styleLook(settings(patch));
        expect(faceMaterial(look({ style: 'hiddenRemoved' }), 1)).toMatchObject({ colorWrite: false, depthWrite: true, transparent: false });
        expect(faceMaterial(look({ style: 'wireframe' }), 1)).toMatchObject({ colorWrite: false, depthWrite: false });
        expect(faceMaterial(look({ style: 'shaded' }), 1)).toMatchObject({ colorWrite: true, depthWrite: true, transparent: false, opacity: 1 });
        // As see-through as a see-through body.
        expect(SEE_THROUGH_OPACITY).toBe(SEE_THROUGH);
        expect(faceMaterial(look({ style: 'shaded', seeThrough: true }), 1)).toMatchObject({ depthWrite: false, transparent: true, opacity: SEE_THROUGH });
        // A part that is already fainter (glass) keeps its own opacity.
        expect(faceMaterial(look({ style: 'shaded', seeThrough: true }), 0.1).opacity).toBe(0.1);
        expect(faceMaterial(look({ style: 'shadedEdges' }), 1)).toMatchObject({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    });

    it('keeps the style and the Edges switch in step: Edges is Shaded with edges against Shaded', () => {
        setDisplayStyle('shaded');
        expect(useStudio.getState().edges).toBe(false);
        useStudio.setState({ edges: true });
        expect(useDisplayStyle.getState().style).toBe('shadedEdges');
        setDisplayStyle('wireframe');
        useStudio.setState({ edges: false });
        // The switch does not take the model out of a line style.
        expect(useDisplayStyle.getState().style).toBe('wireframe');
        toggleSeeThrough();
        expect(useDisplayStyle.getState().seeThrough).toBe(true);
        setDisplay(DEFAULT_DISPLAY);
        expect(useDisplayStyle.getState()).toMatchObject(DEFAULT_DISPLAY);
        expect(useStudio.getState().edges).toBe(true);
    });
});
