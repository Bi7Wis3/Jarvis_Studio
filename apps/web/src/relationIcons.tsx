// Icons of the dimension, relation and sketch setting tools added beside the first set (same 24-unit stroke style).

import type { ReactNode } from 'react';

export const RELATION_ICONS: Record<string, ReactNode> = {
    'add-relation': (
        <>
            <path d="M3 19L11 11" opacity="0.6" />
            <circle cx="11" cy="11" r="2.2" fill="currentColor" />
            <path d="M17 4v7M13.5 7.5h7" />
        </>
    ),
    'dim-horizontal': (
        <>
            <path d="M4 5v14M20 5v14" />
            <path d="M4 15h16M7 12.5L4 15l3 2.5M17 12.5l3 2.5-3 2.5" />
            <circle cx="4" cy="7" r="1.3" fill="currentColor" />
            <circle cx="20" cy="9" r="1.3" fill="currentColor" />
        </>
    ),
    'dim-vertical': (
        <>
            <path d="M5 4h14M5 20h14" />
            <path d="M15 4v16M12.5 7L15 4l2.5 3M12.5 17l2.5 3 2.5-3" />
            <circle cx="7" cy="4" r="1.3" fill="currentColor" />
            <circle cx="9" cy="20" r="1.3" fill="currentColor" />
        </>
    ),
    sketchxpert: (
        <>
            <path d="M4 18l6-12 6 12z" />
            <path d="M10 10.5v3.5M10 16v.2" />
            <path d="M16 6l4 4M20 6l-4 4" opacity="0.7" />
        </>
    ),
    'c-intersection': (
        <>
            <path d="M4 18L20 6M4 6l16 12" opacity="0.6" />
            <circle cx="12" cy="12" r="2.4" fill="currentColor" />
        </>
    ),
    'c-equal-slots': (
        <>
            <rect x="3" y="5" width="12" height="5" rx="2.5" />
            <rect x="9" y="14" width="12" height="5" rx="2.5" />
        </>
    ),
    'c-fix-slot': (
        <>
            <rect x="3" y="9" width="12" height="6" rx="3" />
            <rect x="15" y="12" width="6" height="7" rx="1.2" />
            <path d="M16.5 12v-1.5a1.5 1.5 0 0 1 3 0V12" />
        </>
    ),
    'c-doubled': (
        <>
            <path d="M12 3v18" strokeDasharray="3 2" />
            <path d="M5 12h14M7.5 9.5L5 12l2.5 2.5M16.5 9.5L19 12l-2.5 2.5" />
        </>
    ),
    'dim-ordinate': (
        <>
            <path d="M4 20V4" />
            <path d="M4 8h6M4 13h10M4 18h14" opacity="0.7" />
            <circle cx="10" cy="8" r="1.2" fill="currentColor" />
            <circle cx="14" cy="13" r="1.2" fill="currentColor" />
            <circle cx="18" cy="18" r="1.2" fill="currentColor" />
        </>
    ),
    'dim-running': (
        <>
            <circle cx="12" cy="13" r="1.4" fill="currentColor" />
            <path d="M12 13h8" opacity="0.6" />
            <path d="M20 13a8 8 0 0 0-8-8M20 13a8 8 0 0 0-13.7-5.6" />
            <circle cx="12" cy="5" r="1.2" fill="currentColor" />
            <circle cx="6.3" cy="7.4" r="1.2" fill="currentColor" />
        </>
    ),
    'dim-path': (
        <>
            <path d="M4 18c3 0 3-10 7-10s3 8 9 8" />
            <path d="M4 21h16" opacity="0.6" />
        </>
    ),
};
