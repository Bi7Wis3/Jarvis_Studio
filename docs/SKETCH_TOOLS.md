# SolidWorks sketch commands and what the app has

The full list of sketch-related commands in SolidWorks parts (2024 online help), compared with the app. Written so that each worker who builds a sketch tool knows what exists and where its exact behaviour is described: the option-level detail is in `docs/SOLIDWORKS_REFERENCE.md`, Part B.

How it was made: the command names come from the help's own groupings (Sketch Entities, Sketch Tools, Blocks, Splines, Dimensions and Relations, Sketch Settings menu, Sketch Options, 2D to 3D toolbar), read page by page. Where the help has no page for a command it says "Not verified". The "In the app today" column was read from the code: `DRAW_TOOLS`, `MODIFY_TOOLS`, `CONSTRAINT_TOOLS`, `constrainTools`, `modifyTools`, `sketchModeTools` in `apps/web/src/toolDefs.tsx`, `apps/web/src/sketchToolDefs.tsx`, `apps/web/src/sketchEditForms.tsx`, and the `SketchCurve` and `SketchConstraint` types in `packages/core/src/index.ts`.

Meaning of the status words:
- **yes**: the tool exists with the options the help lists (small cosmetic gaps are named).
- **partly**: the tool exists but options the help lists are missing; the missing ones are named.
- **no**: nothing in the app does this.

What the app's sketch can hold today: points, lines, circles and arcs (`SketchCurve` has only `line`, `circle`, `arc`), flagged construction or not. Every curve type that is not one of these (ellipse, parabola, conic, spline, text, picture, block) needs a new curve kind in the core type, the solver, the region finder and the extrude/revolve profile builder before its tool can exist. The relations are the `SketchConstraint` kinds; the dimensions are `distance`, `length`, `angle`, `radius`, `diameter`.

All help links are in the 2024 English help under `https://help.solidworks.com/2024/English/SolidWorks/sldworks/`.

## 1. Sketch entities

