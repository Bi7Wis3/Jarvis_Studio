# Audit: sketch modify tools

Area: the sketch editing tools (Trim, Extend, Offset, Fillet, Chamfer, Mirror, sketch patterns, Move/Copy/Rotate/Scale/
Stretch, Convert entities, Intersection curve, Repair sketch, Split entities, Jog line, construction geometry) and the
behaviour they share.

Read on 2026-11-13 from the files on disk: `apps/web/src/sketchEdit.ts`, `sketchRepair.ts`, `sketcher.ts` (edit parts),
`sketchToolDefs.tsx`, `toolDefs.tsx` (MODIFY_TOOLS, patterns), `SketchDrawing.tsx`, `Toolbar.tsx`, and the tests
`sketchEdit.test.ts`, `sketchRepair.test.ts`, `sketcher.test.ts` (all 61 pass). `docs/SOLIDWORKS_REFERENCE.md` did not
exist at the start or at the end of this audit, so every SolidWorks description below comes from the online help
(2021/2022 pages, read through the page data) and is linked per tool. Some results were checked in the running app by
calling the live modules (`sketchEdit.ts`, `solver.ts`) on throwaway geometry. Nothing in the owner's project was touched.

## Summary

| Tool | Verdict | P1 | P2 | P3 |
|---|---|---|---|---|
| Trim | incomplete | 1 | 2 | 2 |
| Extend | broken | 1 | 1 | 2 |
| Offset entities | incomplete | 0 | 5 | 3 |
| Sketch fillet | incomplete | 0 | 3 | 3 |
| Sketch chamfer | incomplete | 0 | 2 | 1 |
| Mirror entities | incomplete | 0 | 2 | 3 |
| Dynamic mirror | incomplete (not built) | 0 | 0 | 1 |
| Linear sketch pattern | incomplete | 1 | 3 | 3 |
| Circular sketch pattern | incomplete | 1 | 2 | 3 |
| Move / Copy | differs | 0 | 2 | 2 |
| Rotate | differs | 0 | 1 | 1 |
| Scale | incomplete | 0 | 1 | 1 |
| Stretch | incomplete (not built) | 0 | 1 | 0 |
| Convert entities | incomplete (not built) | 0 | 1 | 0 |
| Intersection curve | incomplete (not built) | 0 | 0 | 1 |
| Repair sketch | incomplete | 0 | 2 | 3 |
| Split entities | incomplete (not built) | 0 | 1 | 0 |
| Jog line / Make path | incomplete (not built) | 0 | 0 | 2 |
| Construction geometry | matches | 0 | 0 | 0 |
| Shared behaviour (selection, keys, undo, solving) | differs | 1 | 2 | 2 |

---

## Trim

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/hidd_trim_choices.htm): the Trim
PropertyManager has five modes. Power trim: drag the pointer across one or more entities and each is cut back to its
nearest crossings; dragging along an entity's end also extends it. Corner: pick two entities and they are trimmed or
extended until they meet at their virtual corner (the end you click decides which part stays). Trim away inside: pick
two boundaries and then the open entities between them are cut away. Trim away outside: the reverse, keeping what is
between the boundaries (and extending what crosses only one). Trim to closest: click to remove up to the nearest crossing,
or drag to extend. Two options: Keep trimmed entities as construction geometry, and Ignore trimming of construction
geometry; with these, dimensions to the trimmed entities are kept.

**App**: a single click-mode that matches "Trim to closest" by click only. Tool def `toolDefs.tsx:1062`, hint
`Toolbar.tsx:135`. The hover shows the piece that would go in red (`sketcher.ts:1139-1144`, `SketchDrawing.tsx:558-560`);
the click commits it (`sketcher.ts:1169-1182`). Geometry in `trimAt` (`sketchEdit.ts:193-272`): crossings and T-ends of
other curves cut the curve (`cutsOn`, `sketchEdit.ts:143-180`); a curve nothing crosses is deleted; a circle needs two
crossings and becomes an arc; a middle cut makes a second curve held collinear (line) or equal (arc). New cut points are
held on the cutting curve with a point-on-curve relation. Line length, midpoint and equal relations are dropped
(`sketchEdit.ts:266-269`). Tests: `sketchEdit.test.ts:38-115`, `sketcher.test.ts:174`.

