// Fillet and chamfer coverage on the owner's SolidWorks parts (read through the app's own reader).
//
//   cd apps/server && nice -n 19 npx tsx ../../tools/blendCorpus.ts [folder] [--out file] [--edges 40]
//
// For each body a spread of edges is picked (line, circle and spline edges; convex and concave corners; every pairing
// of face types present), up to --edges per body, and on each a fillet and a chamfer are tried at 0.3 mm, 1 mm and a
// quarter of the narrower neighbouring face's width, through filletEdges / chamferEdges. Each case is first run the
// old way (OpenCascade, loop blend, run-out blend); only where that fails is it run again with the flag clearing and
// the section blend. Files run one at a time, each in its own process (a hanging case is skipped after a time limit).

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CaseResult {
    file: string;
    body: number;
    edge: number;
    curve: string;
    corner: string;
    faces: string;
    kind: 'fillet' | 'chamfer';
    size: string;
    mm: number;
    /** How the old way made it (null: it failed), and whether that result checks out. */
    before: string | null;
    beforeValid: boolean;
    after: string | null;
    valid: boolean;
    ms: number;
    reason?: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};

// ---- Worker: one file ------------------------------------------------------------------------------------------

async function worker(file: string, from: number, perBody: number): Promise<void> {
    const { default: opencascade } = await import('replicad-opencascadejs');
    const { cast, getOC, measureVolume, setOC } = await import('replicad');
    type Shape3D = import('replicad').Shape3D;
    type Edge = import('replicad').Edge;
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
    const { readSldprt } = await import('../apps/server/src/import/sldprt/readSldprt.js');
    const { blendTap, chamferEdges, filletEdges } = await import('../apps/server/src/cad/applied.js');
    const { insideCorner } = await import('../apps/server/src/cad/runoutBlend.js');
    const oc = getOC() as any;
    const read = readSldprt(new Uint8Array(readFileSync(file)));
    let index = 0;
    for (const [b, body] of read.bodies.entries()) {
        const shape = body.shape as Shape3D;
        if (!shape.solids || shape.solids.length !== 1) {
            continue;
        }
        const solid = shape.solids[0];
        const faces = solid.faces;
        const faceEdges = faces.map((f) => f.edges);
        const facesOf = (e: Edge) => faces.filter((_, k) => faceEdges[k].some((x) => x.isSame(e)));
        // Classify the edges, then pick round-robin over the classes.
        const groups = new Map<string, { edge: Edge; i: number; curve: string; corner: string; faces: string; width: number }[]>();
        solid.edges.forEach((edge, i) => {
            const fs = facesOf(edge);
            if (fs.length !== 2 || fs[0].isSame(fs[1]) || oc.BRep_Tool.Degenerated(edge.wrapped)) {
                return;
            }
            const inside = insideCorner(solid, edge);
            if (inside === null) {
                return;
            }
            const curve = edge.geomType;
            const corner = inside ? 'concave' : 'convex';
            const pair = fs.map((f) => f.geomType).sort().join('+');
            const width = Math.min(...fs.map((f) => {
                const area = (() => {
                    const props = new oc.GProp_GProps();
                    oc.BRepGProp.SurfaceProperties(f.wrapped, props, false, false);
                    const m = props.Mass();
                    props.delete();
                    return m;
                })();
                const perimeter = f.edges.reduce((sum, e) => sum + e.length, 0);
                return 2 * area / (perimeter || 1);
            }));
            const key = `${curve}|${corner}|${pair}`;
            const list = groups.get(key) ?? [];
            list.push({ edge, i, curve, corner, faces: pair, width });
            groups.set(key, list);
        });
        const keys = [...groups.keys()].sort();
        const chosen: NonNullable<ReturnType<typeof groups.get>> = [];
        for (let round = 0; chosen.length < perBody; round++) {
            let any = false;
            for (const key of keys) {
                const list = groups.get(key)!;
                // Spread over the group: its members in a stride order.
                const stride = Math.max(1, Math.floor(list.length / 4));
                const order = list.map((_, k) => k).sort((x, y) => (x % stride) - (y % stride) || x - y);
                if (round < order.length && chosen.length < perBody) {
                    chosen.push(list[order[round]]);
                    any = true;
                }
            }
            if (!any) {
                break;
            }
        }
        const preciseVolume = (x: Shape3D): number => {
            const props = new oc.GProp_GProps();
            oc.BRepGProp.VolumeProperties(x.wrapped, props, 1e-7, false, false);
            const v = props.Mass();
            props.delete();
            return v;
        };
        const before0 = preciseVolume(solid);
        const text = oc.BRepToolsWrapper.Write(solid.wrapped);
        for (const c of chosen) {
            const quarter = Math.round(c.width / 4 * 1e4) / 1e4;
            const sizes: [string, number][] = [['0.3', 0.3], ['1', 1]];
            if (quarter > 0.01 && Math.abs(quarter - 0.3) > 0.03 && Math.abs(quarter - 1) > 0.1) {
                sizes.push(['quarter', quarter]);
            }
            for (const kind of ['fillet', 'chamfer'] as const) {
                for (const [label, mm] of sizes) {
                    if (index++ < from) {
                        continue;
                    }
                    console.log(`START ${index - 1}`);
                    const result: CaseResult = {
                        file, body: b, edge: c.i, curve: c.curve, corner: c.corner, faces: c.faces, kind, size: label, mm,
                        before: null, beforeValid: false, after: null, valid: false, ms: 0,
                    };
                    const t0 = Date.now();
                    const run = (old: boolean): { way: string | null; out: Shape3D | null; reason?: string } => {
                        let way: string | null = null;
                        blendTap.old = old;
                        blendTap.made = (w) => {
                            way = w;
                        };
                        try {
                            // Each case on its own copy of the body (read back from text: the same edges in the same
                            // order), so nothing one case does to the body can reach the next.
                            const body = (cast(oc.BRepToolsWrapper.Read(text)) as Shape3D).solids![0] as Shape3D;
                            const edge = body.edges[c.i];
                            const out = kind === 'fillet' ? filletEdges(body, [edge], { radius: mm })
                                : chamferEdges(body, [edge], { distance: mm });
                            return { way: way ?? 'kernel', out };
                        } catch (e) {
                            return { way: null, out: null, reason: (e as Error).message ?? String(e) };
                        } finally {
                            blendTap.made = null;
                            blendTap.old = false;
                        }
                    };
                    // Valid: one valid solid, with material taken away at a convex edge and added at a concave one.
                    const verdict = (out: Shape3D | null): string | null => {
                        if (!out) {
                            return 'failed';
                        }
                        const check = new oc.BRepCheck_Analyzer(out.wrapped, true, false);
                        const ok = check.IsValid();
                        check.delete();
                        if (!ok) {
                            return 'invalid solid';
                        }
                        if ((out.solids?.length ?? 0) !== 1) {
                            return 'not one solid';
                        }
                        const change = preciseVolume(out) - before0;
                        const rightWay = c.corner === 'convex' ? change < -1e-9 : change > 1e-9;
                        return rightWay ? null : `volume change ${change}`;
                    };
                    let made = run(true);
                    let bad = verdict(made.out);
                    result.before = made.way;
                    result.beforeValid = bad === null;
                    if (bad !== null) {
                        made = run(false);
                        bad = verdict(made.out);
                    }
                    result.after = made.way;
                    result.valid = bad === null;
                    result.reason = (made.reason ?? (bad && bad !== 'failed' ? bad : undefined))?.slice(0, 400);
                    result.ms = Date.now() - t0;
                    console.log(`RESULT ${JSON.stringify(result)}`);
                }
            }
        }
    }
    console.log('DONE');
}

