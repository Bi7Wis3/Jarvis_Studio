# Audit: applied features, patterns, bodies, primitives and materials

Audited 2026-11-13 against the code on disk. `docs/SOLIDWORKS_REFERENCE.md` did not exist at the start or at the end
of this audit, so the SolidWorks side comes from the online help pages cited per tool. Where no help page was
opened, the section says "help page not opened (Not verified)".

Overall: the kernel (`apps/server/src/cad/build.ts`, `refs.ts`, `applied.ts`) is well ahead of the UI. Picked edges and
faces, variable radius, two-distance and distance-angle chamfers, outward shell, picked-face draft, feature patterns,
combine and split all build and have tests. But none of these can be reached from a form: the toolbar forms still
offer only the older "edge group" and "face direction" selectors, and draft, split, combine and feature pattern
have no tool or editor at all. Faces and edges can be clicked in the view, but today those clicks feed only the
Measure readout.

## Summary

| Tool | Verdict | P1 | P2 | P3 |
|---|---|---|---|---|
| Picking in the view (cross-cutting) | incomplete | 1 | 3 | 1 |
| Fillet | incomplete | 2 | 5 | 4 |
| Chamfer | incomplete | 1 | 4 | 2 |
| Shell | incomplete | 1 | 2 | 2 |
| Draft | incomplete | 1 | 3 | 2 |
| Mirror (feature) | differs | 0 | 4 | 2 |
| Linear / circular pattern of features | incomplete | 1 | 4 | 3 |
| Toolbar "Pattern" (whole-part repeat) | differs | 0 | 2 | 1 |
| Curve, sketch, table, fill, variable patterns | missing | 0 | 1 | 1 |
| Combine | differs | 0 | 2 | 1 |
| Split | incomplete | 0 | 2 | 1 |
| Move/Copy, Duplicate, Mirror copy (bodies) | broken | 1 | 1 | 1 |
| Scale, Delete/Keep body, Intersect, Dome, Wrap, Indent | missing | 0 | 1 | 5 |
| Primitives (box, cylinder, sphere, cone, torus, tube) | differs | 0 | 3 | 2 |
| Pocket and boss (`cut` / `add` of a shape) | differs | 0 | 2 | 1 |
| Hole (vs Hole Wizard) | differs | 0 | 3 | 1 |
| Thread | incomplete | 0 | 2 | 1 |
| Fasteners (vs Toolbox) | differs | 0 | 2 | 2 |
| Material and appearance | differs | 0 | 3 | 2 |

Verdict counts: matches 0, differs 9, incomplete 9, broken 1 (19 rows; the "missing" rows count as incomplete).

---

## Picking in the view (cross-cutting)

**SolidWorks.** A feature's PropertyManager has selection boxes; while a box is active, a plain click in the view adds
the edge, face, loop, vertex, plane or feature to that box, and a second click removes it. No Shift/Ctrl is needed.
Entities picked before starting the command are put into the first box. Fillet and chamfer also show a selection
toolbar (connected to start loop, tangent faces and so on). Source:
https://help.solidworks.com/2022/english/solidworks/sldworks/r_constant_size_fillets.htm

**App.**
- Faces and edges of the active part can be clicked only in the part workspace, in select mode, when the kernel
  mesh is there (`apps/web/src/Scene.tsx:390`). A click picks the edge within `EDGE_PICK_PX`, else the face under it
  (`Scene.tsx:225-244`, `489-497`). A plain click replaces the list; Shift toggles (`apps/web/src/picking.ts:172`).
  There is no vertex picking, no plane picking from the tree, and no loop, feature or body picking.
- Picks are mesh ordinals in `useStudio.picked` (`apps/web/src/state.ts:312-330`). They are dropped whenever the part's
  mesh key changes.
- Picks are read only by the HUD and the Measure tool (`apps/web/src/Hud.tsx:23-47`,
  `apps/web/src/evaluateToolDefs.tsx:252`). No feature form reads them.
- `apps/web/src/pickRefs.ts` has everything needed to turn a picked ordinal into the stored kernel reference
  (`edgePick`, `facePick`) and back (`edgeOfPick`, `faceOfPick`), plus `positionFromPick` for holes. It is imported
  only by its own test (`pickRefs.test.ts`). Nothing in the app uses it.
- On the server, `refs.ts` resolves `at` / `faces` / `remove` / `picked` / `neutralFace`, and `build.ts` uses them
  (`build.ts:869-907`, `1240-1253`). `resolveVertex` (`refs.ts:274`), `filletFaces` and `chamferFaces`
  (`applied.ts:133`, `209`) are not called anywhere.

**Gaps**
- P1 · L · No feature form has a selection box. Edges and faces that the user clicks are ignored by Fillet,
  Chamfer, Shell and Draft, even though the kernel takes them (`toolDefs.tsx:1220-1285`) → add PropertyManager
  selection lists. They should fill from `useStudio.picked` through `pickRefs.edgePick` / `facePick`, show a row per
  item with remove, and save `at` / `faces` / `remove` / `picked`.
