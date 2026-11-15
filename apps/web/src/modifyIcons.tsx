// Toolbar icons of the sketch tools in sketchMoreForms.tsx (same 24-unit grid and stroke as icons.tsx, which
// includes them).

import type { ReactNode } from 'react';

export const MODIFY_MORE_ICONS: Record<string, ReactNode> = {
    'dynamic-mirror': (
        <>
            <path d="M12 3v18" strokeDasharray="2 2" />
            <path d="M9 7L4 12l5 5" />
            <path d="M15 7l5 5-5 5" opacity="0.6" />
            <path d="M10.5 3.5h3M10.5 20.5h3" />
        </>
    ),
    jog: (
        <>
            <path d="M3 16h6V8h6v8h6" />
        </>
    ),
    segment: (
        <>
            <path d="M3 12h18" />
            <circle cx="7.5" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="16.5" cy="12" r="1.5" fill="currentColor" />
            <path d="M3 9v6M21 9v6" opacity="0.6" />
        </>
    ),
    replace: (
        <>
            <path d="M4 8h10" strokeDasharray="2 2" opacity="0.6" />
            <path d="M4 17a6 6 0 0 1 12 0" />
            <path d="M17 5l3 3-3 3" />
            <path d="M14 8h6" />
        </>
    ),
    'modify-sketch': (
        <>
            <path d="M5 15l4-8 6 3-2 7z" />
            <path d="M18 4v6M15 7h6" />
            <path d="M3 21l3-3" opacity="0.6" />
        </>
    ),
    'check-sketch': (
        <>
            <path d="M4 18V7l6-3 6 3" />
            <path d="M4 18h7" />
            <path d="M13 17l3 3 5-7" />
        </>
    ),
};
