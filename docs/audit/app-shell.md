# Audit: app shell (feature tree, property manager, selection, view, keys, assembly, documents, evaluate)

Audited 2026-11-13 against the code on disk at about 18:00–19:00. `docs/SOLIDWORKS_REFERENCE.md` did not exist at the
start or at the end of this pass. The SolidWorks help pages render their text with script, so a plain fetch returns only
the site frame. The SolidWorks behaviour below therefore comes from the help pages' search excerpts (URL given) and,
where marked **Not verified**, from general SolidWorks knowledge. Check those against the help before building.

Files that changed while this audit was being written (other people are working in them): `evaluateToolDefs.tsx`,
`measure.ts`, `Manipulators.tsx`, `toolHandles.ts`, `pickRefs.ts`. Selection boxes are announced but not on disk yet.
Line numbers refer to what was on disk when read.

## Summary

| Tool / behaviour | Verdict | P1 | P2 | P3 |
|---|---|---|---|---|
| 1. Feature tree: structure, naming, folders | differs | 0 | 3 | 4 |
| 2. Sketch nesting, (-) (+) (?) marks | incomplete | 0 | 1 | 1 |
| 3. Rollback bar | broken | 1 | 1 | 2 |
| 4. Suppress / unsuppress | differs | 0 | 2 | 0 |
| 5. Reorder | incomplete | 0 | 1 | 1 |
| 6. Rename | incomplete | 0 | 0 | 2 |
| 7. Delete (dependants, absorbed) | incomplete | 0 | 1 | 1 |
| 8. Edit feature / edit sketch / edit sketch plane | incomplete | 0 | 1 | 1 |
| 9. Parent/child, rebuild errors, "What's wrong" | incomplete | 0 | 2 | 0 |
| 10. Tree hide/show, filter, keyboard, menus, History folder | incomplete | 0 | 2 | 3 |
| 11. Property manager frame (OK/Cancel/Enter/Esc, pushpin, sections, preview) | incomplete | 0 | 3 | 3 |
| 12. Number fields (units, expressions, spin) | incomplete | 0 | 2 | 1 |
| 13. Selection boxes | missing | 1 | 0 | 0 |
| 14. Live preview ghosts and drag handles | incomplete | 0 | 1 | 1 |
| 15. Selecting in the view | differs | 0 | 4 | 3 |
| 16. View navigation (mouse, zoom, views, styles, section, perspective) | differs | 0 | 5 | 4 |
| 17. Camera moving on its own | matches (minor) | 0 | 0 | 2 |
| 18. Keyboard shortcuts | differs | 0 | 2 | 3 |
| 19. Parts and assembly | incomplete | 1 | 4 | 3 |
| 20. Documents, autosave, undo/redo, settings | incomplete | 0 | 3 | 4 |
| 21. Evaluate (measure, mass, section, check) | incomplete | 0 | 3 | 2 |

---

## 1. Feature tree: structure, naming, folders

**SolidWorks.** The FeatureManager lists the part (name at the top), then folders and fixed items (History, Sensors,
Annotations, Solid Bodies, Material, Front/Top/Right Plane, Origin), then the features in build order. Sketches are
absorbed under the feature that consumes them. A feature selected in the tree highlights in the graphics area and the
other way round. Multiple selection uses Ctrl and Shift. Names are unique in the part. Source:
https://help.solidworks.com/2020/English/SolidWorks/sldworks/c_featuremanager_design_tree_overview.htm (excerpt only).

**App.** `PartHistory` (`apps/web/src/FeatureTree.tsx:144`) builds the root, a History folder, Material, the three
planes, Origin, "Base body" when the part has a primitive shape, then the step nodes from `buildFeatureTree`
(`featureTree.ts:63`). Names come from `nextFeatureName` (`featureNames.ts:34`): Boss-Extrude1, Cut-Extrude2, Sketch3,
LPattern1. There is a part switcher, an Isolated / In context toggle and the filter above the tree. Clicking a row only
sets a local `current` (`FeatureTree.tsx:692`).

**Gaps**
- P2 · M · Selecting a row selects nothing in the view, and picking a face in the view does not highlight the feature
  that made it. `setCurrent` is local state only (`FeatureTree.tsx:179,692`) → the tree and the view should share one
  selection: a feature row highlights its faces, and a picked face highlights its feature row.
- P2 · M · No multiple selection in the tree (no Ctrl/Shift click); `current` is a single key (`FeatureTree.tsx:179`)
  → Ctrl adds, Shift selects a range, and Delete, Suppress and Hide act on all selected rows.