| SolidWorks command | What it does | In the app today | Help page |
|---|---|---|---|
| Line | Draws lines; Orientation As sketched / Horizontal / Vertical / Angle; options For construction, Infinite length, Midpoint line; Parameters Length and Angle; chain mode | partly: click chain, close on the start, typed length and angle. Missing: Orientation choices with a Parameters box, Infinite length, Midpoint line, Add dimensions | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_LINE_CMD.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Lines.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_LINE.htm |
| Infinite line (option of Line) | Line of infinite length that can later be trimmed; a finite line can be made infinite, not back | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Infinite_Lines.htm |
| Midpoint Line | Line symmetric about the first click | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_midpoint_line_help.htm |
| Centerline | Construction line for symmetry, mirror, revolve axis, radial/diametric dimensions | yes (construction line; mirror and revolve axis use it). Missing: dimensioning radius/diameter from it | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Centerlines.htm |
| Corner Rectangle | Rectangle from two corners | partly: two corners, typed width and height. Missing: Add construction lines (From Corners, From Midpoints), corner coordinate parameters | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Corner_Rectangles.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_RECTANGLES.htm |
| Center Rectangle | Rectangle from its centre | partly: same gaps as Corner Rectangle (centre X/Y parameters too) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Center_Rectangles.htm |
| 3 Point Corner Rectangle | Rectangle at an angle: first edge, then width | partly: same gaps | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_3_Point_Corner_Rectangles.htm |
| 3 Point Center Rectangle | Rectangle at an angle from the centre: half the centreline, then the width | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_3_Point_Center_Rectangles.htm |
| Parallelogram | Four edges, any angles | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Parallelograms.htm |
| Straight Slot | Slot from the two end centres, then the width | partly: two centres and the width (centre to centre). Missing: Overall Length measure, Add Dimensions, Fix Slot and Equal Slots relations, slot parameters box | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketch_Creating_Straight_Slot.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_SLOT.htm |
| Centerpoint Straight Slot | Slot from its centre point, then the end, then the width | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketch_Creating_Centerpoint_Straight_Slot.htm |
| 3 Point Arc Slot | Arc slot on a 3-point arc, then the width | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketch_Creating_3_Point_Arc_Slot.htm |
| Centerpoint Arc Slot | Arc slot from the arc centre, radius, length, then the width | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketch_Creating_Centerpoint_Arc_Slot.htm |
| Polygon | Equilateral polygon, 3 to 40 sides, by inscribed or circumscribed circle | partly: centre then a corner (inscribed only), sides set in Sketch settings (3 to 64). Missing: Circumscribed circle, Angle and Center/Diameter parameters, New Polygon, Edit Polygon | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Polygons.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_POLYGON.htm |
| Circle | Circle from centre and radius | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Circles.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_CIRCLE.htm |
| Perimeter Circle | Circle through three points | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Perimeter_Circles.htm |
| Centerpoint Arc | Arc from centre, start, end | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Centerpoint_Arcs.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_ARC.htm |
| Tangent Arc | Arc from the end of a line, arc, ellipse or spline; pointer motion picks tangent or normal arc | partly: tangent from a line or arc end, chains on. Missing: normal-arc intent zones, autotransition from the Line tool (press A), Reverse Endpoint Tangent | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Tangent_Arcs.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Autotransitioning.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_controlling_tangency_direction.htm |
| 3 Point Arc | Arc from start, end, a point on it | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_3_Point_Arcs.htm |
| Ellipse | Full ellipse from centre and two axes | no (needs a new curve kind) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Ellipses.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_ELLIPSE.htm |
| Partial Ellipse | Elliptical arc | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Partial_Ellipses.htm |
| Parabola | Parabola from focus, apex, extent | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Parabolas.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_PARABOLA.htm |
| Conic | Conic curve by endpoints, top vertex and Rho | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Conics.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Conics.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_BCONIC.htm |
| Spline | Through-point spline with handles, curvature control, control polygon | no (needs a new curve kind) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Multiple_Point_Splines.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_SPLINE.htm |
| Style Spline | Bezier or B-spline (degree 3, 5, 7) from control vertices | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_about_style_splines.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_style_spline_pm.htm |
| Spline on Surface | Spline whose points lie on a surface | no (surface models) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Splines_on_Surfaces.htm |
| Equation Driven Curve | Explicit y(x) or parametric x(t), y(t) | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_equation_driven_curves.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_EQCURVE.htm |
| Point | Sketch point; tool stays active | yes (X/Y parameters only through dimensions) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Points.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_POINT.htm |
| Text | Text on a flat sketch or along curves or edges; font, alignment, flip, width factor, spacing, link to property | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Text.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_TEXT.htm |
| Dissolve sketch text | Turns text into lines, arcs and splines | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_dissolving_sketch_text.htm |
| Plane (in a 3D sketch) | A plane inside a 3D sketch to sketch on | no (3D sketches only; see section 7) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CREATE_PLANE_NEW.htm |
| Sketch Picture | Picture on the sketch plane as a tracing underlay; Autotrace add-in makes vectors | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Picture.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_sketch_picture_pm.htm |

### Spline tools (Spline Tools toolbar)

| SolidWorks command | What it does | In the app today | Help page |
|---|---|---|---|
| Add Tangency Control | Adds a handle to control tangency at a spline point | no (no splines) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Adding_Tangency_Control_to_Splines.htm |
| Add Curvature Control | Adds a curvature pointer at a spline point | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Adding_Curvature_Control_to_Splines.htm |
| Insert Spline Point | Adds points to a spline | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Spline_Points.htm |
| Simplify Spline | Fewer points within a tolerance | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Simplify_Splines.htm |
| Fit Spline | One spline fitted to sketch segments, optionally linked | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Fit_Splines.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_STYLED_CURVES.htm |
| Show Spline Handles / control polygon | Shows the handles or polygon for editing | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Control_Polygons.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Spline_Handles.htm |
| Show Curvature Combs | Comb of slope and curvature on most entities | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Curvature_Combs.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_CURVATURE.htm |
| Show Inflection Points | Marks where concavity changes | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Displaying_Inflection_Points.htm |
| Show Minimum Radius | Shows the tightest radius of a spline | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_displaying_minimum_radius_spline.htm |
| Convert Spline Types | Spline, style spline, generic spline | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_convert_spline_types.htm |
| Fixed spline length (dimension) | Dimension that holds a spline's length | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_set_fixed_length_for_spline.htm |
| Insert Control Vertex, Local Edit (style spline) | Adds control vertices; edits one style spline without moving its neighbours | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_insert_control_vertex_pt.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_use_local_edit.htm |

