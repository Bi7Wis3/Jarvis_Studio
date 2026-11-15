// Icons of the primitives without one of their own (wedge, capsule) and of Customize toolbars. Same 24-unit grid and
// stroke as icons.tsx, which includes them.

import type { ReactNode } from 'react';

export const TOOLBAR_ICONS: Record<string, ReactNode> = {
    wedge: (
        <>
            <path d="M4 19h11L4 7z" />
            <path d="M4 7l5-3 11 12-5 3" />
            <path d="M9 4v12h11" opacity="0.35" />
        </>
    ),
    capsule: (
        <>
            <rect x="7" y="3" width="10" height="18" rx="5" />
            <path d="M7 8.5c2 1.3 8 1.3 10 0" opacity="0.6" />
        </>
    ),
    primitives: (
        <>
            <path d="M8 3l5 2.8v5.6L8 14.2 3 11.4V5.8z" />
            <path d="M3 5.8l5 2.8 5-2.8M8 8.6v5.6" />
            <circle cx="17" cy="16" r="4.5" />
        </>
    ),
    toolbars: (
        <>
            <rect x="3" y="4" width="18" height="5" rx="1.5" />
            <path d="M6.5 6.5h1M10 6.5h1M13.5 6.5h1" />
            <rect x="3" y="12" width="11" height="5" rx="1.5" />
            <path d="M6.5 14.5h1M10 14.5h1" />
            <path d="M18 12.5v6M15 15.5h6" />
        </>
    ),
};