- P2 · S · The Material row has no menu and cannot be edited from the tree: `menuFor` returns `[]` for fixed rows
  without a plane (`FeatureTree.tsx:432-433`). Mass properties guesses density from the colour instead
  (`evaluateToolDefs.tsx:76-82`) → right-click Material: Edit material, with a real material (name and density) stored
  on the part.
- P3 · S · There is no Solid Bodies folder. "Base body" (`FeatureTree.tsx:268`) only shows for primitive parts → a
  Solid Bodies folder listing the result bodies, with hide/show.
- P3 · S · Origin has no menu and no show/hide (`FeatureTree.tsx:265,432`); planes only offer "Sketch on this plane"
  → Show/Hide, Normal To, and for planes Edit and Hide.
- P3 · S · No Sensors, Annotations or Equations folders. Equations do not exist anywhere (see 12).
- P3 · S · The plane rows use the names Front/Top/Right Plane but the part has no way to rename them, unlike SolidWorks.

## 2. Sketch nesting and the (-) (+) (?) marks

**SolidWorks.** A sketch used by a feature is absorbed under it. A sketch shared by several features shows under each
of them. In front of a sketch name: (-) under defined, (+) over defined, (?) cannot be solved, nothing when fully
defined. **Not verified** on the help page.

**App.** `buildFeatureTree` nests a `sketch` step under every later step that refers to it and marks it as shared
(`featureTree.ts:63-136`). Inline sketches show as child rows (`featureTree.ts:95-105`). The marks come from
`definitionMark` → `markFor` (`sketchState.ts:14-19`). Tests: `featureTree.test.ts` (12 cases).

**Gaps**
- P2 · S · There is no (?) mark. `markFor` returns `''` when the solve fails without conflicts (`sketchState.ts:18`), so
  a sketch that cannot be solved looks fully defined. `DefinitionMark` has no `(?)` value (`sketchState.ts:7`) → show
  (?) and say "cannot be solved" in the tooltip (`FeatureTree.tsx:623`).
- P3 · S · Marks only show after the solver WASM loads (`FeatureTree.tsx:590`), so they appear late without any sign.

## 3. Rollback bar

**SolidWorks.** You drag the bar, or use the menu (Roll Back, Roll Forward, Roll to Previous, Roll to End), or the arrow
keys when that is turned on. Features below the bar are greyed and not built. **New features are added at the bar**, and
existing ones can be edited while rolled back. The bar position is saved with the file. Source:
https://help.solidworks.com/2024/English/SolidWorks/Sldworks/c_rollback_bar.htm (excerpt only; the insert behaviour
is also described by resellers).

**App.** The bar sits in gaps between top-level rows (`FeatureTree.tsx:707-741`). You can drag it (`barDown/barMove/barUp`
at `:524-547`), click a gap, or use "Roll back to here" and "Roll to end" (`:381-384`). It sends `rollback` to the
server, which stores `view.rollback` (`apps/server/src/index.ts:262-266`). Meshes use `partsAtTimeline`
(`apps/server/src/meshes.ts:74`).

**Gaps**
- P1 · S · **New features go to the end of the history, not at the bar.** `saveFeature` calls `features_add` without
  `before` (`apps/web/src/toolDefs.tsx:194-195`), and the server appends when `before` is missing
  (`apps/server/src/tools.ts:729-730`). Because the rollback count stays the same, the new feature lands below the bar
  and is not built, so the user sees nothing happen. Repro: roll back above the last feature, add a fillet, press OK.
  The fillet row appears greyed at the bottom and the model does not change → insert before the first feature below the
  bar, and move the bar to just after the new feature.
- P2 · S · Opening Edit sketch moves the bar to the sketch, and leaving the sketch sets it to "none" (roll to end)
  (`Toolbar.tsx:588-604`), so a rollback the user had set is lost → put back the previous position.
- P3 · S · No Roll Forward or Roll to Previous, and arrow keys do not move the bar (`FeatureTree.tsx:381-384,457-487`).
- P3 · S · While the filter is on, the bar is hidden (gaps are skipped at `FeatureTree.tsx:271,284`), and the footer
  is the only sign that the part is rolled back.

## 4. Suppress / unsuppress

**SolidWorks.** Suppressing a feature also suppresses its children. Unsuppressing a child also unsuppresses its parent.
Unsuppress with Dependents restores a feature and its children. Sources:
https://help.solidworks.com/2017/english/SolidWorks/sldworks/c_Suppress_and_Unsuppress_Features.htm,
https://help.solidworks.com/2023/English/SolidWorks/sldworks/c_Dependency_Editing.htm (excerpts).

**App.** The node menu toggles Suppress/Unsuppress (`FeatureTree.tsx:405-408`) → `setSuppressed` (`state.ts:263`) → the
server sets the flag on that one feature (`apps/server/src/index.ts:247-254`). The kernel skips suppressed steps, but a
suppressed sketch is still used by the features that use it (`apps/server/src/cad/build.ts:1342`).

