# Audit: features built from sketches, and reference geometry

Audited 2026-11-13, against the code on disk at that time. Covers extrude boss and cut, revolve, sweep, loft, boundary,
rib, hole, thread, the cut-pocket tool, reference planes, axes, points, coordinate systems and curves.

Sources. `docs/SOLIDWORKS_REFERENCE.md` did not exist when this audit started or when it finished, so the SolidWorks side
comes from the online help. help.solidworks.com builds its pages with JavaScript, and WebFetch only got the page frame,
so the SolidWorks behaviour below comes from search-result extracts of the pages cited and from the standard
PropertyManager layout. Treat each "SolidWorks" paragraph as "check against the page before building". The app side
comes from reading the code. The running app was not used.

## Summary

| Tool | Verdict | P1 | P2 | P3 |
|---|---|---|---|---|
| Extruded boss / cut | incomplete | 0 | 7 | 6 |
| Revolved boss / cut | incomplete | 2 | 4 | 2 |
| Swept boss / cut | broken (from the UI) | 2 | 4 | 2 |
| Lofted boss / cut | incomplete | 0 | 3 | 4 |
| Boundary boss / cut | missing | 0 | 0 | 1 |
| Rib | missing | 0 | 1 | 0 |
| Hole (Hole Wizard) | incomplete | 0 | 6 | 4 |
| Cut pocket (app-only tool) | differs | 0 | 0 | 2 |
| Thread / cosmetic thread | incomplete | 1 | 3 | 3 |
| Reference plane | incomplete (no UI) | 2 | 2 | 1 |
| Reference axis | incomplete (no UI) | 1 | 2 | 0 |
| Reference point | incomplete (no UI) | 0 | 0 | 2 |
| Coordinate system | missing | 0 | 0 | 1 |
| Curves (helix, projected, composite, through points, split line) | missing (helix only inside sweep) | 0 | 2 | 2 |
| Cross-cutting (sketch regions, build, edit flow) | differs | 0 | 3 | 2 |

---

## Extruded boss / cut