**Gaps**
- P1 · M · No power trim by dragging: `sketchDown` returns false for every tool but select and dimension (`sketcher.ts:497-499`), so a drag across curves orbits the camera instead of trimming → while Trim is active, a press-and-drag should trim every curve the pointer path crosses (one undo step for the stroke).
- P2 · M · Corner mode missing → pick two entities, trim/extend both to their virtual intersection, keeping the clicked ends (the corner logic already exists in `cornerOfLines`, `sketchEdit.ts:370-390`).
- P2 · M · Trim away inside / Trim away outside missing → pick two boundary entities, then the entities to trim between or outside them.
- P3 · S · "Keep trimmed entities as construction geometry" and "Ignore trimming of construction geometry" missing; the removed piece is always deleted and construction curves are trimmed like any other (`drawnCurveAt` does not filter them, `sketcher.ts:1110-1113`) → add both options in a PropertyManager panel.
- P3 · S · Trim has no PropertyManager panel at all (it is an `instant` tool, `toolDefs.tsx:1115-1123`) → open a left-panel form with the mode list and options, per CLAUDE.md.

## Extend

**SolidWorks** (extend is part of Power trim and Trim to closest on the page above; Extend Entities is its own command
that lengthens the clicked end to the next entity, with a preview while hovering).

**App**: `extendAt` (`sketchEdit.ts:283-343`): the end nearer the click is moved to the first curve a ray (line) or the
continuing circle (arc) meets; a hover preview is shown (`sketcher.ts:1139-1144`). The length dimension, a lock on the
end and point-to-point distances to the end are dropped; a point-on-curve to the new target is added
(`sketchEdit.ts:337-341`). An end that another curve shares is refused (`sketchEdit.ts:291-293`). Tests:
`sketchEdit.test.ts:117-142`, `sketcher.test.ts:192`.

**Gaps**
- P1 · S · Old point-on-curve relations on the moved end are kept (`sketchEdit.ts:339-340` drops only length, fix and distance), so an end that was cut by Trim (held on the cutting curve by `pointAt`, `sketchEdit.ts:208-215`) is now held on two curves at once. Reproduced in the app: line (-30,0)-(30,0) horizontal, vertical lines at x=0 and x=-40; trim the left part at (-10,0); extend the line at (1,0). The solver reports success but the whole line jumps to y=-21.9 and the end lands at x=-37.3, not on the x=-40 line → drop every point-on-curve and coincident relation on the moved end before adding the new one (and treat a solve that leaves the target off its curve as a failure).
- P2 · S · Midpoint and equal-length relations of the extended line are kept (same lines), unlike Trim (`sketchEdit.ts:266-269`); with an equal relation the solver changes the other line or pulls the end along the target → drop or keep them consistently with Trim and say so in the status line.
- P3 · S · A length dimension is silently deleted (`sketchEdit.ts:339`) → SolidWorks keeps driving dimensions; at least report what was removed.
- P3 · S · Refusal for shared ends (`sketchEdit.ts:291`) and drag-to-extend in a chosen direction (Trim to closest) not supported; SolidWorks behaviour for a shared end not verified.

## Offset entities

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/HIDD_OFFSET1.htm): select one or more sketch
entities (or model edges/faces) first or in the tool. Options: Offset distance (with a drag preview), Add dimensions
(one offset dimension), Reverse, Select chain (all contiguous entities; off: only the picked ones), Bi-directional,
Construction geometry: Base and/or Offset, Cap ends (Arcs or Lines) for open chains. An Offset relation ties the copy
to the original so it follows changes.

**App**: tool `toolDefs.tsx:1066`, hint `Toolbar.tsx:139`. Click a curve (`sketcher.ts:1215-1222`), then click on a side
or type a distance + Enter (`sketcher.ts:796-799`, `1128-1133`). The whole chain through the curve is always used
(`chainOf`, `sketchEdit.ts:506-548`); joints are recomputed as sharp intersections (`sketchEdit.ts:603-639`). Lines get
parallel + a distance dimension each; arcs share the original centre with no relation; a circle becomes a concentric
circle with no relation (`offsetChain`, `sketchEdit.ts:668-722`). Live preview (`sketcher.ts:1151-1155`). Tests:
`sketchEdit.test.ts:214-257`, `sketcher.test.ts:232`.