// ---- Driver ------------------------------------------------------------------------------------------------------

function findParts(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
            out.push(...findParts(p));
        } else if (/\.sldprt$/i.test(name)) {
            out.push(p);
        }
    }
    return out.sort();
}

function runFile(file: string, from: number, perBody: number, limitMs: number): Promise<{ results: CaseResult[]; hung: number | null; error?: string }> {
    return new Promise((resolve) => {
        const script = fileURLToPath(import.meta.url);
        const child = spawn(process.execPath, [...process.execArgv, script, '--file', file, '--from', String(from), '--edges', String(perBody)],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        const results: CaseResult[] = [];
        let started: number | null = null;
        let done = false;
        let buffer = '';
        let errors = '';
        let timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
        child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.startsWith('START ')) {
                    started = Number(line.slice(6));
                    clearTimeout(timer);
                    timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
                } else if (line.startsWith('RESULT ')) {
                    results.push(JSON.parse(line.slice(7)));
                    process.stderr.write('.');
                } else if (line === 'DONE') {
                    done = true;
                }
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            errors += chunk.toString();
        });
        child.on('close', () => {
            clearTimeout(timer);
            const hung = done ? null : started;
            resolve({ results, hung, error: done ? undefined : errors.slice(-500) });
        });
    });
}

