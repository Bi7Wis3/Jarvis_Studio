// What the CAD kernel is doing, as the server tells browsers: the job running and the step it is on, the jobs waiting,
// and the parts whose shown mesh is being rebuilt (their old mesh stays on screen until the new one lands).

/**
 * rebuild: a part's shown result; preview: a tool form's preview; mesh: another build of a part (a preview without
 * steps of its own, an export at fine quality); export: STEP or FreeCAD; props: mass properties; query: the model as
 * a sketch sees it.
 */
export type CadJobKind = 'rebuild' | 'preview' | 'mesh' | 'export' | 'props' | 'query' | 'import';

/** building: running the history's steps; meshing: turning the solid into triangles for the view. */
export type CadPhase = 'building' | 'meshing';

export interface CadStep {
    /** Index of the step in the part's history. */
    index: number;
    id: string;
    name: string;
    op: string;
    /** Its place among the steps this build runs (1 = the first one not taken from the cache), and how many it runs. */
    ordinal: number;
    count: number;
}

export interface CadJobInfo {
    kind: CadJobKind;
    /** The part it builds, when it builds one. */
    partId?: string;
    partName?: string;
    /** Parts whose shown mesh this job makes: the part and its instances, when it is their real result. */
    parts: string[];
}

export interface CadJob extends CadJobInfo {
    phase: CadPhase;
    /** The step being built (absent before the first one, and while only meshing). */
    step?: CadStep;
    /** Server clock, ms. */
    startedAt: number;
}

export interface CadJobEnd extends CadJobInfo {
    ok: boolean;
    /** Server clock, ms. */
    endedAt: number;
    ms: number;
}

export interface CadActivity {
    job: CadJob | null;
    /** Jobs waiting behind the one running. */
    queued: number;
    /** Parts whose shown mesh is being rebuilt (running or waiting): a new result is coming. */
    building: string[];
    /** The job that ended last. */
    last: CadJobEnd | null;
    /** Server clock when this was sent, so a browser can line its own clock up with startedAt and endedAt. */
    at: number;
}

export const IDLE_CAD: CadActivity = { job: null, queued: 0, building: [], last: null, at: 0 };
