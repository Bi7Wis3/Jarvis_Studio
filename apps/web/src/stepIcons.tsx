// Icons for history steps the toolbar icon set has no picture for (reference geometry and advanced ops).

import type { ReactNode } from 'react';
import { Icon } from './icons';

const PATHS: Record<string, ReactNode> = {
    plane: <path d="M3 16l6-9h12l-6 9z" strokeDasharray="0" />,
    axis: (
        <>
            <path d="M4 20L20 4" strokeDasharray="3 2.5" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        </>
    ),
    point: (
        <>
            <path d="M12 5v14M5 12h14" opacity="0.45" />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        </>
    ),
    origin: (
        <>
            <path d="M6 18V6M6 18h12" />
            <path d="M4 8l2-2 2 2M16 16l2 2-2 2" />
            <circle cx="6" cy="18" r="1.6" fill="currentColor" />
        </>
    ),
    sweep: (
        <>
            <path d="M4 18c4 0 4-12 8-12s4 12 8 12" />
            <ellipse cx="4.5" cy="18" rx="1.8" ry="2.6" />
        </>
    ),
    combine: (
        <>
            <rect x="3.5" y="7" width="10" height="10" rx="1" />
            <circle cx="15" cy="12" r="5.5" />
        </>
    ),
    split: (
        <>
            <path d="M5 6h6v12H5zM13 6h6v12h-6z" />
            <path d="M12 3v18" strokeDasharray="2 2" />
        </>
    ),
    draft: (
        <>
            <path d="M7 20l2-14h6l2 14z" />
            <path d="M4 20h16" opacity="0.5" />
        </>
    ),
};

/** A history step icon: our own drawing for reference and advanced ops, else the toolbar icon of that name. */
export function StepIcon({ name, size = 14 }: { name: string; size?: number }) {
    const path = PATHS[name];
    if (!path) {
        return <Icon name={name} size={size} />;
    }
    return (
        <svg
            className="icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {path}
        </svg>
    );
}
