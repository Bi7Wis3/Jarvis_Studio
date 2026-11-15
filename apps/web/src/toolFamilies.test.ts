import { describe, expect, it } from 'vitest';
import type { ToolDef } from './toolDefs';
import { familyOf, toolbarItems } from './toolFamilies';

const tool = (id: string): ToolDef => ({ id, label: id, icon: id });
const shape = (ids: string[]) => toolbarItems(ids.map(tool)).map((item) => ('family' in item ? `${item.family.id}(${item.tools.map((t) => t.id).join(',')})` : item.tool.id));

describe('toolbarItems', () => {
    it('puts the variants of a tool in one item where the first of them stood, in flyout order', () => {
        expect(shape(['sk-select', 'sk-line', 'sk-rect', 'sk-centerRect', 'sk-circle', 'sk-arc', 'sk-centerArc', 'sk-centerline', 'sk-point']))
            .toEqual(['sk-select', 'line(sk-line,sk-centerline)', 'rectangle(sk-rect,sk-centerRect)', 'sk-circle', 'arc(sk-centerArc,sk-arc)', 'sk-point']);
    });

    it('keeps a family of one as a plain button', () => {
        expect(shape(['sk-circle', 'sk-slot'])).toEqual(['sk-circle', 'sk-slot']);
    });

    it('makes one flyout of all relation tools, in the order listed', () => {
        expect(shape(['sk-dimension', 'sk-c-coincident', 'sk-c-horizontal', 'sk-c-fix', 'sk-relations']))
            .toEqual(['sk-dimension', 'relation(sk-c-coincident,sk-c-horizontal,sk-c-fix)', 'sk-relations']);
        expect(familyOf('sk-c-tangent')?.label).toBe('Add relation');
        expect(familyOf('extrude')).toBeNull();
    });
});
