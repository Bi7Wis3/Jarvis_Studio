// Icons of the File menu's forms (Import, Open, Save As) and the Imported step: same 24-unit grid and stroke as
// icons.tsx, which includes them.

import type { ReactNode } from 'react';

export const IMPORT_ICONS: Record<string, ReactNode> = {
    import: (
        <>
            <path d="M12 2v10M8 8.5l4 3.5 4-3.5" />
            <path d="M12 14.5l8 3.5-8 3.5-8-3.5z" />
            <path d="M4 18v1.5L12 23l8-3.5V18" opacity="0.5" />
        </>
    ),
    'open-file': (
        <>
            <path d="M3 6.5h6l2 2.5h9v10.5H3z" />
            <path d="M3 11h17" opacity="0.5" />
            <path d="M12 13.5v4M10 15.5l2-2 2 2" />
        </>
    ),
    'save-file': (
        <>
            <path d="M5 3.5h11l3.5 3.5v13.5h-14.5z" />
            <path d="M8 3.5v5h7v-5" opacity="0.6" />
            <rect x="8" y="13" width="8" height="5" rx="0.5" />
        </>
    ),
};