**Gaps**
- P2 · M · Arcs and circles are not tied to the original: no radius relation or dimension (`sketchEdit.ts:678-684`, `716-719`). Checked in the app: offsetting a circle with a diameter dimension raises the sketch DOF from 2 to 3, so the offset circle can be dragged to any size and does not follow the original → hold the offset radius (radius difference = distance) for arcs and circles, and the offset in general.
- P2 · S · "Add dimensions" is not an option and is not one dimension: every line of the chain gets its own distance dimension (`sketchEdit.ts:715`; a rectangle gets 4) → one dimension for the offset (others via relations), and a checkbox to leave it out.
- P2 · M · Select chain is always on (`sketchEdit.ts:506`); a single line of a rectangle cannot be offset alone, and several unconnected entities cannot be offset in one go → add Select chain, and accept a multi-selection.
- P2 · M · Bi-directional and Cap ends (arcs / lines) missing → add both.
- P2 · S · Pre-selection is ignored: `setTool` only reads the selection for mirror (`sketcher.ts:351`) → start from the selected curves.
- P3 · S · Construction geometry Base / Offset options missing (the copy just inherits the original's construction flag, `sketchEdit.ts:712`).
- P3 · S · No check for an inward offset that collapses a segment (sharp joints are always computed, `sketchEdit.ts:603-612`); only arcs whose radius would go to zero are refused (`sketchEdit.ts:597-599`) → refuse or trim self-crossing results.
- P3 · M · Offset of model edges or faces is not possible (needs Convert entities, below). No PropertyManager panel (instant tool).

## Sketch fillet

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/hidd_dve_sketch_fillet.htm): Entities to
fillet list (pick corners or pairs of entities, several before OK), Radius, Keep constrained corners (keeps the virtual
sharp when the vertex has dimensions or relations; otherwise asks to delete them), Dimension each fillet (off: an equal
relation to the first fillet instead). Works on lines and arcs, and on entities that do not touch.

**App**: tool `toolDefs.tsx:1064`, hint `Toolbar.tsx:137`. Click a corner point or two lines; the size is the last radius
(default 5, `sketcher.ts:223`) or typed digits (`sketcher.ts:742-794`, `1184-1213`). `filletCorner`
(`sketchEdit.ts:425-454`) cuts both lines back, adds a tangent arc with a radius dimension, a centre point and two
construction spokes held perpendicular to the lines (instead of tangent relations). Tests: `sketchEdit.test.ts:144-199`,
`sketcher.test.ts:200-224`.

**Gaps**
- P2 · M · Lines only: a corner with an arc is refused (`cornerAtPoint`, `sketchEdit.ts:358-362`; `sketcher.ts:1196-1198`) → fillet line-arc and arc-arc corners (slots, rounded profiles).
- P2 · M · Keep constrained corners missing: the old corner point is deleted with every relation and dimension on it (`dropUnused`, `sketchEdit.ts:453`), and the lines' length, midpoint and equal relations go too (`cutBack`, `sketchEdit.ts:407-409`). Checked in the app: a distance dimension from the origin to a rectangle corner is gone after the fillet, without a warning → keep a virtual sharp point (as chamfer already does) and its dimensions; ask when it is off.
- P2 · S · No preview of the arc before the click (`editPreview: []`, `sketcher.ts:1149`) and no panel showing the radius → ghost the fillet on hover.
- P3 · S · Dimension each fillet missing: every fillet always gets its own radius dimension (`sketchEdit.ts:447`) → option; off: equal to the first fillet.
- P3 · S · Each fillet adds 3 extra entities (centre point plus two construction spokes, `sketchEdit.ts:448-452`; checked: +3 curves), which clutter the sketch and the relations list → use tangent relations once the solver handles the shared-point case, or hide these helpers.
- P3 · S · Several corners cannot be collected and applied together; each click commits on its own.

## Sketch chamfer

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/hidd_dve_sketch_chamfer.htm): Angle-distance
(distance on the first entity, angle toward the second), Distance-distance with Equal distance on (one distance on both)
or off (Distance 1 on the first, Distance 2 on the second).

