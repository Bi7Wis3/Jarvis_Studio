// How the view draws each part. In the part workspace "Isolated" shows the edited part alone, and "In context"
// shows the rest of the assembly faintly around it (SolidWorks edit part vs edit in context). The toolbar's
// "Show other parts" switches the same setting.

export type PartLook = 'hidden' | 'dimmed' | 'normal';

export interface ViewState {
    workspace: 'part' | 'assembly';
    /** The part being edited in the part workspace, when it is shown. */
    activePart: string | null;
    partView: 'isolated' | 'inContext';
    /** Assembly workspace: the focused part; the others are dimmed. */
    focus: string | null;
}

export function partLook(partId: string, s: ViewState): PartLook {
    if (s.workspace === 'part' && s.activePart !== null && partId !== s.activePart) {
        return s.partView === 'inContext' ? 'dimmed' : 'hidden';
    }
    return s.workspace !== 'part' && s.focus !== null && s.focus !== partId ? 'dimmed' : 'normal';
}
