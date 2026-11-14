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
- [ ] Edge of cylinder and optional start location with offset and start angle.
- [ ] End condition: blind (depth), revolutions, up to selection; maintain thread length.
- [ ] Standard type and size table, override diameter and pitch, cut thread or extrude thread, mirror profile,
  rotation angle, right/left hand, multiple starts, trim with start/end face, preview options.
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
- [ ] Plane constraints: coincident, parallel, perpendicular, project, parallel to screen, tangent, at angle
  (number of planes), offset distance (number of planes), mid plane, flip normal; up to three references (so also
  three points, plane and point, normal to curve).
- [ ] Axis: one line/edge, two planes, two points, cylindrical/conical face, point and face.
- [ ] Point: arc centre, face centre, intersection, projection, on point, along curve by distance, percentage or
  evenly distributed (count).
- [ ] Coordinate system: origin, X/Y/Z directions from points, edges or faces, reverse axes, numeric position and
  rotation.
- [ ] Curves: helix/spiral as its own step (defined by pitch/revolution, height/revolution, height/pitch, spiral;
  variable pitch, taper, start angle, direction), projected (sketch on faces or sketch on sketch), composite,
  through XYZ points, through reference points (closed), split line (projection, silhouette, intersection).

## Sketch

- [~] Entities and tools already in the app: see `docs/ROADMAP.md`; the list below is what the reference adds.
- [ ] Smart dimension: dimension type follows the pick (line length; two lines angle; parallel lines distance;
  point to line; two points horizontal, vertical or aligned by cursor; radius; diameter; arc length; midpoint
  pick; doubled distance to a centerline); driven dimension when it would over-define; value box accepts
  expressions.
- [ ] Line options: orientation (as sketched, horizontal, vertical, angle), for construction, infinite length,
  midpoint line; centerline; rectangles (corner, centre, 3-point corner, 3-point centre, parallelogram) with
  construction lines from corners or midpoints; slots (straight, centrepoint straight, 3-point arc, centrepoint
  arc; centre-to-centre or overall length); circle and perimeter circle; arcs (centrepoint, tangent, 3-point);
  polygon (3 to 40 sides, inscribed or circumscribed); spline with handles and curvature; ellipse, partial
  ellipse, parabola, conic; text (font, alignment, flip, width factor, along a curve); point.
- [ ] Trim: power trim, corner, trim away inside, trim away outside, trim to closest; keep trimmed entities as
  construction; ignore construction geometry. Extend entities.
- [ ] Offset entities: distance, add dimensions, reverse, select chain, bi-directional, construction geometry
  (base/offset), cap ends (arcs or lines). Convert entities (select chain, for construction); intersection curve.
- [ ] Mirror entities (copy toggle) and dynamic mirror; linear sketch pattern (two directions, spacing, angle,
  instances, instances to skip); circular sketch pattern (centre, spacing, equal spacing, radius, arc angle);
  move, copy, rotate, scale (with copies), stretch (from/to or X/Y, repeat, keep relations).
- [ ] Sketch fillet (radius, keep constrained corners, dimension each) and chamfer (angle-distance,
  distance-distance, equal distance).
- [ ] Relations: add relations for the full list in the reference (horizontal, vertical, collinear, coradial,
  perpendicular, parallel, tangent, concentric, midpoint, intersection, coincident, equal, symmetric, fix, pierce,
  merge points, doubled distance, ...); display/delete relations with filters (all, dangling, over defining,
  external, defined in context, locked, broken, selected entities), suppress, replace.
- [ ] Fully define sketch (relations to use, baseline/ordinate/chain schemes, placement); repair sketch (gaps,
  overlaps, small entities, 3+ endpoint junctions); over-defined handling (make driven / leave driving).
- [ ] Quick snaps: point, centre point, midpoint, quadrant, intersection, nearest, tangent, perpendicular,
  parallel, horizontal/vertical, horizontal/vertical to points, length, grid, angle; Ctrl suppresses automatic
  relations. Rapid sketch. Construction geometry toggle.

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

- [x] Number fields take any value: a field's step is only its spin increment (arrows and Up/Down keys; Ctrl ten
  times, Alt a tenth). Worked-out values (drags, picks, dimensions) are kept to 0.000001 mm; labels in the view
  show up to four decimals. Drag handles step finer as the view zooms in (Shift coarser, Alt to a pixel's worth).
- [ ] Still fixed, not yet a setting: the number of decimals shown (SolidWorks: 0 to 8 per document, Units), and
  the spin increments (System Options). Sketch end points closer than 0.001 mm still count as one point.
- [ ] Document properties: unit system (MKS, CGS, MMGS, IPS, custom), length units with decimals or fractions,
  angle units; dimension standard and precision; grid and snap (display grid, major spacing, minor lines per
  major, snap points per minor); image quality (tessellation deviation); material density.
- [ ] Sketch options: auto-rotate normal to sketch, use fully defined sketches, show entity points with status
  colours, prompt to close sketch, create sketch on new part, override dimensions on drag/move, ghost image on
  drag, on-screen numeric input on entity creation, over-defining dimension prompt, display plane when shaded.
- [ ] Relations/snaps options: enable snapping, snap to model geometry, automatic relations, per-snap toggles,
  snap angle.
- [ ] Display and selection options: hidden edges solid/dashed, tangent edge display (visible, phantom, removed),
  anti-aliasing; selection of hidden edges, selection through transparency, default bulk selection method (box or
  lasso).
- [ ] View options: reverse wheel zoom, zoom to fit on standard view, arrow-key rotation increment, mouse speed,
  view transitions.
- [ ] Default templates and backup/auto-recover: default part/assembly template, auto-save interval and backup
  copy.
- [ ] Navigation: middle-drag rotate, Ctrl+middle pan, Shift+middle zoom, wheel zoom at pointer, rotate about a
  picked vertex/edge/face, roll, Ctrl+arrows pan, Shift+arrows 90 degrees, zoom to fit/area/selection.
- [ ] Standard views and orientation: front, back, left, right, top, bottom, isometric, trimetric, dimetric,
  Normal To, view selector cube, named views, Space bar orientation dialog.
- [ ] Display styles: shaded with edges, shaded, hidden lines removed, hidden lines visible, wireframe;
  perspective; hide/show items (planes, axes, sketches, bodies, components).
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