**Gaps**
- P2 · M · Nothing cascades. Children stay active when a parent is suppressed, and suppressing a sketch leaves the
  extrude built from it unchanged (`build.ts:1342`) → suppress the children with the parent (by `stepUsers`, and by
  geometric dependants once those are known), unsuppress parents with a child, and add Unsuppress with dependents.
- P2 · S · Only one row at a time, and only from the right-click menu → work on the selected rows, with a toolbar or
  key command.

## 5. Reorder

**SolidWorks.** Drag a feature to a new place. The move is refused if a feature would come before its parent.
**Not verified.**

**App.** Only top-level rows can be dragged. Their unshared nested sketches move with them (`reorderIds`,
`featureTree.ts:171-186`; `FeatureTree.tsx:551-584`). The server checks only id references: sketchRef, planeRef,
axisRef and pattern ids (`checkHistory`, `apps/server/src/tools.ts:379-429`).

**Gaps**
- P2 · M · Dependencies by geometry are not checked. A fillet or chamfer picked by points (`at`, `faces`), a hole
  position or a shell face can be dragged above the feature that made that geometry. The server accepts the move and
  the rebuild fails or picks different geometry (`tools.ts:788-809`) → refuse, or warn, when the moved feature refers to
  geometry made by a feature it would pass.
- P3 · S · You cannot drag onto a nested row (the drop goes after its parent, `FeatureTree.tsx:888`), and there are no
  keyboard or menu commands to move a row up or down.

## 6. Rename

**App.** F2, the menu, or the root row (`FeatureTree.tsx:341-345,412,755,898`) → `features_update` / `parts_update`.

**Gaps**
- P3 · S · Duplicate names are not refused (no check in `features_update`, `tools.ts:739-786`). SolidWorks requires
  unique feature names, and `failingFeature` matches errors by name (`historyText.ts:367-375`), so two steps with the
  same name confuse error marking → refuse or number duplicates.
- P3 · S · Sketches nested inline cannot be renamed (`startRename` needs a `stepId`, `FeatureTree.tsx:342`).

## 7. Delete (dependants and absorbed sketches)

**SolidWorks.** The Confirm Delete dialog lists the dependent items and has two options: Delete absorbed features and
Delete child features. An advanced mode lets you choose each item. Kept children show errors. Source:
https://help.solidworks.com/2025/English/SolidWorks/Sldworks/HIDD_CONFIRM_DELETE_NEW.htm (excerpt).

**App.** `askDelete` refuses outright if any step uses the feature (`FeatureTree.tsx:323-335`). Otherwise an inline
confirmation offers Delete, "With sketch" (absorbed, unshared sketches, `blockIds`) or Keep (`:838-857`).

**Gaps**
- P2 · M · A feature that has children cannot be deleted at all; the user must delete the children first → a confirm
  that lists the children, with "Delete child features" and "Delete absorbed features" options.
- P3 · S · Only one feature at a time (no multiple selection), and Delete in the viewport does nothing in the part
  workspace (`Toolbar.tsx:460` only handles the assembly).

## 8. Edit feature / edit sketch / edit sketch plane

**SolidWorks.** A feature's menu has Edit Feature and Edit Sketch, and a sketch's menu has Edit Sketch Plane.
**Not verified.**

**App.** The menu has "Edit feature" (not for sketch steps), plus the sketch edits from `sketchEdits`
(`historyText.ts:382-401`; `FeatureTree.tsx:401-404`). Double-click or Enter runs `activate` (`:361-379`), and
`editorFor` (`toolDefs.tsx:2021-2039`) picks the form. Loft with inline sections, cut features with other shapes, and
any op without a tool fall back to `noEditTool`, which tells the user to ask Jarvis (`toolDefs.tsx:1976-1983`).

**Gaps**
- P2 · M · There is no Edit Sketch Plane. The plane can only change by editing the sketch data. Searching the menus
  for "plane" finds only "Sketch on this plane" → add Edit Sketch Plane (pick a plane or face; the sketch keeps its
  geometry).
- P3 · S · Steps with no editor open a panel that says "ask Jarvis" (`toolDefs.tsx:1982`), so sweep, pattern, plane,
  axis, split and draft cannot be edited by hand from the tree (this overlaps the per-tool audits).

## 9. Parent/child, rebuild errors, "What's wrong"

**SolidWorks.** Parent/Child is a read-only dialog listing a feature's parents and children. Rebuild errors put a mark
on the feature, and "What's wrong" lists the errors and warnings. Source:
https://help.solidworks.com/2014/English/SolidWorks/Sldworks/c_Parent_and_Child_Relations.htm (excerpt).