- P2 · M · Picks are dropped whenever the part's mesh key changes (`state.ts:324-330`). A live preview, or editing an
  earlier step, changes the mesh, so a list of mesh ordinals cannot survive while a form is open → convert to stored
  `{at, normal}` refs as soon as an item is picked. Keep the form's list in those refs and map them back with
  `edgeOfPick` / `faceOfPick` for highlighting.
- P2 · S · A plain click replaces the selection and Shift is needed to add (`picking.ts:172-179`). In a SolidWorks
  selection box a plain click adds or removes → in an active selection box, use a plain click to toggle.
- P2 · M · No preselection: nothing picked before opening Fillet or Chamfer is carried into the form → seed the
  first selection box from the current picks.
- P3 · M · No vertex, loop or feature picking. Vertex chamfer and "fillet a feature's edges" need them (`resolveVertex`
  exists, unused, at `refs.ts:274`).

---

## Fillet

**SolidWorks.** Fillet types are Constant size, Variable size, Face fillet and Full round. Items to fillet are edges,
faces, features and loops, picked in the view. Tangent propagation is on by default. Other options: full preview;
Multiple radius fillet (a different radius per edge); a symmetric or asymmetric (two distances) cross section;
profiles Circular, Conic Rho, Conic Radius and Curvature continuous; Setback for corners; Overflow type (default, keep
edge, keep surface); Keep features; Round corners. Variable size sets a radius at each vertex and at points along the
edge, with smooth or straight transition. FilletXpert can add and change fillets.
Sources: https://help.solidworks.com/2022/english/solidworks/sldworks/r_constant_size_fillets.htm ,
https://help.solidworks.com/2016/english/solidworks/sldworks/hidd_dve_fillet_dlg2.htm ,
https://help.solidworks.com/2015/English/SOLIDWORKS/sldworks/c_Example_Tangent_Propagation.htm ,
https://help.solidworks.com/2015/english/SolidWorks/sldworks/r_Face_Fillets.htm

**App.**
- Form: Radius, plus an "Edges" select of all / top / bottom / vertical / horizontal. New fillets default to 2 mm
  on vertical edges (`apps/web/src/toolDefs.tsx:1220-1239`).
- Data: `radius`, `edges`, `at`, `faces`, `tangent`, `radius2` (`packages/core/src/index.ts:280`, schema at
  `apps/server/src/tools.ts:205-212`).
- Kernel: when there are picks, `filletEdges` gets the picked edges plus every edge of each picked face. Tangent
  propagation follows chains of edges, or smoothly joined faces. `radius2` makes the radius change linearly along
  each edge (`build.ts:880-887`, `869-875`, `applied.ts:93-131`). Without picks, the edge group goes through
  `roundEdges` (`build.ts:215-226`, `193-213`).
- Edit: through the same form (`toolDefs.tsx:2032`). `features_update` merges fields
  (`apps/server/src/tools.ts:761`).
- Tests: picked edges and volume (`apps/server/src/cad/sketch.test.ts:502-511`), applied.ts unit tests
  (`apps/server/src/cad/applied.test.ts:29-60`), group fillet (`kernel.test.ts:238`).