### Blocks (Blocks toolbar)

| SolidWorks command | What it does | In the app today | Help page |
|---|---|---|---|
| Make Block | Freezes chosen sketch entities into one block, optional insertion point | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Making_Blocks.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Setting_Insertion_Points.htm |
| Edit Block | Opens a block to change entities, relations, dimensions | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Editing_Blocks.htm |
| Insert Block | Another instance of a block, or a saved block file; Block Scale, Block Rotation, Link to file | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Inserting_Blocks.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_INSERT_SKETCH_GROUP.htm |
| Save Block | Writes the block to an .sldblk file | no (local file; not planned) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Saving_Blocks.htm |
| Explode Block | Dissolves a block into plain entities | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Exploding_Blocks.htm |
| Rebuild Block | Refreshes the sketch while a block is open | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Rebuilding_Blocks.htm |
| Add/Remove (block entities) | Moves entities into or out of a block | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_adding_sketch_entities_blocks.htm |
| Nested blocks, block colour, hide or show a block | Blocks inside blocks; colour and visibility per block | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Making_Nested_Blocks.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Applying_Color_to_Blocks.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_hiding_and_showing_individual_blocks.htm |
| Belt/Chain | Tangent belt path round block circles for pulley layouts | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_SKETCH_BELT.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_using_traction_belts.htm |

## 2. Sketch tools

