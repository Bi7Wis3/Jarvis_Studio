# SolidWorks reference for Jarvis Studio

Specification notes for extending the app's tools so each offers the options SolidWorks offers. Compiled from the official SolidWorks Design Help (2024 release unless stated), paraphrased. Names of buttons, fields and commands are the SolidWorks UI names.

How the pages were read: `help.solidworks.com` pages are a JavaScript shell, so WebFetch returns only navigation. The page text was obtained by requesting the page HTML and reading the embedded page data (the same text the browser shows). Every "Source:" URL below was read this way, in the 2024 English help, unless a section says otherwise. Where a topic could not be found or read it says "Not verified".

Conventions: "PM" = PropertyManager. Drop-down values are listed with `|`. "(boss only)" etc. means the option appears only for that feature variant.

---

## Part A. Features

### Extruded Boss/Base, Extruded Cut (and Extruded Surface)
One PM for all three: sweeps a sketch along a direction.
- **From**: Sketch Plane | Surface/Face/Plane (planar or not; the sketch must lie inside a non-planar start face and follows its shape) | Vertex | Offset (a plane offset from the sketch plane; enter the offset value).
- **Direction 1** (end condition drop-down + Reverse Direction button):
  - Blind (Depth value). Through All (past all geometry). Through All - Both (both directions; needs Direction 1/2 together). Up to Next (to the next surface that the whole profile hits). Up to Vertex (pick a vertex). Up to Surface (pick face/plane; double-clicking a surface sets this; can auto-extend one analytic face). Offset From Surface (pick face/plane, Offset Distance, Reverse offset, Translate surface = end face is a translated copy instead of a true offset). Up to Body (pick a solid/surface body, useful in assemblies/moulds). Mid Plane (Depth split equally both sides).
  - Direction of Extrusion: pick a vector (edge, axis, plane normal...) to extrude other than normal to the sketch.
  - Flip side to cut (cuts only): removes material outside the profile instead of inside.
  - Normal cut (sheet-metal cuts only). Merge result (boss/base only; unchecked = separate solid body). Link to Thickness (sheet metal only).
  - Draft On/Off with Draft Angle and Draft outward checkbox.
- **Direction 2**: same fields as Direction 1; extrudes the opposite way from the sketch plane.
- **Thin Feature**: Type = One-Direction | Mid-Plane | Two-Direction (Direction 1 Thickness, Direction 2 Thickness); Auto-fillet corners + Fillet Radius (open sketches only); Cap ends + Cap Thickness (first body only). Required for open contours, optional for closed ones.
- **Selected Contours**: pick regions or open/closed contours from the sketch (also model edges) to use instead of the whole sketch.
- **Feature Scope** (cuts/multibody): which bodies/components the feature affects. Feature Scope listing is available when Geometry pattern is used in multibody parts.

Notes: Direction 2 and Through All - Both are the way to get a symmetric-through cut. Mid Plane is different from Direction 1+2 because depth is one number. Thin feature with a cut removes only the wall band. Merge result off creates a new body (multibody part).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_extrude_propertymanager.htm ; https://help.solidworks.com/2024/english/SolidWorks/sldworks/c_end_condition_extrude.htm (only images/short text; not detailed).
Feature scope choices: the linear pattern page names All bodies | Selected bodies; an Auto-select option exists in the product but was not on the pages read (Not verified).

### Revolved Boss/Base, Revolved Cut (and Revolved Surface)
- **Axis of Revolution**: a centerline, sketch line or model edge (a centerline/line in the same sketch, or an edge).
- **Direction 1** - Revolve Type: Blind (Direction 1 Angle) | Up to Vertex | Up to Surface (face/plane) | Offset from Surface (Offset Distance, Reverse offset) | Mid-Plane (angle split both sides). Reverse Direction button. Flip side to cut (cuts: removes outside of profile). Merge result (boss/base).
- **Direction 2**: optional second end condition for the other side; same options.
- **Thin Feature**: Type One-Direction | Mid-Plane | Two-Direction; Direction 1 Thickness (and Direction 2 Thickness for Two-Direction); Reverse Direction.
- **Selected Contours**: pick any combination of regions of the sketch; multiple selected regions can give multibody results.
- **Feature Scope**.
Notes: profile must not cross the axis (stated in the 2025 help, not verified for 2024). A Blind angle default is 360 for a full revolve.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_REV.htm

### Swept Boss/Base
- **Sketch Profile**: Profile (closed for a boss), Path (open or closed, one sketch/curve/set of edges; path start must lie on the profile plane). When the path passes through the profile: Direction 1, Bidirectional (both ways; cannot use guide curves or start/end tangency), Direction 2 (twist can be set per direction).
- **Circular Profile**: a solid rod or tube straight along a line/edge/curve, with a Diameter (no profile sketch). Neither section, path nor result may self-intersect.
- **Guide Curves**: list of curves that steer the profile (must touch the profile or a point in its sketch); Move Up/Move Down order; Merge Smooth Faces (clear it to segment at every non-curvature-continuous point for better guide matching/performance); Show Sections (arrows by section number).
- **Options**: Profile Orientation = Follow Path | Keep Normal Constant. Profile Twist = None (2D paths) | Minimum Twist (3D paths) | Follow Path and First Guide Curve | Follow First and Second Guide Curves | Specify Twist Angle (units Degrees | Radians | Revolutions; closed paths need a whole number of turns) | Specify Direction Vector (plane/face/line/edge/axis/two vertices; not with Keep Normal Constant) | Tangent to Adjacent Faces (when attaching to geometry) | Natural (3D paths; may be unpredictable). Merge Tangent Faces (no effect with guide curves). Show Preview.
- **Start and End Tangency**: Start Tangency Type and End Tangency Type each None | Path Tangent.
- **Curvature Display**: Mesh Preview (+ Mesh Density), Zebra Stripes, Curvature Combs (Direction 1/2, Scale, Density, Edit Color).
Source: https://help.solidworks.com/2024/english/SolidWorks/sldworks/r_swept_boss_base_property_manager.htm

### Swept Cut
Same groups as Swept Boss/Base plus:
- **Solid Profile** (Solid Sweep): a Tool Body (convex, not merged to the main body; a revolved feature made of lines/arcs only, or a cylindrical extrude) swept along a Path that must be tangent-continuous and start on/in the tool body. Not available for assembly features. Typical use: cuts around cylinders, end-mill simulation.
- Sketch Profile, Circular Profile, Guide Curves, Options, Start and End Tangency, Feature Scope, Curvature Display.
- Thin feature options are not listed on the cut page that was read (Not verified).
Source: https://help.solidworks.com/2024/english/SolidWorks/sldworks/r_swept_cut_property_manager.htm

### Lofted Boss/Base, Lofted Cut (and Lofted Surface)
- **Profiles**: ordered list of sketch profiles/faces/edges (selection order matters; choose the connection point on each); Move Up / Move Down. Reselect to move connection points if the preview twists.
- **Start/End Constraints** (per end): Default (needs 3+ profiles; fits a parabola between first and last) | None | Direction Vector (pick direction entity; Draft angle; Tangent Length) | Normal to Profile (Draft angle; Tangent Length) | Tangency to Face | Curvature to Face (both only when attached to existing geometry; Next Face toggle). Reverse Direction; Reverse Tangent Direction; Apply to all (one handle per profile vs per segment).
- **Guide Curves**: Guide curves influence = To next guide | To next sharp | To next edge | Global. Guide curve list with Move Up/Down. Guide tangency type = None | Normal to Profile | Direction Vector | Tangency to Face (guide lies on existing geometry edge; best within about 2 degrees), with Draft angle.
- **Centerline Parameters**: Centerline (a sketch/curve), Number of Sections (slider), Show Sections.
- **Sketch Tools**: Drag Sketch (for 3D sketch contours), Undo sketch drag.
- **Options**: Merge tangent faces; Close loft (joins last to first); Show preview (Transparent/Opaque via right-click); Merge result; Micro tolerance.
- **Thin Feature**: One-Direction | Mid-Plane | Two-Direction, thickness fields, Reverse Direction.
- **Curvature Display**; **Feature Scope**.
Source: https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_DVE_FEAT_LOFT.htm

### Boundary Boss/Base, Boundary Cut (and Boundary Surface)
- **Direction 1** and **Direction 2** (identical fields, interchangeable): Curves (ordered list of sketch curves/faces/edges; choose the connection point on each; right-click Flip Connectors if mismatched; Move Up/Down). Dir curves influence = Global | To Next Curve | To Next Sharp | To Next Edge | Linear (one choice applies to all curves of that direction). Tangent Type per curve = Default (3+ curves) | None | Normal to Profile | Direction Vector | Tangency to Face | Curvature to Face (the last two only when attaching to existing geometry), plus Alignment (single direction only), Direction Vector entity, Draft Angle, Tangent influence (%) (only with Global or To Next Sharp and curves in both directions; not for None/Default), Tangent Length (+ Reverse Tangent Direction), Apply to all (single direction only).
- **Options and Preview**: Merge tangent faces, Close Surface, Trim by direction 1 and direction 2 (when curves are not a closed boundary), Drag Sketch / Undo sketch drag (3D sketch only), Show preview.
- **Curvature Display**: Mesh preview/density, Zebra stripes, Curvature combs.
Source: https://help.solidworks.com/2024/english/SolidWorks/sldworks/r_boundary_pm.htm
Not verified: boss/cut-specific merge options (Merge result for boss) and Feature Scope for boundary cut; the page read is the shared PM page.

### Fillet
Mode switch at top: Manual | FilletXpert (symmetric constant radius only; the software manages the underlying features; hidden when editing). Fillet Type: Constant Size | Variable Size | Face | Full Round. Source index: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_fillet_propertymanager.htm

