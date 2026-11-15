# Feature options: target for every tool

Goal (user, 2026-11-13): every function has the comprehensive options a professional CAD program gives it, with
SolidWorks as the reference for what those are. This file is the checklist; the roadmap says when. Looks stay ours
(compact toolbar, forms in the left panel). The option names and meanings below follow `docs/SOLIDWORKS_REFERENCE.md`
(read from the official SolidWorks help); look there for what each option does.

Status key: [x] done, [~] partial or in progress, [ ] not started.

## Foundation: selection fields (needed by most of what follows)

- [ ] A form field kind `pick`: a list box ("Selected edges", "Faces to remove", "Neutral plane", "Axis",
  "Up to surface") that collects what is clicked in the view while it is active: edges, faces, vertices, sketch
  lines, planes, axes; single or multi; one box active at a time (shown highlighted), as in SolidWorks; right-click
  Delete (one) and Clear Selections (all); × per row; hover highlights; boxes resizable; right-click in the view
  advances to the next box or accepts (OK).
- [ ] References stored on the feature as pick points (a point on the edge; a point and normal on the face; the
  vertex position) and resolved by the kernel against the body as it is at that step: nearest entity within a
  tolerance, else a clear "pick it again" error. Same idea as sketch region picks. Optional tangent propagation
  for edges and faces.
- [x] Selected contours (sketch regions) for extrude, cut, revolve.
- [ ] Pick to fill: any option that is a place or a reference (a position, an axis, a direction, a size taken from
  the model) can be set with the mouse. Click into the field, then click in the view: a circle or arc gives its
  centre (and axis and radius), a straight line its midpoint or the clicked spot on it, a point or corner itself,
  a face the clicked spot and its normal. First users: fastener (lands in the hole, takes the hole's axis and
  suggests the matching size), hole and pocket position, move, pattern axis and direction, mirror plane.
- [ ] Preview modes for edge/face features (full, partial, none) and Show preview toggles.

## Sketch-based features

Extrude / cut
- [~] From: sketch plane, offset. To add: surface/face/plane, vertex.
- [~] End conditions: blind, through all, up to next, mid plane. To add: through all both, up to vertex, up to
  surface, offset from surface (with reverse offset and translate surface), up to body.
- [~] Direction 2 (own end condition), draft (angle, outward), flip side to cut. To add: direction of extrusion
  (vector other than the sketch normal), merge result (off = new body).
- [ ] Thin feature: type one-direction, mid-plane, two-direction (two thicknesses); auto-fillet corners with
  radius (open sketches); cap ends with cap thickness; required for open contours.
- [ ] Feature scope (which bodies a cut affects), normal cut (sheet metal only; skip).
- [x] Selected contours. [~] Drag handle for depth.

Revolve / revolved cut
- [ ] Axis of revolution: any sketch line or centreline, or a model edge / reference axis (now only sketch u or v).
- [ ] Direction 1 type: blind (angle), up to vertex, up to surface, offset from surface, mid-plane; reverse
  direction; direction 2 with the same options; flip side to cut; merge result.
- [ ] Thin feature (one-direction, mid-plane, two-direction), feature scope.
- [x] Selected contours. [ ] Drag handle for the angle.

Sweep / swept cut
- [x] Profile and path sketches, helix path, twist.
- [ ] Circular profile by diameter (no profile sketch), path from sketch, curve or model edges, bidirectional.
- [ ] Guide curves (order, merge smooth faces, show sections).
- [ ] Profile orientation: follow path, keep normal constant. Profile twist: none, minimum twist, follow first
  guide curve, follow first and second guide curves, twist angle (degrees, radians, revolutions), direction vector,
  tangent to adjacent faces, natural.
- [ ] Start/end tangency (none, path tangent), merge tangent faces, show preview, thin feature.
- [ ] Swept cut only: solid profile (tool body along a path), feature scope.

Loft / lofted cut
- [x] Sections in order, ruled or smooth.
- [ ] Profile list with move up/down and connection points.
- [ ] Start/end constraints: default, none, direction vector, normal to profile, tangency to face, curvature to
  face; draft angle; tangent length; reverse; apply to all.
- [ ] Guide curves (influence: to next guide, next sharp, next edge, global; guide tangency types), centreline
  with number of sections, close loft, merge tangent faces, merge result, micro tolerance, thin feature.

