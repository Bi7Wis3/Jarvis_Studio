import { z, type ZodRawShape } from 'zod';
import {
    DEFAULT_PRINT, explodeOffsets, THREAD_SIZES, timelineSteps, type Decal, type Feature, type Part, type Project, type Vec3,
} from '@jarvis/core';
import { slug, type ProjectStore } from './store.js';

export interface StudioTool {
    name: string;
    description: string;
    schema: ZodRawShape;
    run: (args: any) => string;
}

export interface ToolOutput {
    text: string;
    image?: { data: string; mimeType: string };
}

/** A tool that needs something outside the project store, such as the browser or the disk. */
export interface HostTool extends Omit<StudioTool, 'run'> {
    run: (args: any) => Promise<ToolOutput>;
}

export type AnyTool = StudioTool | HostTool;

/** Runs a tool and shapes its output as an MCP tool result. Failures are reported to the model, not thrown. */
export async function callTool(tool: AnyTool, args: unknown) {
    try {
        const output = await tool.run(args);
        const { text, image } = typeof output === 'string' ? { text: output, image: undefined } : output;
        return {
            content: [
                { type: 'text' as const, text },
                ...(image ? [{ type: 'image' as const, ...image }] : []),
            ],
        };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[tools] ${tool.name} failed: ${reason}`);
        return { content: [{ type: 'text' as const, text: `Failed: ${reason}` }], isError: true };
    }
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
/** A face picked in the view: a point on it and its outward normal (part frame). */
const facePick = z.object({ at: vec3, normal: vec3.optional() });
/** Edges picked in the view (a point on each), the edges of picked faces, and whether to follow smooth chains. */
const edgePicks = {
    at: z.array(vec3).optional().describe('Picked edges: a point on each, in the part frame'),
    faces: z.array(facePick).optional().describe('Picked faces: all their edges are used'),
    tangent: z.boolean().optional().describe('Follow each picked edge along its smooth chain'),
};

const point2 = z.tuple([z.number(), z.number()]);
const planeRef = z.union([z.enum(['top', 'front', 'right']), z.object({ planeRef: z.string() })])
    .describe('A base plane, or { planeRef: id } of an earlier plane step');
const axisRef = z.union([z.enum(['x', 'y', 'z']), z.object({ axisRef: z.string() })])
    .describe('A part axis through the origin, or { axisRef: id } of an earlier axis step');
const pointRef = z.union([vec3, z.object({ pointRef: z.string() })])
    .describe('A point [x, y, z] in the part frame, or { pointRef: id } of an earlier point step');
const sketchLineAxis = z.object({ line: z.string() }).describe('A line or centreline of the sketch, by curve id (sketch geometry)');
const sketchProfile = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('rect'), center: point2, width: z.number().positive(), height: z.number().positive(),
        radius: z.number().min(0).optional().describe('Corner radius') }),
    z.object({ kind: z.literal('circle'), center: point2, radius: z.number().positive() }),
    z.object({ kind: z.literal('slot'), from: point2, to: point2, radius: z.number().positive() }),
    z.object({ kind: z.literal('polygon'), points: z.array(point2).min(3) }),
    z.object({
        kind: z.literal('path'),
        start: point2,
        segments: z.array(z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('line'), to: point2 }),
            z.object({ kind: z.literal('arc'), to: point2, through: point2.describe('A point the arc passes through') }),
        ])).min(1),
    }),
]);
const sketch = z.object({
    plane: z.union([
        z.enum(['top', 'front', 'right']),
        z.object({ origin: vec3, normal: vec3, xDir: vec3.describe('Sketch u axis, perpendicular to normal') }),
        z.object({ planeRef: z.string() }),
    ]).describe('top: ground plane, u=+X v=-Z; front: u=+X v=+Y; right: u=-Z v=+Y; any plane in the part frame; '
        + 'or { planeRef } of a construction plane step (preferred for anything not on a base plane)'),
    offset: z.number().optional().describe('Moves the plane along its normal (top: up, front: toward +Z, right: +X)'),
    profiles: z.array(sketchProfile).describe('Closed profiles in (u, v) mm; a profile inside another is a hole'),
    // The sketcher's constrained source; kept as given (the sketcher validates it), profiles stay authoritative.
    geometry: z.object({
        points: z.array(z.looseObject({ id: z.string(), u: z.number(), v: z.number() })),
        curves: z.array(z.looseObject({ id: z.string(), kind: z.string() })),
        constraints: z.array(z.looseObject({ id: z.string(), kind: z.string() })),
    }).optional().describe('Leave out; written by the interactive sketcher'),
    regions: z.array(z.object({ loops: z.array(sketchProfile).min(1), at: point2 })).optional()
        .describe('Leave out; written by the interactive sketcher (every closed area of the sketch, for picking)'),
    open: z.array(sketchProfile).optional()
        .describe('Open chains (path profiles, not closed back to their start), e.g. a sweep path; profiles holds only closed areas'),
});
/** Pick points selecting some closed areas of the sketch instead of all of it. */
const regionPicks = z.array(point2).optional()
    .describe('Sketcher-made sketches only: points in sketch (u, v); the step uses just the closed areas containing '
        + 'them, so one sketch can feed several extrudes and cuts. Leave out for the whole sketch');
const extrudeDirection = z.enum(['normal', 'reverse', 'symmetric']);
const extrudeEnd = z.enum(['blind', 'throughAll', 'upToNext']);
/** Give exactly one: an inline sketch, or the id of an earlier sketch step of the same part. */
const sketchSource = {
    sketch: sketch.optional(),
    sketchRef: z.string().optional().describe('Id of an earlier sketch step of this part, instead of an inline sketch'),
};

const shape = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('box'), size: vec3, radius: z.number().optional()
        .describe('Edge rounding in mm; a small one is applied by default, use more for soft consumer forms') }),
    z.object({
        kind: z.literal('cylinder'),
        radius: z.number(),
        radiusTop: z.number().optional().describe('Set for a tapered cylinder'),
        height: z.number(),
        bevel: z.number().min(0).optional().describe('Rim rounding in mm; a small one is applied by default'),
    }),
    z.object({ kind: z.literal('tube'), outerRadius: z.number(), innerRadius: z.number(), height: z.number() }),
    z.object({ kind: z.literal('sphere'), radius: z.number() }),
    z.object({ kind: z.literal('torus'), radius: z.number(), tube: z.number().describe('Radius of the ring wire') }),
    z.object({ kind: z.literal('cone'), radius: z.number(), height: z.number() }),
    z.object({ kind: z.literal('capsule'), radius: z.number(), length: z.number() }),
    z.object({
        kind: z.literal('lathe'),
        profile: z.array(z.tuple([z.number(), z.number()])).min(2)
            .describe('[radius, y] points revolved around the Y axis, relative to the part position'),
        smooth: z.boolean().optional().describe('Run a smooth curve through the points for organic, flowing forms'),
    }),
    z.object({
        kind: z.literal('extrude'),
        outline: z.array(z.tuple([z.number(), z.number()])).min(3)
            .describe('Closed [x, z] outline seen from above, relative to the part position'),
        height: z.number().positive().describe('Thickness along Y'),
        bevel: z.number().min(0).optional(),
    }),
    z.object({
        kind: z.literal('fastener'),
        type: z.enum(['socketCap', 'buttonHead', 'countersunk', 'hexBolt', 'hexNut', 'nylocNut', 'squareNut', 'washer',
            'heatsetInsert']).describe('ISO hardware: socketCap 4762, buttonHead 7380, countersunk 10642, hexBolt 4017, '
            + 'hexNut 4032, nylocNut 10511, squareNut DIN 562, washer 7089, heatsetInsert for plastic'),
        size: z.enum(THREAD_SIZES),
        length: z.number().positive().optional().describe('Screws and bolts: length as sold, under the head '
            + '(countersunk: overall). Use a standard length: 4 5 6 8 10 12 14 16 18 20 25 30 35 40 45 50'),
        thread: z.enum(['modelled', 'plain']).optional(),
    }).describe('Screws and bolts: origin at the underside of the head (countersunk: top of the head), head +Y, '
        + 'shank -Y. Nuts, washers, inserts: axis Y, bottom face at y=0. Place them with position and rotation.'),
    z.object({
        kind: z.literal('script'),
        code: z.string().describe('Body of a function (r, params) => solid, using replicad as r. Author in '
            + 'replicad\'s own frame: Z up, front toward -Y; it is turned to the app frame for you.'),
        params: z.record(z.string(), z.number()).optional().describe('Named dimensions the code reads, e.g. { length: 810 }'),
        size: vec3.describe('Rough bounding box [x, y, z] in the app frame (Y up), shown until the kernel has built it'),
    }).describe('Any solid a CAD program can make: splines, lofts, sweeps, revolves, booleans, bent and organic forms'),
    z.object({ kind: z.literal('empty') })
        .describe('No body yet: start the history with a sketch step; the first extrude/revolve/loft add makes the body'),
    z.object({
        kind: z.literal('sketch'),
        sketch,
        extrude: z.object({ distance: z.number(), direction: extrudeDirection.optional() }).optional(),
        revolve: z.object({
            axis: z.union([z.enum(['u', 'v']), sketchLineAxis]),
            angle: z.number().optional().describe('Degrees, default 360'),
        }).optional(),
    }).describe('A body from a 2D sketch, extruded or revolved (set exactly one). Exact CAD body, no automatic rounding'),
]);

const material = z.object({
    color: z.string().describe('CSS hex colour, e.g. #c9d1d9'),
    metalness: z.number().min(0).max(1),
    roughness: z.number().min(0).max(1),
    emissive: z.string().optional().describe('Glow colour for lights and displays'),
    emissiveIntensity: z.number().optional().describe('Values above 1 bloom'),
    opacity: z.number().min(0).max(1).optional().describe('Below 1 for tinted or smoked plastic'),
    clearcoat: z.number().min(0).max(1).optional().describe('Glossy lacquer layer: piano black, car paint, glazed ceramic'),
    transmission: z.number().min(0).max(1).optional().describe('Clear glass or acrylic that light passes through'),
});

const repeat = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('radial'),
        count: z.number().int().min(2).max(96),
        centre: z.tuple([z.number(), z.number()]).optional().describe('[x, z] of the vertical axis; default [0, 0]'),
        angle: z.number().optional().describe('Total sweep in degrees; default 360'),
    }),
    z.object({
        kind: z.literal('linear'),
        count: z.number().int().min(2).max(96),
        step: vec3.describe('Offset in mm from one copy to the next'),
    }),
]);

const edgeSelect = z.enum(['all', 'top', 'bottom', 'vertical', 'horizontal'])
    .describe('In the part frame: top/bottom = edges at its highest/lowest Y, vertical = edges along Y');
const faceSelect = z.enum(['top', 'bottom', 'front', 'back', 'left', 'right']).describe('front=+Z, right=+X, top=+Y');
const placement = {
    position: vec3.optional().describe('In the part frame, mm'),
    rotation: vec3.optional().describe('Euler XYZ degrees'),
    repeat: repeat.optional(),
};
const holeSpec = z.object({
    kind: z.enum(['clearance', 'tap', 'heatset', 'counterbore', 'countersink', 'nutTrap', 'plain']),
    size: z.enum(THREAD_SIZES).optional().describe('Required except for plain'),
    diameter: z.number().positive().optional().describe('plain holes only'),
    fit: z.enum(['close', 'normal']).optional(),
});
const featureBase = {
    id: z.string().optional().describe('Omit when adding; ids are assigned'),
    name: z.string().optional().describe('Engineer-style name shown in the project tree, e.g. "Lid screw counterbores"'),
    suppressed: z.boolean().optional(),
};
const feature = z.discriminatedUnion('op', [
    z.object({
        ...featureBase,
        op: z.literal('fillet'),
        radius: z.number().positive(),
        edges: edgeSelect.optional().describe('An edge group; ignored when edges or faces are picked'),
        ...edgePicks,
        radius2: z.number().positive().optional().describe('Radius at the far end of each edge (variable fillet)'),
    }),
    z.object({
        ...featureBase,
        op: z.literal('chamfer'),
        size: z.number().positive(),
        edges: edgeSelect.optional().describe('An edge group; ignored when edges or faces are picked'),
        ...edgePicks,
        distance2: z.number().positive().optional().describe('Second distance, for an unequal chamfer'),
        angle: z.number().gt(0).lt(90).optional().describe('Degrees, for a distance-angle chamfer'),
        side: vec3.optional().describe('Normal of the face that size is measured on'),
    }),
    z.object({
        ...featureBase,
        op: z.literal('shell'),
        thickness: z.number().positive().describe('Wall thickness; for printing use a multiple of the nozzle, 1.6-2.4'),
        open: z.array(faceSelect).optional().describe('Faces removed to open the shell, e.g. ["top"] for a tray'),
        remove: z.array(facePick).optional().describe('Faces to remove, picked in the view'),
        outward: z.boolean().optional().describe('Grow the wall outside the body instead of inside'),
    }),
    z.object({ ...featureBase, op: z.literal('add'), shape, ...placement }),
    z.object({ ...featureBase, op: z.literal('cut'), shape, ...placement }),
    z.object({
        ...featureBase,
        op: z.literal('hole'),
        spec: holeSpec,
        position: vec3.describe('Entry point on the surface, in the part frame'),
        direction: vec3.optional().describe('Drilling direction; default [0, -1, 0] (straight down)'),
        depth: z.number().positive().optional().describe('Default through-all'),
        repeat: repeat.optional(),
    }),
    z.object({
        ...featureBase,
        op: z.literal('extrude'),
        ...sketchSource,
        regions: regionPicks,
        distance: z.number().positive().optional(),
        through: z.boolean().optional().describe('Through the whole part instead of a distance (same as end throughAll)'),
        direction: extrudeDirection.optional(),
        mode: z.enum(['add', 'cut']),
        end: extrudeEnd.optional().describe('Where direction 1 stops: blind (distance, default), throughAll, or upToNext '
            + '(a boss grows until it meets the body ahead; a cut goes through the first wall of material it meets)'),
        from: z.number().optional().describe('Start this far from the sketch plane along direction 1, mm (default 0)'),
        draft: z.number().min(0).max(89).optional().describe('Taper of the side walls in degrees, narrowing along the extrusion'),
        draftOutward: z.boolean().optional().describe('The draft widens instead'),
        flipSide: z.boolean().optional().describe('Cut only: remove what is outside the profile (within the depth) instead'),
        second: z.object({
            end: extrudeEnd,
            distance: z.number().positive().optional().describe('For end blind'),
            draft: z.number().min(0).max(89).optional(),
            draftOutward: z.boolean().optional(),
        }).nullable().optional().describe('Also extrude the opposite way from the same start (not with direction symmetric); null removes it'),
    }).describe('A sketch extruded into the part (boss or cut), with SolidWorks-style end conditions, offset start, draft, '
        + 'flip side and a second direction'),
    z.object({
        ...featureBase,
        op: z.literal('revolve'),
        ...sketchSource,
        regions: regionPicks,
        axis: z.union([z.enum(['u', 'v']), sketchLineAxis, axisRef])
            .describe('Axis of revolution: the sketch\'s u or v axis through its origin, { line: id } of the sketch, '
                + 'a part axis or { axisRef: id }'),
        angle: z.number().optional().describe('Direction 1 angle, degrees, default 360'),
        type: z.enum(['blind', 'midPlane']).optional()
            .describe('Direction 1: blind (one way, default) or midPlane (the angle split evenly to both sides)'),
        reverse: z.boolean().optional().describe('Blind: revolve the other way'),
        angle2: z.number().positive().nullable().optional()
            .describe('Blind only: also revolve this many degrees the opposite way (Direction 2); null removes it'),
        mode: z.enum(['add', 'cut']),
    }).describe('A sketch revolved about an axis (boss or cut), with Blind or Mid plane angle and an optional second direction'),
    z.object({
        ...featureBase,
        op: z.literal('sketch'),
        sketch,
    }).describe('A sketch as its own history step; later extrude, revolve and loft steps use it by sketchRef'),
    z.object({
        ...featureBase,
        op: z.literal('loft'),
        sections: z.array(z.object(sketchSource)).min(2)
            .describe('Two or more sections in order, each one closed profile without holes, e.g. on offset planes'),
        ruled: z.boolean().optional().describe('Straight faces between sections instead of a smooth blend'),
        closed: z.boolean().optional().describe('Close loft: join the last section back to the first (3 or more sections)'),
        mode: z.enum(['add', 'cut']),
    }),
    z.object({
        ...featureBase,
        op: z.literal('mirror'),
        plane: z.union([z.enum(['YZ', 'XY', 'XZ']), planeRef])
            .describe('right (= YZ) mirrors left/right, front (= XY) front/back, top (= XZ) up/down; or { planeRef }'),
        offset: z.number().optional().describe('Moves the plane along its normal'),
        keepOriginal: z.boolean().optional().describe('Default true: join the mirror image to the body'),
        features: z.array(z.string()).min(1).optional()
            .describe('Features to mirror: earlier steps that add or cut material, applied again mirrored; omit to mirror the whole body'),
    }),
    z.object({
        ...featureBase,
        op: z.literal('plane'),
        definition: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('offset'), base: planeRef, distance: z.number() }),
            z.object({ kind: z.literal('angle'), base: planeRef, about: z.union([z.enum(['u', 'v']), axisRef]), angle: z.number() }),
            z.object({ kind: z.literal('threePoints'), points: z.tuple([pointRef, pointRef, pointRef]) }),
            z.object({ kind: z.literal('pointNormal'), point: pointRef, normal: vec3, xDir: vec3.optional() }),
            z.object({ kind: z.literal('midplane'), a: planeRef, b: planeRef }),
            z.object({ kind: z.literal('parallel'), base: planeRef, point: pointRef }).describe('Parallel to a plane, through a point'),
            z.object({ kind: z.literal('normal'), axis: axisRef, point: pointRef.optional() })
                .describe('Perpendicular to an axis, through a point (default: on the axis)'),
        ]),
    }).describe('Construction plane; sketches and other steps use it with { planeRef: id }'),
    z.object({
        ...featureBase,
        op: z.literal('axis'),
        definition: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('twoPoints'), a: pointRef, b: pointRef }),
            z.object({ kind: z.literal('pointDirection'), point: pointRef, direction: vec3 }),
            z.object({ kind: z.literal('planeIntersection'), a: planeRef, b: planeRef }),
            z.object({ kind: z.literal('sketchLine'), sketchRef: z.string(), line: z.string() })
                .describe('Along a line or centreline (curve id) of an earlier sketch step'),
            z.object({ kind: z.literal('pointPlane'), point: pointRef, plane: planeRef }).describe('Through a point, normal to a plane'),
        ]),
    }).describe('Construction axis for revolves, coils and circular patterns: { axisRef: id }'),
    z.object({ ...featureBase, op: z.literal('point'), position: vec3 }),
    z.object({
        ...featureBase,
        op: z.literal('sweep'),
        profile: z.object(sketchSource).optional().describe('Closed profile, e.g. a circle for a tube or spring wire (or give diameter)'),
        diameter: z.number().positive().optional()
            .describe('Circular profile instead of a profile sketch: a round rod of this diameter centred on the path start'),
        regions: regionPicks.describe('Areas of the profile sketch to sweep (one area; holes in it are kept)'),
        orientation: z.enum(['followPath', 'keepNormal']).optional()
            .describe('followPath (default): the profile turns with the path; keepNormal: it stays parallel to its plane'),
        path: z.union([
            z.object(sketchSource).describe('The open chain (sketch.open) or single closed profile of another sketch'),
            z.object({
                helix: z.object({
                    axis: axisRef,
                    radius: z.number().positive().optional().describe('Omit to use the profile distance from the axis'),
                    pitch: z.number().positive(),
                    turns: z.number().positive(),
                    leftHanded: z.boolean().optional(),
                    taper: z.number().optional().describe('Degrees; 0 cylindrical'),
                }),
            }),
        ]),
        twist: z.number().optional().describe('Degrees of twist along a straight path'),
        mode: z.enum(['add', 'cut']),
    }).describe('Sweep a profile along a path or helix: tubes, rails, handles, springs, coils, spiral grooves'),
    z.object({
        ...featureBase,
        op: z.literal('pattern'),
        features: z.array(z.string()).min(1).describe('Ids of earlier steps to repeat (holes, cuts, bosses)'),
        kind: z.enum(['linear', 'circular']),
        count: z.number().int().min(2).max(200).describe('Number of instances, the seed included'),
        direction: z.union([axisRef, vec3]).optional().describe('linear (required): the direction'),
        spacing: z.number().optional().describe('linear (required): distance between instances'),
        reverse: z.boolean().optional().describe('Reverse direction 1 (circular: turn the other way)'),
        direction2: z.union([axisRef, vec3]).optional().describe('linear: a second direction (a grid)'),
        count2: z.number().int().min(2).max(200).optional().describe('linear: instances along direction 2'),
        spacing2: z.number().optional().describe('linear: spacing along direction 2'),
        reverse2: z.boolean().optional(),
        seedOnly2: z.boolean().optional().describe('linear: repeat only the seed along direction 2'),
        axis: axisRef.optional().describe('circular (required): the axis'),
        angle: z.number().optional().describe('circular: total angle in degrees (default 360), or with equal false the angle between instances'),
        equal: z.boolean().optional().describe('circular: default true, equal spacing over the total angle'),
        skip: z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)])).optional()
            .describe('Instances to leave out, as [n along direction 1, n along direction 2 (1 if none)]; the seed is [1, 1]'),
    }),
    z.object({
        ...featureBase,
        op: z.literal('combine'),
        part: z.string().describe('Id of another part, as placed in the assembly'),
        operation: z.enum(['join', 'cut', 'intersect']),
    }),
    z.object({ ...featureBase, op: z.literal('split'), plane: planeRef, keep: z.enum(['positive', 'negative', 'both']) }),
    z.object({
        ...featureBase,
        op: z.literal('draft'),
        faces: z.array(faceSelect).optional(),
        picked: z.array(facePick).optional().describe('Faces to draft, picked in the view'),
        tangent: z.boolean().optional(),
        angle: z.number(),
        neutral: planeRef.optional(),
        neutralFace: facePick.optional().describe('A flat face picked as the neutral plane'),
        flip: z.boolean().optional().describe('Reverse the pull direction'),
    }),
    z.object({
        ...featureBase,
        op: z.literal('thread'),
        kind: z.enum(['external', 'internal']),
        at: vec3.optional().describe('A point on the circular edge where the thread begins (end of a shaft or hole); '
            + 'axis, start and diameter come from it'),
        diameter: z.number().positive().optional().describe('Nominal (major) diameter; required without at'),
        pitch: z.number().positive(),
        length: z.number().positive().optional().describe('Thread length (blind); or give revolutions'),
        revolutions: z.number().positive().optional().describe('End condition Revolutions: length = revolutions x lead'),
        offset: z.number().optional().describe('Start this far from the edge along the thread'),
        leftHanded: z.boolean().optional(),
        starts: z.number().int().min(1).max(8).optional().describe('Multi-start thread; default 1'),
        startAngle: z.number().optional().describe('Degrees about the axis where the thread begins'),
        position: vec3.optional().describe('Without at: thread base on the +Y axis through this point'),
    }),
]);

/**
 * Checks a part's history: sketch-based steps have exactly one sketch source, and every reference (sketchRef,
 * planeRef, axisRef, patterned step ids) points to an EARLIER step of the right kind.
 */
export function checkHistory(part: Pick<Part, 'id' | 'features'>): void {
    const seen = new Map<string, string>(); // id -> op of earlier steps
    const expect = (where: string, id: string, op: string) => {
        if (seen.get(id) !== op) {
            throw new Error(`${where}: ${op} "${id}" is not an earlier ${op} step of ${part.id}`);
        }
    };
    const scan = (where: string, value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach((v) => scan(where, v));
        } else if (value && typeof value === 'object') {
            const o = value as Record<string, unknown>;
            if (typeof o.sketchRef === 'string') {
                expect(where, o.sketchRef, 'sketch');
            }
            if (typeof o.planeRef === 'string') {
                expect(where, o.planeRef, 'plane');
            }
            if (typeof o.axisRef === 'string') {
                expect(where, o.axisRef, 'axis');
            }
            if (typeof o.pointRef === 'string') {
                expect(where, o.pointRef, 'point');
            }
            Object.values(o).forEach((v) => scan(where, v));
        }
    };
    const source = (where: string, s: { sketch?: unknown; sketchRef?: string }) => {
        if ((s.sketch === undefined) === (s.sketchRef === undefined)) {
            throw new Error(`${where}: give exactly one of sketch or sketchRef`);
        }
    };
    for (const f of part.features ?? []) {
        const where = `feature ${f.id}`;
        if (f.op === 'extrude' || f.op === 'revolve') {
            source(where, f);
        } else if (f.op === 'loft') {
            f.sections.forEach((s, i) => source(`${where} section ${i + 1}`, s));
        } else if (f.op === 'sweep') {
            if (f.profile) {
                source(`${where} profile`, f.profile);
            } else if (f.diameter === undefined) {
                throw new Error(`${where}: give a profile or a diameter (circular profile)`);
            }
            if (!('helix' in f.path)) {
                source(`${where} path`, f.path);
            }
        } else if (f.op === 'pattern') {
            for (const id of f.features) {
                if (!seen.has(id)) {
                    throw new Error(`${where}: step "${id}" is not an earlier step of ${part.id}`);
                }
            }
            checkPattern(where, f);
        } else if (f.op === 'mirror') {
            for (const id of f.features ?? []) {
                if (!seen.has(id)) {
                    throw new Error(`${where}: step "${id}" is not an earlier step of ${part.id}`);
                }
            }
        }
        const { id: _id, name: _name, suppressed: _s, ...body } = f;
        scan(where, body);
        seen.set(f.id, f.op);
    }
}

/** A pattern's fields per kind: the schema leaves them optional, since one object covers both kinds. */
function checkPattern(where: string, f: Extract<Feature, { op: 'pattern' }>): void {
    const g = f as unknown as Partial<Extract<Feature, { op: 'pattern'; kind: 'linear' }>> & Partial<Extract<Feature, { op: 'pattern'; kind: 'circular' }>>;
    if (f.kind === 'linear') {
        if (g.direction === undefined) {
            throw new Error(`${where}: a linear pattern needs a direction (an axis or a vector)`);
        }
        if (g.spacing === undefined) {
            throw new Error(`${where}: a linear pattern needs a spacing`);
        }
        if (g.direction2 !== undefined && (g.count2 === undefined || g.spacing2 === undefined)) {
            throw new Error(`${where}: direction 2 needs count2 and spacing2`);
        }
    } else if (g.axis === undefined) {
        throw new Error(`${where}: a circular pattern needs an axis`);
    } else if (g.equal === false && g.angle === undefined) {
        throw new Error(`${where}: without equal spacing give the angle between instances`);
    }
    if (g.skip?.some(([i, j]) => i === 1 && j === 1)) {
        throw new Error(`${where}: the seed (instance [1, 1]) cannot be skipped`);
    }
}

/** The rollback bar of a part when it is rolled back (fewer steps built than it has), else null. */
function rollbackOf(project: Project, partId: string): { partId: string; count: number } | null {
    const rollback = project.view.rollback;
    const part = project.parts.find((p) => p.id === partId);
    return rollback && rollback.partId === partId && rollback.count < (part?.features?.length ?? 0) ? rollback : null;
}

/**
 * Where new steps go: before the step at `before` when given (>= 0), else at the rollback bar when the part is
 * rolled back (as in SolidWorks), else at the end.
 */
export function insertIndex(length: number, before: number, rollback: { count: number } | null): number {
    if (before >= 0) {
        return before;
    }
    return rollback ? Math.max(0, Math.min(rollback.count, length)) : length;
}

/** Steps inserted at or above the rollback bar keep it below them (and below the steps it already had built). */
function shiftRollback(project: Project, partId: string, at: number, added: number): void {
    const rollback = project.view.rollback;
    if (rollback && rollback.partId === partId && at <= rollback.count) {
        const part = project.parts.find((p) => p.id === partId);
        // Only while still rolled back: a bar at the end stays at the end.
        if (rollback.count + added < (part?.features?.length ?? 0)) {
            rollback.count += added;
        } else {
            project.view.rollback = null;
        }
    }
}

function withFeatureIds(part: Pick<Part, 'features'>, features: z.infer<typeof feature>[]): Feature[] {
    const used = new Set((part.features ?? []).map((f) => f.id));
    return features.map((f) => {
        const base = slug(f.id ?? f.name ?? f.op);
        let id = base;
        for (let n = 2; used.has(id); n++) {
            id = `${base}-${n}`;
        }
        used.add(id);
        return { ...f, id } as Feature;
    });
}

const partFields = {
    name: z.string().describe('Short human name shown on the callout label'),
    description: z.string().optional(),
    shape,
    position: vec3.describe('Centre of the shape in mm, Y up'),
    rotation: vec3.optional().describe('Euler XYZ in degrees'),
    material,
    explodeOffset: vec3.optional()
        .describe('Offset in mm at full explode. Omit to spread automatically along Y by height'),
    repeat: repeat.optional()
        .describe('Copies of this part as one pattern: screws, feet, vents, grille slots, keys, fins, LEDs'),
    labelSide: z.enum(['left', 'right']).optional(),
    features: z.array(feature).optional()
        .describe('Design history applied to the shape in order: fillets, shells, holes, cuts, bosses, threads'),
    purchased: z.boolean().optional().describe('No longer used: every component is a part and is treated the same'),
    decals: z.array(z.object({
        id: z.string().optional(),
        image: z.string(),
        position: vec3,
        normal: vec3,
        size: z.tuple([z.number().positive(), z.number().positive()]),
        rotation: z.number().optional(),
        opacity: z.number().min(0).max(1).optional(),
        mode: z.enum(['planar', 'box']).optional(),
        depth: z.number().positive().optional(),
    })).optional().describe('Pictures on the surface; usually added with decals_add'),
};

/** Gives every decal an id, keeping ones already set (copies of a part keep their decal ids). */
function withDecalIds(decals: (Omit<Decal, 'id'> & { id?: string })[] | undefined): Decal[] | undefined {
    if (!decals) {
        return undefined;
    }
    const used = new Set(decals.map((d) => d.id).filter(Boolean));
    let n = 1;
    return decals.map((d) => {
        if (d.id) {
            return d as Decal;
        }
        while (used.has(`decal-${n}`)) {
            n++;
        }
        used.add(`decal-${n}`);
        return { ...d, id: `decal-${n}` };
    });
}

function uniqueId(project: Project, name: string): string {
    const base = slug(name);
    let id = base;
    for (let n = 2; project.parts.some((p) => p.id === id); n++) {
        id = `${base}-${n}`;
    }
    return id;
}

function summary(project: Project): string {
    return JSON.stringify({ name: project.name, view: project.view, parts: project.parts });
}

/** One-line scene digest given to the model with every request, to save a tool round trip. */
export function sceneDigest(project: Project): string {
    const parts = project.parts.map((p) => `${p.id} (${p.name})`).join(', ') || 'none';
    const v = project.view;
    return `project "${project.name}"; parts: ${parts}; explode=${v.explode}; labels=${v.labels ? 'on' : 'off'}`
        + `; focus=${v.focus ?? 'none'}`;
}

export function createTools(store: ProjectStore): StudioTool[] {
    return [
        {
            name: 'project_get',
            description: 'Returns the open project as JSON: every part with its shape, position and material, plus the view state.',
            schema: {},
            run: () => summary(store.get()),
        },
        {
            name: 'project_list',
            description: 'Lists saved projects.',
            schema: {},
            run: () => JSON.stringify(store.list()),
        },
        {
            name: 'project_new',
            description: 'Creates and opens a new empty project. The current project is already saved. '
                + 'A name already in use gets a number; saved projects are never overwritten.',
            schema: { name: z.string() },
            run: ({ name }) => {
                store.create(name);
                return `Created empty project "${store.get().name}".`;
            },
        },
        {
            name: 'project_open',
            description: 'Opens a saved project by name.',
            schema: { name: z.string() },
            run: ({ name }) => (store.open(name) ? `Opened "${store.get().name}".` : `No project named "${name}".`),
        },
        {
            name: 'parts_add',
            description: 'Adds one or more parts to the model. Units are mm and Y is up. Cylinders, tubes, cones, '
                + 'capsules, lathes and extrusions have their axis along Y; a torus lies flat in the XZ plane; '
                + 'rotate a part to point it elsewhere. Add all parts of an assembly in one call.',
            schema: { parts: z.array(z.object(partFields)).min(1) },
            run: ({ parts }) => {
                const ids: string[] = [];
                store.mutate((draft) => {
                    for (const input of parts) {
                        const part: Part = { ...input, id: uniqueId(draft, input.name), rotation: input.rotation ?? [0, 0, 0] };
                        part.features = input.features ? withFeatureIds({}, input.features) : undefined;
                        part.decals = withDecalIds(input.decals);
                        checkHistory(part);
                        draft.parts.push(part);
                        ids.push(part.id);
                    }
                });
                return `Added ${ids.length} part(s): ${ids.join(', ')}.`;
            },
        },
        {
            name: 'parts_instance',
            description: 'Places another instance of an existing part in the assembly: same design (shape, features, '
                + 'material, decals), its own position and rotation. Editing the part updates every instance. Use it '
                + 'for identical parts: four wheels, two brackets, a row of standoffs.',
            schema: {
                partId: z.string().describe('The part to instance (if it is itself an instance, its source is used)'),
                instances: z.array(z.object({
                    name: z.string().optional(),
                    position: vec3,
                    rotation: vec3.optional(),
                })).min(1),
            },
            run: ({ partId, instances }) => {
                const ids: string[] = [];
                store.mutate((draft) => {
                    const target = draft.parts.find((p) => p.id === partId);
                    if (!target) {
                        throw new Error(`No part with id "${partId}".`);
                    }
                    const source = target.instanceOf ? draft.parts.find((p) => p.id === target.instanceOf) ?? target : target;
                    instances.forEach((input: { name?: string; position: Vec3; rotation?: Vec3 }, i: number) => {
                        const name = input.name ?? `${source.name} ${draft.parts.filter((p) => p.id === source.id || p.instanceOf === source.id).length + 1}`;
                        const part: Part = {
                            id: uniqueId(draft, name),
                            name,
                            instanceOf: source.id,
                            shape: { kind: 'empty' },
                            position: input.position,
                            rotation: input.rotation ?? [0, 0, 0],
                            material: source.material,
                            purchased: source.purchased,
                        };
                        draft.parts.push(part);
                        ids.push(part.id);
                        void i;
                    });
                });
                return `Placed ${ids.length} instance(s): ${ids.join(', ')}.`;
            },
        },
        {
            name: 'parts_update',
            description: 'Changes fields of existing parts. Only the fields given are replaced; material is merged.',
            schema: {
                updates: z.array(z.object({
                    id: z.string(),
                    ...Object.fromEntries(Object.entries(partFields).map(([k, v]) => [k, v.optional()])),
                    material: material.partial().optional(),
                    repeat: repeat.nullable().optional().describe('null removes the pattern'),
                })).min(1),
            },
            run: ({ updates }) => {
                const missing: string[] = [];
                store.mutate((draft) => {
                    for (const { id, material: mat, ...fields } of updates) {
                        const part = draft.parts.find((p) => p.id === id);
                        if (!part) {
                            missing.push(id);
                            continue;
                        }
                        if (fields.features) {
                            fields.features = withFeatureIds({}, fields.features);
                        }
                        if (fields.decals) {
                            fields.decals = withDecalIds(fields.decals);
                        }
                        Object.assign(part, fields);
                        if (part.repeat === null) {
                            delete part.repeat;
                        }
                        checkHistory(part);
                        if (mat) {
                            part.material = { ...part.material, ...mat };
                        }
                    }
                });
                return missing.length ? `Updated, but these ids do not exist: ${missing.join(', ')}.` : 'Updated.';
            },
        },
        {
            name: 'parts_remove',
            description: 'Removes parts by id.',
            schema: { ids: z.array(z.string()).min(1) },
            run: ({ ids }) => {
                let removed = 0;
                store.mutate((draft) => {
                    const orphaned = draft.parts.filter((p) => p.instanceOf && ids.includes(p.instanceOf) && !ids.includes(p.id));
                    if (orphaned.length) {
                        throw new Error(`Still instanced by ${orphaned.map((p) => p.id).join(', ')}; remove those too`);
                    }
                    const before = draft.parts.length;
                    draft.parts = draft.parts.filter((p) => !ids.includes(p.id));
                    removed = before - draft.parts.length;
                    if (draft.view.focus && ids.includes(draft.view.focus)) {
                        draft.view.focus = null;
                    }
                });
                return `Removed ${removed} part(s).`;
            },
        },
        {
            name: 'assembly_explode',
            description: 'Animates the exploded view. factor 1 lays every part out, 0 puts the assembly back together. '
                + 'Labels are usually turned on with an exploded view.',
            schema: {
                factor: z.number().min(0).max(1),
                spacing: z.number().positive().optional().describe('Gap in mm between levels; omit for automatic'),
                labels: z.boolean().optional().describe('Also show or hide callout labels'),
            },
            run: ({ factor, spacing, labels }) => {
                store.mutate((draft) => {
                    draft.view.explode = factor;
                    if (spacing !== undefined) {
                        draft.view.explodeSpacing = spacing;
                    }
                    if (labels !== undefined) {
                        draft.view.labels = labels;
                    }
                }, { undoable: false });
                const offsets = explodeOffsets(store.get());
                return factor > 0
                    ? `Exploded to ${factor}. Offsets at full explode: ${JSON.stringify(offsets)}`
                    : 'Assembled.';
            },
        },
        {
            name: 'view_set',
            description: 'Controls the camera and overlays. Only the fields given change.',
            schema: {
                labels: z.boolean().optional().describe('Show callout labels with leader lines'),
                focus: z.string().nullable().optional().describe('Part id to highlight and frame; null clears it'),
                autoRotate: z.boolean().optional().describe('Slow turntable rotation'),
                azimuth: z.number().optional().describe('Camera angle around Y in degrees; 0 is front, 90 is right'),
                elevation: z.number().optional().describe('Camera angle above the horizon in degrees, -89 to 89'),
                hidden: z.array(z.string()).optional().describe('Part ids hidden from view, e.g. to show internals'),
            },
            run: (args) => {
                if (args.focus && !store.get().parts.some((p) => p.id === args.focus)) {
                    return `No part with id "${args.focus}".`;
                }
                store.mutate((draft) => {
                    Object.assign(draft.view, args);
                }, { undoable: false });
                return 'View updated.';
            },
        },
        {
            name: 'features_add',
            description: 'Appends features to a part\'s design history (or inserts them before the feature id `before`). '
                + 'When the part is rolled back, new features go in at the rollback bar, which moves below them. '
                + 'Returns the assigned feature ids.',
            schema: { partId: z.string(), features: z.array(feature).min(1), before: z.string().optional() },
            run: ({ partId, features, before }) => {
                let result = '';
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === partId);
                    if (!part) {
                        result = `No part with id "${partId}".`;
                        return;
                    }
                    if (part.instanceOf) {
                        throw new Error(`${partId} is an instance of ${part.instanceOf}; edit ${part.instanceOf} instead`);
                    }
                    const added = withFeatureIds(part, features);
                    const list = part.features ?? [];
                    const index = before ? list.findIndex((f) => f.id === before) : -1;
                    if (before && index < 0) {
                        throw new Error(`No feature "${before}" in ${partId}`);
                    }
                    const at = insertIndex(list.length, index, rollbackOf(draft, partId));
                    list.splice(at, 0, ...added);
                    part.features = list;
                    shiftRollback(draft, partId, at, added.length);
                    checkHistory(part);
                    result = `Added ${added.length} feature(s) to ${partId}: ${added.map((f) => f.id).join(', ')}.`;
                });
                return result;
            },
        },
        {
            name: 'features_update',
            description: 'Edits features in a part\'s history by id: change dimensions, rename, or suppress/unsuppress. '
                + 'Only the fields given change; a field set to null is removed; the op cannot change.',
            schema: {
                partId: z.string(),
                updates: z.array(z.object({ id: z.string() }).passthrough()).min(1)
                    .describe('Each: { id, ...fields to change }, e.g. { id: "lid-fillet", radius: 3 }; null removes an optional field'),
            },
            run: ({ partId, updates }) => {
                const missing: string[] = [];
                let found = true;
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === partId);
                    if (!part) {
                        found = false;
                        return;
                    }
                    part.features = (part.features ?? []).map((f) => {
                        const update = updates.find((u: { id: string }) => u.id === f.id);
                        if (!update) {
                            return f;
                        }
                        const merged = { ...f, ...update, id: f.id, op: f.op };
                        // null clears an optional field (e.g. a chamfer's angle when it becomes equal distance).
                        for (const [key, value] of Object.entries(update)) {
                            if (value === null) {
                                delete (merged as Record<string, unknown>)[key];
                            }
                        }
                        // Switching between an inline sketch and a sketch step replaces the other one.
                        if ('sketchRef' in update) {
                            delete merged.sketch;
                        } else if ('sketch' in update) {
                            delete merged.sketchRef;
                        }
                        const parsed = feature.safeParse(merged);
                        if (!parsed.success) {
                            throw new Error(`feature ${f.id}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
                        }
                        return merged as unknown as Feature;
                    });
                    for (const u of updates) {
                        if (!part.features.some((f) => f.id === u.id)) {
                            missing.push(u.id);
                        }
                    }
                    checkHistory(part);
                });
                if (!found) {
                    return `No part with id "${partId}".`;
                }
                return missing.length ? `Updated, but these feature ids do not exist: ${missing.join(', ')}.` : 'Updated.';
            },
        },
        {
            name: 'features_reorder',
            description: 'Puts a part\'s features in a new order: ids lists every feature id, first to last.',
            schema: { partId: z.string(), ids: z.array(z.string()) },
            run: ({ partId, ids }) => {
                let result = '';
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === partId);
                    if (!part) {
                        result = `No part with id "${partId}".`;
                        return;
                    }
                    const current = part.features ?? [];
                    const same = ids.length === current.length && current.every((f) => ids.includes(f.id));
                    if (!same) {
                        throw new Error('ids must list every feature of the part exactly once');
                    }
                    part.features = ids.map((id: string) => current.find((f) => f.id === id)!);
                    checkHistory(part);
                    result = 'Reordered.';
                });
                return result;
            },
        },
        {
            name: 'features_remove',
            description: 'Removes features from a part\'s history by id.',
            schema: { partId: z.string(), ids: z.array(z.string()).min(1) },
            run: ({ partId, ids }) => {
                let removed = -1;
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === partId);
                    if (part) {
                        const before = part.features?.length ?? 0;
                        // Removed steps above the rollback bar take the bar up with them.
                        const rollback = rollbackOf(draft, partId);
                        if (rollback) {
                            const above = (part.features ?? []).slice(0, rollback.count).filter((f) => ids.includes(f.id)).length;
                            rollback.count -= above;
                        }
                        part.features = (part.features ?? []).filter((f) => !ids.includes(f.id));
                        removed = before - part.features.length;
                        checkHistory(part);
                    }
                });
                return removed < 0 ? `No part with id "${partId}".` : `Removed ${removed} feature(s).`;
            },
        },
        {
            name: 'history_get',
            description: 'Lists the design history: every part\'s creation followed by its features, with step numbers.',
            schema: {},
            run: () => {
                const project = store.get();
                const steps = timelineSteps(project).map((s, i) =>
                    `${i + 1}. ${s.featureId ? `  ${s.kind} "${s.label}" [${s.partId}/${s.featureId}]` : `${s.label} [${s.partId}, ${s.kind}]`}`
                    + (s.suppressed ? ' (suppressed)' : ''));
                return steps.join('\n') || 'No history yet.';
            },
        },
        {
            name: 'decals_add',
            description: 'Applies pictures onto a part\'s surface (deck graphics, labels, logos). image is an asset id: '
                + 'pictures the user attached are stored as assets and their ids given to you. position is a point on '
                + 'the surface and normal the direction that surface faces, both in the part frame. Visual only.',
            schema: {
                partId: z.string(),
                decals: z.array(z.object({
                    image: z.string(),
                    position: vec3,
                    normal: vec3,
                    size: z.tuple([z.number().positive(), z.number().positive()]).describe('[width, height] mm'),
                    rotation: z.number().optional().describe('Degrees about the normal'),
                    opacity: z.number().min(0).max(1).optional(),
                    mode: z.enum(['planar', 'box']).optional().describe('planar (default) wraps over every surface facing it'),
                    depth: z.number().positive().optional().describe('Max reach in mm from the decal point; leave unset'),
                })).min(1),
            },
            run: ({ partId, decals }) => {
                let result = '';
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === partId);
                    if (!part) {
                        result = `No part with id "${partId}".`;
                        return;
                    }
                    const used = new Set((part.decals ?? []).map((d) => d.id));
                    const added = decals.map((d: Omit<Decal, 'id'>) => {
                        let n = used.size + 1;
                        while (used.has(`decal-${n}`)) {
                            n++;
                        }
                        used.add(`decal-${n}`);
                        return { ...d, id: `decal-${n}` };
                    });
                    part.decals = [...(part.decals ?? []), ...added];
                    result = `Added ${added.map((d: Decal) => d.id).join(', ')} to ${partId}.`;
                });
                return result;
            },
        },
        {
            name: 'decals_update',
            description: 'Moves, resizes, rotates or fades decals by id. Only the fields given change.',
            schema: {
                partId: z.string(),
                updates: z.array(z.object({
                    id: z.string(),
                    image: z.string().optional(),
                    position: vec3.optional(),
                    normal: vec3.optional(),
                    size: z.tuple([z.number().positive(), z.number().positive()]).optional(),
                    rotation: z.number().optional(),
                    opacity: z.number().min(0).max(1).optional(),
                    mode: z.enum(['planar', 'box']).optional(),
                    depth: z.number().positive().optional(),
                })).min(1),
            },
            run: ({ partId, updates }) => {
                let found = true;
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === partId);
                    if (!part) {
                        found = false;
                        return;
                    }
                    part.decals = (part.decals ?? []).map((d) => ({ ...d, ...updates.find((u: { id: string }) => u.id === d.id) }));
                });
                return found ? 'Updated.' : `No part with id "${partId}".`;
            },
        },
        {
            name: 'decals_remove',
            description: 'Removes decals from a part by id.',
            schema: { partId: z.string(), ids: z.array(z.string()).min(1) },
            run: ({ partId, ids }) => {
                store.mutate((draft) => {
                    const part = draft.parts.find((p) => p.id === partId);
                    if (part) {
                        part.decals = (part.decals ?? []).filter((d) => !ids.includes(d.id));
                    }
                });
                return 'Removed.';
            },
        },
        {
            name: 'print_settings',
            description: 'Gets or sets the 3D printer settings used for hole tolerances and print checks. '
                + 'Only the fields given change; call with no fields to read them.',
            schema: {
                bed: vec3.optional().describe('Build volume X, Y, Z in mm'),
                nozzle: z.number().positive().optional(),
                layerHeight: z.number().positive().optional(),
                holeTolerance: z.number().min(0).max(1).optional()
                    .describe('Added to printed hole diameters; 0.1-0.3 for a tuned FDM printer'),
            },
            run: (args) => {
                if (Object.keys(args).length > 0) {
                    store.mutate((draft) => {
                        draft.print = { ...DEFAULT_PRINT, ...draft.print, ...args };
                    });
                }
                return JSON.stringify({ ...DEFAULT_PRINT, ...store.get().print });
            },
        },
        {
            name: 'undo',
            description: 'Undoes the last model change.',
            schema: {},
            run: () => (store.undo() ? 'Undone.' : 'Nothing to undo.'),
        },
        {
            name: 'redo',
            description: 'Redoes the last undone model change.',
            schema: {},
            run: () => (store.redo() ? 'Redone.' : 'Nothing to redo.'),
        },
    ];
}
