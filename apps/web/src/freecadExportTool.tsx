// Export > History for FreeCAD: a FreeCAD macro that rebuilds the part's history (export_freecad on the server).

import { runTool } from './state';
import type { ToolDef } from './toolDefs';

export const freecadExportTool: ToolDef = {
    id: 'freecad',
    label: 'History for FreeCAD',
    icon: 'freecad',
    hint: 'the steps, for FreeCAD',
    keepOpen: true,
    width: 320,
    top: () => (
        <p className="tb-note">
            A FreeCAD macro (.FCMacro) that rebuilds the part step by step as a PartDesign Body: sketches with their relations
            and dimensions, and features with the names they have here. Run it in FreeCAD 1.1 or later with Macro, Macros.
            Steps FreeCAD cannot build the same way come across as solids; the list appears here after the export.
        </p>
    ),
    fields: ({ part }) => (part ? [{ key: 'only', label: `Only ${part.name}`, kind: 'check' as const }] : []),
    defaults: ({ part }) => ({ only: !!part }),
    applyLabel: 'Export',
    apply: (v, { part }) => runTool('export_freecad', v.only && part ? { partIds: [part.id] } : {}),
};