Boundary boss / cut, rib, wrap, dome
- [ ] Boundary: curves in direction 1 and 2, curve influence (global, to next curve, next sharp, next edge,
  linear), tangent type per curve (default, none, normal to profile, direction vector, tangency to face,
  curvature to face), draft angle, tangent influence %, tangent length, flip connectors, merge tangent faces,
  close surface, trim by direction.
- [ ] Rib: open sketch, thickness side (first, second, both), thickness value, extrusion direction (parallel or
  normal to sketch), flip material side, draft with outward and reference contour, thickness at sketch plane or
  wall interface, type linear or natural.
- [ ] Wrap: type emboss, deboss, scribe; method analytical or spline surface; source sketch (closed contours),
  face, thickness, reverse, pull direction.
- [ ] Dome: faces, distance, reverse (concave), constraint sketch of points, direction, elliptical dome,
  continuous dome, show preview.

## Applied features

Fillet
- [x] Constant radius on an edge group (all, top, bottom, vertical, horizontal).
- [ ] Mode: manual or FilletXpert. Items: selected edges, faces, features and loops; tangent propagation; full,
  partial or no preview; several radii in one feature (multiple radius).
- [ ] Types: constant size (symmetric or asymmetric two-distance), variable size (attached radii, control
  points, number of instances, smooth or straight transition), face fillet (symmetric, chord width, asymmetric,
  hold line; help point; constant width), full round (side, centre, side face sets).
- [ ] Profile: circular, elliptic, conic rho, conic radius, curvature continuous.
- [ ] Setback vertices and distances, partial edge start/end condition, round corners, keep features, overflow
  type (default, keep edge, keep surface), select through faces, omit attach edges. Drag handle for the radius.

Chamfer
- [x] Equal distance on an edge group.
- [ ] Selected edges, faces, features and loops; tangent propagation; previews.
- [ ] Types: angle-distance, distance-distance (symmetric or asymmetric), vertex (three distances or equal),
  offset face (multi-distance), face-face (symmetric, asymmetric, chord width, hold line); flip direction.
- [ ] Partial edge start/end condition, keep features, select through faces, help point.

Shell
- [x] Thickness, faces to remove by side (top, bottom, ...).
- [ ] Picked faces to remove, shell outward, show preview, multi-thickness faces with their own thickness;
  no face removed gives a closed hollow body.

Draft
- [x] Angle on face sides from a neutral plane.
- [ ] Type: neutral plane, parting line, step draft (tapered or perpendicular steps).
- [ ] Picked faces to draft, picked neutral plane/face, face propagation (none, along tangent, all faces, inner
  faces, outer faces), reverse direction, direction of pull, parting lines with other face, direction 1 and 2
  angles, symmetrical, allow reduced angle, DraftXpert mode.

Hole / hole wizard
- [x] Hole by spec (clearance, tap, heat-set, counterbore, countersink, nut trap) at a position.
- [ ] Wizard types: counterbore, countersink, hole, straight tap, tapered tap, legacy, and the slot variants.
- [ ] Standard (ISO, ANSI metric and inch, others), type (screw clearance, drill sizes, tap drills), size, show
  decimal values, fit (close, normal, loose), custom sizing overrides.
- [ ] End condition: blind (depth, thread depth, depth to shoulder or tip), up to vertex, up to surface, offset
  from surface (also through all and up to next, to confirm); reverse direction.
- [ ] Options: head clearance, near-side, under-head and far-side countersink, cosmetic thread or tap drill
  diameter, tolerance/precision callouts, feature scope, favourites.
- [ ] Positions tab: click to place with snaps and inference lines, from an existing 2D sketch (every point and
  vertex), 3D sketch for several faces, instances to skip; several holes per feature.

Thread
- [x] External/internal by diameter, pitch, length.
- [~] Edge of cylinder (several edges in one step, each from its own hole or shaft), offset, start angle and a
  second direction; not yet the optional start location (vertex, edge, plane or face).
- [~] End condition: blind (depth), revolutions; not yet up to selection or maintain thread length.
- [~] Size table, override diameter and pitch, cut thread or extrude thread (ridges only where the wall or core stands
  behind them), right/left hand, multiple starts, trim with start/end face; the preview while the form is open shows
  the ridges as a ghost and the real cut is made on OK. Not yet mirror profile, rotation angle, preview options.
