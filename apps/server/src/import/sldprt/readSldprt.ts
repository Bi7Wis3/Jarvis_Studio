// SolidWorks part files (.SLDPRT, both the OLE format before 2015 and the 2015+ archive) to OpenCascade solids.
// The part's bodies are read from the Parasolid partition SolidWorks keeps of the model, not from its feature
// history (which cannot be rebuilt here). Lengths are converted from metres to millimetres; the frame is the
// SolidWorks model frame (Y up). OpenCascade must be loaded (replicad's setOC) before calling.

import { inflateSync } from 'node:zlib';
import type { Shape3D } from 'replicad';
import { readContainer } from './container.js';
import { parseXt } from './xtParse.js';
import { UnsupportedGeometry, XtModel } from './xtModel.js';
import { curveBuilder } from './rebuild.js';
import { bodyToBrep } from './brep.js';
import { faceCount, ocErrorMessage, solidsFromBrep } from './occ.js';
import type { XtNode } from './xtParse.js';

export interface SldprtBody {
    shape: Shape3D;
    name?: string;
    /** CSS hex colour, when the body's faces carry one. */
    colour?: string;
}

export interface SldprtResult {
    bodies: SldprtBody[];
    warnings: string[];
    /** The preview SolidWorks saved with the part (PNG). */
    thumbnail?: Uint8Array;
    /** Parasolid version that wrote the model, e.g. "27.0.199". */
    modellerVersion?: string;
}

const BLOCK_GUID = '231dd571da8148a2a85898b21b89ef99';

/**
 * A partition stream: blocks of [length, GUID, unpacked size, packed size, zlib data]. The first holds the
 * partition transmit file; the second the deltas (undo history), not needed here.
 */
export function partitionBlocks(data: Uint8Array): Uint8Array[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out: Uint8Array[] = [];
    for (let p = 0; p + 28 <= data.length;) {
        const length = view.getUint32(p, true);
        const guid = Buffer.from(data.subarray(p + 4, p + 20)).toString('hex');
        const size = view.getUint32(p + 20, true);
        const packed = view.getUint32(p + 24, true);
        if (guid !== BLOCK_GUID || p + 28 + packed > data.length) {
            break;
        }
        const block = new Uint8Array(inflateSync(data.subarray(p + 28, p + 28 + packed)));
        if (block.length !== size) {
            throw new Error('A Parasolid block of the part unpacks to the wrong size');
        }
        out.push(block);
        p += 4 + length;
    }
    return out;
}

const versionText = (v: number): string => `${Math.floor(v / 100000)}.${Math.floor(v / 1000) % 100}.${v % 1000}`;

const hex = (rgb: number[]): string => `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

/** A body's name (Parasolid name attribute) and its most common face colour. */
function nameAndColour(m: XtModel, body: XtNode): { name?: string; colour?: string } {
    let name: string | undefined;
    for (const a of m.attributes(body)) {
        if (a.id === 'SDL/TYSA_NAME') {
            const v = a.fields[0]?.f.values;
            if (typeof v === 'string' && v.trim()) {
                name = v.trim();
            }
        }
    }
    const counts = new Map<string, number>();
    for (const region of m.chain(body.f.region, 'next')) {
        for (const shell of m.chain(region.f.shell, 'next')) {
            for (const face of [...m.chain(shell.f.face, 'next'), ...m.chain(shell.f.front_face, 'next_front')]) {
                for (const a of m.attributes(face)) {
                    const v = a.fields[0]?.f.values;
                    if (a.id === 'SDL/TYSA_COLOUR' && Array.isArray(v) && v.length >= 3) {
                        const c = hex(v as number[]);
                        counts.set(c, (counts.get(c) ?? 0) + 1);
                    }
                }
            }
        }
    }
    const colour = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { name, colour };
}

const BODY_TYPES: Record<number, string> = { 1: 'solid', 2: 'wire', 3: 'sheet', 6: 'general' };

export function readSldprt(bytes: Uint8Array): SldprtResult {
    const container = readContainer(bytes);
    const warnings = [...container.warnings];
    const thumbnail = container.streams.get('PreviewPNG');
    const partitions = [...container.streams.keys()].filter((k) => /^Contents\/Config-\d+-Partition$/.test(k))
        .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
    if (partitions.length === 0) {
        throw new Error('The part file holds no model (no Parasolid partition); it may be empty or from an assembly');
    }
    if (partitions.length > 1) {
        warnings.push(`The part has ${partitions.length} configurations; the first one was read`);
    }
    const blocks = partitionBlocks(container.streams.get(partitions[0])!);
    const xtData = blocks.find((b) => Buffer.from(b.subarray(0, 80)).toString('latin1').includes('(partition)')) ?? blocks[0];
    if (!xtData) {
        throw new Error('The part\'s Parasolid data could not be unpacked');
    }
    const xt = parseXt(xtData);
    const model = new XtModel(xt);
    model.curveBuilder = curveBuilder;

    const bodies: SldprtBody[] = [];
    const approximated = new Map<string, { count: number; error: number }>();
    const all = model.bodies();
    for (const [i, body] of all.entries()) {
        const label = all.length > 1 ? `Body ${i + 1}` : 'The body';
        const type = BODY_TYPES[body.f.body_type as number] ?? 'unknown';
        const solidRegions = model.chain(body.f.region, 'next').filter((r) => r.f.type === 'S');
        if (solidRegions.length === 0) {
            warnings.push(`${label} is a ${type} body, not a solid, and was left out`);
            continue;
        }
        try {
            let brep = bodyToBrep(model, body);
            let result = solidsFromBrep(brep.text);
            if (!result.valid) {
                const again = bodyToBrep(model, body, { centreTubeSeams: true });
                const second = solidsFromBrep(again.text);
                if (second.valid) {
                    brep = again;
                    result = second;
                }
            }
            for (const a of brep.approximated) {
                const t = approximated.get(a.kind) ?? { count: 0, error: 0 };
                approximated.set(a.kind, { count: t.count + a.count, error: Math.max(t.error, a.error) });
            }
            if (!result.valid) {
                warnings.push(`${label} is not a valid closed solid after conversion; check it before modelling on it`);
            } else if (result.repair) {
                warnings.push(`${label} needed repair (${result.repair})`);
            }
            if (brep.edgeDeviation.beyond > 1e-3) {
                warnings.push(`${label} has an edge ${brep.edgeDeviation.dev.toPrecision(2)} mm off its faces`);
            }
            const faces = faceCount(result.shape.wrapped);
            if (faces < brep.faces) {
                warnings.push(`${label} lost ${brep.faces - faces} of its ${brep.faces} faces in conversion`);
            }
            bodies.push({ shape: result.shape, ...nameAndColour(model, body) });
        } catch (error) {
            const why = error instanceof UnsupportedGeometry ? error.message : ocErrorMessage(error);
            warnings.push(`${label} could not be converted: ${why}`);
        }
    }
    for (const [kind, a] of approximated) {
        warnings.push(`${a.count} ${kind} face${a.count === 1 ? ' was' : 's were'} rebuilt as B-spline surfaces `
            + `(within ${a.error < 1e-6 ? '0.000001' : a.error.toPrecision(2)} mm of the original)`);
    }
    return { bodies, warnings, thumbnail, modellerVersion: xt.modellerVersion ? versionText(xt.modellerVersion) : undefined };
}