**App.** The tooltip shows "Uses …" and "Used by …" (`FeatureTree.tsx:604-611`). The failing step gets a ⚠ and the
error in its tooltip (`:599-601,834,905`). `failingFeature` finds the step by name inside the error text
(`historyText.ts:367-375`).

**Gaps**
- P2 · S · There is no Parent/Child command, and no list of the children found by geometry → a menu entry that shows
  parents and children and selects them.
- P2 · S · There is no "What's wrong". The error is only in a tooltip, only one error per part is kept
  (`meshes.errors[partId]`), and an error that matches no feature name only marks the root → an errors panel listing
  every failing step and its message, opened from the root or the feature.

## 10. Tree hide/show, filter, keyboard, menus, History folder

**App.** There is an eye on sketch and reference steps (`FeatureTree.tsx:859-922`). The filter matches names and roles
(`featureTree.ts:235-249`). Keys: arrows, Home/End, Enter, F2, Delete (`FeatureTree.tsx:450-506`). The root menu has
Edit body, Rename part, Expand/Collapse all and Roll to end (`:417-425`). The History folder lists steps added or edited
in this session (`:70-81,246-250`).

**Gaps**
- P2 · S · You cannot hide or show the body, the planes or the origin from the tree. Planes and the origin are never
  drawn outside the plane-picking stage → Show/Hide on every reference and body row.
- P2 · S · Right-clicking a sketch in the **view** hides it at once, with no menu (`SketchLayer.tsx:376-381`). This is
  easy to do by accident, and SolidWorks right-click always opens a menu → open a menu (Edit sketch, Hide, …).
- P3 · S · The node menus lack Hide/Show (except the eye), Parent/Child, Go To, Feature Properties, Zoom to Selection,
  Add to new folder and Collapse items.
- P3 · S · The History folder is kept only in memory for the session (`FeatureTree.tsx:70`). It is lost on reload.
- P3 · S · There are no tree folders the user can make (Add to New Folder).

## 11. Property manager frame

**SolidWorks.** The header has OK, Cancel, Help and Keep Visible (pushpin), and there is a Detailed preview where the tool
offers one. Group boxes can be collapsed. OK applies and closes. Cancel discards and closes. With the pushpin on, OK
applies and keeps the panel open for the next one. Right-click in the view gives OK (the mouse-gesture "OK"), Enter is
OK and Esc is Cancel. Source: https://help.solidworks.com/2022/english/SolidWorks/sldworks/r_pm_overview.htm (excerpt);
pushpin for Fillet/Chamfer: https://help.solidworks.com/2025/English/WhatsNew/c_wn2025_parts_PinFilletChamferPM.htm.

**App.** `PropertyManager` (`PropertyManager.tsx:157-230`) has a name header, OK (submit) and Cancel, sections from
`Field.section` that collapse (`:80-105,210-217`), and Selected contours for region picks (`:107-148`). Every form opens
in the panel (`usesPanel` always true, `:22-24`). OK runs `apply`. On success it closes unless `keepOpen`; on error it
stays open with the message (`toolForm.tsx:134-145`). Esc in the form cancels (`:175-180`), and Esc anywhere else closes
the panel (`Toolbar.tsx:386-387`).

**Gaps**
- P2 · S · There is no Keep Visible pushpin, so repeated features (holes, fillets) reopen the tool each time → a pin
  that keeps the panel open after OK, with fresh values.
- P2 · S · Enter only works while focus is inside the form. After a click in the view, focus leaves the form and Enter
  does nothing, because the global key handler only handles Enter in sketch mode (`Toolbar.tsx:420-436`) → Enter = OK
  whenever a panel is open and focus is not in another text field.
- P2 · S · There is no right-click OK in the view.
- P3 · S · There is no Help button and no Detailed preview toggle. The preview cannot be switched off (`toolForm.tsx:123`).
- P3 · S · Section open/closed state is not remembered between uses (`PropertyManager.tsx:160`).
- P3 · S · Cancel does not undo actions that already went to the model while the panel was open: Move's nudge buttons
  (`toolDefs.tsx:1565-1570`) and the Explode slider (`:1879-1883`) apply at once, and each nudge is its own undo step.

## 12. Number fields

**SolidWorks.** Numeric boxes take units ("1in", "25.4mm"), arithmetic ("10/2+3"), global variables and equations ("=").
Spin arrows step by the increment set in System Options, and Alt or Ctrl with the arrows or the wheel changes the step.
**Not verified.**

