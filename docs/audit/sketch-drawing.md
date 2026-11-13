# Audit: sketch drawing and constraining

Area: starting a sketch (plane or face), Exit sketch / Discard, the draw tools, snapping and inference, the grid,
Smart Dimension, relations, Display/Delete relations, Fully define, sketch status, dragging, undo/redo and selection
inside a sketch. The modify tools (trim, extend, fillet, offset, mirror, patterns, move/copy) are a separate area and
are only mentioned where they touch this one.

Audited 2026-11-13 from the code on disk. `docs/SOLIDWORKS_REFERENCE.md` did not exist at the start or at the end of
this audit, so the SolidWorks side comes from the online help directly (pages listed per section). Some behaviour was
confirmed in the running app through the live modules (a throwaway sketch, closed without saving); those items say
"confirmed live".

## Summary

| Tool / behaviour | Verdict | P1 | P2 | P3 |
|---|---|---|---|---|
| Start sketch: plane or face | incomplete | 1 | 2 | 2 |
| Exit sketch / Discard | differs | 0 | 1 | 1 |
| Line (chains, typed length/angle, H/V inference) | incomplete | 0 | 2 | 2 |
| Centreline, construction toggle | matches | 0 | 0 | 1 |
| Corner rectangle, centre rectangle | incomplete | 0 | 1 | 1 |
| Circle | incomplete | 0 | 1 | 1 |
| 3-point arc | incomplete | 0 | 1 | 0 |
| Centre arc | broken | 0 | 1 | 0 |
| Slot | broken | 1 | 1 | 1 |
| Polygon | incomplete | 0 | 2 | 1 |
| Point | matches | 0 | 0 | 0 |
| Missing draw tools | incomplete | 0 | 3 | 2 |
| Snapping, quick snaps, inference, grid | incomplete | 0 | 2 | 3 |
| Smart Dimension | incomplete | 0 | 5 | 5 |
| Relation tools | broken | 1 | 4 | 2 |
| Display/Delete relations | incomplete | 0 | 0 | 3 |
| Fully define sketch | incomplete | 0 | 1 | 2 |
| Sketch status (colours, messages) | differs | 0 | 2 | 1 |
| Selected entity properties (PropertyManager) | missing | 0 | 1 | 0 |
| Dragging geometry | differs | 0 | 0 | 2 |
| Undo / redo | matches | 0 | 0 | 1 |
| Selection in a sketch | incomplete | 0 | 1 | 2 |
| Tests | incomplete | 0 | 1 | 1 |

---

## Start sketch: choosing a plane or face

**SolidWorks.** Sketch starts on a preselected plane or planar face, or asks for one: the three default planes, any
reference plane, or a planar model face. The sketch stays attached to that plane or face (if the face moves, the
sketch moves with it). Edit Sketch Plane changes it later. The view turns normal to the plane.
Source: https://help.solidworks.com/2021/english/SolidWorks/sldworks/c_Sketch_Geometry_Status.htm (sketch topics),
https://help.solidworks.com/2021/english/SolidWorks/sldworks/t_Dimensioning_a_2D_Sketch.htm (general sketch flow).
The plane-selection page itself was not fetched; this part rests on general SolidWorks behaviour plus the code.

**App.** Sketch tool → `beginSketch` (`apps/web/src/toolDefs.tsx:401-404`) → `startSketch` (`sketcher.ts:303-329`)
always opens the plane stage. The plane stage offers the three planes in the view (`SketchLayer.tsx:192-236`), the
Sketch plane panel with Top/Front/Right plus offset and tilt (`toolDefs.tsx:427-463`), a click on any face of the
part (`Scene.tsx:150-168` → `chooseFace`, `sketcher.ts:336-342` → `planeForFace`, `sketchMath.ts:96-113`), and
"Sketch on this plane" for the three base planes in the tree (`FeatureTree.tsx:346-349, 433`). `choosePlane` turns
the camera (`look`) and selects the Line tool (`sketcher.ts:331-333`).

**Gaps**
- P1 · M · A reference plane step cannot be sketched on: the core type supports `{ planeRef }`
  (`packages/core/src/index.ts:41`) and `planeFrame` resolves it, but nothing in the web app ever creates one (no
  `planeRef:` anywhere in `apps/web/src`); the tree menu only offers base planes (`FeatureTree.tsx:433`), the plane
  panel only Top/Front/Right (`toolDefs.tsx:448`), and plane steps are not clickable in the plane stage → a plane step
  must be pickable in the view and in the tree, and its tree menu must offer "Sketch".