**Constant Size** (https://help.solidworks.com/2024/english/SolidWorks/sldworks/r_constant_size_fillets.htm)
- Items to Fillet: Edges, Faces, Features and Loops (pick any of these); Show selection toolbar; Tangent propagation (continues through tangent faces/edges); preview mode Full | Partial (A key cycles edges) | No preview.
- Fillet Parameters - Fillet Method: Symmetric | Asymmetric.
  - Symmetric: Radius; Multiple radius fillet (different radius per edge; not on faces/loops with shared edges); Profile = Circular | Conic Rho (0 to 1) | Conic Radius | Curvature continuous.
  - Asymmetric: Distance 1, Distance 2, Reverse Direction; Profile = Elliptic | Conic Rho; Curvature continuous.
- Setback Parameters: Setback Vertices, Distance, Setback Distances list (per edge), Set Unassigned, Set All. Blends the corner smoothly starting at that distance along each edge.
- Partial Edge Parameters: Start condition and End condition each None | Offset Distance | Percentage Offset | Selected Reference.
- Fillet Options: Select through faces; Keep Features (cuts/bosses survive a large fillet); Round corners (2+ adjacent edges); Overflow type = Default | Keep edge | Keep surface (for closed single edges meeting others); Feature attachment: Omit attach edges (when a feature is selected, skip the edges where it joins).

**Variable Size** (https://help.solidworks.com/2024/english/SolidWorks/sldworks/r_Variable_Size_Fillet.htm; control points: .../c_Using_Variable_Radius_Control_Points.htm)
- Items: Edges to Fillet, tangent propagation, previews as above.
- Fillet Method Symmetric | Asymmetric. Attached Radii list (vertices + control points), Radius (or Distance 1/Distance 2 + Reverse Direction), Set All. Profile Circular | Conic Rho | Conic Radius (+ Curvature continuous) or Elliptic | Conic Rho. Number of Instances (control points on the edge). Transition: Smooth transition | Straight transition. Vertices touching several filleted edges appear as multi-edge control points; orientation can be reversed per edge.
- Setback Parameters and Fillet Options (Select through faces, Overflow type) as in Constant Size.

**Face Fillet** (https://help.solidworks.com/2024/english/SolidWorks/sldworks/r_Face_Fillets.htm)
- Joins non-adjacent, non-continuous faces. Face Set 1, Face Set 2 (each set must be smoothly connected to propagate), tangent propagation, previews.
- Fillet Method: Symmetric (Radius, Profile Circular | Conic Rho | Conic Radius, Curvature continuous) | Chord Width (Chord Width value; Circular, Curvature continuous) | Asymmetric (Distance 1/2, Reverse Direction, Elliptic | Conic Rho) | Hold Line (pick part edges or projected split lines as boundary that drives the radius).
- Options: Select through faces; Constant width; Help point (vertex on the side where the blend should be); Trim Surfaces (surfaces only): Trim and attach | Don't trim or attach.

**Full Round** (https://help.solidworks.com/2024/english/SolidWorks/sldworks/r_Full_Round_Fillets.htm)
- Side Face Set 1, Center Face Set, Side Face Set 2 (three adjacent face sets); tangent propagation; previews. The radius is derived from the center face width; no radius field.

Notes: default type is Constant Size; Multiple radius needs separate radius per edge; corners with three edges and different radii are allowed. FilletXpert adds Add / Change / Corner tabs (pages HIDD_FILLET_MGR_ADD, _EDIT, _CORNER, not read in detail).

### Chamfer
Chamfer Type (buttons): Angle Distance | Distance Distance | Vertex | Offset Face | Face Face.
- **Items to Chamfer**: Edges, Faces and Loops (angle-distance, distance-distance); Edges, Faces, Features and Loops (offset face); Vertex to chamfer (vertex type); Face Set 1 / Face Set 2 (face face). Show selection toolbar (not for vertex/face-face), Tangent propagation, preview Full | Partial | No preview. Edit mode lists missing references at the top of the list (Repair Missing References).
- **Chamfer Parameters** (depends on type):
  - Angle Distance: Distance and Angle, Flip direction (also by clicking the arrow handle).
  - Distance Distance: Chamfer Method = Symmetric (one value) | Asymmetric (Distance 1 and Distance 2); flip.
  - Vertex: three distances (one per edge at the vertex), or Equal Distance (one value).
  - Offset Face: Offset Distance; Multi Distance Chamfer (symmetric only; select several entities then edit each callout). Works across non-planar neighbours and per-edge direction changes.
  - Face Face: Chamfer Method = Symmetric | Asymmetric | Chord width (Width) | Hold line (one hold line gives symmetric; one or two lines drive an asymmetric blend).
- **Partial Edge Parameters** (offset face): Start condition and End condition each None | Offset Distance | Percentage Offset | Selected Reference.
- **Chamfer Options**: Select through faces; Keep features; Help point (face face only; vertex on the side where the chamfer should land).
Notes: default values are not stated on the page read (Not verified). The vertex type is chosen at a vertex where three edges meet.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_chamfer_pm.htm ; partial example https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_partial_chamfer.htm (not read in detail)

### Shell
- **Parameters**: Thickness (kept walls); Faces to remove (zero faces = closed hollow part; multibody parts also show a Solid Body box until a face/body is picked); Shell outward (grows outer size instead of eating inward); Show preview.
- **Multi-thickness Settings**: Multi-thickness Faces (pick faces that differ), then Multi-thickness(es) value per selected face in the list.
- Error diagnostics section exists in the PM (Shell Feature Diagnostics); shell faces tangent/short geometry is the usual failure; fillets are best added before shelling.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_SHELL.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Shell_with_MultiThickness_Faces.htm
Not verified: the exact PM field layout is derived from the procedural topics; no dedicated "Shell PropertyManager" reference page was found.

### Draft
Toggle at the top: Manual | DraftXpert (neutral plane only; the software manages features; absent when editing).
- **Detailed Preview** (after Direction is set): highlight new or modified faces; show only new or modified bodies.
- **Type of Draft**: Neutral plane | Parting line | Step draft. Allow reduced angle (parting line only: allows drafts where the sum would reach 90 degrees). Tapered steps | Perpendicular steps (step draft only).
- **Draft Angle**: single value for neutral plane and step draft (measured perpendicular to the neutral plane). For parting line: Direction 1 angle, Direction 2 angle (opposite side), Symmetrical Draft.
- **Neutral Plane** (neutral plane type): a plane or planar face; Reverse direction slants the draft the other way.
- **Faces to Draft** (neutral plane only): the faces; Face Propagation = None | Along Tangent | All Faces | Inner Faces | Outer Faces.
- **Direction of Pull** (parting line / step): an edge, face or plane; Reverse Direction.
- **Parting Lines** (parting line / step): pick parting-line edges; Other Face (per-segment different draft side; not when Direction 2 angle is set); Face Propagation = None | Along Tangent.
Notes: step draft needs at least one parting-line segment on the parting plane per draft face and none perpendicular to it. Reverse direction changes the slant not the pull direction.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_DRAFT.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_parting_line_with_step_draft.htm ; https://help.solidworks.com/2024/english/SolidWorks/sldworks/t_parting_line_draft.htm

### Rib
- **Parameters**: Thickness side = First Side | Both Sides | Second Side; Rib Thickness value; (if drafted) thickness measured At sketch plane | At wall interface; Extrusion Direction = Parallel to Sketch | Normal to Sketch; Flip material side; Draft On/Off + Draft Angle + Draft Outward; Type = Linear (extend contours along the sketch direction until a boundary) | Natural (extend using the contour's own curve equation); Selected body (multibody); Next Reference (draft reference contour toggle, parallel-to-sketch with draft).
- **Selected Contours**: sketch contours used.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_FEAT_RIB.htm
Notes: ribs use open or closed sketch contours; sketch can be on a plane parallel to the base part's plane.

### Wrap
- **Wrap Type**: Emboss (raised) | Deboss (indented) | Scribe (imprint only).
- **Wrap Method**: Analytical (sketch onto planar/cylindrical/conical/extruded faces; sketch plane must be tangent to the face) | Spline Surface (any face type; cannot wrap around the model).
- **Wrap Parameters**: Source Sketch (closed contours only; open contours not allowed), Face for Wrap Sketch, Thickness, Reverse direction, Pull Direction (line, linear edge or plane; blank = normal to sketch; emboss/deboss only). Scribe works with single-line fonts.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SURF_WRAPPING_SKETCH.htm

### Dome
- **Faces to Dome** (planar or non-planar; several at once), Distance, Reverse Direction (concave; default convex), Constraint Point or Sketch (sketch with points shapes the dome; disables Distance), Direction (vector, other than face normal), Elliptical dome (cylinders/cones), Continuous dome (polygons; not for 4-sided polygons nor with constraint sketch/direction), Show preview. Distance 0 allowed on cylindrical/conical faces (dome tangent to the side).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_dome.htm

### Mirror (feature)
- **Mirror Face/Plane** (plane or planar face), **Secondary Mirror Face/Plane** (parts only; second plane in the same feature; Mirror seed only when the planes are perpendicular).
- Pick what to mirror: **Features to Mirror** | **Faces to Mirror** (parts only; for imported geometry) | **Bodies to Mirror** (solid/surface bodies, parts only).
- **Options**: Geometry Pattern (copy geometry only; required to mirror features onto another body in a multibody part; not for features merged with the rest), Merge solids (solid bodies), Knit surfaces (surface bodies), Propagate visual properties.
- Also usable in assemblies (assembly features).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_MIRROR.htm

### Linear Pattern
- **Direction 1**: Pattern Direction (linear edge, line, axis, dimension, planar face, conical face, circular edge, reference plane) + Reverse Direction; Spacing and instances (Spacing, Number of Instances including the original) | Up to reference (Reference Geometry, Offset distance, Reverse offset direction, Centroid | Selected reference + Seed Reference).
- **Direction 2**: same fields; Symmetric (mirrors the Direction 1 parameters), Pattern seed only (Direction 2 uses only the seed, not the Direction 1 instances).
- **Features to Pattern** | **Faces to Pattern** (faces must stay within the same face boundary) | **Bodies to Pattern** (multibody).
- **Instances to Skip** (click instance dots; click again to restore).
- **Feature Scope** (with Geometry pattern): All bodies | Selected bodies.
- **Options**: Vary sketch, Geometry pattern, Propagate Visual Properties.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Linear_Patterns_Overview.htm

### Circular Pattern
- **Direction 1**: Pattern Axis (axis, circular edge, linear edge or line, cylindrical/revolved face, angular dimension) + Reverse Direction; Instance spacing; Equal spacing (sets 360 degrees) | Angle; Number of Instances.
- **Direction 2**: enabled by checkbox; Symmetric; same spacing fields.
- **Features and Faces**: Features to Pattern | Faces to Pattern. **Bodies**: Solid/Surface Bodies to Pattern. **Instances to Skip**. **Feature Scope**. Options as linear (Vary sketch, Geometry pattern, Propagate Visual Properties; not read on this page: Not verified).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_CPATTERN.htm

### Curve Driven Pattern
- **Direction 1**: Pattern Direction (curve, edge, sketch entity or sketch), Reverse Direction, Number of Instances, Equal spacing | Spacing, **Curve method** = Transform curve (keeps delta X/Y from the curve origin to the seed) | Offset curve (keeps normal offset distance), **Alignment method** = Tangent to curve | Align to seed, Face normal (3D curves; only mentioned in some releases - Not verified).
- **Direction 2**: checkbox; same set; with no curve picked an implicit pattern is made.
- Features / Faces / Bodies to pattern, Instances to Skip, Vary sketch, Geometry pattern, Propagate Visual Properties.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Curve_Driven_Pattern_Overview.htm

### Sketch Driven Pattern
- **Selections**: Reference Sketch (sketch containing points), Reference point = Centroid (of seed) | Selected point (+ Reference Vertex); Features to Pattern | Faces to Pattern; Geometry pattern; Propagate Visual Properties. The seed is copied to every sketch point.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_PATTERN_BY_SKETCH.htm

### Table Driven Pattern
- Dialog: Read a file from (.sldptab or two-column text of X,Y), Reference point = Selected point (vertex/sketch point) | Centroid, Coordinate system (origin and XY plane for the table), Features to Pattern | Faces to copy, Geometry pattern, Point 0 row = reference position; table rows add X/Y per instance; tables can be saved/loaded.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_PATTERN_TABLE2.htm

### Fill Pattern
- **Fill Boundary** (sketch, planar curves on face, face or coplanar faces).
- **Pattern Layout**: Perforation (grid; Instance Spacing, Stagger Angle) | Circular (Loop Spacing; Target spacing | Instances per loop) | Square (Loop Spacing; Target spacing | Instances per side) | Polygon (Loop Spacing; Target spacing | Instances per side; Polygon sides). Margins, Pattern Direction, Number of Instances (read-only, computed), Validate Count.
- **Features to Pattern**: Selected features | Create seed cut with Circle (Diameter) | Square (Dimension, Rotation) | Polygon (Polygon Sides, Outer/Inner Radius, Rotation); Vertex or Sketch Point to locate the seed; Flip Shape Direction. Faces to Pattern, Bodies to Pattern, Instances to Skip, Geometry pattern, Propagate Visual Properties.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_AREA_FILL_PATTERN.htm

### Variable Pattern
- Features to Pattern (seed); Reference geometry to drive seeds (axis/plane/point/curve/sketch whose dimensions can go in the table); Create/Edit Pattern Table (each row is an instance with its own dimension values); Update Preview; Propagate visual properties; Failed Instances list.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_variable_pattern_property_manager.htm

### Hole Wizard
Two tabs: **Type** and **Positions**; they can be switched back and forth (set positions, define type, add more positions). Different hole types need separate Hole Wizard features. The feature owns two sketches: a position sketch and a profile sketch (deleting can keep the position sketch).
- **Favorite**: Apply Defaults/No Favorite, Add or Update a Favorite, Delete, Save, Load (per hole type).
- **Hole Type** (buttons): Counterbore | Countersink | Hole | Straight Tap | Tapered Tap | Legacy Hole (pre-2000) | Counterbore Slot | Countersink Slot | Slot (slots use a Slot Length dimension scheme: arc centre to arc centre, or arc tangent to arc tangent).
- **Hole Specifications**: Standard (for example ANSI Metric, ISO, JIS, PEM, many others) | Type (screw clearance, drill sizes, tap drills, dowel holes...) | Filter (PEM standards only) | Size | Show decimal values (drill sizes) | Fit (counterbore/countersink only: Close | Normal | Loose) | Show Custom Sizing (edit diameter/depth/angle values; Restore Default Values; yellow = overridden, white = default) | Configurations (This/All/Specify).
- **Section Dimensions** (legacy holes only).
- **End Condition** (drop-down depends on type; Reverse Direction): Blind (Hole Depth; tap holes also thread depth and type; Automatically Calculate Depth on by default) | Up to Vertex (Vertex) | Up to Surface (Face/Surface/Plane) | Offset from Surface (Face/Surface/Plane + Offset Distance). Depth measured Depth to Shoulder or Depth to Tip (for the blind/up-to types). Not verified: Through All and Up to Next are also offered in the product but the page text read lists only Blind, Up to Vertex, Up to Surface, Offset from Surface by name.
- **Options** (vary by type): Head clearance (added above the head), Near side countersink / Under head countersink / Far side countersink (diameter and angle), Cosmetic Threads and Thread class, for taps the Tap drill diameter | Cosmetic thread | Remove thread choices.
- **Feature Scope**; **Tolerance/Precision**: Callout Value, Tolerance Type (None | Basic | Bilateral | Limit | Symmetric ...), Maximum/Minimum Variation, Show Parentheses.
- **Positions tab**: Hole Positions = place by click (snaps and inference lines work), Existing 2D Sketch (creates a hole at every endpoint/vertex/point of picked sketch geometry; Sketch Options choose which), 3D Sketch (holes on several faces); Instances to Skip; slots can follow a centerline and rotate 90 degrees with Tab.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_HIDD_DVE_HW_HOLE_SPEC.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_HW_INSERT_HOLE.htm ; https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Hole_Wizard_Overview.htm
Not verified: the full list of standards and sizes (it is a library; it is not in these pages). Simple Hole PM (HIDD_END_SPEC_HOLE) was found but not read.

### Thread (cut/extrude thread feature)
Select the circular edge where the thread begins.
- **Configurations**: This / All / Specify.
- **Thread Location**: Edge of Cylinder; Optional Start Location (a vertex, edge, plane or planar face; required unless the edge is planar and circular) with Offset and Reverse Direction; Start Angle (positive).
- **End Condition**: Blind (Depth) | Revolutions (positive count) | Up to Selection (vertex/edge/plane perpendicular to the thread axis); Reverse Direction; Maintain thread length (when a surface offset is set and the end condition is Blind or Revolutions).
- **Specification**: Type and Size (nominal profiles from a library of profile parts; not production-grade), Override Diameter, Override Pitch, Thread Method = Cut Thread | Extrude Thread, Mirror Profile (horizontally | vertically), Rotation Angle, Locate Profile.
- **Thread Options**: Right-hand thread | Left-hand thread; Multiple Start (number of starts around the axis; pitch must prevent crossing); Trim with start face; Trim with end face (profile must extend beyond the trimming face).
- **Preview Options**: Shaded preview | Wireframe preview | Partial preview.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_thread_propertymanager.htm

### Cosmetic Thread
- **Thread Settings**: Circular Edges; Standard; Type; Size (valid sizes for the edge); Minor Diameter | Major Diameter | Conical Offset (what the dimension means); End Condition = Blind (Depth; optionally Start from a face/plane) | Through | Up to Next. Shaded display is a Document Properties detailing option.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CTHREAD.htm

### Plane (reference geometry)
Pick up to three references; each reference offers the constraint types that fit the selection. Message box shows plane status.
- Constraint types: Coincident | Parallel | Perpendicular | Project (point/vertex/origin/coordinate system onto a non-planar surface; Nearest location on surface | Along sketch normal) | Parallel to screen (at a vertex, parallel to current view) | Tangent (to cylindrical, conical, non-planar face; with a point) | At angle (through an edge/axis/sketch line at an angle to a plane or cylindrical face; Number of planes) | Offset distance (parallel to plane/face; Number of planes) | Flip Normal | Mid Plane (between two planar faces/planes).
- Second Reference and Third Reference have the same choices. Set origin on curve is offered for curve-normal planes.
- Typical combos (from the examples): three points; point + parallel plane; edge/curve + point perpendicular (normal to curve); two parallel planes + Mid Plane; plane + offset.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CREATE_PLANE.htm ; also Planes overview .../c_Planes_Overview.htm (not read in detail)

### Axis (reference geometry)
Types listed in the Selections group: One Line/Edge/Axis | Two Planes | Two Points/Vertices | Cylindrical/Conical Face | Point and Face/Plane (axis normal to the face through the point).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/hidd_dve_ref_axis.htm

### Point (reference geometry)
Methods: Arc Center | Center Of Face | Intersection (two edges/curves/sketch segments) | Projection (project one entity onto another) | On point | Along curve distance or multiple reference points (Distance | Percentage | Evenly Distribute, Number of reference points) | axis-plane / axis-surface / two-axis intersections.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/hidd_dve_refpoint.htm

### Coordinate System
- **Position**: Origin (vertex, point, midpoint or default origin); Define position with numeric values (X/Y/Z relative to the local origin).
- **Orientation**: X axis, Y axis, Z axis each from a direction reference (vertex/point = toward it; linear edge/sketch line = parallel; non-linear edge or sketch entity = toward the picked spot; planar face = face normal); Reverse Axis Direction; Define rotation with numeric values (X/Y/Z rotation angles, applied in X then Y then Z order; at least one value needed).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_COORD_SYS.htm

### Curves
- **Helix/Spiral** (start from a sketch with a circle): Defined By = Pitch and Revolution | Height and Revolution | Height and Pitch | Spiral. Parameters: Constant pitch | Variable pitch (region table: Rev, H, Dia, P), Height, Pitch, Revolutions, Reverse direction (helix backwards or inward spiral), Start angle, Clockwise | Counterclockwise, Taper Helix with Taper Angle and Taper outward (constant pitch only). Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_HELIX.htm
- **Projected Curve**: Projection Type = Sketch on faces (Sketch to Project, Projection Faces, Direction of Projection, Reverse projection, Bi-directional) | Sketch on sketch (intersection of two sketches on crossing planes). Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_projected_curves_pm.htm
- **Composite Curve**: join sketches, edges and curves into one curve (Entities to Join list). Source: .../HIDD_DVE_COMPOSITE_CURVE.htm
- **Curve Through XYZ Points**: table of X, Y, Z per point (point order = connection order), can load .sldcrv or .txt files. Source: .../HIDD_CURVE_IN_FILE.htm
- **Curve Through Reference Points**: pick sketch points/vertices in order (Through Points list), Closed curve checkbox. Source: .../HIDD_3D_SPLINE_CURVE.htm
- **Split Line** types: Projection (sketch onto faces; text allowed) | Silhouette (on cylindrical parts) | Intersection (solid/surface/face/plane/surface spline). Open profile sketches must span at least two model edges. Source: .../HIDD_DVE_PLINE.htm
Not verified: the Split Line PropertyManager's own field names (Selections: Sketch to Project, Faces to Split, Direction of Projection, Reverse direction, Single direction) were not on the page read.

### Combine (multibody)
Operation Type: Add (merge all) | Subtract (remove overlap from a Main Body; Bodies to Subtract; Make main body transparent) | Common (keep only the overlap). Bodies to Combine (Add/Common). Show Preview. Only within one multibody part.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_COMBINE_BODIES.htm

### Split
Split PropertyManager: Trimming Tools (planes, planar faces extend infinitely; sketches extrude through all both ways; surfaces/non-planar faces do not extend), Cut Part / Cut Bodies, Target Bodies (All bodies | Selected bodies; Solids or Surfaces to Split), Resulting Bodies list with check boxes (Select All, Title, Auto-assign Titles = Body<n>.SLDPRT to save as external files).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_SPLIT.htm

### Move/Copy Bodies
- Bodies to Move/Copy (move as one unit; others fixed), Translate/Rotate (triad at bounding box centre), Copy + Number of Copies.
- **Translate**: Translation Reference (edge or vertex; Distance | To Vertex), Delta X/Y/Z, Reverse Direction per delta; Configurations (This/All/Specify).
- **Rotate**: Rotation Reference (edge/vertex = axis), X/Y/Z rotation about origin point; triad dragging. Mates can place bodies instead.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_MOVE_SURF.htm
Not verified: the Rotate group's full field list (the page text was longer than read).

### Scale
Bodies to Scale (multibody), Scale About = Centroid | Origin | Coordinate System, Uniform Scaling checkbox + Scale Factor (else X/Y/Z Scale Factor), Configurations.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_INSERT_SCALE.htm

### Intersect
Selections: Solids, Surfaces or Planes; Create intersecting regions | Create internal regions | Create both; Cap planar openings on surfaces; Intersect button (calculates regions); Regions to Exclude (Show included / excluded / both, Region List, Select All, Invert Selection; at least one region must remain unselected); Options: Merge result, Consume surfaces.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_SCULPT.htm

### Indent
Target Body; Tool Body Region(s); Keep Selections | Remove Selections (side to keep); Cut (removes intersection area, no thickness); Parameters: Thickness (solids only), Clearance, Reverse Direction.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_PUNCH.htm

### Delete/Keep Body
Delete Bodies | Keep Bodies, then Bodies to delete / Bodies to keep (solid or surface bodies).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_FEAT_DELETE_BODY.htm

---

## Part B. Sketch

### Smart Dimension (what gets dimensioned)
Opened from Dimensions/Relations toolbar or Tools > Dimensions > Smart. Default type is Parallel (aligned); right-click > More Dimensions offers Horizontal | Vertical | Ordinate | Horizontal Ordinate | Vertical Ordinate (drawings add Baseline, Chamfer). Esc undoes the last pick while collecting entities. The dimension type comes from what is picked; for point-to-point, angular and circular dimensions the cursor position then decides the variant (preview snaps to the nearest orientation). The Modify box takes the value; dimension values accept = and global variables/equations.

| Pick | Result |
|---|---|
| One line or edge | its length |
| Two lines (or line + model edge) | angle; where the cursor sits picks which of the supplementary angles/quadrants |
| Two parallel lines (or line + parallel edge) | perpendicular distance |
| Point + line/edge | perpendicular distance from point to line |
| Two points (one can be a vertex) | distance; cursor placement chooses horizontal | vertical | aligned (linear) |
| Arc | radius (default); true arc length by arc then Ctrl+endpoints |
| Circle circumference | diameter (shown linear or diameter depending on placement) |
| Arc/circle + another entity | distance to the centre by default, even if the circumference is picked; options exist to measure to the near/far edge (min/max extents; see "Changing the Way the Distance is Measured") |
| Line midpoint | right-click the edge, Select Midpoint, then the other entity |
| Entity + centerline then drag across it | doubled distance (twice the distance to the centerline) |
| Three points | angle between them |
- Dimension shortcut menu display options: Show Parentheses, Dual dimension, Show as Inspection.
- A dimension that would over-define a closed profile is turned into a driven dimension automatically. Dimension Value PM: Tolerance Type (None | Basic | Bilateral | Limit | Symmetric ...), Maximum/Minimum Variation, Unit Precision, Tolerance Precision, Configurations.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Dimensioning_a_2D_Sketch.htm ; .../c_Dimensions_Between_Arcs_or_Circles.htm ; .../t_creating_arc_dimensions.htm ; .../c_Angular_Dimensions.htm ; .../HIDD_DVE_DIMENSION_VALUE.htm ; .../c_Driven_Dimensions.htm
Not verified: the exact list of the "Changing the Way the Distance is Measured" choices (the Measure tool's Arc/Circle measurements are Center to Center | Minimum Distance | Maximum Distance | Custom Distance).

### Line, Centerline, Midpoint Line
- **Line PM**: Orientation = As sketched (click-drag draws one line; click-click chains until double-click) | Horizontal | Vertical | Angle (relative to horizontal). Options = For construction | Infinite length | Midpoint line (symmetric about the clicked midpoint). Parameters (not for As sketched): Length, Angle, Add dimensions. After drawing, Existing Relations / Add Relations / Parameters (endpoint coordinates, length, angle) show for the selected line.
- **Centerline**: always construction; used for symmetry, mirror, revolve axis, doubled-distance dimensions. **Midpoint Line**: own tool; creates a line symmetric about its midpoint.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_LINE_CMD.htm ; .../c_Centerlines.htm ; .../c_midpoint_line_help.htm

### Rectangles
Rectangle Type: Corner Rectangle | Center Rectangle | 3 Point Corner Rectangle | 3 Point Center Rectangle | Parallelogram. Options: For construction; Add construction lines From Corners | From Midpoints. Parameters: X/Y of the four corner points (centre X/Y too for the center types). Existing Relations and Add Relations lists as for other entities.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_RECTANGLES.htm

### Slots
Slot Types: Straight Slot (two end points) | Centerpoint Straight Slot (from centre) | 3 Point Arc Slot | Centerpoint Arc Slot. Options: Add Dimensions; length measured Center to Center | Overall Length (straight slots; arc-slot angle always centre to centre). Relations specific to slots: Fix Slot, Equal Slots. Parameters: centre X/Y, width, length; arc slots also radius and angle.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_SLOT.htm

### Circle, Perimeter Circle
Circle drawn from centre (drag radius) or through three perimeter points (Perimeter Circle). PM: relations lists, For construction, Parameters Center X, Center Y, Radius.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_CIRCLE.htm

### Arcs
Centerpoint Arc | Tangent Arc (from an endpoint; pointer motion picks tangent vs normal arc from four intent zones; auto-transition from Line tool) | 3 Point Arc. PM parameters: start, end, centre coordinates, Radius, Angle; For construction.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_ARC.htm ; .../t_Sketching_Tangent_Arcs.htm

### Polygon
3 to 40 sides; Inscribed circle | Circumscribed circle (size defined by that construction circle); Number of Sides, Center X/Y, Circle Diameter, Angle; New Polygon button; For construction.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_POLYGON.htm ; .../t_Sketching_Polygons.htm

### Spline
Created by clicking points and double-clicking to finish. PM: Existing Relations, Add Relations (between spline points, handles, external entities), For construction, Show Curvature (combs), Maintain Internal Continuity, Raised degree (spline with end curvature handles; Standard otherwise). Parameters per spline point: point number, X, Y, Radius of Curvature (with curvature control), Curvature, Tangent Weighting 1 and 2, Tangent Radial Direction, Tangent Polar Direction (3D), Tangent Driving, Reset This Handle. The Spline Tools toolbar commands and editing handles are in "Spline details" and "Fit Spline and Simplify Spline" below.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_SPLINE.htm

### Ellipse, Partial Ellipse, Parabola, Conic
Each has its own PropertyManager with Existing Relations, Add Relations, For construction and a Parameters group; the click sequences, fields and the Conic Rho and Auto tangency are written out in the sections "Ellipse and Partial Ellipse", "Parabola" and "Conic" further down in this part.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Partial_Ellipses.htm ; .../t_Sketching_Parabolas.htm ; .../c_Conics.htm ; .../HIDD_DVE_SKETCH_ELLIPSE.htm ; .../HIDD_DVE_SKETCH_PARABOLA.htm ; .../HIDD_DVE_SKETCH_BCONIC.htm

### Sketch Text
Curves (optional: edges/curves/sketch segments to run along), Text (typed), Link to Property, Style (Bold, Italic, Rotate), Alignment (Left | Center | Right | Full Justify; along curves only), Flip (Vertical, Horizontal), Width Factor %, Spacing %, Use document's font (clear to choose Font). Text can be dissolved into entities.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_TEXT.htm

### Point
Click to place; tool stays active; PM shows coordinates and relations.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Points.htm

### Construction geometry
Any entity can be flagged For construction (PM checkbox, Sketch toolbar button, or Tools > Sketch Tools); points and centerlines are always construction. It aids the sketch and is not used by features.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Construction_Geometry.htm

### Trim Entities / Extend Entities
Trim PM types: Power trim (drag across entities; also extends along the natural path) | Corner (two entities meet at a virtual corner; can extend one/shorten the other/extend both; depends on which ends are picked, not pick order) | Trim away inside (open entities between/crossing two bounding entities, or inside a closed entity; each trimmed entity must cross each boundary once or not at all) | Trim away outside (open entities outside two boundaries) | Trim to closest (remove up to nearest intersection, or extend in drag direction). Options: Keep trimmed entities as construction geometry; Ignore trimming of construction geometry (both on = solids become construction, existing construction untouched).
Extend Entities: hover over line/centerline/arc, preview shows direction (move to other half to flip), click to extend to the next entity.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/hidd_trim_choices.htm ; .../c_Trim_Entities.htm ; .../t_Extend_Entities.htm

### Offset Entities
Pick sketch entities, a model face or edge. Parameters: Offset Distance (drag for preview), Add dimensions, Reverse, Select chain (all contiguous entities), Bi-directional, Construction geometry (Base geometry and/or Offset geometry), Cap ends (with Bi-directional: Arcs | Lines; one-directional also allowed). Finite lines, arcs and splines only; not fit splines, previously offset splines or self-intersecting results. Offsets stay linked to the original.
Source: https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_OFFSET1.htm ; .../c_Offset_Entities.htm

### Convert Entities and Intersection Curve
- Convert Entities: pick edges, loops, faces, curves, external sketch contours; options Select chain, For construction. Result projects onto the sketch plane and stays linked (on-edge relations).
- Intersection Curve: opens a sketch (2D when a plane is chosen first; 3D otherwise) holding the curve where plane/surface/face/whole part meet; useful for sweep paths and sections.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_CONVERT_ENTITIES.htm ; .../c_Intersection_Curves.htm

### Mirror Entities, Dynamic Mirror
- Mirror: Entities to mirror, Copy (keep originals; cleared = move originals to mirrored side), Mirror about (line, centerline, linear model edge, plane, planar face).
- Dynamic Mirror: pick the mirror line first, then sketch; new entities mirror live. Cannot mirror pre-existing entities. Mirror about centerline/line/linear edge.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_MIRRORING.htm ; .../HIDD_DVE_SKETCH_DYNAMIC_MIRRORING.htm

### Linear and Circular Sketch Pattern
- **Linear**: Direction 1 (reference X axis, linear entity or model edge; Reverse direction, Spacing, Dimension X spacing, Number of Instances, Display instance count, Angle, Fix X-axis direction); Direction 2 (activates when its count is set; Dimension angle between axes); Entities to Pattern; Instances to Skip. The line used as direction reference cannot itself be patterned.
- **Circular**: Reverse direction; centre = Sketch origin | Center X/Center Y; Spacing (total degrees), Equal spacing, Dimension radius, Dimension angular spacing, Number of Instances, Display instance count, Radius, Arc Angle; Entities to Pattern; Instances to Skip.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_PATTERN_LINEAR.htm ; .../HIDD_DVE_SKETCH_PATTERN_CIRCULAR.htm ; .../t_Creating_Linear_Sketch_Patterns.htm

### Move, Copy, Rotate, Scale, Stretch Entities
Shared PM family. Entities (sketch items or annotations), Keep relations (clear to break relations to unselected entities).
- Move/Copy: From/To (base point then destination) or X/Y destination; 3D sketch = Delta X/Y/Z; Repeat (again by same distance). Copy adds copies.
- Rotate: Center of Rotation (base point), Angle; 3D sketch uses Rotation Reference line and angle.
- Scale: Scale about base point, Scale Factor (2 = double), Copy + Number of Copies.
- Stretch: Base point From/To or X/Y; Repeat.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_Move_PropertyManager.htm ; r_Rotate_PropertyManager.htm ; r_Scale_PropertyManager.htm ; r_Stretch_PropertyManager.htm ; HIDD_DVE_MOVE_COPY.htm

### Sketch Fillet, Sketch Chamfer
- Fillet: Entities to Fillet, Radius (consecutive same-radius fillets get automatic Equal), Keep constrained corners (keeps the virtual corner if dimensioned/related), Dimension each fillet (else Equal relations).
- Chamfer: Angle-distance (Distance 1 on the first picked entity, Direction 1 Angle toward the second) | Distance-distance (Equal distance on: Distance 1 for both; off: Distance 1 first, Distance 2 second).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_FILLET.htm ; .../HIDD_DVE_SKETCH_CHAMFER.htm

### Display/Delete Relations
Filter (what the list shows): All in this sketch | Dangling | Over Defining/Not Solved | External | Defined In Context | Locked | Broken | Selected Entities. Relations list; Information (status of the entity; Broken/Locked for assembly-context relations); Suppressed (suppress relation for this configuration); Undo last relation change; Delete / Delete All. Entities group: Entity, Status (Fully Defined, Under Defined...), Defined In (Current Sketch | Same Model | External Model), Owner, Owner and Assembly; Replace (swap the entity). Configurations: This / All / Specify. Option: show PM when the sketch becomes over defined or unsolvable.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SK_EDIT_RELATIONS.htm

### Sketch relations and what each needs selected
| Relation | Select | Effect |
|---|---|---|
| Horizontal / Vertical | 1+ lines, or 2+ points | lines orient; points align |
| Collinear | 2+ lines | same infinite line |
| Coradial | 2+ arcs | same centre and radius |
| Perpendicular | 2 lines | 90 degrees |
| Parallel | 2+ lines (3D: line + plane) | parallel |
| Tangent | arc/ellipse/spline + line/arc | tangent |
| Concentric | 2+ arcs, or point + arc | same centre |
| Midpoint | 2 lines, or point + line | point at midpoint |
| Intersection | 2 lines + point | point at their intersection |
| Coincident | point + line/arc/ellipse | point on it |
| Equal | 2+ lines or 2+ arcs | equal length / radius |
| Equal Curvature | 2 splines | matching curvature radius and direction |
| Symmetric | centerline + 2 points/lines/arcs/ellipses | mirror-equidistant |
| Fix | any entity | size and location fixed (a fixed line's ends slide along its infinite line) |
| Pierce | sketch point + axis/edge/line/spline | point where it pierces the plane |
| Merge Points | 2 points/endpoints | one point |
| Doubled Distance | centerline + entity | dimensioned at twice distance |
| Equal Slots, Fix Slot | slots | as named |
| On Edge / On Plane / On Surface / Tangent to Face | projected edges / entities on plane / surface / entity + face | as named |
| AlongX/Y/Z, ParallelYZ, ParallelZX | 3D sketch line + plane | 3D-sketch axis relations |
| Torsion Continuity | spline + spline/arc/conic/model edge | equal curvature and rate of curvature |
Notes: relations to a line act on the infinite line, to an arc on the full circle. Automatic relations are inferred while sketching (see Relations/Snaps options below).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Description_of_Sketch_Relations.htm ; HIDD_DVE_SKETCH_DEFAULT.htm (Add Relations PM: see its section below)

### Fully Define Sketch
Entities to Fully Define: All entities in sketch | Selected entities; Calculate. Relations: choose which relation types may be used (Select All / Deselect All / individual). Dimensions: Horizontal Dimensions Scheme and Vertical Dimensions Scheme = Baseline | Ordinate | Chain; Datum for Horizontal/Vertical (model edge, vertex, line or point); Dimension placement (Above/Below sketch; Right/Left of sketch). Restricting relations may prevent full definition.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_FULLY_DEFINE_SKETCH.htm

### Repair Sketch
Auto-repairs: tiny entities (chain shorter than twice the gap value, deleted) and overlapping lines/arcs (merged). Reports: gaps/overlaps smaller than the gap value, points shared by 3+ entities. Dialog: Showing gaps smaller than, Refresh, Previous/Next, magnifying glass toggle. Over-defined sketches have their own tool, see "SketchXpert" below.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_SKETCH_GEOM_DIAGNOSTICS.htm

### Quick Snaps and Sketch Snaps
Quick Snaps toolbar (single-operation, overrides other snaps; double-click an icon to keep it on): Point Snap, Center Point Snap, Midpoint Snap, Quadrant Snap, Intersection Snap, Nearest Snap, Tangent Snap, Perpendicular Snap, Parallel Snap, H/V Snap, H/V Point Snap, Length Snap, Grid Snap, Angle Snap. Sketch Snaps (persistent, in Options > Relations/Snaps) cover the same list; all are on by default except Grid. Length snap uses grid increments and is engaged by holding Shift while sketching. Grid snap respects "Snap only when grid is displayed". Reachable with right-click > Quick Snaps or Tools > Relations > Quick Snaps.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Quick_Snaps.htm ; r_quick_snaps_toolbar.htm ; c_Sketch_Snaps.htm

### Rapid Sketch
With a sketch tool active, hovering a planar face or plane and starting to draw creates the plane and opens a sketch there; tool can change midstream. Button on the Sketch tab.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Using_RapidSketch.htm

### Add Relations PropertyManager (manual relations)
Opened from Add Relation on the Dimensions/Relations toolbar (Tools > Relations > Add). Groups: **Selected Entities** (the picked entities; more can be added by clicking in the view), **Existing Relations** (Relations list for the selection, with a callout highlighted in the view when one is chosen; Information = status such as Fully Defined | Under Defined), **Add Relations** (only the relations that suit the selection are listed; click one to apply), **Options** (For construction). At least one picked item must be a sketch entity; the others may be a sketch entity or a model edge, face, vertex, the origin, a plane, an axis, or a curve of another sketch that projects to a line or arc. The same Existing Relations and Add Relations groups appear in every sketch entity's own PropertyManager. Relations can also be added from the context toolbar after Ctrl-selecting two entities.
- More relation kinds the help describes besides the table above: Equal curve length between unlike entities (line, arc, circle, spline in any pair; several homogeneous entities at once; fixed spline when a spline and any other entity are selected); Equidistant (created by the Segment tool; deleting one deletes the whole group); Tangent to Face and Equal Curvature for splines against adjacent faces; Torsion Continuity (spline with spline, arc, conic or elliptical arc, or a linear/circular/conic/parabolic/elliptical/spline model edge; needs a shared end point; gives equal curvature and equal rate of curvature); Traction (blocks, see Blocks).
- Continuity pop-up: when a new entity ends on the end of a line, arc, style spline, spline, model edge, conic, parabola or partial ellipse, a Constraint pop-up toolbar offers Tangent or Make Curves Equal Length.
- Midpoint of a line, arc or model edge can be picked by hovering: the entity and its midpoint highlight, then click.
- Relations to a spline act on: internal points (Coincident, Horizontal, Vertical, Fix, Midpoint, ...), end points (Coincident, Concentric, Midpoint, Merge, Tangent, Fix), internal handles and end handles (Tangent, Equal Curvature, Parallel, Horizontal, Vertical, Curvature), and Tangent to Face.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_DEFAULT.htm ; .../c_Geometric_Relations.htm ; .../c_Equal_Curve_Length_Parametric_Relations.htm ; .../c_equidistant_relations.htm ; .../t_add_continuity_relations.htm ; .../t_applying_torsion_continuity_relations.htm ; .../c_Relations_with_Splines.htm ; .../t_Selecting_Midpoint_with_Dynamic_highlight.htm ; .../c_Sketch_Relations_Icons.htm

### Sketch status and colours
Whole-sketch states (shown in the status bar): Fully Defined | Over Defined | Under Defined | No Solution Found | Invalid Solution Found (zero-length line, zero-radius arc, self-intersecting spline). Entity colours: black = fully defined, blue = under defined, red = over defined (and unsolvable items), yellow = item conflicts or invalid, brown = dangling (a reference was deleted), grey = driven dimension. A sketch need not be fully defined before a feature uses it; System Options > Sketch > Use fully defined sketches makes that a requirement. Hovering or selecting a dangling relation or dimension can show a ghost of the missing reference. Dimensions that would over-define a closed profile become driven (grey) automatically; for a conflict made another way the Make this dimension driven choice is offered.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Geometry_Status.htm ; .../c_Sketch_Status_Conventions.htm ; .../c_Resolving_Over_Defined_Sketches.htm ; .../t_displaying_ghost_image.htm

### SketchXpert
Tools > Sketch Tools > SketchXpert, or click Over Defined in the status bar; with "Always open this dialog when sketch error occurs" selected it opens as soon as a 2D or 3D sketch becomes over defined. PM groups: **Message** with two buttons, Diagnose | Manual Repair. **Diagnose** lists potential solutions under **Results**; step through them with the previous/next arrows (each is shown applied in the view, moved geometry is ghosted at its old place); **More Information/Options** names the relations or dimensions the chosen solution would delete; **Accept** applies it. **Manual Repair** lists all relations and dimensions under **Conflicting Relations/Dimensions**; selecting one highlights it; per item **Suppressed** (suppress it) | **Delete**; **Delete All** removes everything (the PM undo does not cover it; the normal Undo does); an undo arrow restores one deleted item and refills the list. Colour codes: Item is Unsolvable (red), Item Conflicts (yellow).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_XPERT.htm ; .../c_SketchXpert.htm ; .../t_Diagnosing_Over_Defined_Sketches.htm ; .../t_Manually_Repairing_Over_defined_Sketches.htm

### Line details, infinite and midpoint lines, chains
- Click-drag draws one line; click-click starts a chain. End a chain by double-click (tool stays active), right-click > End chain (same), Esc (ends the chain and releases the tool), or by moving the pointer out of the view. Autotransition: from a line end, move away, back to the end, away again to switch to a tangent arc preview, click to place it; press A to toggle between line and arc without returning to the end.
- Insert Line PM options apply to all four orientations: For construction | Infinite length | Midpoint line. Parameters (not for As sketched): Length (Horizontal, Vertical); Length and Angle (Angle orientation); Add dimensions shows the values. After the first line the PM becomes Line Properties and sketching continues with the same orientation; click its tick or double-click to return to Insert Line and change settings. The angle is relative to the horizontal. Some orientations and Infinite length override Quick Snaps.
- A finite line can be made infinite later (Infinite length in Line Properties); an infinite line cannot be made finite, but can be trimmed. Infinite lines can be construction.
- Line Properties PM (select an existing line): Existing Relations, Add Relations, Options (For construction, Infinite length), Parameters Length and Angle (the page gives the angle as measured from the grid with horizontal as 180 degrees, vertical 90 degrees, counter-clockwise positive), Additional Parameters Start X, Start Y, End X, End Y, Delta X, Delta Y. Changing one parameter updates the others unless relations hold them. An Angle line's angle can be edited in the same session only if an angular dimension to a horizontal construction line exists.
- Centerline: click the start, drag or click the end. **Midpoint Line**: its own tool; the line is symmetric about its midpoint.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Lines.htm ; .../HIDD_DVE_SKETCH_LINE_CMD.htm ; .../HIDD_DVE_SKETCH_LINE.htm ; .../t_Sketching_Infinite_Lines.htm ; .../c_Centerlines.htm ; .../c_Sketch_Modes.htm ; .../t_Autotransitioning.htm

### Rectangle click sequences
- Corner: click the first corner, drag, release at the opposite corner. Center: click the centre, drag to a corner (centerlines are made), release. 3 Point Corner: click the first corner, drag and turn to set the first edge's length and angle, release; click and drag to set the other edges, release. 3 Point Center: click the centre, drag and turn to set half the length of the centerline, then click and drag the other lines, release. Parallelogram: click the first corner, drag to set the first edge, release; click, turn and drag to set the angle and length of the next edges, release.
- Change size or shape afterwards by dragging a side or corner. Individual sides can be made construction. Add construction lines From Corners (diagonals) | From Midpoints (lines between side midpoints) in the PM or at creation.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Corner_Rectangles.htm ; .../t_Sketching_Center_Rectangles.htm ; .../t_Sketching_3_Point_Corner_Rectangles.htm ; .../t_Sketching_3_Point_Center_Rectangles.htm ; .../t_Sketching_Parallelograms.htm ; .../t_Changing_the_Size_or_Shape_of_Rectangles.htm ; .../t_add_construction_lines_and_centerlines.htm

### Slot click sequences
- Straight Slot: click the start centre, click the other end (length), click for the width. Centerpoint Straight Slot: click the centre, click an end (length), click for the width. 3 Point Arc Slot: click the arc start, click the arc end, click a third point on the arc, click for the width. Centerpoint Arc Slot: click the arc centre, click for the radius, click for the length (the sweep), click for the width. For the PM options and parameters see Slots above. Slots also show Add Dimensions and the Center to Center | Overall Length choice for straight slots.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketch_Creating_Straight_Slot.htm ; .../t_Sketch_Creating_Centerpoint_Straight_Slot.htm ; .../t_Sketch_Creating_3_Point_Arc_Slot.htm ; .../t_Sketch_Creating_Centerpoint_Arc_Slot.htm

### Polygon, circle, arc details
- Polygon: tool opens the Polygon PM; set options before or after; click the centre, drag out the polygon. New Polygon starts another with the PM open; after the tick the tool stays on but the PM no longer opens. Edit later through Tools > Sketch Tools > Edit Polygon or right-click a side > Edit polygon. Parameters: Number of Sides (3 to 40), Inscribed circle | Circumscribed circle (the construction circle that sets the size), Center X and Y, Circle Diameter, Angle (rotation). Relations: none exist on the polygon as a whole; relations go on its points and lines.
- Circle: click the centre, drag and click the radius. Perimeter Circle: click a start point on the perimeter, drag, right-click to set the circle (three perimeter points). Circle PM Parameters: Center X, Center Y, Radius. Drag the edge to resize, the centre to move.
- Arcs: Centerpoint Arc: click the centre, release and drag for the radius and angle, click the start point, drag and click the end. 3 Point Arc: click the start, drag and click the end, drag to set the radius, click. Tangent Arc: click the end of a line, arc, ellipse or spline and drag; the pointer direction decides tangent arc vs normal arc through four intent zones (eight possible results); returning to the end point and moving away in another direction toggles. Arc PM Parameters: Center X/Y, Start X/Y, End X/Y, Radius, Angle (subtended). Right-click an arc > Reverse Endpoint Tangent flips the tangent direction at an end.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Polygons.htm ; .../HIDD_DVE_SKETCH_POLYGON.htm ; .../t_Sketching_Circles.htm ; .../t_Sketching_Perimeter_Circles.htm ; .../HIDD_DVE_SKETCH_CIRCLE.htm ; .../t_Modifying_Circles_By_Dragging.htm ; .../t_Sketching_Centerpoint_Arcs.htm ; .../t_Sketching_3_Point_Arcs.htm ; .../t_Sketching_Tangent_Arcs.htm ; .../HIDD_DVE_SKETCH_ARC.htm ; .../t_controlling_tangency_direction.htm

### Ellipse and Partial Ellipse
Ellipse: click the centre, click to set the major axis, click to set the minor axis. Partial Ellipse: click the centre, click the end of one axis, click the end of the second axis (the full-ellipse guide stays), then drag around the guide to the extent and click. **Ellipse PM** (select an existing ellipse): Existing Relations; Add Relations; Options = For construction | Add construction lines (turns the major and minor axes into construction geometry); Parameters = Center X, Center Y, Radius 1, Radius 2, and for a partial ellipse also Start X/Y, End X/Y and Angle.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Ellipses.htm ; .../t_Sketching_Partial_Ellipses.htm ; .../HIDD_DVE_SKETCH_ELLIPSE.htm

### Parabola
Click the focus and drag outward (the parabola is outlined), then click on the curve and drag to set its extent. Edit: drag the vertex away from the focus to flatten, closer to sharpen; drag an end point to change one side's length without changing the curve; drag the curve away from its ends to change both lengths at once. **Parabola PM**: Existing Relations; Add Relations; Options = For construction; Parameters = Start X/Y, End X/Y, Center X/Y (the focus), Apex X/Y.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Parabolas.htm ; .../c_Modifying_Parabolas.htm ; .../HIDD_DVE_SKETCH_PARABOLA.htm

### Conic
A curve driven by two end points and a Rho value; by Rho it is elliptical, parabolic or hyperbolic (the page does not give the Rho limits). It can reference existing sketch or model geometry, can take a driving dimension (the dimension shows Rho) and has a radius of curvature. Click first end point, click second end point, drag and click the top vertex (where the end tangents meet), drag and click to set Rho (reference points show the shoulder and top vertex). **Auto tangency** (PM option): applies tangent relations at both ends and picks the top vertex, so the top-vertex click is skipped. **Conic PM**: Existing Relations; Add Relations; Options = For construction | Auto tangency; Parameters = Start X/Y, End X/Y, Shoulder X/Y (the curve's height point), Top vertex X/Y, Rho (ratio of curve height to the top vertex height), Radius of curvature at the shoulder.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Conics.htm ; .../t_Sketching_Conics.htm ; .../HIDD_DVE_SKETCH_BCONIC.htm

### Spline details (PropertyManager and editing)
- Create: click the first point and drag out the segment tangent, click the next point and drag, repeat, double-click to end. Handles show by default (Show Spline Handles toggles). Two or more points. Splines can be simplified to two points while keeping end slopes.
- **Spline PM**: Existing Relations; Add Relations (between points, between handles, handle to outside entity, listed when the geometry exists); Options = For construction | Show Curvature (opens Curvature Scale PM: Scale, Density) | Maintain Internal Continuity (curvature changes gradually instead of abruptly) | Raised degree (only for splines with curvature handles at both ends; default Standard; raises or lowers the degree, also by dragging handles). Parameters: Spline Point Number, X, Y, Radius of Curvature and Curvature (only after Add Curvature Control), Tangent Weighting 1 and 2 (left and right tangent vector size), Tangent Radial Direction (angle relative to X, Y or Z), Tangent Polar Direction (elevation, 3D), Tangent Driving (turns on control by weighting and radial direction; needed to dimension handles), Reset This Handle, Reset All Handles, Relax Spline (re-smooths after dragging the control polygon), Proportional (dragging an end resizes the whole spline in proportion).
- Editing: drag spline points; drag control polygon points; or use handles (circle = weight and direction together, hold Alt to treat both sides alike; arrow head = weight; diamond = direction). Insert Spline Point adds points; points take dimensions and relations. Add Tangency Control and Add Curvature Control add handles at a point (curvature: drag the ball along the vector to set radius; the pointer crossing sides means an inflection point). Fit Spline, Simplify Spline, Show Inflection Points, Show Minimum Radius, Curvature Combs on most entities, Convert to Style Spline | Convert to Spline | Convert to Generic Spline (right-click).
- Dimensioning a spline: a Smart Dimension on the spline gives a fixed length (stays when ends are dragged); with Tangent driving on, Smart Dimension to a handle sets weighting or radial direction.
- Spline on Surface: pick Spline on Surface in a sketch on a surface; points are bound to the surface, can span faces, update with the model unless constrained.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Multiple_Point_Splines.htm ; .../HIDD_DVE_SKETCH_SPLINE.htm ; .../t_Editing_Splines.htm ; .../t_Adding_Tangency_Control_to_Splines.htm ; .../t_Adding_Curvature_Control_to_Splines.htm ; .../c_Spline_Points.htm ; .../c_Curvature_Combs.htm ; .../HIDD_DVE_SKETCH_CURVATURE.htm ; .../t_Displaying_Inflection_Points.htm ; .../t_displaying_minimum_radius_spline.htm ; .../t_set_fixed_length_for_spline.htm ; .../t_Dimensioning_to_Spline_Handles.htm ; .../c_convert_spline_types.htm ; .../c_Splines_on_Surfaces.htm ; .../t_Creating_Two_Point_Splines_with_Tangency.htm

### Style Spline
Single-span Bezier or B-spline through control vertices (2D and 3D). Click the first vertex, then more; hovering an inference line and clicking while its icon shows creates Tangent (first inference) or Equal Curvature (second) at that vertex; Alt + double-click on the last end applies tangency automatically (bridge curve between two entities). **Style Spline PM**: Existing Relations; Add Relations (Fix); Options = For construction | Show curvature | Local edit (needs two or more style splines; moves one control polygon segment without changing neighbours); Curve Type = Bezier Curve | B-Spline: Degree 3 | B-Spline: Degree 5 | B-Spline: Degree 7 (minimum points 4, 6, 8); Curve degree (greyed when constrained; else set by adding or deleting control vertices); Control vertices (count, read only); Parameters = Non-rational Spline | Rational Spline, Start X/Y, End X/Y, Control Vertex Weight (rational only). Insert Control Vertex (right-click the control polygon) adds a vertex and raises the degree. **Spline Control Vertex PM**: Existing Relations, Add Relations (Fix), X and Y.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_about_style_splines.htm ; .../t_sketch_style_spline.htm ; .../r_style_spline_pm.htm ; .../r_spline_control_vertex_pm.htm ; .../t_insert_control_vertex_pt.htm ; .../t_use_local_edit.htm ; .../c_style_spline_support_for_b_splines.htm

### Fit Spline and Simplify Spline
- **Fit Spline** (Tools > Spline Tools > Fit Spline): click the sketch entities to fit (model edges allowed; nothing can be constrained to the model edge part). PM: Delete geometry (remove the originals; when cleared they stay as construction and you choose **Constrained** (spline linked to the geometry) | **Unconstrained** (same shape, free to dimension) | **Fixed**), Closed spline, Undo Spline, Edit Chaining (order of non-contiguous pieces), Tolerance (maximum deviation; thumbwheel) with Actual Deviation shown, Preview Options Inflection points | Minimum radius | Curvature comb.
- **Simplify Spline**: select a spline, Tools > Spline Tools > Simplify Spline; set Tolerance and OK, or press Smooth repeatedly (down to two points); the dialog shows the number of points in the original and the simplified curve and the achieved tolerance; Previous steps back. Works on splines from imports, Convert Entities, Offset, Intersection Curve and Face Curves.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Fit_Splines.htm ; .../HIDD_STYLED_CURVES.htm ; .../t_Fitting_Sketch_Segments_to_Splines.htm ; .../c_Simplify_Splines.htm

### Equation Driven Curve
PM (Tools > Sketch Entities > Equation Driven Curve; right-click an existing one > edit). **Equation Type**: Explicit (Y as a function of X over the range X1 to X2) | Parametric (X(t) and Y(t) over T1 to T2; Z(t) too in a 3D sketch, and only parametric is available in 3D). Parameters: Equation box(es) (any function the Equations dialog supports; red text means it cannot be solved), the range start and end, each with a lock toggle (locked = fixed point on the curve, unlocked = can be dragged along the curve). Angles are radians. Global variables go in double quotes (not with an equals sign); a dimension can carry a global variable and be used in the equation. Examples: explicit y = sqrt(4 - x^2) for x from -2 to 2; parametric x = 50*cos(t), y = 50*sin(t) for t from 0 to pi. The curve behaves as a rigid curve; scale it in the equation; its ends can take relations and dimensions. Existing curves also show Existing Relations, Add Relations and For construction.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_equation_driven_curves.htm ; .../HIDD_DVE_SKETCH_EQCURVE.htm
Not verified: the numbered click steps of "Creating an Equation Driven Curve" (page returned no text).

### Point, Segment (equidistant points)
- Point: click to place; the tool stays active; PM shows X and Y and relations. Deleting a point made by Segment re-spaces the others; the number of segment points can be edited later.
- **Segment** (Tools > Sketch Tools > Segment): select a sketch entity (line, arc, circle, spline, parabola, ellipse, partial ellipse, conic); set Number of Instances; choose Sketch points (equidistant points) | Sketch segments (the entity is cut into equal parts; on arcs and circles an Equal Length relation is applied). Points get an Equidistant relation that follows the entity when it is dragged or resized; deleting one relation deletes the group.
- Virtual sharp (a point at the virtual corner of two entities): Ctrl-select two entities and click Point; dimensions and relations to it survive a fillet or chamfer of the corner (automatic in 3D sketches).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Points.htm ; .../HIDD_DVE_SKETCH_POINT.htm ; .../t_equidistant_points_and_segments.htm ; .../c_spline_segments.htm ; .../t_deleting_sketch_points.htm ; .../c_equidistant_relations.htm ; .../t_Creating_Virtual_Sharps.htm

### Sketch Text details
Steps: open a sketch on a face; click Text; optionally draw a closed profile in an earlier sketch for the text to follow (a circle or chain of lines, arcs, splines); pick edges, curves, sketches or sketch segments under Curves (the text follows them; with none the text runs horizontally from the origin); type under Text; set Style, Alignment, Flip, Width Factor, Spacing, Font; tick; then extrude or cut with the sketch open. Rotate on selected characters applies 30 degrees counter-clockwise by inserting a code such as `<r30>`; edit the number for other angles. Flip Vertical needs a curve. Width Factor is off with Use document's font on; Spacing is off with Full Justify or the document font. Link to Property ties the text to a document, custom or configuration property (date properties offer Long Date | Short Date and Show Time). Edit: double-click the text or right-click > Sketch Tools > Properties. Right-click > Dissolve sketch text turns it into lines, arcs and splines. Stick fonts (single-line, for engraving and CNC): clear Use document's font, choose the OLF SimpleSansOC font.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Sketching_Text.htm ; .../HIDD_DVE_SKETCH_TEXT.htm ; .../t_Editing_Sketch_Text.htm ; .../t_dissolving_sketch_text.htm ; .../t_using_stick_fonts.htm ; .../HIDD_SELECT_PROPERTY_TEXT.htm

### Sketch Picture
Insert (Tools > Sketch Tools > Sketch Picture, then browse): .bmp, .gif, .jpg, .jpeg, .tif, .tiff, .wmf, .png, .psd. The picture's (0,0) sits at the sketch origin; a .tiff above 4096 x 4096 is halved until it fits. A scale tool (a construction line with end handles) sets the size: put the left end at one edge of the picture, drag the right end, enter the real length in the Modify box; dragging the right end also rotates; Enable Scale Tool hides it. PM page 1: position, size, angle, orientation, aspect ratio setting, transparency; pictures can go on either side of the plane. Page 2 (Autotrace add-in only): Trace Settings (Image Type, selection tools to frame the area, Begin trace), Preview Settings (Show source image, Show traced geometry), sliders Color tolerance and Recognition tolerance, Apply; makes an editable spline sketch. Not available in sketches made in an assembly context. Best for high-contrast sources of at least 300 dpi.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Picture.htm ; .../r_sketch_picture_pm.htm ; .../t_insert_and_resize_pictures.htm ; .../t_Converting_Sketch_Pictures_to_Vector_Data.htm

### Plane (3D sketch) and 3D entities (3D sketches only)
- 3D Sketch opens on the Front plane in isometric view; 3D Sketch on Plane opens on a preselected plane normal to the view. **Plane** (Tools > Sketch Entities > Plane, 3D sketches only) opens the Sketch Plane PM with First, Second and Third Reference (a sketch entity or another plane each, with a relation chosen from the list); the new plane is activated by double-click. **Plane Properties PM**: Existing Relations, Add Relations, Parameters = Distance (from the origin along X, Y or Z), Tangent Radial Direction (angle between the normal's projection on the XY plane and X), Tangent Polar Direction (angle between the normal and the XY plane). Planes can be dragged, resized by corner handles, rotated by centre handles.
- Space handle (appears at the first point; choose the axis; Tab changes plane), Sketcher Triad (limits dragging), Line Snap (snap to model faces, vertices and sketch points), Along X/Y/Z relations when sketching along an axis, Horizontal/Vertical when on a plane. 3D dimension types: Absolute | Along X | Along Y | Along Z (Tab cycles). A 3D line has the same Options as a 2D line (For construction, Infinite length, Midpoint line). 2D sketching in 3D on a plane gives snapping and inference only to geometry in that plane.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CREATE_PLANE_NEW.htm ; .../HIDD_DVE_SKETCH_3D_PLANE.htm ; .../c_3D_Sketching_Capabilities.htm ; .../c_Space_Handles.htm ; .../c_Line_Snap.htm ; .../c_3D_dimension_types.htm ; .../t_Creating_Lines_in_3D_Sketches.htm ; .../c_2D_Sketching_in_3D.htm ; .../c_Differences_Between_2D_and_3D_Sketching.htm

### Blocks
A block freezes chosen entities into one rigid unit with its own relations, so layouts need few dimensions. Commands (Blocks toolbar or Tools > Blocks): **Make Block** (Block Entities list; pre- or post-select; optional Insertion Point manipulator, which is also the rotation and scale point and can be related to entities), **Edit Block** (opens it; add, remove or change entities, relations and dimensions; relations inside a block may not point at external entities; the confirmation corner closes it), **Insert Block** (Blocks to Insert: Open Blocks list for another instance, or Browse for a saved .sldblk file; Link to file keeps all instances tied to the file and blocks editing in this document; Parameters Scale and Angle), **Save Block** (.sldblk; saving edits under the same name updates every instance), **Explode Block** (dissolves one instance only), **Rebuild Block** (refreshes while editing), **Add/Remove** (moves entities between the block and its sketch), **Belt/Chain**. Nested blocks; mirror, scale and pattern of blocks; hide or show per block; colour per block via Edit > Appearance > Sketch/Curve Color; Convert and Offset work inside one block. Block PM: Existing Relations, Add Relations, Definition (Link to file, Browse, Edit), Insertion Point, For construction, Block Scale (default 1), Block Rotation (default 0), Lock angle; drawing-only groups (leaders, text display, layer, attributes) and Motion mass properties.
- **Belt/Chain PM**: needs circle or arc blocks. Belt Members (pulley components; Move Up | Move Down for the order), Flip belt side (all or per arc by its handle), Properties: Driving (belt length drives the layout; cleared = length is calculated), Use belt thickness (value), Engage belt (clear to turn the mechanism off). The belt shows in the tree and is edited with Edit Belt. The Traction relation between two blocks gives relative rotation (gears, rack and pinion); limit Fix relations so motion stays free.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Blocks_in_Parts_and_Assemblies.htm ; .../t_Making_Blocks.htm ; .../t_Editing_Blocks.htm ; .../t_Inserting_Blocks.htm ; .../t_Saving_Blocks.htm ; .../t_Exploding_Blocks.htm ; .../t_Rebuilding_Blocks.htm ; .../t_adding_sketch_entities_blocks.htm ; .../HIDD_DVE_SKG_ADDREMOVE.htm ; .../HIDD_DVE_SKETCH_SUBSKETCH.htm ; .../t_Making_Nested_Blocks.htm ; .../t_Setting_Insertion_Points.htm ; .../t_Applying_Color_to_Blocks.htm ; .../c_hiding_and_showing_individual_blocks.htm ; .../HIDD_DVE_FEAT_SKETCH_BELT.htm ; .../c_using_traction_belts.htm

### Split Entities, Jog Line, Make Path
- **Split Entities**: click the entity where it should split; a split point is added; dimensions can go to it; a circle, full ellipse or closed spline needs two split points. Select a split point and press Delete to rejoin.
- **Jog Line**: click a line, move to preview the jog's width and depth, click to place; the tool stays active for more jogs; jog segments are kept parallel or perpendicular to the original and can be dragged and dimensioned (3D sketches: Tab changes the jog plane).
- **Make Path**: pick one entity of an end-to-end chain, Make Path; Path Properties PM: Existing Relations, Definition > Edit Path (Path PM: Selected Entities, add or remove chain members; removing one that breaks the chain means recreating the path), Path Length Dimension with Driving. The chain can then take a Tangent relation with another entity (cam and follower); a chain belongs to one path; right-click > Select Other for one member. Path length dimension: right-click the sketch > Dimensions > Path Length, pick the chain, tick.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_split_entities.htm ; .../HIDD_DVE_SKETCH_JOG_LINE.htm ; .../c_Make_Path.htm ; .../t_Making_Paths.htm ; .../HIDD_DVE_SKETCH_LOOPS.htm ; .../HIDD_DVE_SKETCH_LOOP_PROP.htm ; .../t_create_path_length_dimensions.htm

### Silhouette Entities, Face Curves, Offset on Surface
- **Silhouette Entities** (open a sketch on a plane first): Entities to Silhouette (bodies or components), External silhouette (outer boundary only; clear to also project inner loops). Result keeps parametric constraints to the model (not in section view).
- **Face Curves** (iso-parametric curves of a face or surface, each as a 3D sketch): Selections = Face, Position Vertex; Mesh (Direction 1 and 2 Number of Curves, evenly spaced) | Position (two orthogonal curves; drag or enter the percentage from the bottom and right); Options = Constrain to model (follow model changes), Ignore holes (curves run across inner gaps).
- **Offset on Surface** (surface models, 3D sketch): Offset type = Geodesic Offset (shortest path along the surface) | Euclidean Offset (straight-line distance, ignores curvature); Parameters = Offset Distance, Reverse (only when the edge's faces belong to one body), Make offset construction; works from an edge or all edges of a face.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_silhouette_entities.htm ; .../r_silhouette_entities_property_manager.htm ; .../t_creating_silhouette_entities.htm ; .../c_Face_Curves.htm ; .../HIDD_DVE_CONVERT_ISO_CURVES.htm ; .../t_Extracting_Iso_Parametric_Curves.htm ; .../r_offset_on_surface_pm.htm ; .../t_Creating_Sketch_offsets_on_3D_Geometry_Surfaces.htm

### Replace Entity
Tools > Sketch Tools > Replace Entity (or from the Sketcher Confirm Delete dialog when deleting). PM Selection: **Replace this entity** (the old one), choose Make construction | Delete for what happens to it, **With this one** (the new entity), Make contour (turn the new entity into a contour entity). One entity at a time. The new entity keeps the old one's dimensions, relations and downstream references (features, faces) unless the downstream use needs the same geometry type (mates); inherited references can be changed and new ones added during the replacement.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_replace_sketch_entities.htm ; .../t_replace_sketch_entities.htm ; .../r_replace_entities_pm.htm

### Align Grid/Origin, Modify Sketch, Close Sketch to Model, Check Sketch for Feature
- **Align Grid/Origin** (Tools > Sketch Tools > Align > Align Grid/Origin): Sketch Origin Location (a vertex or point); X-axis or Y-axis (a linear sketch entity; a button flips 180 degrees); Relocate origin (moves only the origin) | Relocate all sketch entities (moves the sketch by the change of origin and/or axis). Also re-orients a block's origin. Sketches on model faces or planes.
- **Modify Sketch** (Tools > Sketch Tools > Modify): moves, rotates, scales or flips the whole sketch. Translate X value and Y value (or Position selected point to set a chosen point's coordinates), drag with the left button; Rotate to an angle or right-drag around the origin (the centre of rotation can be moved); Scale About = Sketch origin | Movable origin and Factor; flip about X, Y or both from the origin's right-click symbols. Not possible for sketches with several external references; scaling is not possible with external references.
- **Close Sketch to Model**: an open profile whose ends lie on model edges of the same face boundary; Tools > Sketch Tools > Close Sketch to Model; an arrow shows the closing side, Reverse direction to close the sketch if needed, Yes; then Extrude Boss or Cut. The same is offered by the Prompt to close sketch option when an open sketch is extruded.
- **Check Sketch for Feature** (Tools > Sketch Tools > Check Sketch For Feature): Feature usage list (the feature types the sketch is used in, or <none>; pick another to test it), Contour type shown per usage, Check (one error per check, highlighted), Reset, Close. Contour types: Multiple Disjoint Closed, Single Open, Single Closed, General (common checks only). Examples: Boss/Base Extrude and Revolve = Multiple Disjoint Closed; thin variants = Single Open or Multiple Disjoint Closed; Cut Extrude = Single Open or Multiple Disjoint Closed; Loft Section = Single Closed; Loft Guide = Single Open or Single Closed; Sweep Path/Guide = Single Open or Single Closed; Sweep Section = Single Open or Multiple Disjoint Closed; Boundary Surface = any of the three; Jog = Single Open; Rib, Split, Surface Extrude, Surface Fill, Sketched Bend, Mold Parting Surface = General.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_SKETCH_ALIGN_GRID.htm ; .../HIDD_MODIFY_SKETCH.htm ; .../t_Moving_Sketches.htm ; .../t_Rotating_Sketches.htm ; .../t_Scaling_Sketches.htm ; .../t_Closing_Sketches_to_Models.htm ; .../HIDD_SKETCH_DIAGNOSTICS.htm

### Shaded Sketch Contours, selecting contours, Instant2D, Derived Sketch
- **Shaded Sketch Contours** (Sketch toolbar or Tools > Sketch Settings): closed contours and sub-contours (the closed shapes made by combining contours) are shaded, so a gap is easy to see. Drag a shaded area to move the whole entity; relations apply to its entities; Make Block from the shortcut menu; Alt + click a shaded area shows Extruded Boss/Base on the context toolbar; shaded contours are valid input for Mirror Entities and Offset Entities.
- **Selected Contours** in Extrude and Revolve: click contours in the view (Ctrl for several; contours may include model edges); only one face's sketch region is recognised when a sketch is reused; the tool refuses contours on parts with too many edges, or edges on offset planes, chamfers or fillets.
- **Instant2D** (toggle on the Sketch toolbar): click a dimension near its leader to show handles; drag a handle to change the value (a ruler appears) or click the value and type; no Modify dialog needed.
- **Derived Sketch** (Ctrl-select the sketch and a target face, Insert > Derived Sketch) makes a rigid copy that follows the original; it can be positioned by dragging and dimensioning but entities cannot be added or deleted; right-click > Underive breaks the link.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Shaded_Sketch_Contour.htm ; .../t_Extruding_Shaded_Sketch_Contours.htm ; .../t_Selecting_Contours.htm ; .../t_Modifying_2D_Sketch_Dimension_Instant2D.htm ; .../c_Derived_Sketches.htm

### 2D to 3D toolbar
Converts a single 2D sketch (drawn or imported from a drawing) in a part into a 3D part. Flow: import or draw, edit, extract view sketches, align them, extrude the base, then extrude and cut more. Commands: Add to Front | Top | Right | Left | Bottom | Back Sketch (selected entities become that view; the sketches fold into place), Auxiliary Sketch (also pick a line in another view for the angle), Create Sketch from Selections (the selection becomes its own sketch), Repair Sketch, Align Sketch (select an edge in one view, then an edge in the second; the first sketch moves to the second; order matters), Convert to Extrusion and Convert to Cut (from the selected entities, a whole sketch is not needed), Select Chain (chain of attached entities in both directions until a branch).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_2D_to_3D_Conversion_Overview.htm ; .../r_2d_to_3d_toolbar_import_export.htm ; .../c_Additional_Conversion_Tools.htm

### Sketch Ink, Touch Tool, Slicing
- **Sketch Ink toolbar** (pen and touch devices): Color/thickness, Draw (freehand strokes that do not affect the model and can be suppressed or converted later), Eraser (whole strokes only), Select, Power Modify (strokes as gestures to trim, extend, split, offset, fillet, chamfer), Auto Shape (nearest of Line, Point, 3 Point Arc, Circle, Corner Rectangle, Ellipse, Polygon), Auto Sketch Entities, Ink with Touch, Ruler and Protractor (snap strokes to a straight edge or angle), Convert to Spline | Composite | Slot | Ellipse, Auto Spline, Update to Shape | Entities. **Touch Tool**: finger drawing on touch screens.
- **Slicing** (Insert > Slicing): 2D sketch sections at the intersection of a reference plane and a BREP body, mesh BREP body or graphics body; Slicing PM.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_sketch_ink_toolbar.htm ; .../c_Touch_Tool.htm ; .../c_slicing_tool.htm

### Sketch settings menu, options and behaviours
The Sketch Settings menu page lists six toggles (Tools > Sketch Settings; Shaded Sketch Contours and Instant2D sit beside them): **Automatic Relations** (adds relations while sketching; the pointer shows which one will apply; Ctrl held suppresses; clearing Enable snapping also clears it), **Automatic Solve** (solves geometry as it is made; with it off the status bar says Auto-Solve Mode Off, useful while changing many dimensions; System Options > Sketch can turn Automatic Solve and Undo off once a sketch has more entities than a set count), **Enable snapping** (all Sketch Snaps except Grid), **No Solve Move** (moves entities without solving; if dimensions or relations exist a prompt asks: Yes deletes them and moves, No leaves them and copies to the new place), **Detach Segment on Drag** (right-click an entity > Detach Segment on Drag; then dragging an end separates it from what it joins unless dimensions or relations hold it; relations are not deleted; not in 3D sketches), **Override Dims on Drag/Move** (dragging or using Move changes the driving dimensions at the end of the drag; also a System Options > Sketch setting for all documents).
- **Numeric input**: right-click in a sketch > Sketch Numeric Input (or System Options > Sketch > Enable on screen numeric input on entity creation). While creating lines, rectangles, circles and arcs, fields appear for each size; type, Tab (Shift+Tab in 3D) to the next, Enter to finish. With it on, right-click > Add Dimension creates the dimensions with the entity and Sketch Dimension Driven makes them driven (reference).
- **Sketch Options** (System Options > Sketch): Auto-rotate view normal to sketch plane on creation and edit (kept on exit with changes; reverts to the earlier view when discarding); Use fully defined sketches; Display arc centerpoints; Display entity points (black fully defined, blue under defined, red over defined, green selected; over defined and dangling always shown); Prompt to close sketch; Create sketch on new part (Front plane); Override dimensions on drag/move; Display plane when shaded; Line length measured between virtual sharps in 3D; Enable spline tangency and curvature handles; Show spline control polygon by default; Preview sketch dimension when selected; Enable on screen numeric input.
- **Grid/Snap** (Document Properties, also Grid/Snap on the Sketch toolbar): Display grid, Dash, Automatic scaling, Major grid spacing, Minor-lines per major, Snap points per minor. Applies to drawings' rulers too.
- Other behaviours: Maintain proportions (the first dimension of a part sketch scales the whole profile uniformly; not for angular dimensions); Ctrl+C / Ctrl+V copy entities (pasted centred where clicked), Ctrl-drag copies and Shift-drag moves between sketches and documents; whole sketches copy and paste to a face; a sketch used by several features is marked in the tree; Edit Sketch Plane (right-click a sketch) changes the plane or face of an existing sketch; Sketch Complexity note: a complex sketch with sketch fillets rebuilds faster than many fillet features but is harder to edit.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Settings_Menu.htm ; .../t_Using_Automatic_Relations.htm ; .../t_Using_Automatic_Solve.htm ; .../t_Using_No_Solve_Move.htm ; .../t_Using_Detach_Segment_On_Drag.htm ; .../c_Override_Dims_on_Drag_Move.htm ; .../t_numeric_sketch_input.htm ; .../HIDD_OPTIONS_SKETCH.htm ; .../HIDD_OPTIONS_GRID.htm ; .../c_maintain_proportion.htm ; .../t_Cutting_Copying_and_Pasting_Sketch_Entities.htm ; .../t_Copying_and_Pasting_Entire_Sketches.htm ; .../HIDD_DVE_SKETCH_PLANE.htm ; .../c_Sketch_Complexity.htm

### Dimension types beyond Smart Dimension
- **Horizontal / Vertical Dimension** (Tools > Dimensions > Horizontal | Vertical): pick two entities (points, for vertical), then click to place, then the value in Modify; Esc undoes the last pick. Direction follows the sketch's orientation.
- **Ordinate** (Dimensions/Relations toolbar): Horizontal Ordinate | Vertical Ordinate measure from the first picked entity (the zero); the tool stays in ordinate mode until another is chosen; dimensions to edges, vertices, arc centres and extremes, midpoints; the group stays aligned (Break Alignment frees one); drag the zero dimension to move them all; jogged leaders avoid overlaps.
- **Angular**: between three points (end points, vertices, the origin) or two lines (or line and edge; pointer position picks which of the angles) or a line and an imaginary horizontal or vertical line; symmetric half or full angles about a centerline. **Angular Running Dimension**: a set from a zero line for arcs and circles (sketch or drawing). Lock: right-click while the preview shows the wanted type to lock it for placement; applies to point distance at an angle and angular dimensions.
- **Arc length**: Smart Dimension, pick the arc, then Ctrl-pick its two end points; Radius is the default for one pick. **Two points of one arc**: Shift-pick the first quadrant, then the centre or second quadrant. **Circular**: pick the circle, drag to place; leader tab sets Radius | Diameter display; text angle snaps to 15 degrees. **Centerline radial or diametric**: pick a centerline and a line or point; near side = radius, far side = diameter; further picks repeat without picking the centerline again.
- **Path Length** (see Make Path). **Driven dimensions**: Driven check in the Dimension PM Other tab; several at once from the shortcut menu (Dimension > Driven). **Zero and negative values**: allowed; Reverse Direction in the PM or a negative number flips the sense. **Preview of dimensions** when an entity is selected. **Auto Insert Dimension** on the context toolbar after Ctrl-selecting two entities (e.g. after Make Parallel).
- Drawing-only: Baseline, Chain, Chamfer, Symmetric Linear Diameter, Scan Equal, Isolate Changed Dimensions.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/t_Creating_Horizontal_Dimensions.htm ; .../t_Creating_Vertical_Dimensions.htm ; .../c_Ordinate_Dimensions.htm ; .../t_Creating_Horizontal_Ordinate_Dimensions.htm ; .../t_Creating_Vertical_Ordinate_Dimensions.htm ; .../c_Angular_Dimensions.htm ; .../c_Angular_Running_Dimension.htm ; .../t_Locking_Dimensions.htm ; .../t_creating_arc_dimensions.htm ; .../t_dimension_two_points_same_arc.htm ; .../t_Creating_Circular_Dimensions.htm ; .../t_dimensioning_centerlines.htm ; .../t_create_path_length_dimensions.htm ; .../t_settings_multiple_dimensions_to_driven.htm ; .../t_Inserting_Reference_Dimensions.htm ; .../t_zero_negative_dimensions.htm ; .../c_previewing_sketch_dimensions.htm ; .../t_Control_Dimension_Context_Toolbar.htm ; .../r_Dimensions_Relations_Toolbar_and_Menus.htm

### Quick snaps, additions
The Sketch Snaps page lists what each snap catches: End points and sketch points (ends of lines, polygons, rectangles, fillets, arcs, parabolas, partial ellipses, splines, points, chamfers, centerlines; arc centres), Center Points (circles, arcs, fillets, parabolas, partial ellipses), Midpoints, Quadrant Points (circles, arcs, fillets, parabolas, ellipses, partial ellipses), Intersections, Nearest (supports all entities; when cleared, inference shows from any distance; when set, snaps only when the pointer is near), Tangent (circles, arcs, fillets, parabolas, ellipses, partial ellipses, splines), Perpendicular, Parallel, Horizontal/vertical lines (to an existing horizontal or vertical line), Horizontal/vertical to points, Length (grid increments without showing the grid; hold Shift), Grid (the only one off by default; with "Snap only when grid is displayed" cleared it snaps even with the grid hidden), Angle (the Snap angle value is set in System Options > Sketch > Relations/Snaps). Only the entity being sketched shows snaps; hovering an existing entity wakes its snaps.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_Sketch_Snaps.htm ; .../c_Quick_Snaps.htm ; .../c_Inferencing.htm

---

## Part C. Evaluate

### Measure
Select up to six items (points, lines, surfaces, planes). Options: Arc/Circle Measurements = Center to Center | Minimum Distance | Maximum Distance | Custom Distance; Units/Precision; Show XYZ Measurements (dX, dY, dZ, otherwise only minimum distance); Point-to-Point mode; XYZ Relative To (Part Origin | a coordinate system); Projected On = None | Screen | Select Face/Plane (gives Projection and Normal distance; also projected surface area); Measurement History; Create Sensor; pin dialog; Quick Copy Setting. Vertex/point shows X, Y, Z. Also measures angle between coordinate systems.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_MEASURE.htm

### Mass Properties
Selected items (recalculate after changing), Options (units), Override Mass Properties, Include hidden bodies/components, Create Center of Mass feature, Report coordinate values relative to (coordinate system), Print, Copy to Clipboard. Results: density, mass, volume, surface area, centre of mass, principal axes of inertia, moments and products of inertia (principal axes triad drawn at the centre of mass). Section Properties is a sibling tool for planar faces (not read).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_MASSPROPERTY_TEXT_DLG.htm

### Section View (models)
Section Method: Planar (1 to 3 planes/planar faces) | Zonal (zones; needed to make bodies transparent). Section Options: Offset Method (reference plane | selected plane), Show section cap (+ Edit Color), Keep cap color, Graphics-only section. Section 1: plane or face (or Front/Top/Right plane), Reverse Section Direction, Offset Distance, X Rotation, Y Rotation, Edit Color; Section 1 only: Plane about axis (axis/temporary axis/hole/cylindrical face; optional point; Rotate plane along axis). Section 2 and 3 appear progressively.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_DYNAMIC_SECTION.htm

### Interference Detection (assembly; multibody parts)
Selected Components (default top assembly; one component = only interferences with it; two+ = between them), Calculate. Excluded Components (Hide excluded, Remember excluded). Results list (volume each; Ignore/Un-Ignore, Ignore all smaller than, Isolate when done, sort; Save Results to spreadsheet; Component view). Options: Treat coincidence as interference, Show ignored interferences, Treat subassemblies as components, Include multibody part interferences, Include surface bodies, Make interfering parts transparent, Create fasteners folder, Create matching cosmetic threads folder, Ignore hidden bodies/components. Non-interfering Components shown as Wireframe | Hidden | Transparent | Use current.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_INTERFERENCE.htm

### Draft Analysis
Direction of Pull (planar face, linear edge or axis; Reverse), Draft Angle (reference), Adjustment triad (drag rings; read-only angles with X/Y/Z), Face classification (on: faces bucketed and counted; off: contour map), Find steep faces, Calculate. Color Settings: Gradual transition (contour mode), Surface faces with draft, plus per-class colors (positive draft, negative draft, straight, requires draft, positive/negative steep).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_draft_analysis.htm
Not verified: exact list of class names beyond the ones above.

### Thickness Analysis
Report groups four critical thickness ranges (face count and area per range; a face in two ranges counts in the more critical one), lists critical features that violate the Target thickness in order of criticality. Intended for thin-walled plastic and casting parts. Not verified: the Thickness Analysis PropertyManager fields (Target thickness is the visible input; minimum/maximum/scale options were not read).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/r_thickness_analysis_reports.htm ; .../c_thickness_analysis.htm

### Curvature analysis
Surface Curvature Combs PM shows slope/curvature as combs on faces (sketch/curve curvature combs also exist). Zebra Stripes appear in feature PMs (Curvature Display group). Not verified: any standalone "Curvature" analysis dialog; only comb and zebra tools were read.
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_DVE_CURVATURE_HEDGEHOG.htm (search listing only; page not read)

---

## Part D. Assembly basics

### Mate PropertyManager
Three tabs: **Standard**, **Advanced**, **Mechanical**. Common: Entities to Mate (up to the number needed; Alt temporarily hides an obscuring face), Mate alignment (Aligned | Anti-Aligned; faces' normals same/opposite), Mates list (edit several at once), Options: Add to new folder, Show popup dialog, Use for positioning only (moves components without creating the mate).
- **Standard mates**: Coincident (faces/edges/planes share one infinite plane; vertices touch; coincident of origins offers Align axes) | Parallel (constant distance, items parallel) | Perpendicular (90 degrees) | Tangent (needs at least one cylindrical/conical/spherical face) | Concentric (same centreline; Lock rotation; misaligned concentric options Align this mate | Align Linked mate | Symmetric, Maximum deviation, Use Document Property, Remove link between mates) | Lock (fixes relative position and orientation) | Distance (value) | Angle (value). Multiple mate mode: Common reference + Component references, Create multi-mate folder, Link dimensions (distance/angle only).
- **Advanced mates**: Profile Center | Symmetric | Width | Path Mate | Linear/Linear Coupler | Limit (distance or angle range).
- **Mechanical mates**: Cam | Slot | Hinge | Gear | Rack Pinion | Screw | Universal Joint (one line each: cam = follower stays on tangent extruded faces; slot = bolt or slot moves in a slot; hinge = movement limited to one rotational degree of freedom; gear = ratio-coupled rotation about two axes; rack pinion = linear motion drives rotation; screw = concentric + pitch coupling rotation to translation; universal joint = output shaft driven by input shaft).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_NEW_ADD_MATE.htm ; .../r_mate_pm_advanced.htm ; .../r_mate_pm_mechanical.htm ; .../c_Mate_Alignment_SWassy.htm
Not verified: detailed behaviour of each mate beyond the short descriptions on the tab pages.

### Component patterns and Mirror Components
- Component pattern kinds: Linear, Circular, Curve driven, Sketch driven, Pattern driven (from a feature/hole pattern or another component pattern), Chain; patterns can be hidden/suppressed/isolated as a group and dissolved to independent components. Linear Component Pattern PM follows the feature linear pattern (Pattern Direction, Reverse Direction, Spacing and instances | Up to reference with Bounding box center | Selected reference, Offset distance, Set Spacing; Direction 2).
- Mirror Components: step 1 pick mirror plane and components; step 2 set orientation per component (opposite-hand version or just a copy, with orientation choices); step 3 opposite-hand destination (new file or derived configuration) with Insert Part options (custom properties, sketches, dimensions).
Source: https://help.solidworks.com/2024/English/SolidWorks/sldworks/c_component_patterns.htm ; .../r_linear_component_pattern_pm.htm ; .../r_Mirror_Components_PropertyManager.htm

---

## Part E. Settings, view, selection and behaviour

### E1. Document properties (per document; Options > Document Properties)
- **Units** (all document types; also status bar > Unit System > Edit Document Units): Unit system = MKS | CGS | MMGS | IPS | Custom (custom unlocks the table). Basic Units table rows: Length (units, decimals 0-8 or None, fractions with denominator 2-256 for inch-type units, round to nearest fraction, feet-inches conversion), Dual Dimension length, Angle (degrees or radians; decimals), plus other quantity rows in the full table (Not verified on the page read). Changing the system from the status bar does not need the dialog.
- **Drafting Standard / Dimensions**: Overall drafting standard = ANSI | ISO | DIN | JIS | BSI | GOST | GB (or a saved custom one); it sets defaults for dimension appearance. Dimensions page: font, Dual dimensions display (value position top/bottom/right/left), Primary precision (Unit Precision = digits after the decimal point, Tolerance Precision, Link precisions with model), Dual precision. Per-type pages: Linear, Angle, Radius, Diameter, Chamfer, Arc length, Ordinate dimensions. Detailing page holds display filters (e.g. shaded cosmetic threads). Per-dimension override lives in the Dimension Value PM (tolerance type, precision).
- **Grid/Snap**: Display grid, Dash, Automatic scaling (with zoom), Major grid spacing, Minor-lines per major, Snap points per minor. Grid colours come from System Options > Colors. Grid snap is the only snap off by default.
- **Image Quality**: Shaded and draft quality HLR/HLV resolution slider (Low faster to High slower) with Deviation (max chordal deviation; they move inversely), Optimize edge length, Apply to all referenced part documents (assemblies), Save tessellation with part document (parts; smaller files when off but no view-only display). Separate Wireframe/high quality HLR/HLV slider for drawing edges.
- **Material Properties** (parts; unavailable once a material is applied): Density (typed with any unit system, converted), Area Hatch/Fill = None | Solid | Hatch (pattern, scale, angle). Density is also editable in the Mass Properties options dialog.
- **Plane Display** page controls how reference planes are drawn; **Virtual Sharp Display**, **Configurations**, **Annotations** pages exist (not read).
Sources: https://help.solidworks.com/2024/English/SolidWorks/sldworks/HIDD_OPTIONS_UNITS_NEW.htm ; HIDD_OPTIONS_DRAFTING_STD.htm ; HIDD_OPTIONS_DIMS_New.htm ; HIDD_OPTIONS_GRID.htm ; HIDD_OPTIONS_IMAGE_QUALITY.htm ; HIDD_OPTIONS_XHATCH.htm (all under the same folder)

### E2. System options (global; Tools > Options > System Options)
- **Sketch**: Auto-rotate view normal to sketch plane on creation/edit (view restored if the sketch is discarded); Use fully defined sketches (features need fully defined sketches); Display arc centerpoints; Display entity points (colour = status: black fully defined, blue under defined, red over defined, green selected; over defined and dangling always shown); Prompt to close sketch (offers closing an open profile with model edges when making a boss); Create sketch on new part (new part opens a sketch on the Front Plane); Override dimensions on drag/move; Display plane when shaded; Line length measured between virtual sharps in 3D; Enable spline tangency and curvature handles; Show spline control polygon by default; Ghost image on drag; Show curvature comb bounding curve; Enable on screen numeric input on entity creation (+ Create dimension only when value is entered; not for slots); Preview sketch dimension when selected; Over defining dimensions = Prompt to set driven state and/or Set driven by default (four resulting behaviours: dialog defaulting to driven, dialog defaulting to driving, auto driven, auto driving); Turn off Automatic Solve Mode and Undo above N entities; Hide missing geometry error for suppressed dimensions. Shaded sketch contours is covered in its own topic (not read).
- **Relations/Snaps**: Enable snapping (turns all Sketch Snaps on, Grid still off), Snap to model geometry, Automatic relations, Sketch Snaps checklist (same list as the Quick Snaps), Snap angle (increment in degrees; relative to the sketch X-Y axes, or to the existing line when continuing from one), link to Document Grid settings. Make Dimension Driven? dialog: Make This Dimension Driven | Leave This Dimension Driving, Don't ask again.
  - Automatic relations created while sketching (pointer icons shown): Horizontal, Vertical, Coincident, Midpoint, Perpendicular, Tangent (the list the help pages show; fuller list Not verified). Hold Ctrl while sketching to suppress them; Ctrl-drag suppresses inference lines when dragging an endpoint.
- **Display**: Hidden edges displayed as Solid | Dashed (Hidden Lines Visible); tangent edge display As visible | As phantom | Removed (HLR, HLV, Shaded With Edges); edge display in Shaded With Edges: HLR (+ Optimize for thin parts) | Wireframe; assembly transparency for in-context edit (Opaque assembly | Maintain assembly transparency | Force assembly transparency); anti-aliasing None | Anti-alias edges/sketches | Full scene.
- **Selection**: Default bulk selection method Lasso | Box; Selection of hidden edges: Allow selection in wireframe and HLV modes; Allow selection in HLR and shaded modes; Enable selection through transparency (Shift selects the nearest transparent face when on); Enhance small face selection precision.
- **View**: Reverse mouse wheel zoom direction; Zoom to fit when changing to standard views; View rotation: Arrow keys increment angle, Mouse speed; Transitions (view transition, hide/show component, isolate, view selector) each with a speed slider or Off.
- **Spin Box Increments** ([options](https://help.solidworks.com/2026/English/SolidWorks/sldworks/r_spin_box_increment_options.htm), [Modify Dimension](https://help.solidworks.com/2021/English/SolidWorks/sldworks/t_modify_dimension_dialog_box.htm)): Length increments (one value for inch documents, one for metric), Angle increments, Time increments. A click on a spin arrow (or the Up/Down arrow keys, the thumbwheel, the mouse wheel in the Modify box) changes the value by one increment; holding Ctrl makes it ten increments, holding Alt a tenth of one. The increment never limits what can be typed: any value is accepted. The Modify box can change the increment and make it the default.
- **Default Templates**: separate default Part, Assembly, Drawing templates; Always use these default document templates | Prompt user to select document template. Used by File New, import, split-and-save and similar automatic document creation.
- **Backup/Recover**: Save auto-recover info every N minutes, Auto-recover folder (local only), Backup (keeps one version before the last save as "Backup of <name>"; folders configurable), save notifications by minutes.
- **FeatureManager**: Arrow key navigation (rollback bar with arrow keys) and other tree display options.
- **General**: Enable Confirmation Corner; PropertyManager behaviours.
Sources: HIDD_OPTIONS_SKETCH.htm ; r_relations_snaps_options.htm ; t_Using_Automatic_Relations.htm ; HIDD_OPTIONS_EDGES.htm ; HIDD_OPTIONS_SELECTION.htm ; HIDD_OPTIONS_VIEW_ROTATION.htm ; HIDD_OPTIONS_TEMPLATE_DEFAULTS_options.htm ; HIDD_OPTIONS_BACKUPS.htm ; c_rollback_bar.htm (base https://help.solidworks.com/2024/English/SolidWorks/sldworks/)

### E3. View and navigation
- **Mouse** (three-button / wheel): middle-drag = rotate (middle-click a vertex/edge/face first to rotate about it); Ctrl + middle-drag = pan; Shift + middle-drag = zoom; wheel = zoom at the pointer (Zoom About Screen Center from View > Modify; Shift + wheel accelerated zoom when scrollbars are off). Right-drag in empty space = mouse gestures (assemblies: right-drag on a component rotates it). Alt + middle-drag or Alt + arrows = roll (rotate parallel to the view plane). Ctrl + arrows = pan. Arrow keys = rotate by the View Options increment; Shift + arrows = rotate 90 degrees. Z = zoom out, Shift + Z = zoom in. F = zoom to fit. Zoom to Area (drag a box) and Zoom to Selection (select first; also from the tree's right-click menu).
- **Standard views**: Front, Back, Left, Right, Top, Bottom, Isometric, Trimetric, Dimetric, Normal To (selected face/plane/sketch), plus View Selector, viewports (Single, Two Horizontal/Vertical, Four, Link Views) and New View. Space bar opens the Orientation dialog (select a standard view, make named custom views, toggle the View Selector, choose axonometric type); Ctrl + Space opens the View Selector cube. Zoom to fit on view change is an option.
- **Display styles**: Shaded With Edges | Shaded | Hidden Lines Removed | Hidden Lines Visible | Wireframe; Perspective on/off under View Settings (Modify Perspective for camera distance); tangent edge display options.
- **Hide/Show**: View > Hide/Show items (planes, axes, temporary axes, origins, sketches, sketch relations, coordinate systems, bodies via the Hide and Show Bodies PM, components in assemblies: Tab hides all components under the pointer, Shift + Tab shows, Ctrl+Shift+Tab temporarily reveals hidden ones); Alt + click shows a hidden body while hovering. Heads-up View toolbar holds the quick view tools.
- **Section View**: see Part C Section View.
Sources: r_Middle_Mouse_Button.htm ; t_zoom_in_out.htm ; t_zoom_to_area.htm ; t_zoom_to_selection.htm ; c_orientation_dialog_box.htm ; r_standard_views_toolbar.htm ; c_shaded_with_edges.htm ; t_perspective_fundamentals.htm ; HIDD_HIDE_SHOW.htm ; c_time_saving_keyboard_shortcuts.htm
Not verified: Ctrl+1 to Ctrl+8 (and Ctrl+Shift+...) standard-view hotkeys do not appear on the shortcut page read; likely customisable via the Customize Keyboard dialog (HIDD_CUSTOMIZE_KEYBOARD) but the default assignments are not confirmed here.

### E4. Selection behaviour
- **Basics**: click selects (pre-highlight on hover); Ctrl + click adds/removes; Shift + click in the tree selects the range between two items; in assemblies Ctrl + box inverts a pre-selection; Shift selects a transparent face; Alt + click selects back faces of the View Selector cube. Select All, Invert Selection, Previous Selection and Selection Sets exist as tools.
- **Box / cross selection**: drag a box left to right = only items fully inside (solid box line); right to left = items inside and crossing (dotted box line, "cross select"). Defaults by document: parts select edges, assemblies components, drawings sketch entities/dimensions/annotations (change with filters). Within a box, Shift selects everything regardless of prior state, Ctrl inverts; selections outside the box are kept. Lasso is the alternative bulk method (default in Selection options, or right-click > Lasso Selection). Select over Geometry lets a drag start on the model.
- **Selection filters** (toggle toolbar F5, filters on/off F6): Clear All, Select All, Invert Selection; filter buttons for Vertices, Edges (E), Faces (X), Vertices (V), Surface Bodies, Solid Bodies, Axes, Planes, Sketch Points, Sketches, Sketch Segments, Midpoints, Connection Points, Routing Points, Center Marks, Centerlines, Dimensions/Hole Callouts, Surface Finish Symbols, Geometric Tolerances, Notes/Balloons, Datum Features, Weld Symbols, Weld Beads, Datum Targets, Cosmetic Threads, Blocks, Dowel Pin Symbols, mesh facet types. The pointer shows the filter icon when a filter is active.
- **Select Other**: right-click the model > Select Other; list of entities under the pointer in depth order (hover highlights; Tab or middle-wheel scrolls; right-click the model to hide a face and reveal the next; click to pick).
- **Loops and tangency**: right-click an edge > Select Tangency (tangent-connected chain) or Select Loop; right-click a selected loop > De-select Loop; Select Partial Loop for chains of small edges (direction by which side of the midpoint was clicked). Tangent propagation checkboxes in fillet/chamfer/draft PMs do this inside the feature.
- **Selection breadcrumbs / contextual selection**: a context view of the current selection (e.g. the sketch behind a feature, mates of a component).
- **PropertyManager selection boxes**: the active box is pink; picking in the view or tree fills the active box; click another box to make it active; an item can be removed with right-click > Delete (one) or Clear Selections (all); boxes grow, drag the handle to resize, right-click Autosize resets; some PMs have an "advance" pointer: right-click advances to the next box when several selections are required.
- **Accepting**: OK/Cancel in the PM, press Enter (OK) or Esc (Cancel), right-click in the view when the pointer shows the OK mark (accepts the preview), the Confirmation Corner (OK, Cancel, Exit Sketch, Cancel Sketch; can be turned off in General options), and the D key moves the confirmation buttons to the pointer position (press D again to put them back).
Sources: c_Box_Selection.htm ; c_Cross_Selection.htm ; c_Selection_Overview.htm ; r_Selection_Filter.htm ; HIDD_SelectOther_dlg.htm ; t_select_partial_loop.htm ; c_selection_breadcrumbs.htm ; r_pm_overview.htm ; c_accepting_features.htm ; c_Rightclick_Advance_Selection.htm ; HIDD_OPTIONS_SELECTION.htm
Not verified: the exact name of the lasso gesture in 2024 vs older releases and whether "Select Loop" appears for every edge (seen as a right-click command in PM topics).

### E5. Keyboard shortcuts, shortcut bars, context toolbars, mouse gestures
Defaults confirmed on the Selected Keyboard Shortcuts page (2024):
- General/UI: S opens the shortcut bar; Enter repeats the last command; Esc cancels/dismisses; Ctrl + B rebuild (changed features); Ctrl + Q rebuild all (from the Rebuild topic); Ctrl + R redraw; Ctrl + Tab next open document; Ctrl + C / Ctrl + V copy and paste (sketch entities, features, components); Shift + F10 or the menu key opens the shortcut menu and context toolbar; D moves the confirmation buttons to the pointer.
- Display: F zoom to fit; Z zoom out; Shift + Z zoom in; arrow keys rotate; Shift + arrows 90 degrees; Alt + arrows roll; Ctrl + arrows pan; Space = View Selector/Orientation dialog; Ctrl + Space = View Selector.
- Sketch: Ctrl while sketching = no automatic relations; Ctrl-drag endpoint = no inference lines; Shift + drag line = length snap; Shift + click = turn on snapping; Tab = switch XYZ plane in 3D sketch; Shift + drag moves sketch entities; Alt + click on dimension placement turns off auto alignment.
- Assembly: Alt hides a face for mating; Alt + drag creates a SmartMate; Ctrl + drag copies a component; Tab/Shift+Tab hide/show components below the pointer or rotate an inserted component 90 degrees.
- Dimensions: Shift + click while dimensioning arcs/circles snaps to max/min; Alt + 0176 degree sign, Alt + 0216 diameter, Alt + 0181 micro.
- Selection Filter: F5 toggle toolbar, F6 toggle filters, E edges, X faces, V vertices. F9 shows/hides the FeatureManager area. Shift + C collapses all tree items. A cycles partial fillet preview.
- Shortcut bars: Tools > Customize > Shortcut Bars (separate for Part, Assembly, Drawing, Sketch); S opens it (key is user-definable), type in Search All Commands to add a tool; arrows move, Alt + Down opens a tool's menu, Enter runs, Esc dismisses.
- Context toolbars: appear on selection in graphics area or tree; subset of shortcut-menu items; right-click for the rest; keyboard navigable only together with the shortcut menu.
- Mouse gestures: right-drag in the view; 2, 3, 4, 8 or 12 gesture guide (default 4 enabled); assignments editable in Customize > Mouse Gestures (drag a command onto a gesture slot).
- Not verified: Ctrl + 1..8 view hotkeys and default hotkeys for most feature commands (none are assigned by default beyond the above, as far as the page read states).
Sources: https://help.solidworks.com/2024/english/SolidWorks/sldworks/c_time_saving_keyboard_shortcuts.htm ; t_rebuild.htm ; Chunk150219028.htm (shortcut bars; folder .../sldworks/) ; c_context_toolbars.htm ; c_mouse_sestures.htm ; r_Selection_Filter.htm ; c_featuremanager_design_tree_overview.htm

### E6. FeatureManager behaviour
- **Rollback bar**: drag up/down to step through regeneration (or arrow keys when "Arrow key navigation" is enabled); rolled-back items are grey; commands to roll back, roll forward, roll to previous, roll to end, roll back to absorbed features, and delete rolled-back features with dependents. New features can be added while rolled back (inserted at the bar); the model can be saved with the bar anywhere.
- **Suppress/Unsuppress**: removes the feature from the model without deleting it (greyed in the tree); applies to This Configuration | All Configurations | Selected Configurations; governed by parent/child (suppressing a parent suppresses children).
- **Reorder**: drag items in the tree; changes the rebuild order; dragging changes regeneration order; rules for parent/child limits when reordering are Not verified (only suppression rules were read).
- **Parent/Child**: right-click a feature > Parent/Child shows what it depends on and what depends on it.
- **Edit Feature vs Edit Sketch**: Edit Feature reopens the PM (with its pick lists); Edit Sketch reopens the underlying sketch; a feature's profile sketch is an absorbed child item. A sketch used by several features can be shared; "Edit Sketch" then affects all (detailed rules: Not verified).
- **Naming**: rename by two slow clicks on the name; the PM title bar shows names like Boss_Extrude1; double-click a feature to show its dimensions. Default naming pattern beyond that: Not verified.
- **Folders** (tree contents): Annotations, Solid Bodies, Surface Bodies, Equations, Material, Sensors, Favorites, Design Binder, Mates (assembly), user folders; folder prefix (-) means contained items have issues.
- **Prefixes**: sketches: (+) over defined, (-) under defined, (?) cannot be solved, none = fully defined. Assembly components: (+), (-), (?), (f) fixed; mates: (+), (?). External references: -> external, ->* locked, ->x broken, ->? out of context. A rebuild-needed marker precedes changed features.
- **Errors**: red name + error icon = failed (no geometry); green + warning icon = rebuilt with warnings; parent nodes show a warning when a child warns. **What's Wrong?** dialog lists them (dangling dimensions/relations, fillet too large, etc.). Rebuild = Ctrl + B (changed features only) or Ctrl + Q (all).
Sources: c_rollback_bar.htm ; c_Suppress_and_Unsuppress_Features.htm ; c_Dependency_Editing.htm ; c_FeatureManager_Design_Tree_Conventions.htm ; c_featuremanager_design_tree_overview.htm ; HIDD_NEW_WHATS_WRONG.htm ; t_rebuild.htm

### E7. Rebuild, value input, equations, configurations
- **Typing values**: numeric PM fields accept "=" to start an equation using global variables, functions, file properties and dimension names; tooltip says "Enter a value or start with = to create an equation". Fields can toggle between showing the equation and its value. In the Modify box of dimensions the same applies. Equations in multi-configuration documents show a configuration button (This/All/Specified).
- **Units in expressions**: values can carry units (example given: 100in + 3mm + 5cm); units are converted to the document unit; per-configuration units possible for global variables.
- **Global variables**: defined in the Equations dialog or Modify box (name = value, e.g. Well_Volume = 20000); can reference other variables and dimensions ("D1@Sketch4"); can drive dimensions (D1@Extrude1 = "Height"); can be shared between models and configured. Linking two dimensions: set both equal to the same variable (preferred over legacy linked/shared values).
- **Equations folder** appears after the first equation. Dimension names use the form D1@Sketch1 / D1@Boss-Extrude1.
- **Configurations**: one document holds several variants (different dimensions, suppressed features, custom properties; in assemblies suppressed components and per-config mate/feature values); created manually or from an Excel design table; PMs show This/All/Specified Configuration choices where values may differ.
- **Rebuild**: Ctrl + B or the Rebuild button rebuilds only changed features; Ctrl + Q forces all; rebuild order follows the tree and rollback bar position.
Sources: c_direct_input_of_equations2.htm ; c_global_variables.htm ; c_specifying_units.htm ; c_create_equations_modify_dialog.htm ; c_Configurations_Overview.htm ; t_rebuild.htm
Not verified: operator/function list (Operators, Functions and Constants page not read).

### E8. In-view drag handles (Instant3D) and the triad
- **Instant3D** (Features toolbar toggle): selecting a feature face shows manipulators: arrow/handle dragged to resize extrude depth (dragging the other way can flip a boss into a cut), dimension handles offset or translate faces, angle dimension handle rotates faces, handle colour/icon shows when something is not draggable (constrained or unsupported). Single-click a dimension = Quick Edit typing; double-click = full dialog. Ctrl-drag copies a feature (also copies a fillet to another edge); the triad centre drags a feature onto another face. On-screen rulers give increments and snapping; Live Section Planes slice the model; mirrors and patterns show the seed's manipulators and the whole feature updates.
- **Triad** (Move/Copy Bodies Translate/Rotate, assembly Move Component, exploded views, Flex/Deform, 3D sketches): centre ball drags freely (Alt + drag aligns to an edge/face), arms drag along X, Y or Z, wings drag in the wing plane, rings rotate; Ctrl + drag an arrow copies; the triad can be repositioned or re-oriented via its right-click commands.
Sources: c_instant3d_functionality.htm ; t_I3D_modifying_features.htm ; c_triad.htm ; HIDD_DVE_FEAT_MOVE_SURF.htm
Not verified: exact on-screen handle names for each feature type and whether the extrude handle snaps to rulers by default.
