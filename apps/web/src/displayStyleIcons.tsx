// Toolbar icons of the display styles (displayStyleTools.tsx): a cube drawn as each style draws the model. Same
// 24-unit grid and stroke as icons.tsx, which includes them.

import type { ReactNode } from 'react';

/** The cube's three seen faces, its visible edges, and the three edges behind it. */
const FACES = 'M12 3l8 4.5v9L12 21l-8-4.5v-9z';
const FRONT_EDGES = 'M4 7.5l8 4.5 8-4.5M12 12v9';
const BACK_EDGES = 'M4 16.5l8-4.5 8 4.5M12 3v9';

export const DISPLAY_STYLE_ICONS: Record<string, ReactNode> = {
    'display-shadedEdges': (
        <>
            <path d={FACES} fill="currentColor" fillOpacity="0.35" />
            <path d={FRONT_EDGES} />
        </>
    ),
    'display-shaded': (
        <>
            <path d={FACES} fill="currentColor" fillOpacity="0.45" stroke="none" />
            <path d="M4 7.5l8 4.5 8-4.5L12 3z" fill="currentColor" fillOpacity="0.35" stroke="none" />
        </>
    ),
    'display-hiddenRemoved': (
        <>
            <path d={FACES} />
            <path d={FRONT_EDGES} />
        </>
    ),
    'display-hiddenVisible': (
        <>
            <path d={FACES} />
            <path d={FRONT_EDGES} />
            <path d={BACK_EDGES} opacity="0.55" strokeDasharray="1.6 1.6" />
        </>
    ),
    'display-wireframe': (
        <>
            <path d={FACES} />
            <path d={FRONT_EDGES} />
            <path d={BACK_EDGES} />
        </>
    ),
    'display-see-through': (
        <>
            <path d={FACES} fill="currentColor" fillOpacity="0.15" />
            <path d={FRONT_EDGES} opacity="0.8" />
            <path d={BACK_EDGES} opacity="0.45" />
        </>
    ),
};