- P2 · L · A sketch on a face is not attached to the face: `planeForFace` stores a named plane plus a numeric offset,
  or a frozen custom plane (`sketchMath.ts:96-113`). Change the depth of the feature that made the face and the sketch
  stays where it was → store a face reference and re-resolve it on rebuild.
- P2 · S · A preselected face or plane is ignored: `beginSketch` never looks at the current selection
  (`toolDefs.tsx:401-404`) → with a planar face or plane selected, go straight to the draw stage on it.
- P3 · M · No Edit Sketch Plane for an existing sketch (the plane is fixed once chosen, `startSketch` keeps
  `edit.sketch.plane`, `sketcher.ts:317`).
- P3 · S · The plane panel's Offset/Tilt makes an unnamed construction plane inside the sketch
  (`toolDefs.tsx:434-455`), which SolidWorks does not have; it hides the missing "Plane" feature route. Keep, but
  label it as such or route it through a reference plane step.

## Exit sketch / Discard

**SolidWorks.** Exit Sketch (also the confirmation corner) saves and leaves; Discard changes and exit asks first.
Enter ends the current entity / repeats the last command rather than leaving the sketch.

**App.** Exit sketch = `finishTool` (`toolDefs.tsx:699-799`), with an operation panel only when the sketch was started
from Extrude/Cut/Revolve (`finishNeedsPanel`, `toolDefs.tsx:672-678`); a plain sketch may be open but not empty
(`toolDefs.tsx:775-782`). Discard asks when something was drawn or changed (`toolDefs.tsx:681-689`). Enter with
nothing typed opens Exit sketch (`Toolbar.tsx:425-435`).

**Gaps**
- P2 · S · Enter in the middle of a line chain (or any entity in progress) saves and leaves the sketch: with no typed
  value and no mirror step, Enter calls `openById(finishTool.id)` regardless of `draft` (`Toolbar.tsx:427-434`), and
  for a plain sketch that is the instant `exitSketchSaving` (`toolDefs.tsx:692-705`). Reproduce: Line, click two
  points, press Enter → the sketch is saved and closed → Enter should end the chain/entity when `draft` is non-empty
  and only exit from an idle tool.
- P3 · S · Exiting an over-defined sketch is not warned about; `currentSketch` saves whatever is there
  (`sketcher.ts:1513-1528`) → warn like SolidWorks does.

## Line (chains, typed length/angle, horizontal/vertical inference)

**SolidWorks.** Click-click chains; click-drag single lines; Esc or double-click ends; moving back to the end point
switches to a tangent arc. Line PropertyManager: orientation (as sketched, horizontal, vertical, angle), For
construction, Infinite length, Midpoint line, Add dimensions; a selected line shows Length, Angle and start/end
coordinates, editable. Horizontal/vertical relations are added when the pointer shows them.
Source: https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_DVE_SKETCH_LINE.htm,
https://help.solidworks.com/2021/english/SolidWorks/sldworks/c_Inferencing.htm

**App.** `place` case line/centerline (`sketcher.ts:617-637`): first click starts, each click adds a line sharing
the previous end; clicking the chain start closes it; H/V relation added when the snap kind is `horizontal` or
`vertical` (alignment with the previous point, `snapping.ts:256-260`). Typed `length` or `length,angle` + Enter
(`applyTyped`, `sketcher.ts:810-813`) places the point and adds a length and an angle-to-u-axis dimension
(`lineDims`, `sketcher.ts:598-607`). Double-click ends the chain (`SketchDrawing.tsx:665`, `endChain`).

**Gaps**
- P2 · M · No line options at all: no orientation choice, no Infinite length, no Midpoint line, no "Add dimensions"
  toggle, no For construction checkbox at draw time (only the separate Centreline tool) (`toolDefs.tsx:406-415`
  are plain buttons).
- P2 · M · No line-to-tangent-arc switch while chaining (return to the end point / A key); there is no tangent arc
  tool at all (see Missing draw tools).
- P3 · S · Click-drag to draw a single line is not supported; only click-click (`sketchDown` returns false for draw
  tools, `sketcher.ts:497-499`).
- P3 · S · A typed angle is stored as `abs(angle) % 180` against the u axis (`sketcher.ts:604`) while the point is
  placed at the signed angle; the solver then keeps whichever of the four readings is nearest (`solver.ts:177-186`).
  It works for the first solve but the dimension shows e.g. 30° for a line drawn at −30°, and a later edit of the
  value can flip the line to the other side.

## Centreline and construction toggle

**SolidWorks.** Centerline is a construction line; any entity can be switched with For construction.

