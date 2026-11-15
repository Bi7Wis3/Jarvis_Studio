// Toolbar icons of sketch text, sketch picture, equation driven curve, blocks and spline fitting (same 24-unit grid
// and stroke as icons.tsx, which includes them).

import type { ReactNode } from 'react';

export const EXTRAS_ICONS: Record<string, ReactNode> = {
    'sketch-text': (
        <>
            <path d="M5 6V4h14v2M12 4v16M9 20h6" />
        </>
    ),
    'sketch-picture': (
        <>
            <rect x="3" y="5" width="18" height="14" rx="1.5" />
            <path d="M3 16l5-5 4 4 3-3 6 6" opacity="0.7" />
            <circle cx="16" cy="9" r="1.5" />
        </>
    ),
    'equation-curve': (
        <>
            <path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-10 6-10" />
            <path d="M3 21h18" opacity="0.45" />
        </>
    ),
    'block-make': (
        <>
            <rect x="4" y="4" width="16" height="16" rx="1.5" strokeDasharray="2.5 2" />
            <path d="M8 15l3-6 5 6z" />
            <circle cx="8" cy="15" r="1.3" fill="currentColor" />
        </>
    ),
    'block-insert': (
        <>
            <rect x="3" y="3" width="11" height="11" rx="1.2" />
            <path d="M6 11l2.5-5 3 5z" />
            <path d="M17 13v8M13 17h8" />
        </>
    ),
    'block-edit': (
        <>
            <rect x="3" y="3" width="12" height="12" rx="1.2" />
            <path d="M12 21l1-4 6-6 3 3-6 6z" />
        </>
    ),
    'block-explode': (
        <>
            <path d="M8 8l-4-4M16 8l4-4M8 16l-4 4M16 16l4 4" />
            <rect x="8" y="8" width="8" height="8" rx="1" strokeDasharray="2 1.6" />
        </>
    ),
    'block-save': (
        <>
            <path d="M5 4h11l3 3v13H5z" />
            <path d="M8 4v5h7V4M8 20v-6h8v6" />
        </>
    ),
    'block-addremove': (
        <>
            <rect x="3" y="3" width="12" height="12" rx="1.2" />
            <path d="M6 9h6" />
            <path d="M18 14v7M14.5 17.5h7" />
        </>
    ),
    'block-rebuild': (
        <>
            <rect x="4" y="4" width="10" height="10" rx="1.2" />
            <path d="M20 13a6 6 0 1 1-3-5.2M20 4v4h-4" />
        </>
    ),
    'fit-spline': (
        <>
            <path d="M3 17l5-9 5 6 4-8 4 5" opacity="0.45" strokeDasharray="2 1.6" />
            <path d="M3 16c3-9 6-7 9-4s6 0 9-5" />
        </>
    ),
    'simplify-spline': (
        <>
            <path d="M3 16c3-9 6-7 9-4s6 0 9-5" />
            <circle cx="3" cy="16" r="1.4" fill="currentColor" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" />
            <circle cx="21" cy="7" r="1.4" fill="currentColor" />
        </>
    ),
};