**App.** `FieldInput` renders `<input type="number">` (`toolForm.tsx:281-287`). `num()` uses `Number(raw)`
(`toolDefs.tsx:127-140`). Spin buttons step by `field.step` and clamp only to `min` (`toolForm.tsx:158-166`). The unit
is a fixed label.

**Gaps**
- P2 · M · You cannot type units or expressions. A number input refuses "10+5" and "1in", and `num` would reject them
  anyway → a text field that evaluates arithmetic and unit suffixes, then shows the result.
- P2 · L · There are no global variables or equations in the data model or the UI.
- P3 · S · `max` is ignored by the spin buttons and by validation (`toolForm.tsx:165`, `toolDefs.tsx:127`). There is no
  wheel or keyboard step change, and no setting for the default increments.

## 13. Selection boxes

**SolidWorks.** Each feature has selection list boxes (edges, faces, sketch, direction …). The active box is highlighted,
and a click in the view fills it. Entries can be deleted, Clear Selections empties a box, and clicking an entry
highlights it in the view. **Not verified** on the page.

**App.** The only list is Selected contours for sketch regions (`PropertyManager.tsx:107-148`). Picks of faces and edges
(`state.picked`) feed only Measure and the HUD. Fillet, chamfer and shell use group dropdowns ("Vertical edges", open
faces "Top") (`toolDefs.tsx:1227-1283`), although the data model already stores picked edges and faces (`at`, `faces`,
`remove` in `packages/core/src/index.ts:280-291`). Work on selection boxes was announced but is not on disk.

**Gaps**
- P1 · L · Features cannot take faces or edges picked in the view, so there is no real selection box. Editing a fillet
  that Jarvis made with picked edges shows an "Edges" dropdown that is then ignored, because `at` is kept by the merge
  in `features_update` (`tools.ts:761`) and takes precedence → a shared SelectionBox field (active box, picks from the
  view, delete an entry, clear all, hover an entry to highlight it) used by fillet, chamfer, shell, hole, draft, mirror
  and pattern.

## 14. Live preview ghosts and drag handles

**App.** Tools with `preview: true` capture their tool calls and post them to the server, which builds a scratch copy
(`toolForm.tsx:17-88`, `preview.ts`, `apps/server/src/preview.ts`). Ghosts are drawn in yellow over the model
(`Scene.tsx:337-374`). Drag handles exist for extrude, cut, revolve, sketch finish, move, rotate, duplicate and hole
(`toolHandles.ts:207-259`, being changed during this audit).

**Gaps**
- P2 · M · There are no handles for fillet or chamfer radius, shell thickness, pattern spacing or count, mirror, loft
  or thread → add a distance arrow or a ring where SolidWorks has callout handles.
- P3 · S · A failed preview shows only "Preview: <message>" in the result area (`toolForm.tsx:153`). Nothing marks the
  problem in the view.

## 15. Selecting in the view

**SolidWorks.** You can select faces, edges, vertices, sketch entities, planes, axes and the origin. Ctrl+click adds or
toggles. Left-drag makes a box (left to right selects what is inside, right to left what crosses), and a lasso is also
available. Selection filters (F5) limit what can be picked, and Select Other cycles through what is under the pointer.
Esc clears the selection. Sources: https://help.solidworks.com/2022/English/SolidWorks/sldworks/c_Selection_Overview.htm,
https://help.solidworks.com/2017/english/solidworks/sldworks/c_selection_tool_access.htm (excerpts).

**App.** In the part workspace you can pick faces and edges of the active part only (`Scene.tsx:390-391,489-497`).
Shift+click adds or toggles (`state.ts:312-314`). Hover shows the face or edge (`:420-427,540-545`). An edge wins within
6 px (`:34,225-244`). In the assembly, a click selects one part (`:200`). A click on empty space clears (`:210-217`). Esc
clears the picks, then the part (`Toolbar.tsx:390-395`).

**Gaps**
- P2 · S · Ctrl does not add to the selection; Shift does (`Scene.tsx:494`) → Ctrl+click adds/toggles, as in SolidWorks.
- P2 · M · There is no box or lasso selection, because left-drag orbits the camera (camera-controls defaults,
  `Scene.tsx:896`) → left-drag box, with orbit on the middle button (see 16).
- P2 · M · You cannot pick vertices, planes, axes or the origin. `PickedEntity.kind` is only face or edge
  (`picking.ts:7-11`).
- P2 · M · The assembly selection holds one part (`selected: string | null`, `state.ts:23`); there is no multiple
  selection of components.
- P3 · M · There are no selection filters and no Select Other.
- P3 · S · Picks are dropped every time the part's mesh changes (`state.ts:323-331`, `Scene.tsx:404-414`), so a pick is
  lost after any rebuild, including the preview's commit.