**App.** Centreline is the line tool with `toggleConstruction` applied to each segment (`sketcher.ts:625-626`);
X or the Construction button toggles selected curves (`sketcher.ts:385-393`, `Toolbar.tsx:442-445`). Drawn dashed
orange (`SketchDrawing.tsx:533-536`); left out of profiles (`sketchGeometry.ts:70-81`).

**Gaps**
- P3 · S · X does nothing while an entity is in progress, because `typeKey` swallows `x` as the "w x h" separator
  whenever `draft` is non-empty (`sketcher.ts:749, 761`). Acceptable, but the hint should say so.

## Corner rectangle and centre rectangle

**SolidWorks.** Rectangle types: Corner, Center, 3 Point Corner, 3 Point Center, Parallelogram; options For
construction and Add dimensions; centre rectangle gets construction diagonals.

**App.** `addRect` (`sketchGeometry.ts:199-222`): 4 lines, shared corners, two H and two V relations; the first
corner and the opposite corner use their snap refs. Centre rectangle (`sketchEdit.ts:1042-1051`): a corner rectangle
plus one construction diagonal with the centre as its midpoint. Typed `w,h` adds two length dimensions
(`sketcher.ts:638-671`, `814-827`).

**Gaps**
- P2 · M · Missing 3 Point Corner, 3 Point Center and Parallelogram rectangles (`DRAW_TOOLS`, `toolDefs.tsx:406-415`).
- P3 · S · Centre rectangle draws one diagonal; SolidWorks draws both (`sketchEdit.ts:1046-1049`). No "Add
  dimensions" option for either type.

## Circle

**SolidWorks.** Centre circle and Perimeter circle (three points, or tangent to entities); a selected circle shows
centre and radius in the PropertyManager.
Source: https://help.solidworks.com/2021/english/SolidWorks/sldworks/HIDD_DVE_SKETCH_CIRCLE.htm

**App.** Centre, then a point (`sketcher.ts:684-693`); typed value is the diameter. Radius is rounded to the default
step `round(dist(...))` (`sketcher.ts:689`).

**Gaps**
- P2 · M · No Perimeter circle (3 points / tangent to three entities).
- P3 · S · The second click's snap is ignored: clicking an existing point to size the circle adds no coincident
  relation (only `ref.at` is used, `sketcher.ts:689`), so the circle comes loose when that point moves.

## 3-point arc

**SolidWorks.** Start, end, then drag the through point; Arc PropertyManager with centre/start/end/radius/angle.
Tangent arc is a separate tool. Source: https://help.solidworks.com/2021/english/SolidWorks/sldworks/HIDD_DVE_SKETCH_ARC.htm

**App.** `addArc` (`sketchGeometry.ts:262-272`) uses the snap refs for start and end; typed value is a radius
(`sketcher.ts:847-864`).

**Gaps**
- P2 · S · A typed radius that is too small returns an error string from `applyTyped` (`sketcher.ts:854-857`) but the
  Toolbar ignores the return value (`Toolbar.tsx:429`), so the typed text just disappears with no message. Confirmed
  live: chord 20, typed 2 → `message` stays null. Same for "Type a number..." (`sketcher.ts:784`) → show the returned
  text in the status line.

## Centre arc

**SolidWorks.** Centre, start, end; the end can land on an existing point and joins it.

**App.** `place` case centerArc (`sketcher.ts:672-683`) → `addCentreArc` (`sketchEdit.ts:1028-1039`); the sweep
follows the cursor (`sketcher.ts:430-436`); typed radius then angle (`sketcher.ts:828-840`).

**Gaps**
- P2 · S · The end point never joins anything: `place` passes `ref.at` only (`sketcher.ts:680`) and `addCentreArc`
  always makes a new point (`sketchEdit.ts:1035`). Ending the arc on a line's end leaves two separate points with no
  relation; the profile closes only because coinciding points are merged geometrically (`sketchRegions.ts:240-268`),
  and the first drag or dimension change opens a gap → add a coincident (or reuse the point when it lies on the
  circle) when the end snaps to a point, a pointOnCurve when it snaps to a curve.

## Slot

**SolidWorks.** Four slot types: Straight, Centerpoint Straight, 3 Point Arc, Centerpoint Arc. Options Add dimensions,
Center to Center or Overall Length; parameters centre X/Y, width, length (arc slots: radius, angle); slot relations
Fix Slot and Equal Slots. A slot is one editable entity. Source:
https://help.solidworks.com/2021/english/SolidWorks/sldworks/HIDD_DVE_SKETCH_SLOT.htm

