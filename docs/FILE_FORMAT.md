# The .jarvis file (format version 1)

A `.jarvis` file holds one Jarvis Studio project and every file it uses, so the project can be kept anywhere and opened
on another machine. File > Save As writes one, File > Save writes it again, File > Open opens one. Code:
`apps/server/src/jarvisFormat.ts` (packing and checks) and `apps/server/src/jarvisFile.ts` (files and projects).

## Container

A ZIP archive (deflate or stored entries, written with fflate). Entries:

| Entry | What it holds |
| --- | --- |
| `manifest.json` | What the file is, and every other entry with its size and SHA-256. |
| `design.json` | The project, as the studio stores it in `projects/<name>.json`, less what belongs to one machine. |
| `assets/<id>` | Every file the project refers to, by its asset id. |
| `thumbnail.png` | A picture of the model from the 3D view at save time. Optional. |

Entry names are plain relative paths: no leading `/`, no `\`, no `:`, no empty, `.` or `..` segments, and no folder
entries. Every entry other than `manifest.json` is listed in the manifest, and every listed entry is in the archive.

## manifest.json

```json
{
  "format": "jarvis-studio",
  "version": 1,
  "app": "0.1.0",
  "saved": "2026-11-17T18:40:12.345Z",
  "name": "Robot arm",
  "description": "Six-axis arm, printed parts",
  "units": "mm",
  "up": "y",
  "parts": 12,
  "files": [
    { "name": "design.json", "size": 48213, "sha256": "…64 hex digits…" },
    { "name": "thumbnail.png", "size": 81234, "sha256": "…" },
    { "name": "assets/3f2a…24 hex….step", "size": 1048576, "sha256": "…" }
  ]
}
```

- `format`: always `jarvis-studio`.
- `version`: the format version. The whole number is the major version; a reader opens files of the majors it knows
  (1 here) and refuses newer majors with a plain message. A minor version (1.1, 1.2) may add entries; a reader leaves
  entries it does not know alone.
- `app`: the studio version that wrote the file. `saved`: when, in ISO 8601 (UTC).
- `name`, `description`: the project's name and description (Save As, Description), shown by File > Open.
- `units`: lengths in the design are millimetres. `up`: the model's up axis is +Y.
- `parts`: how many parts the project has.
- `files`: every other entry, its unpacked size in bytes and the SHA-256 of its unpacked bytes (lowercase hex).

## design.json

The `Project` object of `packages/core/src/index.ts` as JSON: name, parts with their shapes, features, materials and
decals, view, print settings, mates, folders, description. Left out because they belong to one machine or only to the
browsers showing the project now:

- `jarvisFile`: the path of the file the project was last saved to or opened from, and that file's SHA-256. The studio
  keeps it in its own copy of the project (`projects/<name>.json`), never in a file.
- `view.focus` (the highlighted part), `view.autoRotate` (the turntable spin), `view.azimuth` and `view.elevation` (a
  camera angle asked for). An opened project starts with the defaults.

The rest of `view` stays: explode, labels, hidden parts, sketches and bodies, see-through bodies, rollback.

## assets/

An asset id is the first 24 hex digits of the SHA-256 of the asset's bytes, a dot and the file's own extension, e.g.
`3f2a9c…e1.step`. They are the files of import steps (the original file, the BREP of its solids, the mesh of a graphics
body, the preview picture of a SolidWorks part) and the pictures of decals and sketch pictures. The writer walks the
whole project and includes every string that is an asset id, once, and nothing else. When the studio opens a file, it
copies the assets into its `projects/assets` folder under the same ids; one that is there already is the same file and
is kept.

## Checks when reading

A file is refused, with the reason, when:

- it is not a ZIP archive, has no `manifest.json`, or the manifest is not of format `jarvis-studio`;
- its major version is newer than the reader's (or the version is missing);
- an entry name breaks the rules above, an entry is there twice, an entry is not listed, or a listed entry is missing;
- an entry's size or SHA-256 differs from the manifest, or an asset's bytes do not hash to its id;
- any entry would unpack to more than 512 MB, or all of them to more than 1 GB (checked from the archive's directory
  before anything is unpacked), or the file itself is larger than 1 GB;
- `design.json` is not a project (a name, and parts with an id, name, shape, position, rotation and material).

The project is then opened through the studio's usual loading, which fills in view settings an older project lacks and
repairs folders and mates.