- P3 · S · Other parts in the part workspace cannot be picked even when shown (`dimmed` disables raycast,
  `Scene.tsx:476`). Edit in context cannot pick reference geometry from another part.

## 16. View navigation

**SolidWorks.** Middle-drag rotates, Ctrl+middle pans, Shift+middle zooms, Alt+middle rolls, and the wheel zooms.
Double-clicking the middle button fits. There are Zoom to Fit (F), Zoom to Area, Zoom to Selection, Previous View,
standard views (Front, Back, Left, Right, Top, Bottom, Isometric, Trimetric, Dimetric) and Normal To. Space opens View
Orientation. Display styles are Shaded with Edges, Shaded, Hidden Lines Removed, Hidden Lines Visible and Wireframe. There
is a Section View and a Perspective toggle (off by default: orthographic). Sources:
https://blogs.solidworks.com/products/solidworks/how-do-i-manipulate-my-model-view-let-me-count-the-ways/ (mouse);
display styles, section view and perspective **Not verified**.

**App.** `CameraControls` with default buttons (left rotate, right pan, wheel and middle dolly, `Scene.tsx:896`). The
pivot is the selected or active part's centre, otherwise the point under the cursor (`:745-790`). Views are Iso, Front,
Top (elevation 89), Right, Left and Back (`toolDefs.tsx:1753-1760`). Fit (`:1767-1772`). There is an Edges on/off toggle
(`:1809-1815`) and a fixed perspective camera with fov 32 (`Scene.tsx:858`). The triad is drei `GizmoViewport`
(`:906-914`). The ground grid is 10 mm (`:798-819`).

**Gaps**
- P2 · S · The mouse map is not SolidWorks: left rotates, middle zooms, there is no roll, and no modifiers →
  middle-drag rotate, Ctrl+middle pan, Shift+middle zoom, Alt+middle roll, left free for selection.
- P2 · M · The only display styles are Edges on or off. There is no Hidden Lines Removed, Hidden Lines Visible or
  Wireframe.
- P2 · M · There is no Section View.
- P2 · S · There is no Normal To for a picked face or plane; the camera only faces the sketch plane automatically when
  sketching (`Scene.tsx:716-729`).
- P2 · S · There is no orthographic camera and no perspective toggle, although picking already handles an orthographic
  camera (`Scene.tsx:232`).
- P3 · S · There is no Bottom, Trimetric or Dimetric view, and no View Orientation menu on Space.
- P3 · S · There is no Zoom to Area or Zoom to Selection in the part workspace ("Zoom to part" exists only in the
  assembly menu, `Browser.tsx:139`), and no Previous View.
- P3 · S · Standard views are a server change (`view_set`, `toolDefs.tsx:1762-1765`): every click writes the project
  file and turns the camera in every other open browser.
- P3 · S · There is no setting for the grid spacing or plane in the view (fixed at 10 mm, `Scene.tsx:807`), and no
  hide/show for planes or origins (see 10).

## 17. Camera moving on its own

**App.** `Rig` (`Scene.tsx:613-739`) reframes only on project open, Fit, a view button, a focus or explode change, or a
part added or removed in the assembly. The workspace and the active part are deliberately not in `asked` (`:627`).

**Gaps**
- P3 · S · A kernel mesh arriving for an empty- or sketch-shaped part bumps `boundsVersion` (`Scene.tsx:445-451`). If
  that happens within 4 s of the last framing (`settleUntil`, `:648-656`), for example by switching workspace or
  remounting a part right after Fit, the camera reframes. This is minor and not seen in use.
- P3 · S · Picking another part in the part switcher (`FeatureTree.tsx:943`) keeps the camera aimed at the previous
  part, which may be off screen → frame the newly active part once.

## 18. Keyboard shortcuts

**SolidWorks defaults (third-party lists, consistent with each other; Not verified on help):** Ctrl+1 Front, Ctrl+2
Back, Ctrl+3 Left, Ctrl+4 Right, Ctrl+5 Top, Ctrl+6 Bottom, Ctrl+7 Isometric, Ctrl+8 Normal To, Space View Orientation,
F Zoom to Fit, Z / Shift+Z zoom, arrows rotate, Shift+arrows rotate 90°, Alt+arrows roll, Ctrl+arrows pan, Ctrl+B
rebuild, Ctrl+Q force rebuild, Ctrl+Z/Ctrl+Y undo/redo, Ctrl+N/O/S/P, Delete deletes the selection, Enter repeats the
last command, F5 selection filter. Source list: https://blogs.solidworks.com/tech/2017/10/shortcuts-for-solidworks-beginners.html.

