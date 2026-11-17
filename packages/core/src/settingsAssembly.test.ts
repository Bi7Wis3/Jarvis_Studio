import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_SETTINGS, normaliseSettings } from './settings';

describe('Move components by dragging (General > Assemblies)', () => {
    it('is on by default, as in SolidWorks', () => {
        expect(DEFAULT_SETTINGS.general.moveComponentsByDragging).toBe(true);
        expect(normaliseSettings(undefined).general.moveComponentsByDragging).toBe(true);
    });

    it('loads a settings file from before it unchanged, with the option on', () => {
        const old = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        delete old.general.moveComponentsByDragging;
        old.general.confirmDelete = false;
        old.display.bloom = false;
        const loaded = normaliseSettings(old);
        expect(loaded.general).toEqual({ confirmDelete: false, moveComponentsByDragging: true });
        expect(loaded.display).toEqual({ ...DEFAULT_SETTINGS.display, bloom: false });
        expect({ ...loaded, general: { confirmDelete: false } }).toEqual({ ...old, general: { confirmDelete: false } });
    });

    it('keeps it off when turned off, and a patch of the other general setting leaves it so', () => {
        const off = normaliseSettings({ general: { moveComponentsByDragging: false } });
        expect(off.general).toEqual({ confirmDelete: true, moveComponentsByDragging: false });
        expect(applyPatch(off, { general: { confirmDelete: false } }).general).toEqual({ confirmDelete: false, moveComponentsByDragging: false });
        expect(normaliseSettings({ general: { moveComponentsByDragging: 'no' } }).general.moveComponentsByDragging).toBe(true);
    });
});