| SolidWorks command | What it does | In the app today | Help page |
|---|---|---|---|
| Sketch Fillet | Rounds a corner with a tangent arc | yes (Radius, Keep constrained corners, Dimension each fillet) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_FILLET.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Fillets.htm |
| Sketch Chamfer | Cuts a corner | yes (Angle-distance, Distance-distance, Equal distance) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_CHAMFER.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Sketch_Chamfers.htm |
| Offset Entities | Parallel copy of sketch entities, model edges or faces | partly: sketch curves with distance, Add dimensions, Reverse, Select chain, Bi-directional, Cap ends, Base/Offset construction. Missing: model edges and faces as sources | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OFFSET1.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Offset_Entities.htm |
| Offset on Surface | Offsets model edges or faces over a surface (Geodesic or Euclidean) | no (surface models, 3D sketch) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_offset_on_surface_pm.htm |
| Convert Entities | Projects model edges, loops, faces, other sketch curves onto the sketch plane, linked | no (nothing projects model geometry into a sketch) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Convert_Entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_CONVERT_ENTITIES.htm |
| Intersection Curve | Curve where a plane, face or surface meets the part or another surface | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Intersection_Curves.htm |
| Silhouette Entities | Outline of bodies projected onto the sketch plane (External silhouette option) | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_silhouette_entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_silhouette_entities_property_manager.htm |
| Face Curves | Iso-parametric curves of a face (Mesh or Position) as 3D sketches | no (3D sketches) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Face_Curves.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CONVERT_ISO_CURVES.htm |
| Segment | Equally spaced sketch points or equal-length segments on an entity (Number of Instances; Sketch points or Sketch segments) | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_equidistant_points_and_segments.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_spline_segments.htm |
| Trim Entities | Power trim, Corner, Trim away inside, Trim away outside, Trim to closest; keep as construction; ignore construction | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/hidd_trim_choices.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Trim_Entities.htm |
| Extend Entities | Lengthens a line or arc to the next entity | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Extend_Entities.htm |
| Split Entities | Splits one entity in two at a point (circles and closed curves take two points); deleting the split point rejoins | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_split_entities.htm |
| Jog Line | Adds a jog (step) to a line, kept parallel or perpendicular | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_JOG_LINE.htm |
| Construction Geometry | Switches entities to construction | yes (toggle on selected curves; no For construction check box while drawing) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Construction_Geometry.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_conversion_sketch_lines.htm |
| Make Path | Chain of end-to-end entities treated as one path for tangent relations (cams); path length dimension | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Make_Path.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_LOOP_PROP.htm |
| Mirror Entities | Mirrors chosen entities about a line, centerline or linear edge, with Copy | yes (Copy option; mirror about a model edge missing) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Mirror_Entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_MIRRORING.htm |
| Dynamic Mirror Entities | Pick the mirror line first, then sketch; new entities mirror live | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_DYNAMIC_MIRRORING.htm |
| Move Entities | Moves entities From/To or by X/Y; Keep relations; Repeat | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Moving_or_Copying_Sketch_Entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_Move_PropertyManager.htm |
| Copy Entities | Copies entities the same way | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_Copy_PropertyManager.htm |
| Rotate Entities | Rotates about a point by an angle | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Rotating_Sketch_Entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_Rotate_PropertyManager.htm |
| Scale Entities | Scales about a point; Copy with Number of Copies | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Scaling_Sketch_Entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_Scale_PropertyManager.htm |
| Stretch Entities | Moves chosen entities and stretches what is attached | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Stretching_Sketch_Entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_Stretch_PropertyManager.htm |
| Replace Entity | Swaps an entity for another, keeping its relations and dimensions | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_replace_sketch_entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_replace_entities_pm.htm |
| Linear Sketch Pattern | Rows and grids of entities; two directions; Instances to Skip | partly: spacing, count, angle, reverse, dimensions, second direction, skip list. Missing: direction taken from a line or edge, Display instance count, editing instances by right-click | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_PATTERN_LINEAR.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Linear_Sketch_Patterns.htm |
| Circular Sketch Pattern | Entities round a centre; Equal spacing; Instances to Skip | partly: centre, spacing, equal spacing, count, dimension radius and angle, skip list. Missing: Display instance count, centre picked from a sketch point or origin by click | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_PATTERN_CIRCULAR.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Circular_Sketch_Patterns.htm |
| Cut, copy and paste sketch entities; paste a whole sketch | Ctrl+C / Ctrl+V of entities between sketches and documents | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Cutting_Copying_and_Pasting_Sketch_Entities.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Copying_and_Pasting_Entire_Sketches.htm |
| Create Sketch from Selections | Turns selected entities of a 2D-to-3D sketch into a new sketch | no (it is on the 2D to 3D toolbar) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_2d_to_3d_toolbar_import_export.htm |
| Repair Sketch | Finds and fixes tiny entities, overlaps, gaps | partly: gaps, duplicates, overlaps, tiny pieces, dangling relations. Missing: report of points shared by three or more entities | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_SKETCH_GEOM_DIAGNOSTICS.htm |
| SketchXpert | Diagnose over-defined sketches: cycles solutions, or Manual Repair of conflicts | partly: the Relations list marks conflicting and redundant items and deletes them. Missing: Diagnose with Results to cycle, Accept, Suppressed | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_XPERT.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_SketchXpert.htm |
| Align Grid/Origin | Re-places the sketch origin and axes | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_ALIGN_GRID.htm |
| Modify Sketch | Moves, rotates, scales or flips the whole sketch | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_MODIFY_SKETCH.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Moving_Sketches.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Rotating_Sketches.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Scaling_Sketches.htm |
| Close Sketch to Model | Closes an open profile with model edges | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Closing_Sketches_to_Models.htm |
| Check Sketch for Feature | Checks the sketch against the contour type a feature needs | no (the finish step only counts open chains) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_SKETCH_DIAGNOSTICS.htm |
| Shaded Sketch Contours | Shades closed contours; drag, relate, extrude them | partly: closed regions are found and can be picked as contours for extrude, cut, revolve. Missing: shaded display, dragging a contour, Alt-click context extrude | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Shaded_Sketch_Contour.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Extruding_Shaded_Sketch_Contours.htm |
| Selected Contours | Features use some contours of a sketch (and model edges) | partly: sketch regions yes. Missing: contours that include model edges | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Selecting_Contours.htm |
| Instant2D | Drag dimension handles in the view to change values | partly: dimension labels can be dragged and the value edited. Missing: value handles and on-screen rulers | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Modifying_2D_Sketch_Dimension_Instant2D.htm |
| Rapid Sketch | Starts a sketch by hovering a planar face while a sketch tool is active | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Using_RapidSketch.htm |
| Sketch (start or exit) and Edit Sketch Plane | Opens a sketch on a plane or face; moves an existing sketch to another plane or face | partly: start on a plane or face with offset and tilt, exit, discard. Missing: Edit Sketch Plane for an existing sketch, sketch references list | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_sketching_sketch_entities_tool.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_PLANE.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Exiting_Sketches.htm |
| Sharing Sketches | One sketch used by several features | yes (sketch steps are shared by id) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sharing_Sketches.htm |
| Derived Sketch | A sketch that follows another, placed on another face | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Derived_Sketches.htm |
| Sketch Ink / Touch Tool | Freehand pen strokes turned into sketch entities (Auto Shape, Power Modify, ...) | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_sketch_ink_toolbar.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Touch_Tool.htm |
| Slicing | 2D sketch sections where a plane cuts a body or mesh | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_slicing_tool.htm |

