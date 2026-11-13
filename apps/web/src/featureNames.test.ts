import { describe, expect, it } from 'vitest';
import { featureBaseName, nextFeatureName } from './featureNames';

describe('feature names', () => {
    it('names steps the SolidWorks way', () => {
        expect(featureBaseName({ op: 'extrude', mode: 'add' })).toBe('Boss-Extrude');
        expect(featureBaseName({ op: 'extrude', mode: 'cut' })).toBe('Cut-Extrude');
        expect(featureBaseName({ op: 'revolve', mode: 'add' })).toBe('Revolve');
        expect(featureBaseName({ op: 'revolve', mode: 'cut' })).toBe('Cut-Revolve');
        expect(featureBaseName({ op: 'loft', mode: 'cut' })).toBe('Cut-Loft');
        expect(featureBaseName({ op: 'pattern', kind: 'circular' })).toBe('CirPattern');
        expect(featureBaseName({ op: 'pattern', kind: 'linear' })).toBe('LPattern');
        expect(featureBaseName({ op: 'sketch' })).toBe('Sketch');
        expect(featureBaseName({ op: 'chamfer' })).toBe('Chamfer');
    });

    it('numbers each kind on its own, above every number in use', () => {
        const features = [
            { name: 'Sketch1' }, { name: 'Boss-Extrude1' }, { name: 'Sketch7' }, { name: 'Cut-Extrude1' }, { name: 'Boss-Extrude3' },
            { name: 'Sketch 9 · top' }, { name: 'Extrude 10 mm' }, {},
        ];
        expect(nextFeatureName(features, { op: 'sketch' })).toBe('Sketch8');
        expect(nextFeatureName(features, { op: 'extrude', mode: 'add' })).toBe('Boss-Extrude4');
        expect(nextFeatureName(features, { op: 'extrude', mode: 'cut' })).toBe('Cut-Extrude2');
        expect(nextFeatureName(features, { op: 'fillet' })).toBe('Fillet1');
        expect(nextFeatureName(undefined, { op: 'chamfer' })).toBe('Chamfer1');
    });
});
