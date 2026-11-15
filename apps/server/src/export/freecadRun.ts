// Runs a history macro in FreeCAD headless (for tests): recomputes, checks every feature, measures each body.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** How to start FreeCAD's command line: the program and the environment it needs. */
export interface FreecadCommand {
    program: string;
    env: NodeJS.ProcessEnv;
}

export interface BodyResult {
    label: string;
    volume: number | null;
    box: number[] | null;
    valid: boolean;
    /** Labels of features FreeCAD could not rebuild. */
    invalid: string[];
    features: { label: string; type: string }[];
}

export interface FreecadResult {
    bodies: BodyResult[];
    notes: string[];
    seconds: number;
    /** FreeCAD's output, for messages. */
    log: string;
}

const DRIVER = String.raw`
import sys, json, time
import FreeCAD as App
t0 = time.time()
source = sys.stdin.read()
scope = {'__name__': '__main__'}
exec(compile(source, 'history.FCMacro', 'exec'), scope)
doc = App.ActiveDocument
doc.recompute()
out = {'bodies': [], 'notes': scope.get('NOTES', [])}
for body in [o for o in doc.Objects if o.TypeId == 'PartDesign::Body' and not o.Name.startswith('Tool')]:
    invalid = [o.Label for o in body.Group if 'Invalid' in o.State or 'Error' in o.State]
    tip = body.Tip
    shape = tip.Shape if tip is not None else None
    entry = {'label': body.Label, 'invalid': invalid, 'features': [{'label': o.Label, 'type': o.TypeId} for o in body.Group]}
    if shape is not None and not shape.isNull():
        b = shape.optimalBoundingBox(False, False)
        entry.update({'volume': shape.Volume, 'box': [b.XMin, b.YMin, b.ZMin, b.XMax, b.YMax, b.ZMax], 'valid': shape.isValid()})
    else:
        entry.update({'volume': None, 'box': None, 'valid': False})
    out['bodies'].append(entry)
out['seconds'] = time.time() - t0
sys.stdout.write('\nJARVIS-RESULT ' + json.dumps(out) + '\n')
sys.stdout.flush()
`;

function works(command: FreecadCommand): boolean {
    const run = spawnSync(command.program, ['-c', "print('jarvis-ok')"], { env: command.env, encoding: 'utf8', timeout: 60_000 });
    return run.status === 0 && /jarvis-ok/.test(`${run.stdout}${run.stderr}`);
}

let found: FreecadCommand | null | undefined;

/**
 * FreeCAD's command line, or null when it is not installed: FREECAD_CMD, FreeCADCmd or freecadcmd on the path, the
 * snap's binary run directly (where snap confinement is not available), or the snap's freecad.cmd.
 */
export function findFreecad(): FreecadCommand | null {
    if (found !== undefined) {
        return found;
    }
    const candidates: FreecadCommand[] = [];
    if (process.env.FREECAD_CMD) {
        candidates.push({ program: process.env.FREECAD_CMD, env: process.env });
    }
    candidates.push({ program: 'FreeCADCmd', env: process.env }, { program: 'freecadcmd', env: process.env });
    const snap = '/snap/freecad/current';
    const kf6 = '/snap/kf6-core24/current';
    if (existsSync(`${snap}/usr/bin/FreeCADCmd`) && existsSync(kf6)) {
        candidates.push({
            program: `${snap}/usr/bin/FreeCADCmd`,
            env: {
                ...process.env,
                LD_LIBRARY_PATH: [`${snap}/usr/lib`, `${snap}/usr/lib/x86_64-linux-gnu`, `${snap}/lib/x86_64-linux-gnu`,
                    `${kf6}/usr/lib/x86_64-linux-gnu`, `${kf6}/usr/lib`].join(':'),
                PYTHONHOME: `${kf6}/usr`,
            },
        });
    }
    candidates.push({ program: 'freecad.cmd', env: process.env });
    found = candidates.find((c) => {
        try {
            return works(c);
        } catch {
            return false;
        }
    }) ?? null;
    return found;
}

/** Runs the macro (given as text) in FreeCAD at the lowest priority and reports every body it made. */
export function runFreecad(command: FreecadCommand, macro: string, timeoutMs = 900_000): FreecadResult {
    const run = spawnSync('nice', ['-n', '19', command.program, '-c', `exec(${JSON.stringify(DRIVER)})`], {
        env: command.env, input: macro, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
    });
    const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const line = log.split('\n').find((l) => l.startsWith('JARVIS-RESULT '));
    if (!line) {
        throw new Error(`FreeCAD did not finish the macro (status ${run.status}${run.error ? `, ${run.error.message}` : ''}):\n${log.slice(-4000)}`);
    }
    const result = JSON.parse(line.slice('JARVIS-RESULT '.length)) as Omit<FreecadResult, 'log'>;
    return { ...result, log };
}