function table(results: CaseResult[], keyOf: (r: CaseResult) => string): string {
    const rows = new Map<string, { n: number; before: number; after: number; valid: number }>();
    for (const r of results) {
        const k = keyOf(r);
        const row = rows.get(k) ?? { n: 0, before: 0, after: 0, valid: 0 };
        row.n++;
        if (r.before && r.beforeValid) {
            row.before++;
        }
        if (r.after && r.valid) {
            row.after++;
        }
        rows.set(k, row);
    }
    const pct = (a: number, n: number): string => `${(100 * a / (n || 1)).toFixed(1)}%`;
    const lines = [...rows.entries()].sort((a, b) => b[1].n - a[1].n)
        .map(([k, v]) => `${k.padEnd(52)} ${String(v.n).padStart(6)} ${pct(v.before, v.n).padStart(8)} ${pct(v.after, v.n).padStart(8)}`);
    return [`${'class'.padEnd(52)} ${'cases'.padStart(6)} ${'before'.padStart(8)} ${'after'.padStart(8)}`, ...lines].join('\n');
}

function summary(results: CaseResult[]): string {
    const out: string[] = [];
    const total = results.length;
    const before = results.filter((r) => r.before && r.beforeValid).length;
    const after = results.filter((r) => r.after && r.valid).length;
    out.push(`cases ${total}; made and valid before ${before} (${(100 * before / (total || 1)).toFixed(1)}%), after ${after} `
        + `(${(100 * after / (total || 1)).toFixed(1)}%)`);
    const ways = new Map<string, number>();
    for (const r of results) {
        const w = r.after ? (r.valid ? r.after : `${r.after} (invalid)`) : 'failed';
        ways.set(w, (ways.get(w) ?? 0) + 1);
    }
    out.push(`made by: ${[...ways.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
    out.push('', 'By kind and size', table(results, (r) => `${r.kind} ${r.size}`));
    out.push('', 'By edge curve', table(results, (r) => r.curve));
    out.push('', 'By corner', table(results, (r) => r.corner));
    out.push('', 'By face pair', table(results, (r) => r.faces));
    out.push('', 'By curve, corner and kind', table(results, (r) => `${r.curve} ${r.corner} ${r.kind}`));
    // Remaining failures by cause (the reason's leading words, numbers and places dropped).
    const causes = new Map<string, number>();
    for (const r of results.filter((x) => !(x.after && x.valid))) {
        const plain = (r.reason ?? 'unknown').replace(/[-\d.]+(e-?\d+)?/g, '#').replace(/\s+/g, ' ');
        const m = /fails too: ([^;)]*?)(\(#[^)]*\))?(\)|;|$)/.exec(plain);
        const cause = (m ? `sections: ${m[1].trim()}` : plain.replace(/\([^)]*\)/g, '')).slice(0, 110);
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
    }
    out.push('', 'Remaining failures by cause');
    for (const [k, v] of [...causes.entries()].sort((a, b) => b[1] - a[1])) {
        out.push(`${String(v).padStart(5)}  ${k}`);
    }
    const times = results.map((r) => r.ms).sort((a, b) => a - b);
    out.push('', `time per case: median ${times[Math.floor(times.length / 2)] ?? 0} ms, 90% ${times[Math.floor(times.length * 0.9)] ?? 0} ms, `
        + `max ${times[times.length - 1] ?? 0} ms`);
    return out.join('\n');
}

async function driver(): Promise<void> {
    const root = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? process.env.JARVIS_DESIGNS;
    if (!root) {
        throw new Error('Give the folder of SLDPRT files to scan, or set JARVIS_DESIGNS');
    }
    const outFile = flag('--out') ?? join(fileURLToPath(new URL('.', import.meta.url)), 'blendCorpus.out.txt');
    const perBody = Number(flag('--edges') ?? 40);
    const limit = Number(flag('--limit') ?? 120_000);
    const only = flag('--only');
    const files = findParts(root).filter((f) => !only || f.includes(only));
    const all: CaseResult[] = [];
    const notes: string[] = [];
    for (const file of files) {
        const t0 = Date.now();
        let from = 0;
        for (;;) {
            const { results, hung, error } = await runFile(file, from, perBody, limit);
            all.push(...results);
            if (hung === null) {
                if (error) {
                    notes.push(`${file}: stopped (${error.replace(/\s+/g, ' ').slice(-200)})`);
                }
                break;
            }
            notes.push(`${file}: case ${hung} took over ${limit / 1000} s and was skipped`);
            from = hung + 1;
        }
        process.stderr.write(`\n${file}: ${Date.now() - t0} ms\n`);
        writeFileSync(outFile, `${summary(all)}\n\nNotes\n${notes.join('\n')}\n\nCases\n${all.map((r) => JSON.stringify(r)).join('\n')}\n`);
    }
}

if (args.includes('--file')) {
    await worker(flag('--file')!, Number(flag('--from') ?? 0), Number(flag('--edges') ?? 40));
} else {
    await driver();
}
