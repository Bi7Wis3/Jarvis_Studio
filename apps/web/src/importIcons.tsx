// Icons of File > Import and the Imported step: same 24-unit grid and stroke as icons.tsx, which includes them.

import type { ReactNode } from 'react';

export const IMPORT_ICONS: Record<string, ReactNode> = {
    import: (
        <>
            <path d="M12 2v10M8 8.5l4 3.5 4-3.5" />
            <path d="M12 14.5l8 3.5-8 3.5-8-3.5z" />
            <path d="M4 18v1.5L12 23l8-3.5V18" opacity="0.5" />
        </>
    ),
};
