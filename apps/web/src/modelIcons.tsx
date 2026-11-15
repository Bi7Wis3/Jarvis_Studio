// Toolbar icons of the sketch tools that take geometry from the model (sketchModelForms.tsx); same 24-unit grid and
// stroke as icons.tsx, which includes them.

import type { ReactNode } from 'react';

export const MODEL_SKETCH_ICONS: Record<string, ReactNode> = {
    convert: (
        <>
            <path d="M4 9l5-4h11l-5 4z" opacity="0.6" />
            <path d="M4 9v4M15 9v4M20 5v4" opacity="0.6" />
            <path d="M12 13v3" />
            <path d="M10 15l2 2 2-2" />
            <path d="M4 19h16" strokeDasharray="2.5 2" />
        </>
    ),
    'copy-model': (
        <>
            <path d="M4 9l5-4h11l-5 4z" opacity="0.6" />
            <path d="M4 9v4M15 9v4M20 5v4" opacity="0.6" />
            <path d="M12 13v3" />
            <path d="M10 15l2 2 2-2" />
            <path d="M5 19h14" />
            <circle cx="4" cy="19" r="1.3" />
            <circle cx="20" cy="19" r="1.3" />
        </>
    ),
    'intersection-curve': (
        <>
            <ellipse cx="12" cy="6" rx="5" ry="2" opacity="0.6" />
            <path d="M7 6v12M17 6v12" opacity="0.6" />
            <path d="M3 14l18-4" />
            <path d="M7 13.1c2 1.6 8 0.4 10-2.2" strokeWidth="2.2" />
        </>
    ),
    silhouette: (
        <>
            <path d="M5 18V9l4-4h10v9l-4 4z" />
            <path d="M5 9h10v9M15 9l4-4" opacity="0.45" strokeDasharray="2 2" />
        </>
    ),
    pierce: (
        <>
            <path d="M3 16l6-6h12l-6 6z" opacity="0.6" />
            <path d="M12 3v18" />
            <circle cx="12" cy="13" r="1.8" fill="currentColor" />
        </>
    ),
};