**App.** Two centre clicks, then the width (`sketcher.ts:714-725`) → `addSlot` (`sketchGeometry.ts:275-304`): two
lines, two arcs, four tangents, equal radii. Typed: length (with optional angle), then width, stored as an arc radius.

**Gaps**
- P1 · S · The slot ignores where it was snapped: `addSlot(g, a.at, b.at, ...)` (`sketcher.ts:721`) always makes new
  centre points, so a slot started on the origin or on a point is not attached to it. Confirmed live: slot from the
  origin → no arc uses `origin` as its centre. The user sees a snap and gets no relation → pass the refs and reuse or
  constrain the points.
- P2 · L · Only the straight centre-to-centre slot; no Centerpoint Straight, 3 Point Arc, Centerpoint Arc slots; no
  slot identity (it is four loose curves), so no Fix Slot / Equal Slots and no editing it as a slot.
- P3 · S · No construction centre line between the centres and the width is dimensioned as an arc radius
  (`sketcher.ts:722`); SolidWorks shows width and length (centre-to-centre or overall).

## Polygon

**SolidWorks.** 3 to 40 sides, Inscribed or Circumscribed construction circle, centre X/Y, circle diameter, angle,
New Polygon; editable later with Edit Polygon. Source:
https://help.solidworks.com/2021/english/SolidWorks/sldworks/HIDD_DVE_SKETCH_POLYGON.htm

**App.** Centre, then a corner (`sketcher.ts:694-703`) → `addPolygon` (`sketchGeometry.ts:307-332`): corners on a
construction circle, all sides equal. The side count lives in Sketch settings (`toolDefs.tsx:465-487`, 3-64).

**Gaps**
- P2 · S · The side count is not on the tool, it is in a separate Sketch settings popup (`toolDefs.tsx:473`) → put
  sides, inscribed/circumscribed and angle in the polygon's own panel.
- P2 · M · No Inscribed option (the corners are always on the circle, i.e. only Circumscribed) and no Edit polygon
  (sides cannot be changed after drawing; the polygon is just lines).
- P3 · S · The corner click's snap is ignored (`addPolygon(g, last, ref.at, sides)`, `sketcher.ts:699`); the typed
  value is the circle radius but the hint does not say so (`Toolbar.tsx:132`); limit is 64 instead of 40.

## Point

**SolidWorks.** A sketch point; PropertyManager shows X/Y.

**App.** `placePoint` with snap refs (`sketcher.ts:609-615`, `sketchGeometry.ts:161-177`); a second point on an
existing one is refused with a message. Kept when other geometry is deleted (`removeItemsKeepingPoints`,
`sketchGeometry.ts:384-398`). Matches, apart from the missing properties panel (see below).

## Missing draw tools

**SolidWorks** also has: tangent arc, perimeter circle, 3-point and parallelogram rectangles, the other slot types,
spline (and style spline, equation-driven curve), ellipse and partial ellipse, parabola, conic, sketch text, midpoint
line, infinite line, fillet/chamfer (present, other area), Convert Entities, Intersection Curve, Construction
geometry from model edges.

**App.** `DRAW_TOOLS` (`toolDefs.tsx:406-415`) plus Centreline and Point (`sketchToolDefs.tsx:59-85`). The curve
model only has line, circle, arc (`packages/core/src/index.ts`, `SketchCurve`).

**Gaps**
- P2 · M · Tangent arc (most used missing tool; needs a tangent relation to the previous entity).
- P2 · L · Spline and ellipse: need new curve kinds in core, solver primitives (PlaneGCS has ellipse and B-spline),
  region building and kernel conversion.
- P2 · L · Convert Entities (project model edges into the sketch) — essential for sketching on faces; absent.
- P3 · L · Parabola, conic, sketch text.
- P3 · S · Midpoint line and infinite line (line options).

## Snapping, quick snaps, inference, grid

**SolidWorks.** Sketch snaps (on by default): end point, centre, midpoint, quadrant, intersection, nearest, tangent,
perpendicular, parallel, horizontal/vertical lines, horizontal/vertical to points, length, grid, angle. Quick Snaps
pick one for the next click. Inference lines show alignment; a relation shown by the pointer at the click is added.
Automatic relations can be switched off (Ctrl while sketching suppresses inference). Grid snap only when the grid
is displayed. Source: https://help.solidworks.com/2021/english/SolidWorks/sldworks/c_Inferencing.htm

