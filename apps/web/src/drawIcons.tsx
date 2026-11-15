// Toolbar icons of the draw tool variants (same 24-unit grid and stroke as icons.tsx, which includes them).

import type { ReactNode } from 'react';

export const DRAW_VARIANT_ICONS: Record<string, ReactNode> = {
    'midpoint-line': (
        <>
            <path d="M3 18L21 6" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
            <path d="M9.5 8.5l2.5 3.5M14.5 15.5L12 12" opacity="0.5" />
        </>
    ),
    'center-rect-3pt': (
        <>
            <path d="M3 12l7-7 11 11-7 7z" />
            <circle cx="12" cy="14" r="1.4" fill="currentColor" />
            <circle cx="15.5" cy="10.5" r="1.4" />
            <path d="M12 14l3.5-3.5" opacity="0.6" strokeDasharray="1.5 1.5" />
        </>
    ),
    parallelogram: (
        <>
            <path d="M3 18L8 6h13l-5 12z" />
            <circle cx="3" cy="18" r="1.4" fill="currentColor" />
            <circle cx="16" cy="18" r="1.4" fill="currentColor" />
            <circle cx="21" cy="6" r="1.4" fill="currentColor" />
        </>
    ),
    'center-slot': (
        <>
            <path d="M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z" />
            <path d="M8 12h8" strokeDasharray="2 1.5" opacity="0.6" />
            <circle cx="12" cy="12" r="1.3" fill="currentColor" />
        </>
    ),
    'arc-slot-3pt': (
        <>
            <path d="M3.5 17a8.5 8.5 0 0 1 17 0a2.5 2.5 0 0 1-5 0a3.5 3.5 0 0 0-7 0a2.5 2.5 0 0 1-5 0z" />
            <circle cx="6" cy="17" r="1.1" fill="currentColor" />
            <circle cx="18" cy="17" r="1.1" fill="currentColor" />
            <circle cx="12" cy="11" r="1.1" fill="currentColor" />
        </>
    ),
    'center-arc-slot': (
        <>
            <path d="M3.5 17a8.5 8.5 0 0 1 17 0a2.5 2.5 0 0 1-5 0a3.5 3.5 0 0 0-7 0a2.5 2.5 0 0 1-5 0z" />
            <circle cx="12" cy="17" r="1.3" fill="currentColor" />
            <path d="M12 17L6 17M12 17l6 0" strokeDasharray="1.5 1.5" opacity="0.6" />
        </>
    ),
};
