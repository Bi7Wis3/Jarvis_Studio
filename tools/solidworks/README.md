# SolidWorks history export

`JarvisHistoryExport.vbs` reads your SolidWorks parts and assemblies and writes what Jarvis Studio needs to rebuild
them with their feature history, not only as solids. Jarvis Studio then imports the files (File > Import).

It only reads. Every file is opened read-only and closed again without saving; documents you already had open stay
open as they were.

## What you need

- SolidWorks 2015 (or later) running in the Windows virtual machine.
- The folder with your designs reachable from Windows. In the VM the host's Downloads folder is drive `Z:\`, so the
  designs in `~/Downloads/3D_Prints` on the host are `Z:\3D_Prints` in Windows.
- To export designs from another host folder (for example `~/Desktop/3D Printer/3D_Designs`, which is not shared with
  the VM), copy that folder into the host's Downloads folder first, for example to `~/Downloads/3D_Designs`; in Windows
  it is then `Z:\3D_Designs`.

## Run it

1. Start SolidWorks and wait until it is ready. Leave it open.
2. In Windows Explorer, open `Z:\JarvisExport` and double-click `JarvisHistoryExport.vbs`.
3. Answer the questions:
   - **Export a whole folder and all its subfolders?** Yes: choose the top folder, for example `Z:\3D_Prints`
     (type the path in the box at the bottom of the folder dialog if it is not listed). No: only the document open in
     SolidWorks is exported.
   - **Write each .jarvis-sw.json next to its part?** Yes (recommended): each file goes into the part's own folder. No:
     choose one folder for all of them.
   - **Export all parts again?** No skips the files whose `.jarvis-sw.json` is newer than the SolidWorks file, so a
     second run only does what changed. Yes exports everything again.
4. It says how many files it found; OK starts. SolidWorks is busy until a message says it is done. A big folder takes
   a while (every feature of every part is measured): the progress is written to `JarvisExport-summary.txt` in the top
   folder as it goes.

## What it writes

Next to each `Name.SLDPRT` and `Name.SLDASM` (names with spaces and dots are fine, e.g.
`Phone.a.Tablet.Stand.SLDPRT` gives `Phone.a.Tablet.Stand.jarvis-sw.json`):

- `Name.jarvis-sw.json`: for a part, every feature in tree order (type, name, suppressed, its settings and the faces,
  edges and vertices it uses as points and normals), every sketch (plane, points, lines, arcs, circles, ellipses,
  splines with their exact control points, construction flags, relations and dimensions), feature folders, the
  volume after each feature, and SolidWorks' own volume, area, centre of mass and bounding box. For an assembly: its
  components (file, configuration, suppression, fixed or floating, position and rotation, subassemblies nested), its
  mates with their entities, and its volume and box. Everything is in SolidWorks' own units (metres, radians).
- `Name.jarvis-sw.log`: what was read and anything that could not be (the same lines are inside the JSON).

And in the top folder, `JarvisExport-summary.txt`: each file done, skipped (up to date) or failed, and why.

If you change the settings at the top of the script, open it in Notepad: `MEASURE_EACH_FEATURE = False` makes a run
quicker, but Jarvis Studio can then no longer say at which feature a rebuild first differs from SolidWorks.

## Import into Jarvis Studio

File > Import, then pick the `.jarvis-sw.json` in the Import form's own file browser (Downloads > 3D_Prints > ...),
not by dropping it on the form: the importer needs the files next to it (the SLDPRT for features it cannot rebuild,
the part files of an assembly).

- A part becomes a new part with its sketches and features, named as in SolidWorks. Where a feature cannot be rebuilt
  yet (or rebuilds differently from SolidWorks), the part continues from SolidWorks' own body read from the SLDPRT
  next to the JSON, as an Imported step; the form lists what came across, what did not and why.
- The rebuilt part is measured against SolidWorks: the form says whether the volume and box match (to 0.001 %), and
  at which feature they first differ when they do not.
- An assembly becomes one part per component, placed as in SolidWorks; a part used several times becomes one part and
  its instances. Each component's history comes from its own `.jarvis-sw.json` (export the folder with the parts too).
  Subassemblies are flattened (their name is kept in each part's description). Mates are kept with the project for
  when Jarvis Studio has mates; until then the parts stay where SolidWorks placed them.

## When something goes wrong

Send the `.jarvis-sw.json` (or the `.jarvis-sw.log` when there is no JSON) and `JarvisExport-summary.txt`. The log
names every SolidWorks call that failed and how SolidWorks hands its objects to the script.