**App**: tool `toolDefs.tsx:1065`, hint `Toolbar.tsx:138`. Same picking as fillet; `chamferCorner`
(`sketchEdit.ts:460-494`) cuts both lines back the same distance, keeps the sharp point with two equal construction
legs and dimensions the first. Default 2 (`sketcher.ts:224`). Tests: `sketchEdit.test.ts:201-212`, `sketcher.test.ts:225`.

**Gaps**
- P2 · M · Only equal distance: no Distance-distance with two values, no Angle-distance → add both, with the first-picked entity getting Distance 1.
- P2 · S · Lines only (shares `cornerAtPoint`) and no preview, as for fillet.
- P3 · S · No panel; values only by typing digits blind at the cursor.

## Mirror entities

**SolidWorks** (https://help.solidworks.com/2022/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_MIRRORING.htm): Entities to
mirror (selection box), Copy (on: keep originals; off: only the mirrored result remains), Mirror about: any line, a
linear model edge, a reference plane or planar face. Symmetric relations hold the result.

**App**: tool `toolDefs.tsx:1067`, hint `Toolbar.tsx:140`. Pre-selected curves become the picks (`sketcher.ts:351`);
click more curves, then click an axis or construction line, or press Enter and click any line
(`sketcher.ts:1227-1256`, `1274-1281`). `mirrorCurves` (`sketchEdit.ts:746-797`) adds the copies with symmetric
relations, shares points on the line, adds equal for circles. Tests: `sketchEdit.test.ts:259-291`, `sketcher.test.ts:252`.

**Gaps**
- P2 · S · Copy option missing: originals are always kept (`sketchEdit.ts:777-795`) → option to remove the originals.
- P2 · L · Mirror about model edges, reference planes or planar faces not possible: only sketch lines and the two axes (`mirrorLine`, `sketchEdit.ts:727-736`); sketches cannot reference model geometry at all (curve kinds in `packages/core/src/index.ts:127-131`).
- P3 · S · Points cannot be mirrored (picks are filtered to curves, `sketcher.ts:351`; `mirrorCurves` takes curves only).
- P3 · S · No preview of the mirrored result (`sketcher.ts:1158-1159`); no panel with the two selection boxes.
- P3 · S · A construction line clicked while picking is taken as the mirror line at once (`sketcher.ts:1236`), so a centreline cannot be among the entities to mirror unless picked before the tool → an explicit "Mirror about" box.

## Dynamic mirror

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/HIDD_DVE_SKETCH_DYNAMIC_MIRRORING.htm): pick a
line or edge, switch the tool on, and everything sketched afterwards is mirrored as it is drawn, until switched off.

**App**: not built (no tool in `toolDefs.tsx` or `sketchToolDefs.tsx`).

**Gaps**
- P3 · M · Dynamic mirror missing → a toggle that runs `mirrorCurves` on each newly placed entity about the chosen line.

## Linear sketch pattern