- [ ] Cosmetic thread: standard, type, size, minor/major diameter, end condition (blind, through, up to next).

Mirror (feature)
- [x] Whole body across a base plane.
- [ ] Mirror plane/face (picked face or reference plane) plus a secondary plane (mirror seed only); mirror
  chosen features, faces or bodies; geometry pattern; merge solids / knit surfaces; propagate visual properties.

Patterns (feature)
- [x] Linear and circular pattern of chosen steps.
- [ ] Linear direction 1 and 2: direction by picked edge or axis, reverse, spacing and number of instances, or
  up to reference with offset (centroid or selected reference); direction 2 symmetric; pattern seed only.
- [ ] Circular: pattern axis, angle or equal spacing (360), number of instances, direction 2 and symmetric.
- [ ] Both: features, faces or bodies to pattern; instances to skip; vary sketch; geometry pattern; feature scope;
  propagate visual properties.
- [ ] Curve-driven (curve, number, equal spacing or spacing, transform or offset curve, tangent to curve or align
  to seed, direction 2), sketch-driven (reference sketch, centroid or selected point), table-driven (XY table
  with coordinate system, reference point, load/save tables), fill pattern (boundary, perforation / circular /
  square / polygon layouts, spacing, margins, stagger angle, seed cut shape, validate count), variable pattern
  (pattern table of dimension values).

Combine, split, move/copy, scale
- [x] Combine with another part (join, cut, intersect); split by plane.
- [ ] Multi-body parts: bodies folders; combine (add, subtract, common) by picked bodies; split (trimming tools,
  cut bodies, resulting bodies, target bodies); move/copy bodies (translate by deltas or reference, rotate,
  copies); scale (about centroid, origin or coordinate system; uniform or per-axis factors); delete/keep body;
  intersect (regions to exclude, merge result, consume surfaces); indent (target and tool body, keep/remove,
  thickness, clearance, cut); flex.

Reference geometry
- [x] Plane, axis, point steps.
- [x] Plane: up to three references picked in the view (planar or cylindrical face, edge, vertex, base plane,
  reference step) with the constraints that fit: coincident, parallel, perpendicular, tangent (cylinder), at angle
  (number of planes), offset distance (number of planes, draggable), mid plane, flip normal; so also three points,
  plane and point, edge and point, normal to an edge. A reference taken from the model keeps its pick and follows
  the model: the kernel finds the face, edge or vertex again at every rebuild (a flat face moved along its normal,
  split or resized in its plane; a cylinder or cone about the same axis, its radius changed; an edge or vertex where
  the faces that met there meet now) and the plane is drawn where the kernel puts it. A reference that can no longer
  be found is an error naming the plane and what it lost (dangling). Older steps kept by value stay so (the form says
  so; pick again to make them follow).
- [ ] Plane, still open: following a face that moved sideways or turned, or a hole that moved (now an error: pick it
  again); project; parallel to screen; set origin on curve; tangent to cones and other curved faces.
- [x] Axis: one line/edge/axis, two planes, two points/vertices, cylindrical/conical face, point and face/plane,
  sketch line; references taken from the model follow it as for Plane.
- [x] Point: coordinates (placed by a click in the view, dragged by its arrows), arc centre, centre of face, on
  point, intersection of two straight edges, along a straight or circular edge by distance or percentage (count);
  those taken from the model follow it as for Plane, and reopen as they were made.
- [ ] Point, still open: projection; evenly distributed.
- [ ] Coordinate system: origin, X/Y/Z directions from points, edges or faces, reverse axes, numeric position and
  rotation.
- [ ] Curves: helix/spiral as its own step (defined by pitch/revolution, height/revolution, height/pitch, spiral;
  variable pitch, taper, start angle, direction), projected (sketch on faces or sketch on sketch), composite,
  through XYZ points, through reference points (closed), split line (projection, silhouette, intersection).

## Sketch

