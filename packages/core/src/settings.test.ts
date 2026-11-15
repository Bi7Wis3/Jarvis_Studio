import { describe, expect, it } from 'vitest';
import {
    applyPatch, DEFAULT_SETTINGS, defaultSettings, LIGHTING_PRESETS, maskKey, MAX_LIGHTS, normaliseSettings, plainData, resetCategory,
    validModel,
} from './settings';

describe('normaliseSettings', () => {
    it('fills everything missing with the defaults', () => {
        expect(normaliseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(normaliseSettings({ display: { bloom: false } }).display).toEqual({ ...DEFAULT_SETTINGS.display, bloom: false });
    });

    it('clamps numbers, refuses bad colours, choices and model ids', () => {
        const s = normaliseSettings({
            units: { lengthDecimals: 12, angleDecimals: -3, angleUnit: 'grad', formDecimals: 2.6 },
            display: { meshQuality: 'ultra', edgeColor: '#ABCDEF', edgeOpacity: 4, transition: 'warp' },
            ai: { auth: 'cloud', fast: { model: 'rm -rf /', effort: 'huge' }, best: { model: ' claude-opus-5-5 ', effort: 'max' } },
        });
        expect(s.units).toEqual({ lengthDecimals: 8, angleDecimals: 0, angleUnit: 'deg', formDecimals: 3 });
        expect(s.display).toMatchObject({ meshQuality: 'normal', edgeColor: '#abcdef', edgeOpacity: 1, transition: 'normal' });
        expect(s.ai).toEqual({ auth: 'local', fast: DEFAULT_SETTINGS.ai.fast, best: { model: 'claude-opus-5-5', effort: 'max' } });
    });

    it('keeps up to the light limit with unique ids', () => {
        const many = Array.from({ length: 12 }, () => ({ id: 'same', intensity: 1 }));
        const s = normaliseSettings({ lighting: { directional: many } });
        expect(s.lighting.directional).toHaveLength(MAX_LIGHTS);
        expect(new Set(s.lighting.directional.map((l) => l.id)).size).toBe(MAX_LIGHTS);
        // An empty list stays empty (all lights deleted).
        expect(normaliseSettings({ lighting: { directional: [] } }).lighting.directional).toEqual([]);
    });

    it('keeps only plain text and check-box defaults with sensible keys', () => {
        const s = normaliseSettings({ defaults: { fillet: { r: '3', tangent: false, bad: { x: 1 }, n: 4 }, 'no way!': { r: '1' }, empty: {} } });
        expect(s.defaults).toEqual({ fillet: { r: '3', tangent: false } });
    });

    it('keeps the presets as valid settings', () => {
        for (const preset of Object.values(LIGHTING_PRESETS)) {
            expect(normaliseSettings({ lighting: preset }).lighting).toEqual(preset);
        }
    });
});

describe('patches and resets', () => {
    it('replaces whole categories and ignores unknown ones', () => {
        const s = applyPatch(defaultSettings(), { units: { lengthDecimals: 2 }, nonsense: 1 });
        expect(s.units).toEqual({ ...DEFAULT_SETTINGS.units, lengthDecimals: 2 });
        expect('nonsense' in s).toBe(false);
    });

    it('resets one category', () => {
        const s = applyPatch(defaultSettings(), { units: { lengthDecimals: 2 }, display: { bloom: false } });
        const r = resetCategory(s, 'units');
        expect(r.units).toEqual(DEFAULT_SETTINGS.units);
        expect(r.display.bloom).toBe(false);
    });
});

describe('helpers', () => {
    it('masks a key to its last four characters', () => {
        expect(maskKey('sk-ant-abcdefWXYZ')).toBe('••••••••WXYZ');
        expect(maskKey('')).toBe('');
    });

    it('accepts aliases and model ids only', () => {
        expect(validModel('sonnet')).toBe(true);
        expect(validModel('claude-opus-5-5')).toBe(true);
        expect(validModel('opus[1m]')).toBe(true);
        expect(validModel('a b')).toBe(false);
        expect(validModel('')).toBe(false);
    });

    it('drops what is not plain data or too big', () => {
        expect(plainData({ a: 1, b: [true, 'x', Infinity], f: () => 1 } as unknown)).toEqual({ a: 1, b: [true, 'x', null], f: null });
        expect(plainData({ big: 'x'.repeat(70_000) })).toEqual({});
        expect(plainData([1, 2])).toEqual({});
    });
});
