// The Python helpers every FreeCAD history macro starts with (see freecadMacro.ts). Kept free of `${` so it can live
// in a raw template string.

export const PRELUDE = String.raw`
import math
import base64
import zlib
import FreeCAD as App
import Part
import Sketcher

V = App.Vector
NOTES = []
# How far a rebuilt step may differ from Jarvis Studio's solid before it is reported: volume (relative) and size (mm).
VOLUME_TOLERANCE = 1e-3
SIZE_TOLERANCE = 0.01


def note(text):
    NOTES.append(text)
    App.Console.PrintWarning('Jarvis Studio export: ' + text + '\n')


def frame(origin, x, n):
    """Placement whose origin is at origin, local X along x and local Z along n."""
    xv = V(*x)
    nv = V(*n)
    yv = nv.cross(xv)
    m = App.Matrix(xv.x, yv.x, nv.x, origin[0], xv.y, yv.y, nv.y, origin[1], xv.z, yv.z, nv.z, origin[2], 0, 0, 0, 1)
    return App.Placement(m)


def clean(placement):
    """The placement without floating point noise (components below 1e-12)."""
    b = placement.Base
    base = V(*[0.0 if abs(c) < 1e-12 else c for c in (b.x, b.y, b.z)])
    q = [0.0 if abs(c) < 1e-12 else c for c in placement.Rotation.Q]
    return App.Placement(base, App.Rotation(*q))


def origin(body, role):
    """An origin feature of the body by role: X_Axis, Y_Axis, Z_Axis, XY_Plane, XZ_Plane, YZ_Plane."""
    for o in body.Origin.OriginFeatures:
        if o.Role == role:
            return o
    raise RuntimeError('the body has no ' + role)


def new_body(name, placement):
    body = App.ActiveDocument.addObject('PartDesign::Body', 'Body')
    body.Label = name
    body.Placement = placement
    if hasattr(body, 'AllowCompound'):
        body.AllowCompound = True
    return body


def tool_body(label):
    """A body that only makes a tool for a Boolean of the part's body (in the part's own frame, so at the origin)."""
    body = App.ActiveDocument.addObject('PartDesign::Body', 'Tool')
    body.Label = label
    if hasattr(body, 'AllowCompound'):
        body.AllowCompound = True
    return body


def add(body, kind, label):
    obj = body.newObject(kind, kind.split('::')[-1])
    obj.Label = label
    if obj.isDerivedFrom('PartDesign::Feature'):
        # A pattern made without its originals yet is not taken as the body's tip; the next feature must build on it.
        body.Tip = obj
    return obj


def place_on(obj, support, placement):
    """Attaches obj flat on support (a plane or a planar face), its offset chosen so that it lands at placement."""
    if support is None:
        obj.MapMode = 'Deactivated'
        obj.Placement = placement
        return
    obj.AttachmentSupport = support
    obj.MapMode = 'FlatFace'
    obj.AttachmentOffset = App.Placement()
    obj.recompute()
    obj.AttachmentOffset = clean(obj.Placement.inverse().multiply(placement))
    obj.recompute()


def datum_plane(body, label, support, placement):
    obj = add(body, 'PartDesign::Plane', label)
    place_on(obj, support, placement)
    return obj


def datum_line(body, label, point, direction):
    obj = add(body, 'PartDesign::Line', label)
    d = V(*direction)
    obj.MapMode = 'Deactivated'
    obj.Placement = App.Placement(V(*point), App.Rotation(V(0, 0, 1), d))
    return obj


def datum_point(body, label, point):
    obj = add(body, 'PartDesign::Point', label)
    obj.MapMode = 'Deactivated'
    obj.Placement = App.Placement(V(*point), App.Rotation())
    return obj


# ---- Sketch geometry, in the sketch's own (x, y) ----------------------------------------------------------------

def line(x1, y1, x2, y2):
    return Part.LineSegment(V(x1, y1, 0), V(x2, y2, 0))


def circle(cx, cy, r, seam=None):
    """seam: the angle where the circle starts (it decides how lofts join it to the next section)."""
    c = Part.Circle(V(cx, cy, 0), V(0, 0, 1), r)
    if seam is not None:
        c.XAxis = V(math.cos(seam), math.sin(seam), 0)
    return c


def arc(cx, cy, r, a0, a1):
    """Counter-clockwise from angle a0 to a1 (radians)."""
    return Part.ArcOfCircle(Part.Circle(V(cx, cy, 0), V(0, 0, 1), r), a0, a1)


def ellipse(cx, cy, mx, my, nx, ny):
    """Centre, the end of the major axis, a point at the minor radius from it."""
    return Part.Ellipse(V(mx, my, 0), V(nx, ny, 0), V(cx, cy, 0))


def ellipse_arc(cx, cy, mx, my, nx, ny, a0, a1):
    return Part.ArcOfEllipse(ellipse(cx, cy, mx, my, nx, ny), a0, a1)


def parabola_arc(vx, vy, ax, ay, focal, u0, u1):
    """Vertex, unit axis towards the focus, focal length, and the arc's parameters across the axis."""
    p = Part.Parabola()
    p.Focal = focal
    p.Center = V(vx, vy, 0)
    p.Axis = V(0, 0, 1)
    p.XAxis = V(ax, ay, 0)
    return Part.ArcOfParabola(p, u0, u1)


def bspline(poles, degree, knots, mults, weights=None, simplify=False):
    c = Part.BSplineCurve()
    c.buildFromPolesMultsKnots([V(x, y, 0) for x, y in poles], mults, knots, False, degree, weights)
    if simplify:
        # The pieces join curvature continuously, so their inner knots go without changing the curve.
        for i in range(len(knots) - 1, 1, -1):
            try:
                c.removeKnot(i, 1, 1e-9)
            except Exception:
                pass
    return c


def point(x, y):
    return Part.Point(V(x, y, 0))


def sketch_points(sk):
    out = []
    for g in range(len(sk.Geometry)):
        for pos in (1, 2, 3):
            try:
                p = sk.getPoint(g, pos)
            except Exception:
                continue
            out.append(p)
    return out


def moved(before, after):
    return max([(a - b).Length for a, b in zip(before, after)] or [0.0])


def constrain(sk, items):
    """
    Adds constraints one at a time (lengths in mm, angles in radians; a trailing dict gives a dimension its name and
    whether it drives), keeping each only if the sketch still solves without its geometry moving.
    """
    dropped = []
    start = sketch_points(sk)
    for item in items:
        kind, args = item[0], tuple(item[1:])
        opts = {}
        if args and isinstance(args[-1], dict):
            opts = args[-1]
            args = args[:-1]
        saved = sk.Geometry
        try:
            index = sk.addConstraint(Sketcher.Constraint(kind, *args))
        except Exception as e:
            dropped.append('%s %s (%s)' % (kind, args, e))
            continue
        if opts.get('driving') is False:
            sk.setDriving(index, False)
        if opts.get('name'):
            try:
                sk.renameConstraint(index, opts['name'])
            except Exception:
                pass
        if opts.get('active') is False:
            sk.setActive(index, False)
        status = sk.solve()
        if status != 0 or moved(start, sketch_points(sk)) > 1e-5:
            sk.delConstraint(index)
            sk.Geometry = saved
            sk.solve()
            dropped.append('%s %s' % (kind, args))
    if dropped:
        note('%s: %d relation(s) or dimension(s) could not be kept: %s' % (sk.Label, len(dropped), '; '.join(dropped)))
    sk.recompute()
    return sk


def sketch(body, label, support, placement, geometry, expose=()):
    """A sketch of (geometry, construction) pairs; expose: B-splines whose control points are shown and editable."""
    sk = add(body, 'Sketcher::SketchObject', label)
    place_on(sk, support, placement)
    for geo, construction in geometry:
        sk.addGeometry(geo, construction)
    for g in expose:
        try:
            sk.exposeInternalGeometry(g)
        except Exception:
            pass
    sk.solve()
    return sk


def sketch_axis(sk, g):
    """Sketch line g as an axis: AxisN for the N-th construction line, else its edge."""
    if sk.getConstruction(g):
        n = sum(1 for i in range(g) if sk.getConstruction(i) and isinstance(sk.Geometry[i], Part.LineSegment))
        return 'Axis%d' % n
    return sketch_edges(sk, [g])[0]


def pole(sk, x, y):
    """The control point circle of a B-spline at (x, y)."""
    for g, geo in enumerate(sk.Geometry):
        if isinstance(geo, Part.Circle) and sk.getConstruction(g) and (geo.Center - V(x, y, 0)).Length < 1e-7:
            return g
    raise RuntimeError('%s: no control point at (%g, %g)' % (sk.Label, x, y))


def sketch_edges(sk, geo_ids):
    """Sub-element names of the sketch edges made by these geometries."""
    names = []
    edges = sk.Shape.Edges
    for g in geo_ids:
        geo = sk.Geometry[g].toShape()
        mid = geo.valueAt(0.5 * (geo.FirstParameter + geo.LastParameter))
        best = None
        for i, e in enumerate(edges):
            d = e.distToShape(Part.Vertex(sk.Placement.multVec(mid)))[0]
            if best is None or d < best[0]:
                best = (d, i)
        if best is None or best[0] > 1e-6:
            raise RuntimeError('%s: geometry %d is not an edge of the sketch' % (sk.Label, g))
        names.append('Edge%d' % (best[1] + 1))
    return names


# ---- Picking edges and faces of a feature by geometry -----------------------------------------------------------

def _near(shape, p, tol):
    b = shape.BoundBox
    return (b.XMin - tol <= p[0] <= b.XMax + tol and b.YMin - tol <= p[1] <= b.YMax + tol
            and b.ZMin - tol <= p[2] <= b.ZMax + tol)


def find_edges(feature, edges, tol=1e-3):
    """Names of the feature's edges through the given points (each edge: its start, middle and end)."""
    shape = feature.Shape
    names = []
    for pts in edges:
        best = None
        for i, e in enumerate(shape.Edges):
            if not all(_near(e, p, tol) for p in pts):
                continue
            d = max(e.distToShape(Part.Vertex(V(*p)))[0] for p in pts)
            if best is None or d < best[0]:
                best = (d, i)
        if best is None or best[0] > tol:
            note('%s: an edge through %s was not found' % (feature.Label, pts[1]))
            continue
        name = 'Edge%d' % (best[1] + 1)
        if name not in names:
            names.append(name)
    return names


def find_faces(feature, faces, tol=1e-3):
    """Names of the feature's faces through the given points, each with its area."""
    shape = feature.Shape
    names = []
    for p, area in faces:
        best = None
        for i, f in enumerate(shape.Faces):
            if not _near(f, p, tol):
                continue
            d = f.distToShape(Part.Vertex(V(*p)))[0]
            if d > tol:
                continue
            score = abs(f.Area - area) / max(area, 1.0)
            if best is None or score < best[0]:
                best = (score, i)
        if best is None:
            note('%s: a face through %s was not found' % (feature.Label, p))
            continue
        name = 'Face%d' % (best[1] + 1)
        if name not in names:
            names.append(name)
    return names


# ---- Solids carried over from Jarvis Studio -----------------------------------------------------------------

def solid(blob):
    shape = Part.Shape()
    shape.importBrepFromString(zlib.decompress(base64.b64decode(''.join(blob.split()))).decode('ascii'))
    return shape


def carried(label, blob):
    """A plain solid in the document (hidden), used by the step that needs it."""
    obj = App.ActiveDocument.addObject('Part::Feature', 'Solid')
    obj.Label = label
    obj.Shape = solid(blob)
    obj.Visibility = False
    return obj


def boolean(body, label, kind, tool):
    obj = add(body, 'PartDesign::Boolean', label)
    obj.Type = kind
    obj.addObjects([tool])
    return obj


# ---- Checks against Jarvis Studio's own solid ------------------------------------------------------------------

def check(feature, volume, box):
    """Recomputes and compares the body after this step with Jarvis Studio's (volume in mm3, box in mm)."""
    App.ActiveDocument.recompute()
    if 'Invalid' in feature.State or feature.Shape.isNull():
        note('%s did not rebuild in FreeCAD' % feature.Label)
        return False
    shape = feature.Shape
    b = shape.optimalBoundingBox(False, False)
    got = (b.XMin, b.YMin, b.ZMin, b.XMax, b.YMax, b.ZMax)
    dv = abs(shape.Volume - volume) / max(volume, 1e-9)
    db = max(abs(g - e) for g, e in zip(got, box))
    if dv > VOLUME_TOLERANCE or db > SIZE_TOLERANCE:
        note('%s differs from Jarvis Studio: volume %.4f mm3 (Jarvis Studio %.4f), size off by up to %.4f mm'
             % (feature.Label, shape.Volume, volume, db))
        return False
    return True


def finish():
    App.ActiveDocument.recompute()
    if NOTES:
        App.Console.PrintWarning('Jarvis Studio export: %d note(s), see above.\n' % len(NOTES))
    else:
        App.Console.PrintMessage('Jarvis Studio export: every step rebuilt as in Jarvis Studio.\n')
    if App.GuiUp:
        import FreeCADGui
        view = FreeCADGui.ActiveDocument.ActiveView
        view.viewIsometric()
        view.fitAll()
`;