- [~] The command-by-command state is in `docs/SKETCH_TOOLS.md` (every SolidWorks sketch command against the app).
- [x] Draw tools with forms in the left panel: line (orientation as sketched, horizontal, vertical, angle; for
  construction; length and angle; add dimensions), midpoint line, line-to-tangent-arc switch (A, or back over the
  end point); rectangles (corner, centre, 3 point corner, 3 point centre, parallelogram, chosen in the form too;
  construction lines from corners or midpoints; corner X/Y and centre X/Y parameters); slots (straight, centrepoint
  straight, 3 point arc, centrepoint arc, chosen in the form too; centre to centre or overall length; add
  dimensions); polygon (3 to 40 sides, inscribed or circumscribed, centre, diameter, angle); circle, arc and point
  parameters; infinite length lines (trimmed into rays and pieces); slot parameters and the
  Slot PropertyManager, Fix Slot and Equal Slots for straight and arc slots; conic with Auto tangency; Belt/Chain
  (members in order, flip, driving length, thickness; not Engage belt). PropertyManagers of a selected line (Line
  properties), circle, arc and point: Existing relations (status, delete), Add relations that fit, For construction,
  Infinite length, Parameters (Additional parameters Start, End, Delta for lines), solved as one undo step; Existing
  and Add relations on the ellipse, parabola and conic forms too. Not built: normal-arc intent zones.
- [x] Curves: ellipse, partial ellipse, parabola, conic (Rho), spline through points, style spline (Bezier,
  B-spline degree 3, 5, 7; control polygon, insert control vertex), each with its form, closed areas and open
  chains found, exact edges in the solid; trim, extend (not splines) and split on them, into exact pieces of their
  own kind; offset, fillet and chamfer on them; point on conic, a conic's Rho dimension and its Auto tangency. Not
  built: equal and radius relations on them; point on spline; trim, split and offset of rational style splines.
- [x] Spline tools: handles at every spline point (circle, arrow head and diamond; Alt or Shift for both sides),
  Add tangency control, Add curvature control (radius of curvature held), Spline form (show curvature with scale
  and density, maintain internal continuity, proportional, spline point number, X, Y, radius of curvature,
  curvature, tangent weighting 1 and 2, tangent radial direction, tangent driving, reset this handle, reset all
  handles, relax spline), control polygon of a spline (drag a vertex; Spline polygon form), curvature combs on any
  curve, inflection points, minimum radius, convert spline to style spline and back (exact), fixed spline length
  dimension, insert spline point keeping the curve, style spline local edit and rational style splines (control
  vertex weights), equation curve range locks and relations on its ends, fit spline Constrained and on any curve
  or model edge, spline settings (handles, polygon by default, comb bounding curve). Not built: Raised degree, generic
  splines, fit spline edit chaining and its preview options, style spline inference clicks, combs after the
  sketch is closed.
- [x] Modify and selection: box selection with the Select tool (left to right inside, right to left crossing,
  Shift adds, Ctrl inverts); copy, cut and paste, Ctrl-drag copies and Shift-drag moves, whole sketches copied and
  pasted on a face or plane (or into an open sketch); dynamic mirror; jog line; segment (deleting a point re-spaces
  the rest, the count can be changed later); replace entity; modify sketch (translate, rotate, scale, flip; dragged
  and turned in the view); check sketch for feature; tangent or normal arc by the direction the pointer leaves; edit
  sketch plane; make path (tangent to a path, path length); select chain; reverse endpoint tangent; align grid/origin; linear pattern direction from a sketch line; sketch patterns kept for editing (right-click Edit
  pattern), Display instance count (double-click to change it), instances to skip picked in the view, circular
  centre picked from a point or the origin, Radius and Arc angle. Not built:
  lasso, dragging a pattern's selection point, segment on splines, ellipses, parabolas and conics.
- [x] Whole-sketch tools: shaded sketch contours (drag an area to move its entity, Alt + click for Extruded
  Boss/Base), Instant2D handles with a ruler, Close sketch to model, contours bounded by the face's model edges,
  Rapid sketch, Derived sketch (follows its parent; Underive), Repair sketch reporting points shared by three or
  more entities, SketchXpert opening by itself; the 2D to 3D group (add to front, top, right, left, bottom, back
  and auxiliary sketch, create sketch from selections, align sketch, convert to extrusion and cut). Not built:
  Make Block and Mirror/Offset from a shaded contour, derived sketch positioned by dimensions, Rapid sketch onto
  planes, the direction of Convert to extrusion by a click in the view.
- [x] The model in a sketch: the part's edges and corners (and other sketches' entities) can be picked in the
  Dimension, relation and Select tools and are snapped to; Convert entities, Intersection curve, Silhouette
  entities, Pierce point; offset, mirror and pattern direction from model edges. All by value: what is taken from
  the model is locked where it was and does not follow later changes to it.
