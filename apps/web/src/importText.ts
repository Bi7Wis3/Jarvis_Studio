// What the feature tree says about an Imported step.

import type { ImportStep } from '@jarvis/core/imported';

export function importSummary(step: ImportStep): string {
    const solids = step.brep ? Math.max(1, (step.bodies?.length ?? 1) - (step.mesh ? 1 : 0)) : 0;
    const kinds = [solids ? `${solids} solid ${solids === 1 ? 'body' : 'bodies'}` : '', step.mesh ? 'a graphics body' : ''].filter(Boolean);
    return [`${step.file.format.toUpperCase()} · ${step.file.name}`, kinds.join(' and ')].filter(Boolean).join(' · ');
}