### 2D to 3D toolbar (sketch conversion)

| SolidWorks command | What it does | In the app today | Help page |
|---|---|---|---|
| Add to Front, Top, Right, Left, Bottom, Back Sketch; Auxiliary Sketch | Marks selected entities of one imported drawing as a view | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_2d_to_3d_toolbar_import_export.htm |
| Align Sketch | Aligns one extracted view sketch to another | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Aligning_Sketches.htm |
| Convert to Extrusion, Convert to Cut | Extrudes or cuts from selected entities of the view sketches | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Extruding_in_2D_to_3D.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Cutting_in_2D_to_3D.htm |
| Select Chain | Selects the chain of entities attached both ways until a branch | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Additional_Conversion_Tools.htm |

## 3. Relations and dimensions

| SolidWorks command | What it does | In the app today | Help page |
|---|---|---|---|
| Add Relation (PropertyManager) | Adds a relation from the list that suits the selection; For construction | partly: 14 relations (Coincident, Merge Points, Horizontal, Vertical, Collinear, Parallel, Perpendicular, Tangent, Concentric, Coradial, Equal, Midpoint, Symmetric, Fix). Missing: Intersection, Pierce, Equal Curvature, Torsion Continuity, Doubled Distance, Equal Slots, Fix Slot, Equal curve length across types, Traction, relations to model edges and external geometry | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_DEFAULT.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Geometric_Relations.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Description_of_Sketch_Relations.htm |
| Display/Delete Relations | Lists relations with filters; Delete, Delete All, Suppress, Replace; Configurations | partly: list with All, Dangling, Problems filter, Delete, Delete all, hover highlight. Missing: External, Defined In Context, Locked, Broken, Selected Entities filters; Suppressed; Replace; per-configuration | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SK_EDIT_RELATIONS.htm |
| Smart Dimension | One tool; the type follows the selection and cursor (length, distance, angle, radius, diameter, arc length, to midpoint, doubled distance) | partly: line length, point to point (horizontal, vertical or aligned), point to line, angle, radius, diameter. Missing: arc length, midpoint pick, doubled distance to a centerline, arc extremes, locking the type, tolerance | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Dimensioning_a_2D_Sketch.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Dimensions_Between_Arcs_or_Circles.htm |
| Horizontal Dimension, Vertical Dimension | Forces the measure along the sketch X or Y | partly: reachable as a distance on the U or V axis; no tools of their own | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Horizontal_Dimensions.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Vertical_Dimensions.htm |
| Ordinate, Horizontal Ordinate, Vertical Ordinate | Dimensions from a zero point, aligned in a group | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Ordinate_Dimensions.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Horizontal_Ordinate_Dimensions.htm |
| Path Length Dimension | Length of a chain of entities | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_create_path_length_dimensions.htm |
| Angular Running Dimension | Angles from a zero line | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Angular_Running_Dimension.htm |
| Auto Insert Dimension (context toolbar) | Dimension from the context toolbar for selected entities | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Control_Dimension_Context_Toolbar.htm |
| Driven (reference) dimensions; Sketch Dimension Driven; Add Dimension while drawing | Dimensions that report but do not drive; shown on creation | no (a dimension that over-defines is refused, not made driven) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Inserting_Reference_Dimensions.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Displaying_Dimensions.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Driven_Dimensions.htm |
| Fully Define Sketch | Calculates relations and dimensions to define a sketch | partly: adds dimensions for the remaining freedom. Missing: choice of relations, Baseline/Ordinate/Chain schemes, datum, placement | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_FULLY_DEFINE_SKETCH.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Fully_Defined_Sketches.htm |
| Dimension to spline handles, lock dimension type, zero and negative dimensions, ghost of a missing reference, maintain proportions of first dimension | Dimension refinements | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Dimensioning_to_Spline_Handles.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Locking_Dimensions.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_zero_negative_dimensions.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_displaying_ghost_image.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_maintain_proportion.htm |
| Sketch status colours | Black fully defined, blue under defined, red over defined, yellow invalid or conflict, brown dangling | yes (defined and under defined are coloured; conflicts reported) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Geometry_Status.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Status_Conventions.htm |

