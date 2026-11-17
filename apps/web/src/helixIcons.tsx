// The Helix and spiral icon: for the toolbar (icons.tsx) and, in the reference colour, for the feature tree (stepIcons.tsx).

import type { ReactNode } from 'react';

const coil: ReactNode = (
    <>
        <path d="M12 2.5v19" strokeDasharray="2 2" opacity="0.45" />
        <path d="M6.5 20.5C6.5 18.6 17.5 18.4 17.5 16.5S6.5 14.1 6.5 12.2 17.5 10 17.5 8.1 6.5 5.6 6.5 3.5" />
    </>
);

export const HELIX_ICONS: Record<string, ReactNode> = { helix: coil };

export const HELIX_STEP_ICON = { color: '#ffd58a', body: coil };
