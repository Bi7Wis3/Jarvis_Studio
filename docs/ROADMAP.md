# Jarvis Studio: Roadmap

Goal (2026-11-13): a full parametric CAD app with the feature set of SolidWorks and Fusion, followed by CAM.
Every phase leaves the app usable, and every feature stays callable both from the toolbar and by Jarvis as a tool.

Out of scope: team and collaboration features (sharing, comments, multi-user editing, PDM, cloud data management).
This is a single-user local app: projects, exports, tool libraries and CAM data stay on this machine, with no cloud
storage, sync, rendering or computation. (Jarvis itself still talks to Claude through Claude Code.)

Status key: [x] done, [~] partial, [ ] not started.

## Reference: SolidWorks part mode (2026-11-13)

The user's reference for what the app can do and how it behaves is SolidWorks part mode. Its look is not wanted:
the app keeps its own compact icon toolbar, floating popups and dark theme (no ribbon, tabs or left-side property
panel). Every command in the two SolidWorks ribbons is wanted:

Every tool is also to get the full set of options a professional CAD program gives it: the per-tool checklist is
in [FEATURE_OPTIONS.md](FEATURE_OPTIONS.md).

Features tab
- [x] Extruded boss/base, extruded cut, revolved boss/base, revolved cut, swept boss/cut, lofted boss/cut
- [x] Fillet, chamfer, linear/circular pattern, mirror, draft, shell, hole, thread, reference geometry (plane, axis, point)
- [x] Per-feature choice of sketch regions, one sketch used by several extrudes and cuts; live previews in forms
- [ ] Boundary boss/base and boundary cut
- [ ] Hole wizard (standard sizes, counterbore/countersink, positions from sketch points)
- [ ] Rib, wrap, intersect
- [ ] Curves (helix exists inside sweep; missing: projected, composite, through points, split line)

Sketch tab
- [x] Exit sketch, smart dimension (drag out of a line), line, rectangle, circle, 3-point arc, slot, polygon
- [x] Trim, offset, mirror, sketch fillet/chamfer, extend, linear/circular sketch pattern, centre arc, centre rectangle
- [x] Point, centreline, move/copy/rotate/scale entities, display/delete relations, quick snaps, repair sketch,
  fully define sketch
- [ ] Spline, ellipse, text (need new curve types in the kernel)
- [ ] Convert entities (project model edges)
- [ ] Rapid sketch

Tree
- [x] Part root, material, planes, origin, features with their sketch nested, rollback bar, suppress, rename, reorder
- [x] Names like Boss-Extrude1 / Cut-Extrude1 / Sketch1, the (-) under-defined mark on sketches, History folder,
  feature editing in the left panel
- [ ] Parent/child view

## Phase 0: Foundations (needed by everything after, and by CAM)

- [ ] **Persistent face/edge/vertex references.** Pick one specific face or edge by clicking; the reference survives
  rebuilds (topological naming: name entities by the feature and sketch curve that created them, with a geometric
  fallback). Replaces the direction-only `EdgeSelect` / `FaceSelect`, which stay as shortcuts.
- [ ] **Selection in the viewport:** hover highlight and pick of faces, edges and vertices, with a selection filter.
- [ ] **Named parameters and equations** (`wall = 2`, `width = wall * 10`) usable in any numeric field.
- [ ] **Sketch snapping that behaves:** snap grid matches the drawn grid, snap onto curves and intersections,
  alignment with any sketch point, quadrants and arc midpoints. (In progress.)

## Phase 1: Sketcher parity

- [~] Lines, rectangles, circles, 3-point arcs, slots, polygons. Missing: centre-point arc, tangent arc,
  ellipse, spline, conic, text, construction toggle in the UI.
- [ ] Trim, extend, split, offset, sketch fillet and chamfer, mirror, linear/circular sketch pattern, move/rotate/scale.
- [ ] Project / convert model edges into a sketch; intersection curves; sketch on a selected face.
- [~] Constraints and dimensions (have the common set). Missing: concentric, collinear, pierce, curvature;
  driven (reference) dimensions; automatic relations while drawing; over-constraint diagnosis.
- [ ] DXF/SVG import into a sketch.

## Phase 2: Part modelling parity

- [x] Extrude, revolve, loft, sweep, fillet, chamfer, shell, hole, thread, draft, mirror, patterns, split, combine.
- [ ] Extrude options: to face / to next / up to body, two-sided, taper, thin feature; from a selected face.
- [ ] Variable and face fillets, setback; chamfer by distance-distance and distance-angle on picked edges.
- [ ] Rib/web, boss with draft, hole wizard on picked faces (positions from sketch points), cosmetic threads.
- [ ] Direct editing: press/pull, offset face, move face, delete face, replace face; thicken; scale.
- [ ] Multi-body parts, body booleans, mirror/pattern bodies and faces, pattern along a curve / sketch-driven.
- [ ] Surfaces: extrude/revolve/loft/sweep surface, boundary, fill/patch, offset, trim, knit, thicken.
- [ ] Sheet metal: base flange, edge flange, bends, relief, unfold/flat pattern, DXF of the flat.
- [ ] Configurations / design variants driven by parameters.

## Phase 3: Assemblies

- [~] Components, explode, move/rotate.
- [ ] Mates/joints: coincident, concentric, distance, angle, rigid, revolute, slider, cylindrical, ball, gear.
- [ ] Degrees of freedom shown, drag to move within mates, motion study, interference and clearance check.
- [ ] Edit part in assembly context, references between parts, sub-assemblies, BOM.

## Phase 4: Inspection and output

- [ ] Measure (distance, angle, radius between any picked entities), mass properties, centre of mass.
- [ ] Section view, draft and curvature analysis, wall-thickness analysis.
- [x] STL and STEP export. Missing: STEP/IGES import, 3MF, DXF.
- [ ] 2D drawings: standard/section/detail views, dimensions, GD&T, title block, PDF/DXF export.
- [ ] Rendering / appearances beyond materials.

## Phase 5: CAM

- [ ] Setup: stock, work coordinate system, machine and tool library.
- [ ] 2.5D: facing, 2D contour, pocket, adaptive clearing, drilling, chamfer/deburr; on picked faces and contours.
- [ ] 3D: parallel, scallop, waterline finishing; rest machining.
- [ ] Toolpath simulation with stock removal and collision checks.
- [ ] Post-processors (GRBL, LinuxCNC, Fanuc first), G-code export.
- Also: laser/plasma (2D profiles) and FDM slicing hand-off.

CAM depends on Phase 0 (picked faces and contours that survive edits) and Phase 4's exact B-rep access, so those
come first. The OpenCascade kernel already gives the exact geometry toolpaths need.