**App.** `snapCursor` (`snapping.ts:154-265`): points, then intersections/midpoints/quadrants, then on curve, then grid
and alignment with the last point or any point. Relations added from snaps: shared point, midpoint, pointOnCurve
(intersections get two) (`sketchGeometry.ts:161-177`), and H/V for lines aligned with the previous point
(`sketcher.ts:623-624`). Quick snaps panel switches kinds off, stored in localStorage (`sketchToolDefs.tsx:41-56`,
`sketcher.ts:1447-1458`). Grid step and snap on/off in Sketch settings (`toolDefs.tsx:465-487`); grid drawn always
(`SketchLayer.tsx:239-279`).

**Gaps**
- P2 · M · No tangent, perpendicular or parallel snaps/inference and no matching automatic relations (e.g. a line
  started at an arc end is not made tangent; a line drawn square to another gets no perpendicular)
  (`snapping.ts:10-11, 36` list the only kinds).
- P2 · S · No way to suppress automatic relations for one click (Ctrl in SolidWorks) and no "Automatic relations"
  switch separate from snapping (`sketcher.ts:397-400` only has `snap` on/off).
- P3 · S · Quick snaps here are persistent on/off filters (`sketchToolDefs.tsx:41-56`), not SolidWorks' one-shot
  "snap only to this for the next pick".
- P3 · S · Grid snap is on by default with a 1 mm step (`sketcher.ts:220-221`, `snapping.ts:237-239`), so every free
  click is rounded; SolidWorks snaps to the grid only when asked. The grid cannot be hidden in a sketch (cell falls
  back to 1 when step is 0, `SketchLayer.tsx:251`).
- P3 · S · Angle and length snaps (fixed increments while drawing) missing.

## Smart Dimension

**SolidWorks.** Type depends on picks and, for point-to-point, angle and circle, on where it is placed: line length
(aligned/horizontal/vertical by placement), angle between two lines (placement picks which of the four angles),
distance between parallel lines, point to line, point to point (horizontal/vertical/aligned by placement), radius of
an arc, arc length (arc + both ends), circle diameter (shown as diameter or linear), distances to arcs/circles (to
centre by default, min/max options), midpoint of an edge, doubled distance to a centreline. Esc undoes the last pick.
Values accept units and equations / global variables; a redundant dimension can be made driven (grey reference).
Sources: https://help.solidworks.com/2021/english/SolidWorks/sldworks/t_Dimensioning_a_2D_Sketch.htm,
https://help.solidworks.com/2021/english/SolidWorks/sldworks/c_Sketch_Geometry_Status.htm

**App.** Picks via `dimensionPick` (`sketcher.ts:880-883`); type from `dimensionFromPicks`
(`sketchGeometry.ts:517-572`): line → length; circle → diameter; arc → radius; point-point → distance with axis by
placement; line-line → angle, or distance when parallel; point-line → distance. Drag-out from geometry
(`sketcher.ts:479-496, 518-535`) or click picks then click empty space (`sketcher.ts:897-915`). Value input with
arithmetic (`evaluate`, `sketchGeometry.ts:575-624`), conflicts refused and shown in the input
(`sketcher.ts:937-965`). Labels drag, click-select, double-click edit (`SketchDrawing.tsx:262-334`). Delete removes
a selected dimension (`deleteSelected`).

**Gaps**
- P2 · S · Anything with a circle or arc besides its own size cannot be dimensioned: point-circle, line-circle,
  circle-circle, arc-arc all return null (`sketchGeometry.ts:567-571`) and the user gets "Those cannot be dimensioned
  together" (`sketcher.ts:889-891`) → measure to the centre (SolidWorks default), with min/max as an option.
- P2 · M · Angle dimensions cannot be obtuse or chosen by placement: `dimensionFromPicks` ignores the placement for
  angles, the preview and initial value always show the acute reading (`measure` picks the reading nearest the value,
  0 for a new one, `solver.ts:351-360`), and `translate` aims for whichever of ±θ, π∓θ is nearest the current
  geometry (`solver.ts:177-186`). Typing 100 on lines 60° apart yields 80° geometry while the label says 100° →
  store which angle (quadrant) the dimension measures, from where it is placed.
- P2 · M · No driven (reference) dimensions: a dimension that over-defines is simply refused (`sketcher.ts:960-964`);
  there is no "make driven" and no grey reference dimension type in `SketchConstraint`
  (`packages/core/src/index.ts:138-151`).
- P2 · M · Values take only numbers and + − × ÷ and brackets (`sketchGeometry.ts:577`): no unit suffix (25.4mm,
  1in), no equations linking dimensions or global variables; the unit is hard-coded "mm"/"deg"
  (`SketchDrawing.tsx:398`).