**SolidWorks** (https://help.solidworks.com/2022/English/solidworks/sldworks/HIDD_DVE_SKETCH_PATTERN_LINEAR.htm):
Direction 1 (X axis, a line or model edge; Reverse; Spacing; Dimension X spacing; Number of instances; Display instance
count; Angle; Fix X-axis direction), Direction 2 (same, plus Dimension angle between axes), Entities to pattern,
Instances to skip. The pattern stays editable and the instances follow the original through relations and dimensions.

**App**: panel `toolDefs.tsx:1073-1089` with Count (default 3) and a Spacing vector U/V (default 20, 0); acts on the
selected curves (`sketcher.ts:1284-1303`). `linearPattern` / `copies` (`sketchEdit.ts:808-858`) adds the copies with
the internal relations of the set (COPIED kinds). Tests: `sketchEdit.test.ts:294`, `sketcher.test.ts:271`.

**Gaps**
- P1 · M · Instances are not tied to the original or to each other: no spacing dimension, no relation. Checked in the app: a circle fully defined at the origin (0 DOF) patterned 3 times leaves 4 DOF; dragging the original leaves the copies behind, and changing the spacing means undoing and redoing → hold each instance by spacing dimension(s) and equal / parallel relations, like SolidWorks.
- P2 · M · Direction 2 missing (no grid patterns).
- P2 · S · No live preview of the instances while the panel is open.
- P2 · S · No "Entities to pattern" selection box: the selection at the moment of Apply is used (`selectedCurves`, `sketcher.ts:1284-1286`); loose points are ignored (filter on `type === 'curve'`).
- P3 · M · Instances to skip missing.
- P3 · S · Direction cannot be picked from a line or edge, no Reverse, no Fix X-axis direction, no Display instance count (the U/V vector covers angle and length only by typing).
- P3 · S · Distance, angle and symmetric relations inside the patterned set are not carried to the copies (`COPIED`, `sketchEdit.ts:802-805`), so the copies are less defined than the original.

## Circular sketch pattern

**SolidWorks** (https://help.solidworks.com/2022/English/solidworks/sldworks/HIDD_DVE_SKETCH_PATTERN_CIRCULAR.htm):
Reverse direction, centre (sketch origin by default, or Center X / Y, or a picked point), Spacing (total angle), Equal
spacing, Dimension radius, Dimension angular spacing, Number of instances, Display instance count, Radius, Arc angle,
Entities to pattern, Instances to skip.

**App**: panel `toolDefs.tsx:1091-1112` with Count (6), Angle (360) and Centre U/V (selected point or origin,
`sketcher.ts:1289-1294`). `circularPattern` (`sketchEdit.ts:861-872`): at 360 the instances are spread evenly, else
count-1 steps over the angle; horizontal/vertical relations are dropped on the copies. Tests: `sketchEdit.test.ts:305`,
`sketcher.test.ts:271`.

**Gaps**
- P1 · M · Same as linear: no relation or dimension ties the instances (positions, radius, angle) to the original, so the pattern is a one-off copy (`copies`, `sketchEdit.ts:808-850`).
- P2 · S · Equal spacing is implied by "angle is 360" (`sketchEdit.ts:865-866`) instead of a checkbox; with it off SolidWorks reads the angle as the step → add the checkbox.
- P2 · S · No preview; no selection box for the entities (as linear).
- P3 · S · Centre cannot be clicked in the view while the panel is open (only typed or pre-selected); no Reverse direction (a negative angle works but is not offered).
- P3 · S · Dimension radius / angular spacing, Radius and Arc angle fields, Display instance count missing.
- P3 · M · Instances to skip missing.

## Move / Copy

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/HIDD_DVE_MOVE_COPY.htm and
https://help.solidworks.com/2020/English/SolidWorks/sldworks/r_Move_PropertyManager.htm): Entities to move/copy, Keep
relations (on: relations to unselected geometry stay, so attached entities stretch along; off: only those relations
break), From/To with a start point and drag, or X/Y deltas, and Repeat.

**App**: panels `sketchToolDefs.tsx:89-176` (Move by U/V, "Keep the original (copy)"); clicking two points in the view
applies at once (`sketchToolDefs.tsx:115-128`, `sketcher.ts:1343-1351`) with a ghost preview (`sketcher.ts:1354-1374`).
`transformEntities` (`sketchEdit.ts:945-1023`) moves the geometry, splits points shared with curves that stay, and drops
relations to the rest (count reported, `sketcher.ts:1395-1398`). Tests: `sketchEdit.test.ts:351-413`,
`sketcher.test.ts:391-432`.

**Gaps**
- P2 · M · Keep relations missing: a move always behaves as "Keep relations" cleared (shared points split, ties dropped, `sketchEdit.ts:957-958`, `1004-1021`) → with it on, solve with the moved points as targets so attached geometry follows.
- P2 · S · Repeat missing → re-apply the last offset.
- P3 · S · No selection box: with nothing selected clicks select, with a selection they pick points and Shift is needed to change it (`sketcher.ts:1343-1347`); the form's third vector box is blank (`vecField`, `sketchToolDefs.tsx:37`).
- P3 · S · The "to" point applies immediately on the second click; there is no drag of the ghost to place it.

## Rotate

**SolidWorks** (Rotate PropertyManager under the page above): entities, Keep relations, centre of rotation, angle.

**App**: `transformTool('rotate')` (`sketchToolDefs.tsx:142-176`): centre clicked or typed, angle (default 90), optional
copy; horizontal/vertical swap on quarter turns and are dropped otherwise (`sketchEdit.ts:904-924`).

**Gaps**
- P2 · M · Keep relations missing (same as Move).
- P3 · S · No preview of the rotated result (`xformPreview` handles move/copy only, `sketcher.ts:1356`), no drag to set the angle.

## Scale

**SolidWorks** (Scale PropertyManager under the page above): base point, scale factor, Copy, Number of copies.

**App**: `transformTool('scale')` with factor (default 2), centre, copy; dimensions and radii are scaled
(`sketchEdit.ts:916-923`, `982`).

**Gaps**
- P2 · S · Number of copies missing (copy makes one).
- P3 · S · No preview.

## Stretch

**SolidWorks** (Stretch PropertyManager under the page above): entities to stretch (usually a box selection), base point
From/To or X/Y deltas, Repeat; geometry partly inside the box stretches.

**App**: not built.

**Gaps**
- P2 · M · Stretch entities missing → move the selected points (box selection is being added by someone else) and let the solver stretch connected curves.

## Convert entities and Intersection curve

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/c_Convert_Entities.htm): project model
edges, loops, faces or other sketches onto the sketch plane as sketch curves linked to them (they update with the
model). Intersection curve makes sketch curves where the sketch plane cuts faces or bodies.

**App**: neither exists. A sketch can only hold its own lines, arcs and circles (`packages/core/src/index.ts:127-131`); there
is no curve kind that refers to a model edge, no spline or ellipse kind, and no server call that returns edge curves in
the sketch frame.

**Gaps**
- P2 · L · Convert entities needs: a sketch curve kind (or relation) that references a model edge by a stable id (see
  `apps/server/src/cad/refs.ts`), server-side projection of the edge onto the sketch plane, re-evaluation when the model
  changes, and spline/ellipse support for non-circular edges. Offset of model edges and Mirror about edges depend on it.
- P3 · L · Intersection curve needs the same reference machinery plus a plane-body section on the server (OpenCascade
  `BRepAlgoAPI_Section`).

## Repair sketch

**SolidWorks** (https://help.solidworks.com/2021/english/SolidWorks/sldworks/HIDD_SKETCH_GEOM_DIAGNOSTICS.htm): deletes
short entities (chain shorter than twice the maximum gap) and merges overlapping lines and arcs automatically; lists
gaps and overlaps smaller than "Showing gaps smaller than" and points shared by three or more entities; Refresh,
Previous / Next and a magnifying glass on each error.

**App**: panel `sketchToolDefs.tsx:178-217`; `findProblems` / `fixProblem` / `fixAll` (`sketchRepair.ts:75-233`): zero-
length curves, a curve lying completely on another (or identical circles/arcs), gaps under a fixed 0.5 mm, and relations
to deleted geometry. Hovering a row lights the geometry. Tests: `sketchRepair.test.ts:18-94`, `sketcher.test.ts:452`.

**Gaps**
- P2 · S · The gap size is fixed at 0.5 mm (`sketchRepair.ts:12`) → a "Showing gaps smaller than" field, and short entities defined as shorter than twice it (now only below 0.001 mm, `sketchRepair.ts:14`, `45-53`).
- P2 · M · Partly overlapping or collinear touching lines (and overlapping arcs) are not merged; only a curve completely inside another is found (`liesOn`, `sketchRepair.ts:56-68`) → merge overlaps into one entity.
- P3 · S · Points shared by three or more entities are not reported.
- P3 · S · No zoom / magnifier to the problem, no Previous / Next (rows highlight only).
- P3 · S · Overlaps (crossing ends) are not reported as gaps; only near-miss ends are (`sketchRepair.ts:102-121`).

## Split entities

**SolidWorks** (https://help.solidworks.com/2022/english/SolidWorks/sldworks/c_split_entities.htm): click an entity to
split it into two at that spot with a split point you can dimension to; two points for a circle; deleting the split
point joins them again.

**App**: not built. The middle-cut logic in `trimAt` (`sketchEdit.ts:248-259`) already makes two pieces that stay in
line.

**Gaps**
- P2 · S · Split entities missing → reuse the trim middle-cut without removing anything; Delete on the split point should join the two again.

## Jog line / Make path

**SolidWorks**: Jog line inserts a rectangular jog into a line; Make path groups a chain of entities into a path
(mainly for assemblies and mechanisms). Help pages not read in this audit.

**App**: neither exists.

**Gaps**
- P3 · M · Jog line missing.
- P3 · M · Make path missing (low value without sketch blocks or mechanism mates).

## Construction geometry

**SolidWorks**: any entity can be switched to construction (For construction checkbox); centrelines are construction.

**App**: X key and a Constrain-group button toggle the selected curves (`sketcher.ts:385-393`, `toolDefs.tsx:1050-1057`,
`Toolbar.tsx:441-445`); the centreline tool draws construction lines (`sketcher.ts:625-626`). Offset, mirror and patterns
keep the flag. Matches for the basic job; the trim options that use it are listed under Trim.

## Shared behaviour

**SolidWorks**: tools work on pre-selected entities or open a PropertyManager with selection boxes; OK / Enter or
right-click OK ends the tool; Esc cancels; each tool's result is one undo step; results are held by relations so the
sketch stays solvable.

**App**: Trim, Extend, Fillet, Chamfer, Offset and Mirror are click tools with no panel (`toolDefs.tsx:1114-1123`). Esc
clears typed text, then picks, then leaves the tool (`sketcher.ts:1088-1103`). Enter applies a typed value, then the
mirror step, else opens the Finish popup (`Toolbar.tsx:426-435`). Every result goes through `commit`, which solves first
and refuses an over-constrained result with one undo step (`sketcher.ts:252-271`).

**Gaps**
- P1 · M · A solve that reports success does not mean the relations hold: in the Extend case above `solveGeometry` returned ok with no conflicts while the extended end sat off both curves it is held on → `commit` should check the residual and refuse (or report) a result that does not satisfy its relations. (Solver internals not audited here; seen only through this case.)
- P2 · M · Pre-selection is ignored by every edit tool except Mirror (`sketcher.ts:351`), and Trim/Extend/Fillet/Chamfer clear the selection on use → act on the selection when the tool starts, as SolidWorks does.
- P2 · L · No PropertyManager for Trim, Extend, Fillet, Chamfer, Offset, Mirror: options cannot exist without one and values are typed blind at the cursor (`typeKey`, `sketcher.ts:742-766`). CLAUDE.md asks for left-panel forms with selection boxes.
- P3 · S · Right-click does nothing in the sketch view (only the left button is handled, `SketchDrawing.tsx:617-621`); Enter with nothing pending opens the Finish popup instead of ending the tool (`Toolbar.tsx:431-433`).
- P3 · S · Only Trim and Extend (and Offset after the pick) preview their result; Fillet, Chamfer, Mirror, patterns, Rotate and Scale do not.

---

## Top 10 for this area

1. Extend keeps old point-on-curve relations on the moved end and gives wrong geometry after a trim (P1 · S, `sketchEdit.ts:339-341`).
2. `commit` accepts solves whose relations do not hold (P1 · M, `sketcher.ts:258-269`, found through item 1).
3. Power trim by dragging across curves (P1 · M, `sketcher.ts:497-499`).
4. Linear and circular sketch patterns are dead copies, not tied by dimensions or relations (P1 · M, `sketchEdit.ts:808-872`).
5. Offset of arcs and circles is not tied to the original; one optional dimension instead of one per line (P2 · M, `sketchEdit.ts:668-722`).
6. Fillet: keep constrained corners (dimensions on the corner are deleted silently) and line-arc / arc-arc corners (P2 · M, `sketchEdit.ts:357-454`).
7. Edit tools ignore pre-selection and have no PropertyManager panel (P2 · L, `sketcher.ts:349-356`, `toolDefs.tsx:1114-1123`).
8. Offset: Select chain off, Bi-directional, Cap ends (P2 · M).
9. Chamfer distance-distance and angle-distance (P2 · M, `sketchEdit.ts:460-494`).
10. Move / Rotate Keep relations and Repeat, plus Stretch and Split entities (P2 · M/S).

## Not checked

- The solver itself (why the impossible Extend case solved "ok"); only seen through that case.
- Trim of an arc cut in the middle (equal relation between two arcs on one centre) and trims of construction geometry in the running app.
- Whether the select tool stays usable to change the selection while a pattern panel is open (read, not run).
- What a lock (`fix`) on a moved point does after Move (depends on solver semantics of `fix`).
- SolidWorks help for Jog line, Make path, Intersection curve and the separate Extend Entities page (described from the command list only); "Keep relations" for Rotate taken from the Move page.
- Undo/redo in the running app (only through the existing tests, which cover trim, drags and relation deletes).