- [x] Dimensions and relations: driven dimensions; arc length, three-point angle, line midpoint, doubled distance,
  arc conditions; horizontal, vertical and ordinate dimensions; path length (driving or driven); angular running
  dimensions; ordinate rows (Break alignment, drag the zero, along an edge); Add relations form;
  relation filters, suppress and replace; Intersection, Equal slots, Fix slot; fixing over-defined sketches
  (SketchXpert); Fully define with relation choice, baseline or chain and a datum; automatic relations setting
  with parallel, perpendicular and tangent inference; tangent, perpendicular, parallel, angle and length snaps;
  automatic solve, detach segment on drag, override dimensions on drag, show relations.
- [x] Sketch text (local fonts, along curves, exact outlines), sketch picture (with scale tool; dragged in the view
  to move it, by a corner to size it), equation driven curve (spline fit; rigid, its ends take relations; range
  locks), blocks (make with text, equation curves and blocks inside, insert with Link to file, edit with Rebuild,
  add/remove entities, explode, save; colour, hide, Lock angle, For construction; instances are rigid bodies that
  relations and dragging move), fit and simplify spline. Not built: text Link to Property, document font and stick
  fonts; pictures from TIFF, PSD or WMF.
- [x] The cursor snaps to the part's other visible sketches: their points, midpoints, centres and lines, projected
  onto the sketch plane (circles and arcs only from a parallel plane). The point lands there but is not tied to
  the other sketch by a relation.
- [x] A sketch is left as a plain sketch step unless it was started from Extrude, Cut or Revolve; New part makes
  an empty part. A press on locked geometry, or anywhere while something is selected, does not turn the view.
- [~] Entities and tools already in the app: see `docs/ROADMAP.md`; the list below is what the reference adds.
- [x] Smart dimension: dimension type follows the pick (line length; two lines angle; parallel lines distance;
  point to line; two points horizontal, vertical or aligned by cursor; radius; diameter; arc length; line and arc
  midpoint pick; doubled distance to a centerline); driven dimension when it would over-define; value box accepts
  expressions; right-click locks the type; zero and negative position dimensions, Reverse direction; tolerance
  and precision (no fit tolerances); spline handle length and angle; the first dimension scales the sketch.
- [ ] Line options: orientation (as sketched, horizontal, vertical, angle), for construction, infinite length,
  midpoint line; centerline; rectangles (corner, centre, 3-point corner, 3-point centre, parallelogram) with
  construction lines from corners or midpoints; slots (straight, centrepoint straight, 3-point arc, centrepoint
  arc; centre-to-centre or overall length); circle and perimeter circle; arcs (centrepoint, tangent, 3-point);
  polygon (3 to 40 sides, inscribed or circumscribed); spline with handles and curvature; ellipse, partial
  ellipse, parabola, conic; text (font, alignment, flip, width factor, along a curve); point.
- [ ] Trim: power trim, corner, trim away inside, trim away outside, trim to closest; keep trimmed entities as
  construction; ignore construction geometry. Extend entities. Split entities, joined again by deleting the split
  point. All on every curve kind. Still open: extending by dragging in Power trim and Trim to closest; trim away
  inside of a curve between the boundaries that does not cross them; trim away outside extending a curve that
  crosses one boundary only.
- [x] Offset entities: distance, add dimensions, reverse, select chain, bi-directional, construction geometry
  (base/offset), cap ends (arcs or lines), on every curve kind (ellipses, splines, parabolas and conics as splines
  within 0.000001 mm, rebuilt with their chain). Convert entities (select chain, for construction); intersection curve.
- [~] Mirror entities (copy toggle) and dynamic mirror; linear sketch pattern (two directions, spacing, angle,
  instances, instances to skip); circular sketch pattern (centre, spacing, equal spacing, radius, arc angle);
  move, copy, rotate, scale (with copies), stretch (from/to or X/Y, repeat, keep relations); all on every curve
  kind. Missing: display instance count.
- [x] Sketch fillet (radius, keep constrained corners, dimension each) and chamfer (angle-distance,
  distance-distance, equal distance), between any two curve kinds, each side cut exactly.