- P2 · S · Line length is always aligned: placing the label above a slanted line does not give its horizontal
  projection (`sketchGeometry.ts:520-522`); only point-point respects placement.
- P3 · S · No arc length (arc + both end points) and no doubled distance to a centre line (revolve profiles).
- P3 · S · Circle always diameter, arc always radius; no toggle (radius/diameter/linear display).
- P3 · S · Esc clears all picks (`sketcher.ts:1096-1097`), not the last one.
- P3 · S · Moving a label is not an undo step (`moveLabel`, `sketcher.ts:538-540`), and while a value input is open
  a click elsewhere does nothing (`sketcher.ts:544-546`); it must be closed with Enter or Esc.
- P3 · S · Point-to-line distance is unsigned (`p2l_distance`, `solver.ts:154-156`): a large value change can flip
  the point to the other side of the line.

## Relation tools

**SolidWorks.** Add Relations lists only the relations valid for the current selection. Relations and what they take:
Horizontal/Vertical (one or more lines, or two or more points), Collinear (two or more lines), Coradial (two or more
arcs), Perpendicular (two lines), Parallel (two or more lines), Tangent, Concentric (two or more arcs, or a point and
an arc), Midpoint (two lines, or a point and a line), Intersection (two lines and a point), Coincident (a point and a
line/arc/ellipse), Equal (two or more lines or arcs), Equal curvature (splines), Symmetric (a centreline and two
points, lines, arcs or ellipses), Fix (any entity: size and position fixed, a fixed line's ends may still slide along
it, an arc's ends along its circle), Pierce, Merge points, Doubled distance, Equal slots.
Source: https://help.solidworks.com/2021/english/SolidWorks/sldworks/c_description_of_sketch_relations.htm

**App.** One button per relation (`toolDefs.tsx:1019-1049`) → `constraintTool` (`sketcher.ts:1017-1034`): applies to
the selection if `constraintFromPicks` (`sketchGeometry.ts:467-509`) accepts it, else waits for picks
(`constraintClick`, `sketcher.ts:1063-1085`). Lock toggles fix on points (`toggleLock`, `sketcher.ts:1037-1061`).
Solved by PlaneGCS (`solver.ts:84-195`).

**Gaps**
- P1 · S · With several items selected only the first pair is used: `constraintFromPicks` reads `ids[0]`/`ids[1]`
  and returns one constraint (`sketchGeometry.ts:483-494`), and `constraintTool` applies just that
  (`sketcher.ts:1025-1031`). Confirmed live: four rectangle sides selected, Equal → one relation added. Same for
  Horizontal/Vertical on several lines, Parallel on three lines. The rest of the selection is silently ignored →
  apply to all (chain equal/parallel to the first, H/V to each).
- P2 · S · Redundant relations are accepted silently: `commit` only refuses conflicts (`sketcher.ts:258-266`),
  `solver.ts:281` treats redundant as OK. Confirmed live: Horizontal on an already horizontal rectangle side adds a
  fifth relation with no message and the same DOF. SolidWorks shows this as over-defined (yellow) → refuse or flag.
- P2 · M · Missing relations: Concentric, Coradial, Collinear, Intersection, Merge points (Coincident keeps two
  points), Horizontal/Vertical between two points, Midpoint of an arc, Symmetric for lines/arcs/circles (only two
  points, `sketchGeometry.ts:500-505`), Doubled distance. PlaneGCS has primitives for most of these.
- P2 · S · Lock differs from Fix: a circle locks only its centre, so its radius stays free (`sketcher.ts:1044`); a
  line locks both ends rather than its position and direction → match Fix semantics (circle centre and radius; line
  on its infinite line).
- P2 · M · No "offered relations" view: all buttons are always available and the user learns the combination was
  wrong only after picking (`sketcher.ts:1080-1082`); SolidWorks lists only the valid ones for the selection.
- P3 · S · Relation glyphs are hidden while a draw tool is active (`SketchDrawing.tsx:479-483`); SolidWorks shows
  them unless View > Sketch Relations is off; there is no such toggle.
- P3 · S · Coincident between a point and a curve is stored as `pointOnCurve` but listed as "On curve"
  (`sketchToolDefs.tsx:224`), not "Coincident" as the user asked for.

## Display/Delete relations

**SolidWorks.** Lists relations (not dimensions) with filters (all, dangling, over defined/not solved, external,
defined in context, locked, broken, selected entities), status per relation, delete, delete all, suppress, and
Replace for dangling entities.

**App.** `RelationsList` (`sketchToolDefs.tsx:246-327`): every relation and dimension, scope to the selected geometry,
filter All / Dangling / Conflicting or redundant, hover highlights, delete one, Delete all with a confirm.

**Gaps**
- P3 · S · "Delete all" also deletes every dimension in view (rows are built from all `g.constraints`,
  `sketchToolDefs.tsx:262`) while the confirm says "Delete N relations?" (`sketchToolDefs.tsx:287`) → separate or say so.
- P3 · M · No Replace entity for dangling relations, no Suppress.
- P3 · S · Relations refer to entities by internal id ("line c12", `sketchToolDefs.tsx:229-241`), hard to read
  beyond the hover highlight.

## Fully define sketch

**SolidWorks.** All entities or selected entities; Relations section (choose which relation types may be added);
Dimensions section: horizontal and vertical schemes (baseline, ordinate, chain), datum for each, placement
(above/below, left/right); Calculate previews. Source:
https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_FULLY_DEFINE_SKETCH.htm

**App.** One button (`sketchToolDefs.tsx:341-347`) → `fullyDefineSketch` (`sketcher.ts:1482-1500`) → `fullyDefine`
(`sketchRepair.ts:283-310`): tries an origin anchor, then sizes, then horizontal/vertical distances of every point
from one base, keeping each that lowers DOF without redundancy.

**Gaps**
- P2 · M · No options panel: no selected-entities scope, no relations (it never adds H/V, parallel ...; only
  dimensions), no scheme (baseline/chain/ordinate), no datum choice, no placement, no preview before applying.
- P3 · S · Added dimensions get no label position (`labels` untouched), so they pile up at default anchors.
- P3 · S · Zero-value distances may be added (`sketchRepair.ts:258-260, 277`), which the dimension input itself
  refuses (`sketcher.ts:945`); a relation (H/V, coincident) is the right thing there.

## Sketch status (colours and messages)

**SolidWorks.** Per entity: blue under defined, black fully defined, red unsolvable, yellow redundant/invalid, grey
driven, brown dangling; status bar says Under/Fully/Over Defined; the tree prefixes (-)/(+).
Source: https://help.solidworks.com/2021/english/SolidWorks/sldworks/c_Sketch_Geometry_Status.htm

**App.** Whole-sketch colour only: every curve blue until DOF is 0, then all white (`SketchDrawing.tsx:515, 533`);
curves referenced by conflicting constraints red. Status bar shows "N DOF" / "Fully constrained"
(`Toolbar.tsx:196-198`). Tree marks from `markFor` (`sketchState.ts:14-19`).

**Gaps**
- P2 · M · No per-entity state: in a sketch with 1 DOF left everything stays blue, so the user cannot see which
  entity is free → colour each point/curve by whether it can still move (PlaneGCS dependency info, or a probe solve
  per point).
- P2 · S · Redundant constraints are never shown as over-defined: neither the view nor the tree mark (`markFor`
  ignores `redundant`, `sketchState.ts:14-19`).
- P3 · S · Status words differ ("Fully constrained", "N DOF") from Under Defined / Fully Defined / Over Defined.

## Selected entity properties (PropertyManager)

**SolidWorks.** Selecting a line, arc, circle, point or slot opens its PropertyManager: existing relations, status,
Add relations (only those possible), For construction, and editable parameters (coordinates, length, angle, radius).
Sources: the Line, Arc, Circle, Point and Slot PropertyManager pages linked above.

**App.** Nothing: the left panel shows tool forms only; selecting sketch geometry shows no panel
(`PropertyManager.tsx` has no sketch-selection case; selection is used only for highlighting and for the tools).

**Gaps**
- P2 · L · Add a sketch-entity PropertyManager: relations of the selection, status, relations valid for it,
  construction checkbox, and numeric parameters.

## Dragging geometry

**SolidWorks.** Under-defined geometry drags; dragging a circle's edge changes its radius, its centre moves it;
fully defined geometry does not move.

**App.** Select tool press on geometry (`sketchDown`, `sketcher.ts:479-516`): a point alone, a line by both ends, a
circle or arc by its centre; solved with drag targets, holding the rest still, then the attached curves, then
nothing (`dragTo`, `sketcher.ts:444-473`). One undo step per drag (`sketcher.ts:518-524`).

**Gaps**
- P3 · S · A circle or arc cannot be resized by dragging its edge; grabbing the edge moves the centre
  (`sketcher.ts:506`).
- P3 · S · Dragging only works in the Select tool; SolidWorks lets you drag with no tool active, which is the same
  thing here, but not while a dimension tool is active (dimension labels excepted).

## Undo / redo

**App.** Snapshots of the geometry, 80 deep, cleared selection and picks on undo, re-solve after
(`sketcher.ts:358-376`); Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z while sketching (`Toolbar.tsx:403-414`). Matches.

**Gaps**
- P3 · S · Label moves and quick-snap/grid changes are not undoable (labels live outside `geometry`,
  `sketcher.ts:538-540`).

## Selection in a sketch

**SolidWorks.** Click selects; Ctrl (or Shift) adds; box select left-to-right (inside) and right-to-left
(crossing); Delete removes; Esc clears.

**App.** `selectAt` (`sketcher.ts:572-577`): click, Shift toggles; glyphs and labels select relations/dimensions;
Delete/Backspace removes (`Toolbar.tsx:437-440`, `deleteSelected`, `sketcher.ts:378-383`), keeping loose points.
Esc clears last (`sketcher.ts:1100-1101`).

**Gaps**
- P2 · M · No box (window/crossing) selection in a sketch; a press on empty space goes to the camera
  (`sketchDown` returns false, `sketcher.ts:500-503`). Noted: someone is said to be adding selection boxes; nothing for
  the sketch was on disk.
- P3 · S · Ctrl+click does not add to the selection, only Shift (`SketchDrawing.tsx:662` passes `e.shiftKey`).
- P3 · S · The origin and the axes cannot be selected (`sketcher.ts:575`), so they cannot be preselected for a relation
  button (they can be picked inside a relation tool).

## Tests

**App.** `sketcher.test.ts`, `sketchGeometry.test.ts`, `snapping.test.ts`, `solver.test.ts`, `sketchRepair.test.ts`,
`sketchState.test.ts` cover the solver, dimension drag-out, dragging, modify tools, centre tools, snaps, fully define.

**Gaps**
- P2 · S · Nothing tests the relation tools: `constraintFromPicks`, `constraintTool`, `constraintClick`, `toggleLock`
  have no test (grep of the test files); the multi-selection and redundancy bugs above would have shown.
- P3 · S · No tests for line chains (closing, H/V inference, typed length/angle), 3-point arc and slot placement with
  snapped refs, `applyTyped` errors, Enter/Esc handling, angle dimensions by placement.

---

## Top 10 for this area

1. P1 · S · Relation buttons use only the first pair of a multi-selection (`sketchGeometry.ts:483-494`,
   `sketcher.ts:1025-1031`).
2. P1 · S · Slot ignores snapped centres, so it never attaches to the origin or points (`sketcher.ts:721`).
3. P1 · M · Reference plane steps cannot be sketched on (no `planeRef` created anywhere in the web app).
4. P2 · S · Enter mid-entity saves and exits the sketch (`Toolbar.tsx:427-434`).
5. P2 · S · Redundant relations accepted silently and never shown as over-defined (`sketcher.ts:258-266`,
   `solver.ts:281`, `sketchState.ts:14-19`).
6. P2 · S · Centre arc end point never joins the point it snapped to (`sketcher.ts:680`, `sketchEdit.ts:1035`).
7. P2 · S · Dimensions involving circles/arcs (point/line/circle to a circle) are refused
   (`sketchGeometry.ts:567-571`).
8. P2 · M · Angle dimensions: no placement quadrant, obtuse values become the supplement while the label says
   otherwise (`solver.ts:177-186`, `solver.ts:351-360`).
9. P2 · M · Per-entity defined/under-defined colours (`SketchDrawing.tsx:515, 533`).
10. P2 · S · Typed-value errors (arc radius too small, bad number) are swallowed (`Toolbar.tsx:429`).

Next after these: Lock semantics for circles (P2 · S), tangent arc (P2 · M), missing relations (concentric, collinear,
coradial ...) (P2 · M), sketch-entity PropertyManager (P2 · L), box selection (P2 · M), driven dimensions and
units/equations (P2 · M each), tests for the relation tools (P2 · S).

## Not checked

- The finish panel's extrude/revolve options, region picking and the solid preview (other areas).
- The modify tools (trim, extend, fillet, chamfer, offset, mirror, patterns, move/copy/rotate/scale, repair) beyond
  where they share code with this area.
- Document unit settings (whether the app has non-mm units anywhere); the sketch assumes mm throughout.
- Visual check of colours, glyph placement and dimension rendering in the running app (only state was probed live).
- Whether PlaneGCS can give per-entity DOF cheaply (affects the size of item 9).
- Polygon solving to a regular shape in all cases (equal chords on a circle can also form a star); not tried.
- SolidWorks help pages for plane selection and Exit sketch were not fetched; those sections rest on general
  SolidWorks behaviour.
