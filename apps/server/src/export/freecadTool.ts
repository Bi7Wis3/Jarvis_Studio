// The export_freecad tool: writes the FreeCAD history macro and offers it as a download, reporting which steps came
// across as FreeCAD features, which with differences and which as solids.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CadKernel } from '../cad/kernel.js';
import { EXPORTS_DIR } from '../paths.js';
import { slug, type ProjectStore } from '../store.js';
import type { HostTool } from '../tools.js';
import type { FreecadExport } from './freecadMacro.js';

/** The tool's answer: where the file went and the steps that did not come across as plain FreeCAD features. */
export function freecadReport(made: FreecadExport, filename: string): string {
    const lines = [`Saved ${filename} (${Math.round(made.text.length / 1024)} KB) and sent it to the browser. Run it in FreeCAD `
        + '(Macro > Macros..., or freecad.cmd) to rebuild the history as a PartDesign Body.'];
    for (const part of made.parts) {
        const features = part.steps.filter((s) => s.how === 'feature').length;
        const changed = part.steps.filter((s) => s.how === 'changed');
        const solids = part.steps.filter((s) => s.how === 'solid');
        const left = part.steps.filter((s) => s.how === 'left out');
        lines.push('', `${part.name}: ${features} of ${part.steps.length} steps as FreeCAD features.`);
        if (solids.length) {
            lines.push(`Carried over as solids (FreeCAD cannot build them that way): ${solids.map((s) => `${s.name} (${s.detail})`).join('; ')}.`);
        }
        if (changed.length) {
            lines.push(`With differences: ${changed.map((s) => `${s.name}: ${s.detail.replace(/^[^:]*: /, '')}`).join('; ')}.`);
        }
        if (left.length) {
            lines.push(`Left out: ${left.map((s) => `${s.name} (${s.detail})`).join('; ')}.`);
        }
        if (part.notes.length) {
            lines.push(`Note: ${part.notes.join('; ')}.`);
        }
    }
    return lines.join('\n');
}

export function freecadTool(store: ProjectStore, host: { kernel: CadKernel; download: (filename: string) => void }): HostTool {
    return {
        name: 'export_freecad',
        description: 'Exports parts with their history as a FreeCAD macro (.FCMacro) and offers it as a download. Run in '
            + 'FreeCAD, it rebuilds each part as a PartDesign Body step by step, with sketches (relations and dimensions) '
            + 'and features named as here; steps FreeCAD cannot express are carried over as solids. Default: every part.',
        schema: {
            partIds: z.array(z.string()).min(1).optional().describe('Only these parts'),
        },
        run: async ({ partIds }: { partIds?: string[] }) => {
            const project = store.get();
            const made = await host.kernel.freecadMacro(project, partIds ?? []);
            const one = made.parts.length === 1 ? `-${slug(made.parts[0].name)}` : '';
            const filename = `${slug(project.name)}${one}-history.FCMacro`;
            mkdirSync(EXPORTS_DIR, { recursive: true });
            writeFileSync(join(EXPORTS_DIR, filename), made.text);
            host.download(filename);
            return { text: freecadReport(made, filename) };
        },
    };
}
