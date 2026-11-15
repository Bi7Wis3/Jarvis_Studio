// The View toolbar's display style flyout (SolidWorks: Heads-up View toolbar > Display Style): one button showing
// the style in use, its arrow listing the five styles and the see-through switch. SolidWorks gives these commands no
// keyboard shortcut by default, so none is set here either.

import { DISPLAY_STYLES, setDisplayStyle, toggleSeeThrough, useDisplayStyle } from './displayStyle';
import type { ToolDef } from './toolDefs';

export const displayStyleTools: ToolDef[] = [
    ...DISPLAY_STYLES.map((style): ToolDef => ({
        id: `display-${style.id}`,
        label: style.label,
        icon: `display-${style.id}`,
        hint: style.hint,
        instant: () => setDisplayStyle(style.id),
        active: () => useDisplayStyle.getState().style === style.id,
    })),
    {
        id: 'display-see-through',
        label: 'See-through',
        icon: 'display-see-through',
        hint: 'the whole model see-through, in the shaded styles',
        instant: () => toggleSeeThrough(),
        active: () => useDisplayStyle.getState().seeThrough,
    },
];