**SolidWorks** ([Extrude PropertyManager](https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_extrude_propertymanager.htm),
[End condition](https://help.solidworks.com/2022/english/SolidWorks/sldworks/c_end_condition_extrude.htm)):
- **From:** Sketch plane, Surface/Face/Plane, Vertex, or Offset, with a reverse option.
- **Direction 1:**
  - End conditions: Blind, Through All, Through All-Both, Up To Next, Up To Vertex, Up To Surface, Offset From Surface (with translate surface), Up To Body, Mid Plane.
  - Reverse direction, plus an optional direction vector (extrude along an edge or axis instead of the normal).
  - Draft on/off with Draft outward.
  - Flip side to cut (cuts only).
  - Merge result (boss) and Feature scope.
- **Direction 2:** the same end conditions and draft as Direction 1.
- **Thin Feature:** one-direction, mid-plane or two-direction thickness, Cap ends, and Auto-fillet corners for open contours.
- **Selected Contours:** pick contours or regions of the sketch.

The preview shows the result; editing reopens every option. Editing the sketch updates the feature.

**App**
- Data model: `packages/core/src/index.ts:306-309`. End conditions are only `blind | throughAll | upToNext` (`index.ts:166`).
- Kernel:
  - `apps/server/src/cad/build.ts:1086-1106`: plain extrudes.
  - `apps/server/src/cad/sketch.ts:661-713` (`extrudeTool`): the From offset, draft, flip side, Up to next and Direction 2.
  - `sketch.ts:384-393`: selected regions.
- Two forms:
  - The sketch finish panel, `apps/web/src/toolDefs.tsx:699-857`.
  - Extrude/Cut on an existing sketch step, `sketchOpTool` at `toolDefs.tsx:874-966`.
  - Both share `extrudeFields`, `extrudeOptions`, `extrudeExtras` and `extrudeResets` at `toolDefs.tsx:508-604`.
- Selected contours: `PropertyManager.tsx:108-148` and `regionPick.ts`.
- Through All-Both is Mid plane plus Through all, or Through all in both directions.
- Edits round-trip: `extrudeValues` and `finishDefaults` in `sketcher.ts:1545-1549`.
- Tests: `sketch.test.ts:442-495` and `411-440`.

**Gaps**
- P2 · L · No Up To Vertex, Up To Surface, Offset From Surface or Up To Body (`index.ts:166`, `sketch.ts:511`, `toolDefs.tsx:533`) → add them as end conditions with a face, vertex or body pick, for both directions.
- P2 · M · From offers only Sketch plane and Offset (`toolDefs.tsx:542`, `index.ts:308`, where `from` is a number) → add Surface/Face/Plane and Vertex starts.
- P2 · L · No Thin Feature (`index.ts:306-309`; open contours are dropped by `sketchRegions.ts:24-27`) → thin extrude with one-direction, mid-plane or two-direction thickness, Cap ends, and extrude of open contours.
- P2 · M · The finish-panel preview, which is the main SolidWorks workflow, is drawn on the client from distance and direction only (`SketchLayer.tsx:138-147`, and `finishTool` has no `preview: true`). It ignores the end condition (Through all and Up to next still show a box of the hidden distance), From offset, draft, Direction 2 and flip side, and it draws a box even for a cut → use the server preview, as `sketchOpTool` does (`toolDefs.tsx:885`).
- P2 · M · "New body" in Result makes a separate part, not a second body in the same part (`toolDefs.tsx:827-853`). There is no Merge result checkbox and no Feature scope → multibody parts, or at least rename the option and say so.
- P2 · S · Region picks are stored as (u, v) points (`regionPick.ts:1-2`). After a sketch edit a pick can land in a different region and the feature silently uses it. Only when it lands in none is there an error (`sketch.ts:389-391`) → store a region identity based on the curve ids around it, or flag the feature when the region under the pick changes.
- P2 · S · When a sketch has both closed and open curves, the open curves are silently ignored by every feature (`toolDefs.tsx:779-782` only errors when there is no closed profile at all) → warn, as SolidWorks does for open contours.
- P3 · M · No direction vector: the extrusion always runs along the sketch normal (`sketch.ts:427`).
- P3 · S · Cut defaults to Through all (`toolDefs.tsx:908`). SolidWorks defaults to Blind.
- P3 · S · The in-view depth arrow is shown when End is Up to next, or Through all on a boss (only a cut with Through all hides it). It ignores the From offset and has no Direction 2 arrow (`toolHandles.ts:140-152, 208-229`). This file was being changed by someone else during the audit.
- P3 · S · On Edit, the boss form lets the result be switched between Join and Cut (`toolDefs.tsx:897-898`). SolidWorks keeps boss and cut as separate features. Harmless, but different.
- P3 · S · Draft works only on planar and cylindrical walls (`sketch.ts:578-607`). Splines are not an issue yet because the sketcher has none, but the error says the walls "would meet" even when the real cause is an unsupported face type.
- P3 · M · Missing tests: Up to next combined with Direction 2, Up to next with draft, flip side with Direction 2, regions with options (`extrudeTool` with regions), and Through all in reverse.

## Revolved boss / cut

**SolidWorks** ([Revolve PropertyManager](https://help.solidworks.com/2024/english/SolidWorks/Sldworks/HIDD_DVE_FEAT_REV.htm)):
- **Axis of revolution:** a centreline, line or edge, chosen when the sketch has several.
- **Direction 1 types:** Blind (angle), Up To Vertex, Up To Surface, Offset From Surface, Mid-Plane, plus reverse.
- **Other options:** Direction 2, Thin Feature (one-direction or mid-plane thickness), Selected Contours, and Merge result / Feature scope.

**App**
- Data model: `index.ts:311` stores `axis: 'u' | 'v'` (the sketch's own axes through the sketch origin) and `angle`.
- Kernel: `sketch.ts:435-455`, used from `build.ts:1107-1111`.
- Forms:
  - The finish panel (`toolDefs.tsx:728-730`) and `sketchOpTool` (`toolDefs.tsx:894-898`).
  - Axis is a select of "Sketch V" and "Sketch U". A sketch centreline exists (`sketchToolDefs.tsx:61-67`, hint "to mirror or revolve about") but nothing can use it as the axis.

**Gaps**
- P1 · M · The axis can only be the sketch's u or v axis through its origin (`index.ts:311`, `sketch.ts:440-453`). A centreline, a model edge, or a construction axis step (`AxisRef` exists for patterns) cannot be used, so a profile must be drawn around the origin. The centreline tool's hint promises revolving about it → accept a sketch construction line id or an `AxisRef`, and pick it in the view.
- P1 · S · Editing a revolve that uses a sketch step cannot set the angle back to 360°. `sketchOpFeature` leaves `angle` out when it is 360 (`toolDefs.tsx:659`), and `features_update` merges fields (`tools.ts:761`), so the old angle stays. Repro: revolve 180°, Edit feature, type 360, OK → still 180° → always send `angle`, or send it as null to clear it.
- P2 · M · No end conditions besides an angle (no Mid-Plane, Up To Vertex or Up To Surface), no Direction 2, and no reverse in the UI. The form only takes a positive angle (`toolDefs.tsx:950`, while the kernel accepts a negative one at `sketch.ts:443`).
- P2 · L · No Thin Feature, and no revolve of open profiles.
- P2 · M · The finish-panel preview is a client-side lathe of the first picked region's outer outline only (`SketchLayer.tsx:148-152`). It drops holes and other regions, and mirrors negative coordinates with `Math.abs` → use the server preview.
- P2 · S · A profile that crosses the axis gets an error (`sketch.ts:450-452`), which matches SolidWorks. But the message names "u"/"v" rather than the axis the user sees → name it "Sketch U (horizontal) axis".
- P3 · S · No tests for revolve with picked regions or with a partial or negative angle on a cut.
- P3 · S · The finish panel offers Join/Cut for an edited revolve but not New body (`toolDefs.tsx:721-723`). Minor inconsistency.

## Swept boss / cut

**SolidWorks** ([Sweep PropertyManager](https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_SWEEP.htm), not fetched):
- Profile and path, or a Circular profile with a diameter on a path.
- Profile orientation: follow path or keep normal constant. Profile twist: none, specify twist value, specify direction vector, or tangent to adjacent faces.
- Guide curves (with merge smooth faces), start and end tangency, Thin Feature, and Merge result.

**App**
- Data model: `index.ts:334`. The kernel is `build.ts:1034-1060`, with path wires from `sketch.ts:742-765`. The schema is at `tools.ts:315-334`.
- There is no toolbar tool. `editorFor` (`toolDefs.tsx:2021-2039`) finds no tool for `sweep`, so Edit shows `noEditTool` ("ask Jarvis"). Only Jarvis can create a sweep.

**Gaps**
- P1 · M · No Sweep tool in the toolbar, and no editor (`toolDefs.tsx:1498-1510`, `2031-2036`) → add a Sweep PropertyManager with profile and path selection boxes.
- P1 · M · A path drawn in the sketcher can never be used. The sketcher saves only closed loops as `profiles` and counts open chains without saving them (`sketchRegions.ts:24-27`, `sketcher.ts:1513-1528`). `pathWire` needs exactly one profile (`sketch.ts:734-739`), so a sketched open path fails with "path sketch needs exactly one profile (got 0)" → save open chains in the sketch, for example as `paths`, and let a sweep pick one.
- P2 · M · Twist is only allowed along a single straight line, and not along a helix (`build.ts:1039-1049`). There is no orientation option (follow path or keep normal) and no twist along a general path.
- P2 · L · No guide curves, no start/end tangency, and no Thin Feature.
- P2 · S · No Circular profile option: the profile always has to be a sketch (`index.ts:334`).
- P2 · S · A profile with holes (a tube cross-section) is refused: `profileWire` needs a single profile (`sketch.ts:742-743`).
- P3 · S · No check that the profile sits at the start of the path. Misplaced profiles sweep from wherever they are (`build.ts:1052`).
- P3 · S · The helix is part of the sweep instead of a curve feature (see Curves).

## Lofted boss / cut

**SolidWorks** ([Loft PropertyManager](https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_LOFT.htm), not fetched):
- Profiles: sketches, faces, or points at the ends.
- Start/end constraints: None, Direction vector, Normal to profile, Tangent to face.
- Guide curves, Centerline parameters, and Sketch tools (connectors that control the twist).
- Options: Merge tangent faces, Close loft, Show preview, Thin Feature.

**App**
- Data model: `index.ts:318` (`sections`, `ruled`, `mode`). The kernel is `sketch.ts:716-732`. The form is `toolDefs.tsx:969-1013`.
- It has a live preview (`preview: true`), and editing works when every section is a sketch step (`toolDefs.tsx:2025-2027`).

**Gaps**
- P2 · L · No guide curves and no centreline (`index.ts:318`).
- P2 · M · No start/end constraints (normal to profile, tangent to face, direction vector).
- P2 · M · Each section must be a sketch step with exactly one profile (`toolDefs.tsx:997-1003`, `sketch.ts:721-723`). There are no faces, no points, and no selected contours from a sketch with several regions.
- P3 · S · No Close loft.
- P3 · L · No Thin Feature.
- P3 · M · No connectors or start-point control, so a loft between polygons whose start points differ can twist (`loft(wires, { ruled })` at `sketch.ts:731`).
- P3 · S · A loft whose sections are inline sketches (made by Jarvis) cannot be edited in the UI (`toolDefs.tsx:2026`).

## Boundary boss / cut

**SolidWorks** ([Boundary PropertyManager](https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_BOUNDARY.htm), not fetched): profile curves in two directions, with tangency and influence settings.

**App:** missing (no op in `index.ts:274-355`).

**Gaps**
- P3 · L · Boundary boss and boundary cut are missing. replicad/OpenCascade can fill a surface from boundary curves (`BRepOffsetAPI_MakeFilling`), but that needs new kernel work.

## Rib

**SolidWorks** ([Rib PropertyManager](https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_RIB.htm), not fetched): an open sketch becomes a wall. Options: thickness (one side, both sides or mid), extrusion direction (parallel or normal to the sketch), draft, flip material side, and extend to the body.

**App:** missing.

**Gaps**
- P2 · L · Rib is missing. It depends on open sketch contours being saved (see Sweep) and on a thin-wall extrude up to the body.

## Hole (Hole Wizard)

**SolidWorks** ([Hole Wizard Type PropertyManager](https://help.solidworks.com/2019/English/SolidWorks/sldworks/HIDD_DVE_HW_HOLE_SPEC.htm),
[Hole Wizard overview](https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Hole_Wizard_Overview.htm)):
- **Type tab:**
  - Hole types: counterbore, countersink, hole, straight tap, tapered tap, legacy, and slot variants.
  - Standard (ANSI inch/metric, ISO, DIN, JIS, and others), fastener type, size, and fit (close, normal, loose).
  - Custom sizing.
  - End conditions, which depend on the type: blind, through all, up to next, up to vertex, up to surface, offset from surface.
  - Thread depth and type for tapped holes; options such as near-side, far-side and under-head countersinks; cosmetic thread.
- **Positions tab:** pick a planar or non-planar face, then place centres as sketch points with dimensions, or take every point of an existing 2D sketch.

**App**
- Data model: `index.ts:249-254, 298`. Sizes come from `packages/core/src/fasteners.ts:218-257`; the kernel is `build.ts:810-829, 1078-1085`.
- Form: `toolDefs.tsx:1286-1356`.
  - Type: clearance, tap, heat-set, counterbore, countersink, nut trap, plain.
  - Size M2 to M8; fit normal or close; "Drill from" one of six axis faces; entry point typed as XYZ; Through all or Depth; optional repeat.
- It has a live preview and can be edited.

**Gaps**
- P2 · L · No Positions step. Hole centres cannot be picked on a face or taken from sketch points. One XYZ is typed, and only the built-in repeat makes more → face pick plus placement points (or sketch points), as in the Positions tab. `pickRefs.ts` looks like the start of this work but is not used yet.
- P2 · S · The default entry point is wrong for sketch-built parts. `half()` uses `shapeHalfExtents(part.shape)` (`toolDefs.tsx:161-163`), which is [0,0,0] for an `empty` part and ignores all features. So defaults and "Drill from" put the hole at the origin (`toolDefs.tsx:1307-1309, 1323-1326`) → use the built mesh bounds, or better, a picked face.
- P2 · S · Editing loses a drilling direction that is not one of the six axes. `faceOf` falls back to "top" (`toolDefs.tsx:1214-1217`) and OK writes `direction` from the face (`toolDefs.tsx:1351`). Holes Jarvis made at an angle are silently re-aimed.
- P2 · S · Heat-set holes: "Through all" is ticked by default but is wrong, because without `depth` the kernel uses the insert depth (`build.ts:1081`, `fasteners.ts:232-235`). Editing shows Through all ticked again (`toolDefs.tsx:1316`) → show the insert depth as Blind, and only send through when it is really through.
- P2 · M · End conditions are only Through all and Blind (flat-bottomed, with no drill-point angle). Up to next, Up to surface and Offset from surface are missing.
- P2 · M · Sizes are ISO metric M2–M8 only, fits are close and normal only (no loose), there is no inch standard, and no tapered tap or slot types (`index.ts:214`, `fasteners.ts`).
- P3 · S · Counterbores are always sized for a socket cap and countersinks always 90° (`fasteners.ts:236-246`). No custom sizing, and no near-side or far-side countersink.
- P3 · S · A "Plain" hole silently adds the print hole tolerance to the typed diameter (`fasteners.ts:220-222`). The form does not say so.
- P3 · M · Tapped holes have no thread depth or cosmetic thread. They are only a tap-drill cylinder.
- P3 · S · No tests for editing a hole (round trip of `direction` and the heat-set depth).

## Cut pocket (app-only)

**SolidWorks:** there is no such tool. Its job is done by an extruded cut from a sketch.

**App:** `toolDefs.tsx:1357-1420` stores an `op: 'cut'` box or cylinder with its top at a typed point, always cutting down along −Y. A cut with any other shape opens `noEditTool` (`toolDefs.tsx:2033-2035`).

**Gaps**
- P3 · S · It only works top-down along Y, and its defaults use `half()`, so they are wrong for sketch-built parts. Consider retiring it in favour of Cut from a sketch.
- P3 · S · Edit ignores a stored `rotation`, so the typed "top centre" is wrong for a rotated cut (`toolDefs.tsx:1382-1393`).

## Thread / cosmetic thread

**SolidWorks** ([Thread PropertyManager](https://help.solidworks.com/2019/English/SolidWorks/sldworks/r_thread_propertymanager.htm),
[Cosmetic Threads](https://help.solidworks.com/2022/English/SolidWorks/Sldworks/HIDD_DVE_CTHREAD.htm)):
- Thread: pick the circular edge of a shaft or hole, with an optional start face and an offset with reverse.
- End conditions: Blind, Revolutions, Up to selection, with Maintain thread length.
- Profile type (metric/inch die or tap), size, diameter and pitch overrides, cut or extrude method, mirror or rotate the profile, right/left hand, multiple starts, and trim to the start/end face.
- Cosmetic thread: a light-weight annotation on a cylinder, with a standard, size, end condition and thread callout.

**App**
- Data model: `index.ts:354` (kind, diameter, pitch, length, position). The kernel is `build.ts:840-866`. The form is `toolDefs.tsx:1449-1495`.
- It has a preview and can be edited.

**Gaps**
- P1 · M · The thread axis is always the part's +Y from `position` (`build.ts:845-865` uses `cylinderY`). A thread on a horizontal or tilted shaft or hole is impossible. Nothing ties it to a picked edge, and an external thread fuses a threaded rod into empty space if there is no boss (`build.ts:854-857`) → pick the circular edge to get the axis, diameter and start, and check the thread lies on the cylinder.
- P2 · S · No hand (left-hand) and no multiple starts, although the helix code already supports left-handed helices (`build.ts:1021`).
- P2 · M · The only end condition is a length. There is no Revolutions or Up to selection, no offset from the start face, and no trim to faces.
- P2 · M · No cosmetic thread anywhere, neither for Hole Wizard tapped holes nor for shafts.
- P3 · S · Edit always shows Preset "Custom" (`toolDefs.tsx:1469`), even for a standard size.
- P3 · S · An internal thread bores the hole out to major diameter + tolerance, whatever the hole was (`build.ts:859-865`). This is not explained in the form.
- P3 · S · The default start is `[0, -hy, 0]` from `half()`, which is the origin for sketch-built parts (`toolDefs.tsx:1472-1473`).

## Reference plane

**SolidWorks** ([Plane PropertyManager](https://help.solidworks.com/2017/English/SolidWorks/Sldworks/HIDD_DVE_CREATE_PLANE.htm)):
- Up to three references (faces, planes, edges, axes, points, curves), each with constraints:
  - parallel, perpendicular, coincident, at angle, offset distance (with flip and a number of planes);
  - mid plane, tangent, projection, and normal to curve (with origin on the curve).
- The plane is shown in the view, can be picked as a sketch plane, and follows its references when the model changes.

**App**
- Data model: `index.ts:50-57`. Definitions are offset, angle (about u, v or an axis), threePoints, pointNormal, midplane. The resolver is `packages/core/src/reference.ts:68-117`; the schema is `tools.ts:294-304`; tests are `reference.test.ts` and `advanced.test.ts:83-114`.
- Editing a plane step changes every sketch on it, because sketches resolve `planeRef` at build time (`build.ts:938-944`).

**Gaps**
- P1 · M · There is no Plane tool in the toolbar and no editor: `editorFor` gives `noEditTool` (`toolDefs.tsx:2031-2036`). Only Jarvis can make or change a plane step.
- P1 · M · Plane steps are not drawn in the 3D view; nothing in `apps/web/src` renders `op: 'plane'`. The sketch-plane picker offers only Top, Front, Right or a face (`toolDefs.tsx:427-463`), so a plane step cannot be chosen for a new sketch. A tilted sketch plane there is stored inline in the sketch, not as a plane step.
- P2 · L · Planes are defined by numbers, not by picked geometry. Three points and point/normal are fixed coordinates (`index.ts:54-56`), so they do not follow the model. "Tangent at point" is stored as pointNormal → reference faces, edges and vertices with the picks in `apps/server/src/cad/refs.ts`.
- P2 · M · Missing definitions: normal to a curve at a point, parallel to a plane through a point, tangent to a cylinder, projected, and several offset planes at once.
- P3 · S · No flip for offset or angle planes in the form. A negative number works through Jarvis.

## Reference axis

**SolidWorks** (Axis PropertyManager, `https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CREATE_AXIS.htm`, not fetched): one line, edge or axis; two planes; two points or vertices; a cylindrical or conical face; a point and a face or plane. Temporary axes can be shown.

**App:** `index.ts:59-62` has twoPoints, pointDirection and planeIntersection. The resolver is `reference.ts:130-161`. Patterns and helices use axes; revolve does not.

**Gaps**
- P1 · M · No Axis tool, no editor and no display, as for planes. Revolve cannot use an axis (see Revolve).
- P2 · M · No axis from a cylindrical or conical face, which is the most common case, and none from an edge or from a point plus a face.
- P2 · S · No temporary axes.

## Reference point

**SolidWorks** (Point PropertyManager, not fetched): arc centre, face centre, intersection, projection, on a vertex, along a curve (distance, percentage or evenly spaced, with a count).

**App:** `index.ts:329` is absolute coordinates only. Nothing refers to a point step: there is no `pointRef` anywhere.

**Gaps**
- P3 · M · No Point tool, no display, and point steps are not usable by anything.
- P3 · M · There is only "at XYZ". The face/arc centre, intersection, projection and along-curve options are missing.

## Coordinate system

**SolidWorks** (Coordinate System PropertyManager, not fetched): an origin plus axis directions from picks, used for mass properties, measure and export.

**App:** missing.

**Gaps**
- P3 · M · Coordinate system is missing. Mass properties in `evaluateToolDefs.tsx` cannot report relative to one.

## Curves

**SolidWorks** (Helix and Spiral, Projected curve, Composite curve, Curve through XYZ points, Curve through reference points, Split line): help pages not fetched.

**App:** a helix exists only inside a sweep (`index.ts:65-74`, `build.ts:984-1032`). It has pitch, turns, left-handed and taper. Nothing else exists.

**Gaps**
- P2 · M · There is no standalone Helix/Spiral curve feature. The helix cannot be shown, reused or edited on its own. It lacks height and pitch or height and revolutions definitions, a start angle, variable pitch, and spiral.
- P2 · L · No Split line. It is needed to split faces for draft or partial fillets.
- P3 · L · No Projected curve and no Composite curve.
- P3 · M · No curve through XYZ points or through reference points. The kernel already has splines via scripts.

## Cross-cutting: sketch regions, build and the edit flow

**Gaps**
- P2 · M · One failing feature stops the build of everything after it (`build.ts:1356-1361`, `buildPartial` returns). SolidWorks rebuilds the features that do not depend on the failed one and marks only the failed one and its children.
- P2 · S · Suppressing a sketch step does not suppress the features built from it (`build.ts:1342-1351`). SolidWorks suppresses the children with the parent.
- P2 · S · Editing in a form (Extrude/Cut/Revolve on a sketch step, Loft, Hole, Thread) does not roll the model back to the feature. Only editing through the sketch does (`Toolbar.tsx:285-299, 590-597`). The two edit paths behave differently.
- P3 · S · Overlapping closed profiles with no regions picked fail with "profile 0 … and profile 1 … overlap" (`sketch.ts:325-333`) → say "pick the areas to use (Selected contours)".
- P3 · S · Sketches written as profiles only (by Jarvis) have no `regions`, so their picks fall back to the whole sketch. The UI shows such picks as "Area<n>" rows that do nothing (`sketch.ts:385-387`, `PropertyManager.tsx:124-129`).

## Top 10 for this area

1. Revolve about a sketch centreline or an axis step, not only the sketch u/v axes (P1 · M).
2. Revolve edit cannot go back to 360° (P1 · S): always send `angle`.
3. Plane tool (offset, angle, mid plane, through picked points or faces), plane steps drawn in the view, and plane steps choosable as sketch planes (P1 · M ×2).
4. Save open sketch chains so they can be sweep paths and thin, rib or guide sources (P1 · M).
5. Sweep tool and editor in the toolbar (P1 · M).
6. Thread on a picked circular edge, at any axis direction (P1 · M).
7. Axis tool, including an axis from a cylindrical face, with display (P1 · M).
8. Server-side preview for the sketch finish panel, for extrude and revolve (P2 · M).
9. Up To Surface / Offset From Surface / Up To Vertex end conditions, and a From face/vertex (P2 · L).
10. Hole fixes: Positions from face picks or sketch points, correct default entry for sketch-built parts, direction kept on edit, heat-set depth label (P2 · S–L).

## Not checked

- None of the SolidWorks help pages could be read in full, because help.solidworks.com renders with JavaScript. The SolidWorks side above comes from search extracts plus the standard PropertyManager layout; check each against the page before implementing.
- Nothing was run in the app. The revolve 360° bug, the hole direction loss and the unusable sketched sweep path are confirmed by reading the code only.
- Kernel quality was not checked: how well the drafted Up-to-next result or the flip-side slab handles very large models, sweep self-intersection checks, or loft twisting.
- Feature-tree display of these features (icons, nesting) was not checked, and neither was undo and redo of edits.
- `toolHandles.ts`, `Manipulators.tsx` and `pickRefs.ts` were changing while this audit was written. The handle findings may already be out of date.
