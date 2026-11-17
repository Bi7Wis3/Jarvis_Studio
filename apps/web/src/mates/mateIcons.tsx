// Icons of the Mate tool and the mate types (the Mates folder of the tree, the form's type buttons): same 24-unit
// grid and stroke as icons.tsx, which includes them.

import type { ReactNode } from 'react';

export const MATE_ICONS: Record<string, ReactNode> = {
    // Two parts brought together along a face.
    mate: (
        <>
            <path d="M3 13h8v7H3z" />
            <path d="M13 4h8v7h-8z" />
            <path d="M11 13l2-2M8 10l3 3 3-3" />
        </>
    ),
    // Two faces lying on one another.
    'mate-coincident': (
        <>
            <path d="M4 15l6-4h10l-6 4z" />
            <path d="M4 11l6-4h10l-6 4z" opacity="0.55" />
        </>
    ),
    'mate-parallel': (
        <>
            <path d="M5 8h14M5 16h14" />
            <path d="M5 6v4M19 6v4M5 14v4M19 14v4" opacity="0.5" />
        </>
    ),
    'mate-perpendicular': (
        <>
            <path d="M5 19h14M12 19V5" />
            <path d="M12 15h4v4" opacity="0.6" />
        </>
    ),
    'mate-tangent': (
        <>
            <circle cx="12" cy="10" r="6" />
            <path d="M3 16h18" />
        </>
    ),
    'mate-concentric': (
        <>
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="4" />
            <path d="M12 11v2M11 12h2" />
        </>
    ),
    'mate-lock': (
        <>
            <rect x="5" y="11" width="14" height="9" rx="1.5" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </>
    ),
    'mate-distance': (
        <>
            <path d="M4 5v14M20 5v14" />
            <path d="M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3" />
        </>
    ),
    'mate-angle': (
        <>
            <path d="M4 19h16M4 19L16 6" />
            <path d="M11 19a7 7 0 0 0-2-5" />
        </>
    ),
    // The Mates folder.
    mates: (
        <>
            <path d="M2 6h7l2 2.5h11V20H2z" />
            <path d="M8 15h8M12 11v8" opacity="0.6" />
        </>
    ),
    // Mate alignment.
    aligned: (
        <>
            <path d="M7 20V5M4 8l3-3 3 3" />
            <path d="M17 20V5M14 8l3-3 3 3" />
        </>
    ),
    'anti-aligned': (
        <>
            <path d="M7 20V5M4 8l3-3 3 3" />
            <path d="M17 4v15M14 16l3 3 3-3" />
        </>
    ),
};