- [~] Relations: add relations for the full list in the reference (horizontal, vertical, collinear, coradial,
  perpendicular, parallel, tangent, concentric, midpoint, intersection, coincident, equal, symmetric, fix, pierce,
  merge points, doubled distance, ...); display/delete relations with filters (all, dangling, over defining,
  external, defined in context, locked, broken, selected entities), suppress, replace. Done but pierce as a
  relation, equal curvature, torsion continuity, point on spline or conic; defined in context and broken do not
  apply (no assembly context).
- [~] Fully define sketch (relations to use with select all / deselect all, baseline/ordinate/chain schemes, placement;
  Calculate shows what it adds as ghosts, OK adds it); repair sketch (gaps,
  overlaps, small entities, 3+ endpoint junctions); over-defined handling (make driven / leave driving). Done but
  the 3+ endpoint junction report of Repair sketch.
- [~] Quick snaps: point, centre point, midpoint, quadrant, intersection, nearest, tangent, perpendicular,
  parallel, horizontal/vertical, horizontal/vertical to points, length, grid, angle; Ctrl suppresses automatic
  relations. Rapid sketch. Construction geometry toggle. Done: single-use quick snaps (double-click keeps one),
  all but Nearest, horizontal/vertical as one; construction toggle. Not yet: Rapid sketch.

## Parts and assembly

- [x] Pattern of a part (linear, radial), move, rotate, duplicate, mirror copy, material.
- [~] Drag handles for move and rotate (triad: centre ball free, arms along X/Y/Z, wings in plane, rings rotate,
  Ctrl+drag copies).
- [ ] Mirror copy that stays linked to its source (editable as a mirror); mirror components with opposite-hand
  option.
- [ ] Mates, standard: coincident, parallel, perpendicular, tangent, concentric (lock rotation), lock, distance,
  angle; mate alignment aligned / anti-aligned; multiple mate mode.
- [ ] Mates, advanced: profile center, symmetric, width, path, linear/linear coupler, limit (distance, angle).
- [ ] Mates, mechanical: cam, slot, hinge, gear, rack pinion, screw, universal joint.
- [ ] Component patterns (linear, circular, curve driven, sketch driven, pattern driven, chain).
- [ ] Material library with densities; appearances per face.
- [x] Export history for FreeCAD: a macro that rebuilds each part as a PartDesign Body with its steps and names
  (sketches with relations and dimensions, Pad, Pocket, Revolution, Groove, lofts, pipes, helices, Fillet, Chamfer,
  Thickness, Draft, Hole, Mirrored, patterns, datums, threads as bore and helix ridge); steps FreeCAD cannot express
  come across as solids, and every step is checked against the kernel's body. SolidWorks and Fusion scripts: not yet.

## Evaluate

- [ ] Measure: picked entities, arc/circle measurement mode (centre to centre, minimum, maximum), show XYZ deltas,
  point to point, projected on a plane, units/precision, history.
- [ ] Mass properties: density, mass, volume, surface area, centre of mass, principal axes and moments of inertia,
  include hidden bodies, coordinate system, override.
- [ ] Section view: planar (up to three planes) or zonal, offset, rotation, cap, reverse direction.
- [ ] Interference detection: components to check, options (coincidence, subassemblies, multibody, surface
  bodies), results with volume and ignore.
- [ ] Draft analysis (direction of pull, reference angle, face classification, steep faces), thickness analysis
  (target thickness, report of critical features), curvature display (combs, zebra stripes).

## Settings, view and selection behaviour

Not started unless marked; each item is described in `docs/SOLIDWORKS_REFERENCE.md` part E.

- [x] Right-click menus: in the view on a face, an edge, a sketch, a reference plane or empty space (part and
  assembly), in an open sketch on an entity or empty space, and in the feature tree; each entry runs the existing
  tool with what was clicked already picked. A right-drag still pans. Not there: zoom to selection, select other,
  select loop or chain, appearance per face, context toolbars, mouse gestures.
- [x] Toolbar: a group that collapses into a menu shows its name beside the icon while there is room; variants of
  one tool share a button with a flyout (line, rectangle, slot, circle, arc, trim, fillet, patterns, move,
  relations); the sketch toolbar has Draw, Modify, Relations and View groups.
