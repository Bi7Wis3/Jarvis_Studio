# Jarvis Studio

A local, single-user parametric CAD app with an AI assistant, Jarvis. The aim is a full professional CAD program,
with CAM later. It runs on your own machine: a web UI, a Node server and the OpenCascade kernel. There is no cloud
storage or computation.

The project is inspired by Iron Man: Tony Stark's build tools, where he designs his suits by talking to J.A.R.V.I.S.
and shaping the parts in front of him. Jarvis Studio aims for the same way of working on real parts: you talk, Jarvis
builds and changes the model, and you refine it with full CAD tools.

![Jarvis Studio with the skateboard assembly open](image.png)

Design notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The order of work is in
[docs/ROADMAP.md](docs/ROADMAP.md).

## What it does

- **Sketches:** lines, arcs, circles, slots, splines, text and more, with relations and dimensions. Model edges can be
  turned into sketch items, there is a trim tool, and points can snap to and be pierced by curves such as a helix
  (see [docs/SKETCH_TOOLS.md](docs/SKETCH_TOOLS.md)).
- **Features:**
  - from sketches: extrude, revolve, loft, sweep, hole and thread, each with the options a professional CAD program
    gives it. A helix or spiral is a step of its own, defined by pitch, height or turns, with variable pitch and
    taper, so a spring is a circle, a helix, a profile on a plane square to the helix, and a sweep. A boss that only
    touches the body, such as a thread profile drawn on a bore and swept along a helix, joins it as one body;
  - applied to the body: fillet, chamfer, shell, draft, mirror and patterns. Where the kernel's own fillet gives up,
    the studio builds the round from its true sections, also round a hole's rim that runs across several faces.
  - Threads can be shown fully modelled or as a light helix drawn on the hole or shaft while the model stays plain.
- **Reference geometry:** planes (offset, at an angle, through points, or square to a curve at a point of it), axes
  and points, including points on a helix or spaced along it.
- **Feature tree:** sketches sit under the features that use them, folders group steps, the Solid Bodies folder
  lists the bodies, and steps can be hidden, suppressed, rolled back and reordered.
- **Tool forms:** open in the left panel in place of the tree, with see-through previews over the model.
- **Assemblies:** several parts in one project, joined by mates (coincident, parallel, perpendicular, tangent,
  concentric, lock, distance and angle) between faces, edges, points, planes and axes. The assembly tree shows each
  part as fixed or how free it still is, keeps the mates in their own folder, and lets you reorder parts by dragging
  and group them in folders. Parts move within the freedom their mates leave. Hidden parts are left unbuilt until you
  show them again, so a project opens on the parts you can see.
- **Project files:** File > Save and Save As write a `.jarvis` file wherever you like, holding the design with every
  imported file and picture it uses and a preview picture; File > Open brings one back as a project. The format is in
  [docs/FILE_FORMAT.md](docs/FILE_FORMAT.md). Inside the studio every change is saved as you work. To see a whole
  design, open [examples/Skateboard.jarvis](examples/Skateboard.jarvis): a street skateboard with a maple deck, trucks,
  wheels on 608 bearings and the screws and nuts that hold it together.