## 4. Sketch settings and options

| SolidWorks command | What it does | In the app today | Help page |
|---|---|---|---|
| Automatic Relations | Adds relations while sketching; Ctrl suppresses | partly: inferred while drawing (horizontal, vertical, coincident, midpoint, on curve). Missing: switch off, Ctrl to suppress, perpendicular, tangent, parallel inference | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Using_Automatic_Relations.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Inferencing.htm |
| Automatic Solve | Solves while sketching; off while editing many dimensions | no (always solves; no switch) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Using_Automatic_Solve.htm |
| Enable snapping | Turns on all Sketch Snaps except Grid | yes (Snap to grid and points, plus per-snap list) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Settings_Menu.htm |
| Quick Snaps | Single-use snap filters: Point, Center Point, Midpoint, Quadrant, Intersection, Nearest, Tangent, Perpendicular, Parallel, H/V, H/V Point, Length, Grid, Angle | partly: End points, Centres, Midpoints, Quadrants, Intersections, On curve, Alignment guides, Grid. Missing: Tangent, Perpendicular, Parallel, Length (Shift), Angle snap, double-click to keep | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Quick_Snaps.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Snaps.htm |
| Grid/Snap (document) | Display grid, Dash, Automatic scaling, Major grid spacing, Minor-lines per major, Snap points per minor | partly: grid step and snap on or off. Missing: the rest | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OPTIONS_GRID.htm |
| No Solve Move | Moves entities without solving dimensions or relations | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Using_No_Solve_Move.htm |
| Detach Segment on Drag | Pulls an endpoint away from what it joins | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Using_Detach_Segment_On_Drag.htm |
| Override Dims on Drag/Move | Dragging a dimensioned entity changes its driving dimension | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Override_Dims_on_Drag_Move.htm |
| Sketch Numeric Input | Type sizes while creating lines, rectangles, circles, arcs | yes (typed value with Enter while drawing) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_numeric_sketch_input.htm |
| Shaded Sketch Contours (setting) | See section 2 | partly | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Shaded_Sketch_Contour.htm |
| Sketch Options (System Options): auto-rotate normal to sketch plane | Turns the view normal on opening or editing a sketch; restores on discard | yes (view tips to the sketch and returns on leaving) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OPTIONS_SKETCH.htm |
| Sketch Options: Use fully defined sketches | Refuses features from sketches not fully defined | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OPTIONS_SKETCH.htm |
| Sketch Options: Display entity points with status colours; arc centrepoints | Endpoint dots coloured by state | yes | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OPTIONS_SKETCH.htm |
| Sketch Options: Prompt to close sketch; Create sketch on new part; Display plane when shaded; Preview sketch dimension when selected | Convenience options | partly: sketch on a new part works; the rest are missing | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OPTIONS_SKETCH.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_previewing_sketch_dimensions.htm |
| Sketch Options: spline tangency handles, control polygon by default | Spline display | no (no splines) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OPTIONS_SKETCH.htm |
| Relations/Snaps options (snap angle, snap to model geometry) | Snap settings | no | https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Snaps.htm |
| Sketch Relations visibility (View > Hide/Show > Sketch Relations) | Show or hide relation icons | no (switch not found in the sketch tools) | https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_view_sketch_relations.htm |