- [x] Number fields take any value: a field's step is only its spin increment (arrows and Up/Down keys; Ctrl ten
  times, Alt a tenth). Worked-out values (drags, picks, dimensions) are kept to 0.000001 mm; labels in the view
  show up to four decimals. Drag handles step finer as the view zooms in (Shift coarser, Alt to a pixel's worth).
- [ ] Still fixed, not yet a setting: the number of decimals shown (SolidWorks: 0 to 8 per document, Units), and
  the spin increments (System Options). Sketch end points closer than 0.001 mm still count as one point.
- [ ] Document properties: unit system (MKS, CGS, MMGS, IPS, custom), length units with decimals or fractions,
  angle units; dimension standard and precision; grid and snap (display grid, major spacing, minor lines per
  major, snap points per minor: done, in Sketch settings); image quality (tessellation deviation); material density.
- [~] Sketch options: auto-rotate normal to sketch, use fully defined sketches, show entity points with status
  colours, prompt to close sketch, create sketch on new part, override dimensions on drag/move, ghost image on
  drag, on-screen numeric input on entity creation, over-defining dimension prompt, display plane when shaded.
  Done but prompt to close sketch (needs Close sketch to model); also preview sketch dimension when selected and
  the automatic solve and undo limit.
- [x] Relations/snaps options: enable snapping, snap to model geometry, automatic relations, per-snap toggles,
  snap angle.
- [ ] Display and selection options: hidden edges solid/dashed, tangent edge display (visible, phantom, removed),
  anti-aliasing; selection of hidden edges, selection through transparency, default bulk selection method (box or
  lasso).
- [ ] View options: reverse wheel zoom, zoom to fit on standard view, arrow-key rotation increment, mouse speed,
  view transitions.
- [ ] Default templates and backup/auto-recover: default part/assembly template, auto-save interval and backup
  copy.
- [x] Navigation, built: middle-drag rotate (about the point under the pointer), Ctrl+middle pan, Shift+middle zoom,
  wheel zoom at the pointer, zoom to fit. The app's own habits stay: a left drag turns the 3D view and a right drag
  pans it. In an open sketch a left drag belongs to the sketch: it drags the point or curve under it (with any draw
  tool that has nothing begun, as with Select), draws a selection box (Select), or slides the view along the sketch
  plane; it never turns the view.
- [ ] Navigation, still open: rotate about a middle-clicked vertex/edge/face, roll, Ctrl+arrows pan, Shift+arrows 90
  degrees, zoom to area/selection.
- [x] Normal To on a face, plane or sketch, and inside an open 2D sketch (Views list, right-click on empty space);
  a second time it looks from the other side.
- [x] Standard views: front, back, left, right, top, bottom, isometric, trimetric, dimetric.
- [ ] Orientation, still open: Normal To with two faces, view selector cube, named views, Space bar orientation
  dialog.
- [x] Perspective on/off (View > Perspective): off is a flat, parallel view. Sketching and the 3D view each keep
  their own choice; sketching is flat unless turned on, the 3D view has perspective unless turned off.
- [ ] Display styles: shaded with edges, shaded, hidden lines removed, hidden lines visible, wireframe; hide/show
  items (planes, axes, sketches, bodies, components).
- [ ] Selection behaviour: Ctrl add/remove, box select (left to right inside only; right to left crossing),
  lasso, selection filters (vertices, edges, faces, bodies, axes, planes, sketches; F5/F6, E, X, V hotkeys),
  select other, select tangency / loop, select all, invert, previous selection.
- [ ] Accepting: OK/cancel in forms, Enter and Esc, right-click to accept, confirmation corner, D key to move
  the confirm buttons to the pointer.
- [ ] Keyboard shortcuts and bars: S shortcut bar with command search, Enter repeats the last command, Esc,
  Ctrl+B rebuild, Ctrl+Q rebuild all, F zoom to fit, Z / Shift+Z zoom, Ctrl+C/V copy, F5/F6 filters, mouse gestures
  (right-drag), context toolbar on selection.
- [ ] Feature tree behaviour: rollback bar, suppress/unsuppress per configuration, drag reorder, parent/child
  view, edit feature vs edit sketch, rename, folders, sketch status prefixes ((+) over defined, (-) under
  defined, (?) unsolved), error/warning icons and a What's Wrong list, rebuild all.
- [ ] Values and equations: "=" in any number field to type an expression with units and variables, global
  variables, equations folder, linked values, configurations (design table) per feature value.
