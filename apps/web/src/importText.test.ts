import { describe, expect, it } from 'vitest';
import type { ImportStep } from '@jarvis/core/imported';
import { importSummary } from './importText';

const file = { name: 'bracket.step', format: 'step', asset: 'a'.repeat(24) + '.step' };

describe('importSummary', () => {
    it('names the file and what came in', () => {
        expect(importSummary({ op: 'import', file, brep: 'b.brep', bodies: [{}, {}] } as ImportStep)).toBe('STEP · bracket.step · 2 solid bodies');
        expect(importSummary({ op: 'import', file: { ...file, name: 'cube.stl', format: 'stl' }, mesh: 'm.stl', bodies: [{}] } as ImportStep))
            .toBe('STL · cube.stl · a graphics body');
        expect(importSummary({ op: 'import', file, brep: 'b.brep', mesh: 'm.stl', bodies: [{}, {}] } as ImportStep))
            .toBe('STEP · bracket.step · 1 solid body and a graphics body');
    });
});
