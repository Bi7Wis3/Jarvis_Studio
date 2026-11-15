// The sketch settings fields beyond snapping on or off (SolidWorks: Tools > Sketch Settings, Document Properties >
// Grid/Snap, System Options > Sketch and Relations/Snaps), for the Sketch settings form; and the Solve button for
// when Automatic solve is off.

import type { Field, Values } from './toolDefs';
import { solveSketch, useSketcher } from './sketcher';
import { DEFAULT_SKETCH_SETTINGS, solvesAtOnce, type SketchSettings } from './sketchSettings';
import { valueText } from './numberText';

const check = (key: keyof SketchSettings, label: string, section: string, show?: (v: Values) => boolean): Field =>
    ({ key, label, kind: 'check', section, ...(show ? { show } : {}) });

const CHECKS: (keyof SketchSettings)[] = [
    'autoRelations', 'autoSolve', 'noSolveMove', 'detachOnDrag', 'overrideDims', 'showRelations', 'gridDisplay', 'gridDash', 'gridAutoScale',
    'gridSnapOnlyShown', 'useFullyDefined', 'displayPlane', 'previewDims', 'ghostOnDrag', 'drivenOnCreate', 'relationsOnError', 'overDefPrompt',
    'overDefDriven', 'solveLimitOn',
];

export const SKETCH_SETTING_FIELDS: Field[] = [
    check('autoRelations', 'Automatic relations (hold Ctrl to leave them out for one click)', 'Sketch settings'),
    check('autoSolve', 'Automatic solve', 'Sketch settings'),
    check('noSolveMove', 'No solve move (drag without solving; what it would break is asked about)', 'Sketch settings'),
    check('detachOnDrag', 'Detach segment on drag', 'Sketch settings'),
    check('overrideDims', 'Override dimensions on drag', 'Sketch settings'),
    check('showRelations', 'Show relations in the view', 'Sketch settings'),
    check('gridDisplay', 'Display grid', 'Grid/Snap'),
    check('gridDash', 'Dash', 'Grid/Snap', (v) => !!v.gridDisplay),
    check('gridAutoScale', 'Automatic scaling (fewer lines when zoomed out)', 'Grid/Snap', (v) => !!v.gridDisplay),
    { key: 'gridMajor', label: 'Major grid spacing', kind: 'number', unit: 'mm', min: 0, step: 1, section: 'Grid/Snap' },
    { key: 'gridMinorPerMajor', label: 'Minor-lines per major', kind: 'number', min: 1, step: 1, section: 'Grid/Snap' },
    { key: 'gridSnapPerMinor', label: 'Snap points per minor', kind: 'number', min: 1, step: 1, section: 'Grid/Snap' },
    check('gridSnapOnlyShown', 'Snap only when grid is displayed', 'Grid/Snap'),
    { key: 'snapAngle', label: 'Snap angle', kind: 'number', unit: 'deg', min: 0, step: 1, section: 'Relations and snaps' },
    check('useFullyDefined', 'Use fully defined sketches (features only from fully defined sketches)', 'Sketch options'),
    check('displayPlane', 'Display plane when shaded', 'Sketch options'),
    check('previewDims', 'Preview sketch dimension when selected', 'Sketch options'),
    check('ghostOnDrag', 'Ghost image on drag', 'Sketch options'),
    check('drivenOnCreate', 'Sketch dimension driven (dimensions added while drawing are driven)', 'Sketch options'),
    check('relationsOnError', 'Show the relations list when the sketch becomes over defined or does not solve', 'Sketch options'),
    check('solveLimitOn', 'Turn off automatic solve and undo when the sketch has more entities than', 'Sketch options'),
    { key: 'solveLimit', label: 'Entities', kind: 'number', min: 1, step: 100, section: 'Sketch options', show: (v) => !!v.solveLimitOn },
    check('overDefPrompt', 'Prompt to set driven state', 'Over defining dimensions'),
    check('overDefDriven', 'Set driven by default', 'Over defining dimensions'),
];

export function sketchSettingValues(s: SketchSettings): Values {
    return {
        ...Object.fromEntries(CHECKS.map((key) => [key, !!s[key]])),
        snapAngle: valueText(s.snapAngle), gridMajor: valueText(s.gridMajor), gridMinorPerMajor: valueText(s.gridMinorPerMajor),
        gridSnapPerMinor: valueText(s.gridSnapPerMinor), solveLimit: valueText(s.solveLimit),
    };
}

function whole(v: Values, key: string, label: string): number {
    const n = Number(v[key]);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error(`${label} must be a whole number from 1.`);
    }
    return n;
}

function count(v: Values, key: string, label: string): number {
    const n = Number(v[key]);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
        throw new Error(`${label} must be a whole number from 1 to 1000.`);
    }
    return n;
}

export function sketchSettingsOf(v: Values): SketchSettings {
    const angle = Number(v.snapAngle);
    if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
        throw new Error('Snap angle must be between 0 and 180 degrees.');
    }
    const major = Number(v.gridMajor);
    if (!Number.isFinite(major) || !(major > 0)) {
        throw new Error('Major grid spacing must be more than 0 mm.');
    }
    return {
        ...DEFAULT_SKETCH_SETTINGS,
        ...Object.fromEntries(CHECKS.map((key) => [key, !!v[key]])),
        snapAngle: angle, gridMajor: major, gridMinorPerMajor: count(v, 'gridMinorPerMajor', 'Minor-lines per major'),
        gridSnapPerMinor: count(v, 'gridSnapPerMinor', 'Snap points per minor'),
        solveLimit: v.solveLimitOn ? whole(v, 'solveLimit', 'The entity count') : Number(v.solveLimit) > 0 ? Math.round(Number(v.solveLimit)) : DEFAULT_SKETCH_SETTINGS.solveLimit,
    } as SketchSettings;
}

/** Solve, for when Automatic solve is off. */
export function SolveButton() {
    const auto = useSketcher((s) => solvesAtOnce(s.settings, s.geometry.curves.length));
    return (
        <div className="sk-list-actions">
            <span className="tb-note">{auto ? 'Every change is solved at once.' : 'Automatic solve is off (or the sketch is over its entity limit): changes wait for Solve.'}</span>
            <button type="button" className="sk-small" onClick={() => solveSketch()}>Solve</button>
        </div>
    );
}