**App.** `Toolbar.tsx:373-475`: bare 1 Front, 2 Top, 3 Right, 4 Iso, F fit, G grid, S new sketch (part workspace),
Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Delete (assembly only). Sketch mode has its letter tools (`:143-145`). FileMenu: Ctrl+O,
Ctrl+N, Ctrl+Shift+S (`FileMenu.tsx:52-67`).

**Gaps**
- P2 · S · The view keys differ: bare digits, and 2 = Top, 3 = Right, 4 = Iso → Ctrl+1…8 as in SolidWorks (bare digits
  can stay as extras).
- P2 · S · Shortcuts do not work after a page load until the user clicks the view. The prompt field has `autoFocus`
  (`App.tsx:183`), and the toolbar treats any focused input as typing, even an empty one (`Toolbar.tsx:376,398`).
  FileMenu uses `typingInField`, which ignores empty fields (`menus.tsx:151-160`) → use the same rule in the toolbar,
  or do not autofocus the prompt.
- P3 · S · Ctrl+S is not handled, so the browser's "Save page" dialog opens. Ctrl+N cannot be caught in Chrome, so the
  "Ctrl+N" hint in the File menu does not work (`FileMenu.tsx:176`).
- P3 · S · There are no arrow-key view rotations, no Z zoom, no Ctrl+B / Ctrl+Q rebuild, no Space menu and no Enter to
  repeat the last command.
- P3 · S · Delete does nothing in the part workspace unless the tree has focus (`Toolbar.tsx:460`).

## 19. Parts and assembly

**SolidWorks.** An assembly has mates (coincident, concentric, distance, angle …), components fixed or floating,
Move/Rotate Component with a triad, component patterns (linear, circular, pattern driven), mirror components about any
plane, hide/show/isolate, edit part in context, insert new part on a plane, exploded views with steps, and interference
detection. **Not verified** on the help pages.

**App.** The components list (`Browser.tsx:91-270`) shows designs with their instances and patterns, and has Edit part,
Edit in place, Insert instance, Pattern, Rename, Duplicate, Zoom to part, Delete (instances checked) and hide.
Transform tools (`toolDefs.tsx:1542-1678`): Move and Rotate (absolute XYZ and Euler, with triad and rings handles),
Duplicate, Mirror copy (YZ or XY world plane only), Delete. Explode is a single factor slider (`:1871-1884`). The new
part flow is `newPartTool` (`:1963-1973`) and "+ New part" in the tree (`FeatureTree.tsx:51-68`).

**Gaps**
- P1 · S · **The Isolated / In context toggle does nothing.** `partView` is set (`state.ts:358`) and shown
  (`FeatureTree.tsx:109-132`) but never read by the scene. Visibility of other parts depends only on `showOthers`
  (`Scene.tsx:874-879`), so "Edit part" and "Edit in place" (`Browser.tsx:132-133`) behave the same → make Isolated
  hide the other parts and In context show them ghosted, or remove the toggle and the duplicate menu entry.
- P2 · L · There are no mates and no fixed/floating state. Parts sit at absolute coordinates only.
- P2 · M · There is no interference or clearance detection.
- P2 · S · Mirror copy offers only the YZ and XY world planes (`toolDefs.tsx:1640`), although the core mirror op also
  supports XZ (`packages/core/src/index.ts:323`). There is no picked plane or face.
- P2 · M · There is no Isolate and no multiple selection, so you cannot hide, move or delete several components.
- P3 · M · Explode is one automatic factor. There are no exploded-view steps the user can edit.
- P3 · S · Move and Rotate are absolute values only. There is no "by delta" or "to a picked point", and no snapping
  to another part.
- P3 · S · There is no Pattern Driven or curve-driven component pattern; only part `repeat` linear/circular
  (`toolDefs.tsx:1514-1535`).

## 20. Documents, autosave, undo/redo, settings

**App.** The project is one JSON file. Every model change is written right away (`apps/server/src/store.ts:187-224`), and
the File menu shows "Saved automatically". The File menu has New, Open, Rename, Save as copy, Export, Print settings,
Undo and Redo (`FileMenu.tsx:162-190`). Deleting a project moves it to `.trash` (`store.ts:152-169`). Undo is a
100-step server stack of whole-project snapshots; view state is left out (`store.ts:53-75,171-185`). The sketch has
its own undo (`Toolbar.tsx:404-410`). Sketch settings (grid, snap, polygon sides) live in browser memory only
(`toolDefs.tsx:465-487`).

**Gaps**
- P2 · M · There are no document units or precision. Lengths are always mm and angles degrees, and values are rounded
  for display to 2 decimals by `fmt` (`toolDefs.tsx:125`) → document units (mm, cm, m, in, ft) and decimal places,
  used by every field and readout.