## 5. Counts

Counted from the tables above (one row is one command or one closely tied group listed on one row):

- Rows: 128. yes: 24. partly: 26. no: 78.

## 6. Cannot be done sensibly in this app

- **2D sketching in drawings, drawing dimensions (Baseline, Chain, Chamfer dimension, Symmetric Linear Diameter, Scan Equal, Isolate Changed Dimensions)**: these exist on drawing sheets and the app has no drawings yet (a later roadmap phase). Ordinate and Angular Running dimensions are listed as "no" above because they also exist in sketches.
- **Assembly layout sketch, Make Part from Block, Traction relation between blocks, Defined In Context and External (other model) relations**: they relate a sketch to other components of an assembly. Nothing is sketched in the context of another part in the app today; relations to other sketches in the same part are possible.
- **Sketch Ink and Touch Tool**: made for pen and touch devices; the app is a desktop pointer app.
- **Sketch Picture Autotrace**: a separate add-in of SolidWorks; the picture underlay itself is possible.
- **Slicing**: slices mesh bodies; the app has no mesh bodies.
- **Offset on Surface, Face Curves, Spline on Surface**: work on surface models (surface bodies); the app builds solids only and has no surface bodies yet.
- **Save Block as an .sldblk file**: a file format of SolidWorks. Blocks themselves can be built; saving one would be the app's own part file or none.
- **Configuration-specific relation and dimension settings (Suppressed per configuration, Sketch Relations in Configurations)**: the app has no configurations yet (roadmap).

## 7. 3D-sketch-only commands

Out of scope until the app has 3D sketches (a sketch whose points are not on one plane). Listed so nothing is lost.

- 3D Sketch, 3D Sketch On Plane (https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Beginning_a_3D_Sketch.htm)
- Plane in a 3D sketch with First, Second, Third Reference, Plane Properties (https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CREATE_PLANE_NEW.htm, https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_3D_PLANE.htm)
- 3D Line, 3D Point, 3D Arc, 3D Circle, 3D Spline PropertyManagers (https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Lines_in_3D_Sketches.htm, https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_POINT_3D.htm, https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_ARC_3D.htm, https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_CIRCLE_3D.htm, https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_SPLINE_3D.htm)
- Space Handles and Tab to change plane, Sketcher Triad, Line Snap, Virtual Sharps (https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Space_Handles.htm, https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Line_Snap.htm, https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Virtual_Sharps.htm)
- Relations Along X, Along Y, Along Z, Parallel YZ, Parallel ZX, Normal, Pierce to a plane (https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Relations_in_3D_Sketches.htm)
- 3D dimension types Absolute, Along X, Along Y, Along Z (https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_3D_dimension_types.htm)
- Face Curves and Offset on Surface (see section 2); Intersection Curve and Convert Entities also make 3D sketches when no plane is chosen

## 8. Not verified

- Numbered steps of "Creating an Equation Driven Curve" (page returned no text; the PropertyManager page was read).
- "Create Sketch from Selections" has no own page in the 2024 help; it is described only on the 2D to 3D toolbar page and in Additional Conversion Tools.
- The Modify Dimension, Dimension PropertyManager (tolerance, leaders) and Dimension Value pages were not re-read here; the older section "Smart Dimension" in the reference covers them.
- The topics "Sketch Entities Overview", "Sketch Tools Overview", "Sketching Overview", "Sketch Relations Callouts" and "Dimensions Overview" under those exact names do not exist as pages; the group pages `c_sketch_entities_top.htm`, `c_sketch_tools_top.htm`, `c_sketching_top.htm`, `c_dimensions_relations_top.htm` were used instead.
