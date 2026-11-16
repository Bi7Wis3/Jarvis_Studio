// import_file: Jarvis brings a CAD file from this machine into the project, as File > Import does.

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { CadKernel } from '../cad/kernel.js';
import type { ProjectStore } from '../store.js';
import type { HostTool } from '../tools.js';
import { readImportFile } from './fromPath.js';
import { importIntoProject } from './project.js';
import { IMPORTERS } from './registry.js';
import { importOptionsSchema } from './schema.js';

export function importFileTool(store: ProjectStore, host: { kernel: CadKernel }): HostTool {
    const types = IMPORTERS.map((i) => i.label).join(', ');
    return {
        name: 'import_file',
        description: `Imports a CAD file from this computer into the project (${types}). Its bodies come in as an `
            + 'Imported step (Imported1; STL Graphics1 for a mesh shown as a graphics body) at the top of a new part, or '
            + 'appended to an existing part, and later features (fillets, cuts) work on its solid bodies. STEP keeps '
            + 'exact solids; an STL comes in as a graphics body unless options.meshAs is "solid" (one face per facet, '
            + 'closed meshes only). Files are taken as Z up and turned to the studio\'s Y up unless options.up is "y".',
        schema: {
            path: z.string().describe('Absolute path of the file (~ for the home folder)'),
            target: z.string().optional().describe('"new" (default): new part(s); or the id of the part to add the bodies to'),
            replace: z.string().optional().describe('With target: the id of an Imported step to replace with this file'),
            options: importOptionsSchema.optional(),
        },
        run: async ({ path, target, replace, options }: { path: string; target?: string; replace?: string; options?: z.infer<typeof importOptionsSchema> }) => {
            const full = path.startsWith('~') ? resolve(homedir(), path.slice(1).replace(/^[/\\]/, '')) : path;
            if (!isAbsolute(full)) {
                throw new Error('Give the absolute path of the file');
            }
            const report = await importIntoProject(store, host.kernel, { ...await readImportFile(full), options, target, replace });
            return { text: `${report.text}\nParts: ${report.parts.join(', ')}; steps: ${report.steps.join(', ')}.` };
        },
    };
}