- P2 · S · Ctrl+Z while a property manager is open (focus not in a field) undoes the model behind the open form
  (`Toolbar.tsx:402-415`). The form keeps its stale context → block model undo while a panel is open, or close the
  panel first.
- P2 · S · There is no undo list. Each Move nudge is a separate undo step (`toolDefs.tsx:1565-1570`).
- P3 · S · Sketch grid and snap settings are not saved and reset on reload.
- P3 · S · There is no System Options page: no mouse or view settings, spin increments, colours, or confirmation
  messages to bring back.
- P3 · S · Autosave writes the file on every change, including view-only changes (`store.mutate` with
  `undoable:false` still saves). There is no explicit save point or "revert to saved".
- P3 · S · The undo history is lost on project switch and server restart (in memory, `store.ts:105,116`). This matches
  SolidWorks closing a document, but the File menu does not say so.

Not available at all (beyond those above): drafting standard, dimension styles, image quality/tessellation settings,
material database, configurations, custom properties.

## 21. Evaluate

**SolidWorks.** Measure picks vertices, edges, faces and points across components, can show XYZ deltas and projected
distances, has unit and precision options, and can create sensors. Mass Properties uses the assigned material, a
selectable output coordinate system and override values, and reports principal axes and moments. Section View and
Interference Detection are separate tools. Check verifies geometry: invalid faces and edges, short edges, minimum
radius. **Not verified.**

**App.** Measure (`evaluateToolDefs.tsx:250-295`, being changed during this audit) works only in the part workspace,
on picked faces and edges of one part (`picked[0].partId`). Mass properties runs `mass_properties` with a density from
a colour-matched preset (`:63-90,162-206`; server `apps/server/src/hostTools.ts:179-210`). Check runs `cad_check`:
build errors, sizes and bed fit (`toolDefs.tsx:1888-1898`; `hostTools.ts:154-176`).

**Gaps**
- P2 · M · Measure cannot pick vertices or points, cannot measure between two parts, and does not work in the assembly
  (`evaluateToolDefs.tsx:253,264`).
- P2 · S · The density comes from the part's colour (`evaluateToolDefs.tsx:75-82`). Any custom colour falls back to PLA
  without a warning → use the part's assigned material (see 1).
- P2 · M · There is no Section View tool (see 16) and no geometry Check. `cad_check` reports build errors and bed fit
  only.
- P3 · S · Mass properties has no output coordinate system choice, no override and no principal axes, only moments.
  It also ignores the rollback bar, while the view honours it (not confirmed in the kernel path).
- P3 · S · Measure has no unit or precision options and no XYZ delta readout (not checked in `measure.ts`, which was
  mid-change).

---

## Top 10 for this area

1. P1 · S · Insert new features at the rollback bar, not at the end (3).
2. P1 · L · Selection boxes fed by picks in the view, used by fillet, chamfer, shell, hole and the rest; stop the
   ignored "Edges" dropdown when editing picked fillets (13).
3. P1 · S · Make Isolated / In context do something, or remove it (19).
4. P2 · M · Link tree and view selection both ways, with multiple selection (1).
5. P2 · S · SolidWorks mouse map, leaving left-drag free for box selection; Ctrl+click to add (15, 16).
6. P2 · M · Delete with child and absorbed options; suppress cascades to children (4, 7).
7. P2 · M · Number fields that take units and arithmetic, then document units and precision (12, 20).
8. P2 · S · Keep Visible pushpin, Enter = OK from the view, right-click OK (11).
9. P2 · S · Shortcut fixes: Ctrl+1…8 views, shortcuts working after load (prompt autofocus), Ctrl+S handled (18).
10. P2 · M · Display styles, orthographic toggle, Normal To and Section View (16).

## Not checked

- No SolidWorks help page body could be read (script-rendered). Every "SolidWorks" paragraph comes from excerpts or is
  marked Not verified, and should be rechecked once `docs/SOLIDWORKS_REFERENCE.md` exists.
- The running app was not used. Every finding is from reading code. The camera behaviour (17) and the triad click
  behaviour with camera-controls (drei `GizmoViewport` tweening against `CameraControls`) were not tried live.
- Whether exports and `cad_check` honour the rollback bar (`meshes.meshFor` path).
- Import of STEP/STL into a project (not looked for).
- `measure.ts`, `Manipulators.tsx` and `toolHandles.ts` in detail: they were being edited during the audit.
- How `effectivePart` treats a mirror feature written onto an instance by Mirror copy with "Keep original" off.
- Tests: there are no tests for the FeatureTree component, the Toolbar key handling, `Rig`, or the property manager
  frame. `store.test.ts` and `tools.test.ts` exist but were not read for undo or reorder coverage.