- **Import:**
  - STEP, IGES, STL and .sldprt parts (read from the file's own Parasolid data);
  - feature histories exported from another CAD program with the macro in `tools/`, rebuilt as features, with
    assemblies keeping their placements and, where their faces are found again, their mates.
- **Export:** STL, STEP and a FreeCAD macro.
- **Toolbars:** each mode (part, sketch, assembly) has its own toolbars, which you can rearrange in Options. Any
  toolbar, or any group from a pulldown such as the sketch relations, can float as a toolbar of its own anywhere on
  the screen, as a row or a column, and comes back where you left it.
- **Options:** general, sketch, tool defaults, units, display (including mesh quality), lighting, AI assistant,
  speech input, toolbars and files. The lighting page shows the model with its lights and the view's camera in a small 3D overview,
  where directional, point and spot lights are placed by dragging.
- **Jarvis:** type in the prompt bar, or hold **Talk** and speak: the words appear as you pause, and on release only
  the last phrase is left to recognise, so the request goes off a fraction of a second later. Jarvis uses the same
  tools as the UI. For a bigger
  job with several independent pieces, such as the parts of an assembly, Jarvis can hand the pieces to part builders
  working alongside it, then checks each result and fits them together; small requests it does itself. This comes
  from its skills, which are listed with a switch each in Options > AI assistant; your own skills go in
  `projects/.studio/skills/`.

What each tool has and still lacks is in [docs/FEATURE_OPTIONS.md](docs/FEATURE_OPTIONS.md).

## Requirements

- Node 22 and Python 3, on Linux, Windows or macOS.
- For Jarvis, one of these, chosen in Options > AI assistant:
  - Claude Code installed and logged in on this machine (the default);
  - an Anthropic API key;
  - an API key for another service with an OpenAI-compatible API (OpenAI, Google Gemini, Mistral, Groq, DeepSeek,
    xAI, OpenRouter or any other address), or a model running on this machine in Ollama or LM Studio.

  Keys stay on the server, are never shown in full, and are sent only to the service they were saved for. The page
  fetches the list of models each service offers, Claude's with their effort levels, and has a Test connection
  button. Part builders need Claude; with other services Jarvis follows its skills on its own.

## Setup and run

```bash
npm install
npm run setup:voice                          # Piper voice (speech out)
npm run setup:stt -- --moonshine             # speech in: Whisper, and Moonshine (the default, fastest on a CPU)
npm run dev
```

The setup scripts pick the right one for the OS: `scripts/setup-*.sh` (bash) on Linux and macOS,
`scripts/setup-*.ps1` (PowerShell) on Windows. Both take the same options:

| Option | What it adds |
|---|---|
| `--moonshine` | Moonshine (Useful Sensors), a recogniser made for fast English on CPUs, and its model |
| `--gpu` | NVIDIA's cuBLAS for CUDA 12, so Whisper can run on an NVIDIA GPU (Linux and Windows; about 400 MB) |

Engine, model and device (auto, CPU or GPU) are chosen in Options > Speech. Auto uses the GPU when it passes a test at
start-up and falls back to the CPU otherwise, or when the GPU fails later (out of memory, for example). The GPU must be
one CTranslate2 has kernels for: its current wheels need compute capability 5.3 or newer. Moonshine runs on the CPU.
`.venv/bin/python scripts/stt_selfcheck.py` (Windows: `.venv\Scripts\python.exe scripts\stt_selfcheck.py`) checks every
installed engine on every device and prints the timings.

Open http://localhost:4719. Esc stops Jarvis. Without the voice or speech setup the app still works: it falls back to
the browser's voice and hides the Talk button. ffmpeg is not needed: browsers send raw audio, and the rare one without
Web Audio sends a compressed clip that the speech server decodes with PyAV (installed with faster-whisper), or with the
ffmpeg program when PyAV cannot.

## Ports

Everything listens on 127.0.0.1 only, and the server answers only requests addressed to this computer, so a web page
elsewhere cannot reach the studio's API or tools through your browser.

| Port | What |
|---|---|
| 4719 | Web app (Vite), proxies `/api`, `/ws` and `/mcp` to the server |
| 4720 | Server: project store, CAD kernel, tools, Jarvis, MCP |
| 4721 | Piper text-to-speech |
| 4722 | Speech-to-text (Whisper or Moonshine) |

## Driving it from another AI client

Every app action is an MCP tool, served over Streamable HTTP at `http://127.0.0.1:4720/mcp`: the same tools Jarvis
uses, from sketches and features to mates, assembly folders and project files. A client that connects also gets the
modelling rules Jarvis works by (units, how to build real parts, how to check the result). With Claude Code:

```bash
claude mcp add --transport http jarvis-studio http://127.0.0.1:4720/mcp
```

## Moving designs over from another CAD program

The history export macro in `tools/` runs inside the other program. You double-click it and choose a folder. It
writes a `<name>.jarvis-sw.json` next to every part and assembly in that folder and its subfolders. Import those files
with File > Import: parts come in with their features, sketches and folders, and assemblies with their components.
The macro's own README, next to it, has the details.

## Environment settings

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_MODEL` | `sonnet` | Claude model used for Jarvis in Fast mode |
| `JARVIS_EFFORT` | `medium` | Thinking effort in Fast mode (`low` is faster, `high` designs more carefully) |
| `JARVIS_QUALITY` | `fast` | Start in `best` mode (Opus, high effort); also switchable in the status chip |
| `JARVIS_STT_MODEL` | `base.en` | Whisper model `setup:stt` downloads (the one used is set in Options > Speech) |
| `JARVIS_STT_MOONSHINE_MODEL` | `base` | Moonshine model `setup:stt -- --moonshine` downloads |
| `JARVIS_PROJECTS_DIR` | `./projects` | Where projects and exports are saved |

The model and effort can also be set in Options > AI assistant.

## Checks

```bash
npm run typecheck
npx vitest run
```

The test "makes a 10-turn spring along a helix, watertight and quickly" is timing-based and can fail on a busy machine;
run its file alone before treating it as a failure.

A few tests read real part files that are not in the repository. They look in `JARVIS_TEST_SAMPLES` (default
`~/.local/share/jarvis-studio/test-samples`) and are skipped where the files are missing; the scans over a whole folder
of designs run only when `JARVIS_DESIGNS` names one.
