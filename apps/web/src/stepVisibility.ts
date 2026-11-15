// The steps the view leaves out now: sketch, reference and thread steps hidden one by one, and absorbed sketches not
// shown one by one (see @jarvis/core/visibility). Keys are "partId/featureId".

import { hiddenSteps } from '@jarvis/core/visibility';
import { useStudio } from './state';

const NONE: ReadonlySet<string> = new Set();

export function hiddenStepsNow(): ReadonlySet<string> {
    const history = useStudio.getState().history;
    return history ? hiddenSteps(history.view, history.parts) : NONE;
}

export function useHiddenSteps(): ReadonlySet<string> {
    const hiddenSketches = useStudio((s) => s.history?.view.hiddenSketches);
    const shownSketches = useStudio((s) => s.history?.view.shownSketches);
    const parts = useStudio((s) => s.history?.parts);
    return parts ? hiddenSteps({ hiddenSketches, shownSketches }, parts) : NONE;
}
