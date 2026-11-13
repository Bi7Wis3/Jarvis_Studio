// Copies of parts for Duplicate and Mirror copy.

import { effectivePart, type Part } from '@jarvis/core';

/**
 * A new independent part with the same design as `part` and the fields in `patch`. For an instance this is the
 * design of its source: an instance itself holds no shape or features, and parts_add has no `instanceOf`.
 */
export function designCopy(part: Part, patch: Partial<Part>, parts: Part[]): Record<string, unknown> {
    const { id: _id, instanceOf: _instanceOf, ...rest } = effectivePart(part, parts);
    return { ...rest, ...patch };
}