**Gaps**
- P1 · M · The form cannot pick edges or faces in the view, so a user cannot fillet one chosen edge, which is the
  basic job of the tool. The only choices are geometric groups such as "top edges" (edges at the part's highest Y)
  (`toolDefs.tsx:1227-1230`) → add an "Items to fillet" selection list that saves `at` / `faces`. Keep the groups only
  as a shortcut, if at all.
- P1 · S · Editing a fillet that has picks (for example one made by Jarvis) shows the "Edges" group and saves
  `edges`, but the merge keeps `at` / `faces` and picks win in the kernel. So changing the group silently does
  nothing, and there is no way to clear the picks (`toolDefs.tsx:1231-1237`, `tools.ts:761`, `build.ts:884`) → show
  the picked items in the form and save the whole selection.
- P2 · S · Tangent propagation is off unless `tangent: true` is sent, and the form has no checkbox
  (`build.ts:871`). SolidWorks has it on by default → add the checkbox, defaulting to on for new fillets.
- P2 · S · `radius2` is ignored without error when the fillet uses an edge group (`build.ts:887` uses only
  `f.radius`) → apply it, or reject the combination in the schema.
- P2 · M · The variable-size direction is arbitrary. `FilletSpec.from` (`applied.ts:22`, `105-112`) is never set by
  `build.ts:885`, so which end gets `radius` depends on how OpenCascade orients each edge. On a chain, every edge
  starts again at r1 → store per-vertex radii (SolidWorks style) or a start point, and expose this as a
  "Variable size" fillet type in the form.
- P2 · M · No Multiple radius fillet: one radius for all items → per-item radius in the selection list.
- P2 · S · The tree summary always shows the edge group, for example "r 2 · all edges", even when the fillet uses
  picked edges or radius2 (`apps/web/src/historyText.ts:265-266`) → summarize picks ("3 edges, 1 face") and the
  variable radius.
- P3 · L · No Face fillet, no Full round, no asymmetric section, no conic or curvature-continuous profile, no setback,
  no overflow control. `applied.ts:4-8` says OpenCascade gives a circular section only, so profiles, setback and
  overflow are a kernel limit. Face fillet and full round need face-set selection and new kernel code
  (`BRepFilletAPI_MakeFillet` cannot do full round directly) → list them in FEATURE_OPTIONS as not possible / later.
- P3 · S · No Keep features, and no Features or Loops selection (see Picking).
- P3 · S · The edge groups (`EDGES`, `toolDefs.tsx:1155`) are not a SolidWorks concept, and "top" means the part's
  highest Y only → drop them from the form once picking exists (keep them for Jarvis).
- P3 · S · No test that tangent propagation from one edge rounds the whole chain inside a fillet feature (`refs.test.ts:39` tests
  only the resolver), and no test for faces combined with tangent.

---

## Chamfer

**SolidWorks.** Chamfer types are Angle distance, Distance distance (symmetric or asymmetric), Vertex (three
distances at a corner), Offset face and Face face. Items are edges, faces, features, loops and vertices. Options:
Flip direction, tangent propagation, full/partial/no preview, Keep features, and a Multi distance chamfer for offset
face. Source: https://help.solidworks.com/2023/English/SolidWorks/sldworks/r_chamfer_pm.htm (also
https://help.solidworks.com/2021/English/SolidWorks/sldworks/r_chamfer_pm.htm)

**App.**
- Form: Size and Edges group; defaults 1 mm on top edges (`toolDefs.tsx:1240-1259`).
- Data: `size`, `edges`, `at`, `faces`, `tangent`, `distance2`, `angle`, `side` (a normal vector choosing the face
  that `size` is measured on) (`index.ts:285-288`, `tools.ts:213-222`).
- Kernel: `build.ts:888-900`. `chamferEdges` / `chamferReferenceFace` in `applied.ts:143-207`. Without `side`, the
  reference face is "the first face in the shape's face order" (`applied.ts:148-149`).
- Tests: `applied.test.ts:62-80`, `sketch.test.ts:507-508`, `kernel.test.ts:248`.

**Gaps**
- P1 · M · As for Fillet, no selection list: no picking in the view (`toolDefs.tsx:1247-1250`) → add one.
- P2 · S · The form offers only equal distance. Distance-distance and angle-distance exist in the kernel but cannot
  be chosen → add a "Chamfer type" select with the second distance or the angle.
- P2 · S · No Flip direction. Without `side`, which face gets d1 or the angle is arbitrary (`applied.ts:148-149`).
  `side` is a raw vector no user can type → add a Flip checkbox. For each edge, store the side as the normal of the
  face it is measured on (computed when picked).
- P2 · S · Editing a chamfer made by Jarvis with `angle` or `distance2` shows only "Size". On save the angle stays
  (merge), so the field label is misleading and the type cannot be changed back (`toolDefs.tsx:1251-1257`,
  `tools.ts:761`) → load and save the full type.
- P2 · S · The tree summary ignores picks, distance2 and angle (`historyText.ts:267-268`).
- P3 · M · No Vertex chamfer (resolveVertex is ready, `refs.ts:274`), and no Offset face or Face face types
  (need kernel work).
- P3 · S · No Keep features. The tangent option exists but has no checkbox.

---

## Shell

**SolidWorks.** Parameters: thickness, Faces to remove (picked in the view), Shell outward, Show preview. Multi-thickness
settings give chosen faces their own thickness. With no face removed, the result is a closed hollow part. Help page
not opened (Not verified).

**App.**
- Form: Wall thickness and "Open faces" as a multi-select of six directions; default 2 mm open at the top
  (`toolDefs.tsx:1260-1285`).
- Kernel: an `open` direction removes the outermost flat face(s) facing that way (`build.ts:745-766`). `remove` picks
  and `outward` use `shellFaces` (`build.ts:901-907`, `applied.ts:232-273`). With no faces, it is a closed hollow body.
- Tests: `kernel.test.ts:224-237`, `applied.test.ts:82-101`, `sketch.test.ts:513-515`.

**Gaps**
- P1 · M · Faces to remove cannot be picked; only "outermost face facing +Y" style choices are offered
  (`toolDefs.tsx:1269`). On a stepped or angled part, the face the user means often cannot be chosen → add a "Faces to
  remove" selection list that saves `remove`.
- P2 · S · No "Shell outward" checkbox, although the kernel supports it (`build.ts:903`) → add it.
- P2 · S · Editing a shell with `remove` / `outward` keeps them silently (merge), and the summary shows only
  "open top" or "closed" (`historyText.ts:269-270`).
- P3 · L · No multi-thickness. `applied.ts:11-12` notes it needs `BRepOffset_MakeOffset` with per-face offsets, which
  is not wrapped.
- P3 · S · There are two code paths with different error texts (`build.ts:768-800` vs `applied.ts:232-273`) → route
  everything through `shellFaces`.

---

## Draft

**SolidWorks.** Draft types are Neutral plane, Parting line and Step draft. The user sets an angle, picks the neutral
plane (a plane or flat face) and the faces to draft, and can reverse the direction. Face propagation can be none,
along tangent, all faces, inner faces or outer faces. DraftXpert is also available. Help page not opened (Not verified).

**App.**
- No toolbar tool and no editor: `draft` is not in `featureTools`, so `editorFor` returns `noEditTool`
  (`toolDefs.tsx:2031-2036`). Only Jarvis can add or change a draft.
- Data and kernel: angle, `faces` by direction, `picked`, `tangent`, `neutral` (plane ref) or `neutralFace`, `flip`
  (`index.ts:346-352`, `build.ts:1234-1272`, `applied.ts:282-314`). The angle must be between 0 and 45 degrees.
- Tests: `advanced.test.ts:290-301`, `sketch.test.ts:516-522`, `applied.test.ts:103`.

**Gaps**
- P1 · M · The draft tool is missing from the UI, and an existing draft cannot be edited (`toolDefs.tsx:1498-1510`,
  `2036`) → add a Draft form: angle, neutral plane (plane, or flat face picked in the view), faces to draft (picked),
  tangent propagation and reverse direction.
- P2 · S · The direction is not pinned by any test. Both tests accept the volume going either up or down
  (`advanced.test.ts:297-298` "comes or goes", `sketch.test.ts:522` uses `Math.abs`). So which way a positive angle
  tilts the faces, and what `flip` does, is unverified → assert the sign: the face leans away from the pull direction.
- P2 · M · No face propagation beyond `tangent` (all faces, inner, outer).
- P2 · S · The schema leaves the angle unbounded (`tools.ts:359`), and the limit is enforced only at build time
  (`build.ts:1235`). SolidWorks allows larger angles → decide on the range and validate it in the schema.
- P3 · L · No Parting line or Step draft (need a split line first), and no DraftXpert.
- P3 · S · `faces` direction groups pick only the outermost face per direction (`build.ts:1239`), so all side walls
  of a pocket cannot be drafted without picks.

---

## Mirror (feature)

**SolidWorks.** The user picks the Mirror face/plane (any plane or flat face), then Features to mirror, Faces to
mirror or Bodies to mirror. Options: Merge solids, Knit surfaces, Geometry pattern and Propagate visual properties.
Sources: https://help.solidworks.com/2012/English/SolidWorks/sldworks/Pattern_and_Mirror_Overview.htm ,
https://help.solidworks.com/2024/english/SolidWorks/sldworks/c_pattern_and_mirror_support.htm

**App.**
- Form: Plane select YZ / XY / XZ, Offset, "Keep original (join)" (`toolDefs.tsx:1421-1448`).
- Kernel: mirrors the whole body built so far about a part-frame plane at an offset, and fuses it with the original
  or replaces it (`build.ts:910-919`).
- Tests: `sketch.test.ts:202-228`.

**Gaps**
- P2 · M · Only the three part-frame planes can be used, typed as XY / YZ / XZ. A construction plane step
  (`planeRef`) or a picked flat face cannot be the mirror plane (`index.ts:323`) → take a `PlaneRef` or a picked face,
  as split and draft already do.
- P2 · M · Only "bodies to mirror" exists. Chosen features or faces cannot be mirrored → add "features to mirror"
  (reuse `stepTool` like `pattern` does, with a mirror transform).
- P2 · S · The plane names XY / YZ / XZ do not match the app's own Top / Front / Right plane names used everywhere
  else (`index.ts:28`, `toolDefs.tsx:1430`) → use Front (XY), Right (YZ), Top (XZ).
- P2 · S · If the mirror image does not touch the original, the fuse leaves two solids. Every later fillet, chamfer,
  shell or draft then fails with "needs a single solid" (`build.ts:100-105`, `918`). There is no "Merge solids"
  choice or warning → say so in the form or the error.
- P3 · S · "Keep original" unchecked (the body replaced by its image) is not a SolidWorks Mirror option. It is used
  internally by Mirror copy (`toolDefs.tsx:1653`) → keep it for that, but hide it from the feature form.
- P3 · S · No Geometry pattern or Propagate visual properties options (only matter once features can be mirrored).

---

## Linear pattern and circular pattern of features

**SolidWorks.** Linear: Direction 1 and 2, each from an edge, axis or dimension, with spacing and instances or "up to
reference". Options: Seed only for direction 2, instances to skip (clicked in the view), instances to vary, Features
and Faces or Bodies to pattern, Geometry pattern, Vary sketch, Propagate visual properties, full or partial preview.
Circular: an axis (axis, circular edge, cylindrical face), angle and instances, Equal spacing (total angle) or angle
between instances, Symmetric (2nd direction), and the same skip, body and geometry options. Sources:
https://help.solidworks.com/2026/English/SolidWorks/sldworks/t_Linear_Patterns_Overview.htm ,
https://help.solidworks.com/2017/english/SolidWorks/sldworks/HIDD_LPATTERN.htm . Circular pattern page not opened
(Not verified).

**App.**
- No toolbar tool and no editor for the `pattern` op. The part-workspace "Pattern" button is the whole-part repeat
  (next section). `editorFor` returns `noEditTool` (`toolDefs.tsx:2036`).
- Data: `features[]` (earlier step ids); `linear` with `direction` (x / y / z, axisRef or a vector), `count` and
  `spacing`; `circular` with `axis`, `count` and `angle` (`index.ts:336-337`, `tools.ts:335-345`).
- Kernel: for each patterned step it rebuilds the step's tool (`stepTool`) and adds or cuts translated or rotated
  copies (`build.ts:1131-1174`). A full 360° spreads the copies evenly; a partial angle includes both ends
  (`build.ts:1150-1154`).
- Tests: `advanced.test.ts:180-216`; checkHistory `tools.test.ts:473`.

**Gaps**
- P1 · L · No UI to make or edit a feature pattern. This is the usual way to make bolt circles and rows of holes
  (`toolDefs.tsx:1498-1535`) → add Linear pattern and Circular pattern forms. Direction: an edge or axis picked in the
  view, or a plane normal. Features to pattern: picked in the tree. Then spacing / instances, equal spacing, and a
  reverse direction.
- P2 · M · Only material-making steps can be patterned. Fillet, chamfer, shell, draft, thread, mirror and patterns
  of patterns are rejected (`build.ts:1166-1169`). SolidWorks patterns fillets and chamfers with their parent feature
  → at least allow fillet and chamfer by moving their picks (`at` / `faces`) with each copy.
- P2 · M · No second direction, and no Symmetric option for circular patterns.
- P2 · S · Circular has only "equal spacing over a total angle". An angle between instances cannot be given
  (`build.ts:1150-1153`) → add the Equal spacing checkbox meaning.
- P2 · M · No instances to skip.
- P3 · M · Copies are always the seed's tool moved (in effect a geometry pattern). End conditions such as up-to-next
  are not solved again per copy, and the tool is rebuilt against the body at the pattern step, not at the seed step
  (`build.ts:1166`, `stepTool(body, ...)`) → document it, and add a "geometry pattern" off mode later.
- P3 · S · A linear pattern without `direction`, or a circular one without `axis`, passes the schema (both
  optional, `tools.ts:341-343`). It then fails with a raw TypeError from `resolveAxis(undefined)`
  (`packages/core/src/reference.ts:130-135`) → validate per kind.
- P3 · M · No bodies or faces to pattern, no vary sketch, no up to reference.

## Toolbar "Pattern" (whole-part repeat)

**App.** In both workspaces the Pattern group holds `patternTool`, which sets `part.repeat`: copies of the whole part
as one assembly item. Linear by a step vector, or radial about a vertical axis (`toolDefs.tsx:1514-1535`, `1988`,
`2006`).

**Gaps**
- P2 · S · In the part workspace a SolidWorks user clicking "Pattern" expects a feature pattern inside the part. They
  get copies of the whole part instead (hint "copies of the whole part") → show feature patterns in the part
  workspace and keep this one for the assembly (where SolidWorks has Component patterns).
- P2 · S · The pattern cannot be removed from the form: the "None" option is filtered out (`toolDefs.tsx:1523-1524`),
  so `readRepeat` never returns undefined → add a remove or None choice (the tool already accepts `repeat: null`).
- P3 · S · The default step uses `shapeHalfExtents`, which is 0 for sketch-built (`empty`) parts, so the default
  spacing is 5 mm (`toolDefs.tsx:1527`, `index.ts:569-570`) → use the kernel mesh bounds.

## Curve-driven, sketch-driven, table-driven, fill and variable patterns

**SolidWorks.** Curve driven (along a curve or edge), sketch driven (at sketch points), table driven (X/Y table or
file), fill (fills a face area with a grid or circular layout), variable (a table of dimension changes per instance).
Help pages not opened (Not verified).

**App.** None exist. The `pattern` op has only `linear` and `circular` (`index.ts:336-337`).

**Gaps**
- P2 · M · Sketch-driven pattern: the most used of these for holes. It needs `kind: 'sketch'` with a sketch ref, and
  copies placed at the sketch points relative to the seed. The machinery exists: `resolveSketch` and translation in
  `pattern`.
- P3 · L · Curve-driven: needs the path wire (as `sweepTool` builds) and a transform at each arc-length station.
  Table-driven: a list of offsets, small kernel work (M). Fill: grid clipped to a face boundary, needs a face pick and
  a 2D point-in-face test (L). Variable: needs a per-instance parameter table and a rebuild of the seed per instance (L).

---

## Combine

**SolidWorks.** Combine works on bodies of one multibody part: Add (main body plus others), Subtract (main body minus
tool bodies) and Common (only the overlap), with "Show preview". Help page not opened (Not verified).

**App.** `combine` makes a boolean with another *part* as placed in the assembly: join, cut or intersect
(`index.ts:342`, `build.ts:1176-1209`). Cycles are detected. Tests: `advanced.test.ts:219-264`. No UI and no editor.

**Gaps**
- P2 · M · No toolbar tool or editor (`toolDefs.tsx:2036`) → add a Combine form: operation, plus the other part
  picked in the view or the tree.
- P2 · L · The app has no multibody parts, so a SolidWorks Combine of bodies within one part cannot be expressed.
  The cross-part boolean is closer to the assembly "Join" / "Cavity" features. Decide whether parts get bodies (also
  needed by Split "both", Mirror without merge, Delete/Keep body, Move/Copy body, Intersect).
- P3 · S · Names differ: join / cut / intersect vs SolidWorks Add / Subtract / Common → use SolidWorks names in the UI.

## Split

**SolidWorks.** Split uses trim tools (planes, faces, surfaces or a sketch) to cut a part into bodies. You choose
which resulting bodies to keep, and can save bodies to their own part files. Help page not opened (Not verified).

**App.** A plane (base plane or plane step) and keep positive / negative / both. "Both" keeps two solids in one
compound (`build.ts:1216-1232`). Tests: `advanced.test.ts:267-288`. No UI, no editor.

**Gaps**
- P2 · M · No toolbar tool or editor → add one.
- P2 · S · "Both" leaves two solids, after which fillet, chamfer, shell, mirror-dependent features and draft fail with
  "needs a single solid" (`build.ts:100-105`). There is no way to save a piece as its own part → offer "save bodies as
  new parts" (copy the part with a split keeping each side).
- P3 · M · Only a plane can split; a sketch or surface cannot.

## Move/Copy bodies, Duplicate, Mirror copy

**SolidWorks.** Move/Copy Bodies is a part feature: pick bodies, translate (by an edge, vertex or XYZ) and rotate
(about an axis or XYZ), optionally keep copies with a count. It can also position a body with mates. Help page not
opened (Not verified).

**App.** There is no in-part body transform. The assembly workspace has Move (absolute position plus nudges), Rotate
(Euler angles), Duplicate (a copy at an offset) and Mirror copy (`toolDefs.tsx:1542-1660`).

**Gaps**
- P1 · S · Mirror copy and Duplicate break on an instance part (made with `parts_instance`). `fullPart` returns the
  raw instance (`shape: empty`, no features, `instanceOf` set). `copyOf` passes it to `parts_add`, whose schema has
  no `instanceOf`, so zod drops it (`tools.ts:445-471`, `553`). The copy comes out as an empty part: Duplicate gives
  nothing visible, and Mirror copy gives a part whose only step is a mirror, which fails with "needs a body first".
  Mirror copy with "Keep original" off writes the mirror feature onto the instance, where `effectivePart` ignores it
  (`index.ts:734-750`). The placement is still reflected, so the geometry ends up mirrored in place but not flipped
  (`toolDefs.tsx:1646-1658`) → resolve the source with `effectivePart` before copying, and refuse or redirect edits
  of instance features.
- P2 · M · There is no Move/Copy body feature inside a part (needed with multibody parts, see Combine).
- P3 · S · Mirror copy offers only YZ and XY (no XZ). The copy is not linked to its source, so later edits to the
  original do not reach it (SolidWorks Mirror Components can create linked opposite-hand versions).

## Scale, Delete/Keep body, Intersect, Dome, Wrap, Indent

None exist (no op in `index.ts:274-355`, no tool). Help pages not opened (Not verified). What each would need:
- P2 · M · **Scale**: about the centroid, origin or a coordinate system, uniform or per axis. Kernel: `gp_GTrsf`
  through `BRepBuilderAPI_GTransform` (non-uniform) or replicad `scale` (uniform). Small data op
  `{ op: 'scale', factor | factors, about }`. Useful for shrink compensation in printing.
- P3 · S · **Delete/Keep body**: needs multibody parts first. Today "keep one side" exists only inside Split.
- P3 · M · **Intersect**: pick bodies, surfaces and planes, then keep chosen regions. Needs multibody parts and a
  region list (split all tools against each other, keep picked cells).
- P3 · M · **Dome**: a picked flat face, a height, elliptical or continuous. Kernel: build a cap by lofting the face
  wire to a scaled or offset point, or by a filling surface (`BRepFill_Filling`), then fuse.
- P3 · L · **Wrap**: a sketch wrapped onto a cylinder or face as emboss, deboss or scribe. Needs the sketch mapped
  onto the face's parameter space (2D curves on the surface) and then a thickened face: new kernel work.
- P3 · M · **Indent**: a target body, a tool body (another part), a thickness and a clearance. Kernel: cut the
  target with the tool offset by the clearance, then add an offset shell. Can build on `combine`.

---

## Primitives (box, cylinder, sphere, cone, torus, tube)

**SolidWorks.** There are no primitive solids. Every part starts from a sketch and a feature. Standard hardware
comes from Toolbox, and reusable shapes from the Design Library. (General knowledge; no help page opened.)

**App.** These tools are in the assembly Insert group only (`toolDefs.tsx:2004`). Each makes a new part whose base
shape is the primitive, resting on the ground, with PLA grey (`toolDefs.tsx:213-243`, `330-396`). The base can be
edited later with the same form (`toolDefs.tsx:2038`, `222-225`). The kernel softens box, cylinder and tube edges by
default when the part has no history (`build.ts:592-628`). Capsule, lathe, extrude and script shapes exist in the
data (Jarvis only) and open `noEditTool`.

**Gaps**
- P2 · M · Primitives do not fit the "every part is drawn from sketches and features" direction. They have no sketch
  to edit, no dimensions on a sketch, and cannot be used for a feature that needs a sketch → make the Insert tools
  produce an `empty` part with a sketch step (rectangle or circle, dimensioned) plus an extrude or revolve. Keep the
  shape kinds only for Jarvis and old projects.
- P2 · S · Editing a cylinder silently drops `radiusTop` (taper) and `bevel`. The form loads only r and h and
  writes a new `{kind, radius, height}` (`toolDefs.tsx:346-354`; `parts_update` replaces `shape`,
  `tools.ts:631`) → keep unknown fields, or show them.
- P2 · S · Editing a box whose `radius` was unset (automatic softening) shows 0. Saving writes `radius: 0`, so the
  rounded edges silently turn sharp (`toolDefs.tsx:337`, `build.ts:601`).
- P3 · S · Automatic edge rounding and "Edge round" on a box are not SolidWorks behaviour, and they disappear as soon
  as the part gets any feature (`build.ts:1326-1329`). The shape changes when an unrelated feature is added.
- P3 · S · Primitives cannot be inserted in the part workspace (Insert exists only in `ASSEMBLY_GROUPS`).

## Pocket and boss (`cut` / `add` of a shape)

**SolidWorks.** No equivalent: a pocket is a sketch on a face plus Extruded Cut, and a boss is a sketch plus
Extruded Boss.

**App.** "Cut pocket" cuts a box or cylinder, 0.5 mm higher than its depth, at a typed "Top centre" in part
coordinates (`toolDefs.tsx:1357-1420`). `add` has no tool, and editing one gives `noEditTool`
(`toolDefs.tsx:2031-2036`).

**Gaps**
- P2 · S · The defaults use `shapeHalfExtents`, which is [0, 0, 0] for sketch-built parts (`index.ts:569-570`). On
  the parts the app now encourages, the pocket defaults to 1 × 1 mm, 1 mm deep, at the origin
  (`toolDefs.tsx:1376-1381`) → place it on a face picked in the view (`pickRefs.positionFromPick`), sized from the
  kernel bounds. Or retire Pocket in favour of sketch + Cut extrude.
- P2 · S · A boss (`add` of a shape) made by Jarvis cannot be edited (`noEditTool`), and neither can a `cut` of any
  shape other than box or cylinder (`toolDefs.tsx:2033-2035`).
- P3 · S · "Corner round" rounds all 12 edges of the cutting box, including the pocket floor and the rim above the
  surface, not only the vertical corners (`build.ts:602`, `soften(..., () => true)`) → round only the vertical edges,
  or rename the field to "Edge round".

## Hole (compared with Hole Wizard)

**SolidWorks.** Hole Wizard has a Type tab and a Positions tab. Type: hole type (counterbore, countersink, hole,
straight tap, tapered tap, legacy, slots), standard (ANSI, ISO, ...), fastener type, size, fit, end condition (blind,
through all, up to next / vertex / surface, offset from surface) and options (head clearance, near- and far-side
countersink, cosmetic thread). Positions: click points on a face (a placement sketch, dimensioned). Help page not
opened (Not verified). (Another area may audit holes in depth; covered here only for picking and the Toolbox link.)

**App.** Kinds clearance, tap, heat-set, counterbore, countersink, nut trap and plain; M2–M8; fit; "Drill from" one of
six axis directions; the entry point typed as XYZ; through or depth; a repeat (`toolDefs.tsx:1286-1356`).

**Gaps**
- P2 · M · The position cannot be clicked on a face. It is typed in part coordinates, and the direction is limited
  to the six axis directions (`toolDefs.tsx:1300-1301`, `1343-1351`) → Positions selection: click points on a face
  (`pickRefs.positionFromPick` exists, unused), with the direction from the face normal.
- P2 · S · Defaults come from `shapeHalfExtents`, so on sketch-built parts the entry point is the origin, and
  changing "Drill from" sets it to (0, 0, 0) (`toolDefs.tsx:1307-1309`, `1322-1327`).
- P2 · M · No end conditions beyond through all and blind; no inch standard; no cosmetic thread.
- P3 · S · Several holes from one feature only through the radial or linear repeat, not by several clicked points.

## Thread

**SolidWorks.** The Thread feature picks a circular edge, sets a start offset and an end condition (blind,
revolutions, up to selection), takes the profile from a library, cuts or extrudes, right- or left-handed, with
multiple starts. Help page not opened (Not verified).

**App.** Kind external or internal, a size preset (fills diameter and pitch), length, and start position
(`toolDefs.tsx:1449-1495`). The kernel always builds the thread along +Y from `position`
(`build.ts:840-866`, `cylinderY`).

**Gaps**
- P2 · M · The thread axis is always vertical (+Y). A thread on a horizontal boss or bore cannot be made, and the
  circular edge cannot be picked → take the axis and start from a picked circular edge (`circleOfEdge` in
  `pickRefs.ts:134` gives centre, normal and radius).
- P2 · S · The default start is (0, -hy, 0) from `shapeHalfExtents`, which is 0 for sketch parts
  (`toolDefs.tsx:1472-1473`).
- P3 · M · No left hand, no multiple starts, no "revolutions" end.

## Fasteners (compared with Toolbox)

**SolidWorks.** Toolbox is a library of standard parts (many standards and sizes, inch and metric), dragged into an
assembly and snapped onto holes with mates. Smart Fasteners fill Hole Wizard holes with matching screws
automatically. Help page not opened (Not verified).

**App.** A Fastener tool in the assembly Insert group: type (9 ISO types), size M2–M8, a standard length (screws),
thread modelled or plain. It creates a part placed upright on the ground, steel or brass. The base can be edited with
the same form (`toolDefs.tsx:245-328`). Tables are in `packages/core/src/fasteners.ts`, geometry in
`build.ts:384-590`. Tests: `kernel.test.ts:314-358`.

**Gaps**
- P2 · L · Fasteners are not tied to holes: no "insert into this hole", no Smart Fasteners, no mates or placement on
  a picked hole edge. The user types the position → place a fastener by clicking a hole's circular edge
  (`circleOfEdge`), aligned to its axis, with the size from the hole spec.
- P2 · S · Changing the type between a screw and a nut or washer keeps the part's position, but the origin
  convention differs (screws: under the head; nuts: bottom face, `index.ts:217-222`), so the part jumps
  (`toolDefs.tsx:310-313`).
- P3 · S · Sizes stop at M8 with no inch sizes (`index.ts:214`). A length that is not standard (set by Jarvis) does
  not appear in the Length select when editing (`toolDefs.tsx:289-296`).
- P3 · S · Fasteners fit the "every component is a part" rule, but not "drawn from sketches". This is acceptable
  for library parts (as Toolbox parts are generated), but should be stated.

## Material and appearance

**SolidWorks.** Edit Material picks from a material library (by class: steel, aluminium alloys, plastics...). Each
material has physical properties (density, elastic modulus, Poisson's ratio, yield and tensile strength, thermal
data) and a linked appearance. Custom materials are possible. Mass Properties uses the part's material density.
Appearances are separate: colour, texture and finish, applied per face, feature, body or part. Help page not opened
(Not verified).

**App.** `Material` is appearance only: colour, metalness, roughness, plus optional emissive, opacity, clearcoat and
transmission (`index.ts:373-382`). The form shows colour, metalness, roughness, clear coat, transmission and 7 presets
(`toolDefs.tsx:1680-1749`). Mass properties takes a density separately, one value for the whole call, PLA by default
(`apps/server/src/hostTools.ts:70-71`, `182-210`, `apps/web/src/evaluateToolDefs.tsx:64`).

**Gaps**
- P2 · M · No physical material. Choosing "Stainless steel" changes only the look; mass properties still uses PLA
  unless the user picks a density again in that tool → add `material.name` / `density` (and later mechanical
  properties) to `Material`, with presets that carry both. Mass properties should then read each part's density.
- P2 · M · An appearance can be set only on the whole part, not on a face, feature or body.
- P2 · S · Presets are a short list of print materials and finishes, with no library structure and no custom saved
  materials.
- P3 · S · A colour that is not 7-character hex (for example `#fff` or a name set by Jarvis) loads as grey, and
  saving overwrites it (`toolDefs.tsx:1707`). Opacity and emissive exist in the data but not in the form.
- P3 · S · No texture or decal link from the material form (pictures are a separate tool).

---

## Top 10 for this area

1. P1 · L · Selection lists in feature forms, wired to view picks through `pickRefs.edgePick` / `facePick`, stored as
   refs, kept across previews (Picking).
2. P1 · M · Fillet: Items to fillet from picks, tangent propagation on by default, full selection saved and loaded
   on edit.
3. P1 · M · Chamfer: picks, plus a type select (equal, two distances, distance-angle) and Flip.
4. P1 · M · Shell: Faces to remove from picks, plus a Shell outward checkbox.
5. P1 · L · Linear and Circular pattern forms for the existing `pattern` op (direction or axis from a picked edge;
   features chosen in the tree), and keep "Pattern" in the part workspace for features, not part copies.
6. P1 · M · Draft form (neutral plane or face, faces, angle, reverse), and pin the draft direction in tests.
7. P1 · S · Fix Duplicate and Mirror copy of instance parts (resolve with `effectivePart`; never drop `instanceOf`
   silently).
8. P2 · S · Stop losing data on edit: cylinder `radiusTop` / `bevel`, box auto-radius, chamfer angle, fillet picks,
   and shell remove / outward. Show them in the summaries.
9. P2 · M · Mirror about a plane step or picked face, with Front / Right / Top names; then features to mirror.
10. P2 · M · Material with a density that mass properties uses; primitives and pocket redone as sketch + feature
    templates, with face-picked placement for holes, pockets and threads.

## Not checked

- `docs/SOLIDWORKS_REFERENCE.md` did not exist. The Shell, Draft, Mirror, Combine, Split, Move/Copy, Scale, Dome,
  Wrap, Indent, Hole Wizard, Thread, Toolbox and material help pages were not opened. Those SolidWorks descriptions
  are marked Not verified and should be checked against the digest when it lands.
- Nothing was run: no tests and no live app. In particular, these were not checked:
  - whether clicking edges while the fillet form is open still works with a preview ghost in the way;
  - whether editing a feature rolls the model back to before it;
  - whether a face pick with `tangent: true` on a fillet includes the smooth shared edges between the propagated
    faces (`build.ts:872` takes every edge of every face), which OpenCascade would likely refuse.
- The OK, Cancel, Esc and Enter behaviour of the generic form (`toolForm.tsx`, `PropertyManager.tsx`) is shared with
  other areas and was not re-audited here.
- Mid-change files seen: `Manipulators.tsx` and `toolHandles.ts` (drag handles, including a `hole` handle at
  `toolHandles.ts:246`), plus `evaluateToolDefs.tsx` and `measure.ts` (the only consumers of view picks). They were
  read only as far as their use of picks.
- Hole and thread were covered only for picking, placement and the Toolbox link, not for table accuracy.
