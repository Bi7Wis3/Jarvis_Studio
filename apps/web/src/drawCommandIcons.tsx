// Toolbar icons of Select Chain, Reverse Endpoint Tangent, Infinite length, Align Grid/Origin, Make Path and
// Belt/Chain (same 24-unit grid and stroke as icons.tsx, which includes them).

import type { ReactNode } from 'react';

export const DRAW_COMMAND_ICONS: Record<string, ReactNode> = {
    'select-chain': (
        <>
            <path d="M4 17l5-8h6l5 8" strokeWidth="2.2" />
            <circle cx="9" cy="9" r="1.3" fill="currentColor" />
            <circle cx="15" cy="9" r="1.3" fill="currentColor" />
            <path d="M3 5.5l2.5 2.5M6.5 4l-1 4-4-1" opacity="0.6" />
        </>
    ),
    'reverse-tangent': (
        <>
            <path d="M3 15h7" />
            <path d="M10 15a5 5 0 0 1 9-3" />
            <path d="M10 15a5 5 0 0 0 9 3" strokeDasharray="1.6 1.6" opacity="0.6" />
            <circle cx="10" cy="15" r="1.3" fill="currentColor" />
            <path d="M19 6v4h-4" opacity="0.6" />
        </>
    ),
    'infinite-line': (
        <>
            <path d="M6 16L18 8" />
            <path d="M2.5 18.3L4.5 17M19.5 7l2-1.3" strokeDasharray="1 1.2" />
            <circle cx="9" cy="14" r="1.3" fill="currentColor" />
            <circle cx="15" cy="10" r="1.3" fill="currentColor" />
        </>
    ),
    'align-grid': (
        <>
            <path d="M4 20V8M4 20h12" opacity="0.5" />
            <path d="M9 15l8-6M9 15l-2.5-6" />
            <path d="M17 9l-2.3.2M17 9l-.8 2.2" />
            <circle cx="9" cy="15" r="1.4" fill="currentColor" />
            <path d="M4 20l5-5" strokeDasharray="1.4 1.4" opacity="0.6" />
        </>
    ),
    'make-path': (
        <>
            <path d="M3 17h6a4 4 0 0 0 4-4V9a4 4 0 0 1 4-4h4" strokeWidth="2.2" />
            <circle cx="3" cy="17" r="1.3" fill="currentColor" />
            <circle cx="21" cy="5" r="1.3" fill="currentColor" />
            <circle cx="17" cy="16" r="3" opacity="0.6" />
        </>
    ),
    belt: (
        <>
            <circle cx="7" cy="13" r="3" />
            <circle cx="17" cy="11" r="2" />
            <path d="M6.5 8.04L16.8 9.01M7.5 17.96l9.7-4.95" />
            <path d="M6.5 8.04a5 5 0 0 0 1 9.92M16.8 9.01a3 3 0 0 1 .4 3.99" opacity="0.7" />
            <circle cx="7" cy="13" r="0.9" fill="currentColor" />
            <circle cx="17" cy="11" r="0.9" fill="currentColor" />
        </>
    ),
};
