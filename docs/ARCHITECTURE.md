# Jarvis Studio: Architecture

Status: milestone 1 built; milestone 2 largely built: OpenCascade kernel, feature history, ISO fasteners, CAD scripts, STEP export, direct CAD toolbar (2026-11-12). See README.md for how to run it.

## 1. What it is

A local web app where you build hardware projects by talking to an AI assistant.
There are no menus or toolbars: the screen is a full-bleed 3D viewport, a prompt bar and a microphone.
Everything else (creating parts, exploding an assembly, drawing a schematic) is done by the assistant calling tools.

Four capabilities, one shared core:

| # | Capability | Summary |
|---|---|---|
| 1 | Jarvis | Voice and text assistant with a calm British-butler persona |
| 2 | MCP server | Every app action is an MCP tool, usable by Jarvis and by external AI clients |
| 3 | 3D modelling | Parametric parts, assemblies, exploded views with callout labels |
| 4 | Project building | One project holds mechanical model, schematic, PCB and bill of materials |

## 2. Assumptions to confirm

1. **"Local Claude server" means the Claude Code install already on this machine** (`~/.local/bin/claude`, v2.1.314), driven through the Claude Agent SDK and using your existing login. No API key in the project. If you meant something else (a local proxy, or a local open model), section 5 changes and nothing else does.
2. **Single user, localhost only.** No accounts, no auth beyond binding to 127.0.0.1.
3. **The voice is a British male Piper voice with light processing.** It is in the style of a film AI butler; it does not clone any actor's voice.

## 3. System overview

```
 Browser (renderer only)                    Node server (source of truth)
┌──────────────────────────┐   WebSocket   ┌─────────────────────────────────┐
│ 3D viewport (three.js)   │◄─────────────►│ Project store (document + undo) │
│ Callout labels, HUD orb  │  state patches│ Tool registry  ◄── one place    │
│ Prompt bar, mic, audio   │               │   ├─ in-process MCP → Jarvis    │
│ CAD worker (OpenCascade) │               │   └─ HTTP MCP  → external AIs   │
└──────────────────────────┘               │ Jarvis agent (Claude Agent SDK) │
                                           │ Voice: Whisper STT, Piper TTS   │
                                           └─────────────────────────────────┘
```

The key decision: **the project document lives on the server, and the browser only renders it.**
A tool call changes the document, the server broadcasts a patch, and the viewport animates to the new state.
This is what lets an external MCP client and the in-app Jarvis drive the same scene with the same code.

## 4. The tool registry (capability 2)

Each tool is defined once (name, zod schema, handler) and exposed two ways:

- **In-process** to the Jarvis agent via the Agent SDK's `createSdkMcpServer`.
- **Streamable HTTP** at `http://127.0.0.1:4720/mcp` (also proxied at port 4719) for Claude Code, Claude Desktop or any MCP client.

Tools implemented so far (planned ones in italics):

| Group | Tools |
|---|---|
| Project | `project_get`, `project_list`, `project_new`, `project_open`, `undo`, `redo`, `print_settings` |
| Parts | `parts_add`, `parts_update`, `parts_remove` (batch calls; material is merged on update) |
| Features | `features_add`, `features_update`, `features_remove`, `features_reorder`, `history_get` |
| Decals | `decals_add`, `decals_update`, `decals_remove` |
| Assembly | `assembly_explode` (factor 0..1, so explode and assemble are one tool), *`assembly_mate`* |
| View | `view_set` (labels, focus, turntable, camera angles), `view_screenshot`, *`view_section`* |
| Electronics | *`schematic_set`, `schematic_get`, `pcb_layout`, `bom_get`* |
| Export | `export_stl` (per printed part), `export_step`, `cad_check`, *`export_kicad`, `export_bom_csv`* |

`view_screenshot` round-trips to the browser and returns an image, so the model can look at its own work and correct it.
That feedback loop matters more for modelling quality than any other single tool.

## 5. Jarvis (capability 1)

- **Brain:** Claude Agent SDK (TypeScript) on the server. Built-in file and shell tools are disabled; the agent only gets the Jarvis Studio tools.
- **Persona:** a system prompt for short, dry, spoken-style replies ("All laid out, sir.") and no markdown, since output is spoken.
- **Speech in:** `faster-whisper` with the `base.en` model on CPU, kept warm as a local HTTP process (needs ffmpeg). The GTX 950M is too small to help, and base.en runs faster than real time on CPU. Push-to-talk first; wake word ("Jarvis") later via openWakeWord.
- **Speech out:** Piper with `en_GB-alan-medium`, streamed sentence by sentence so speech starts before the reply finishes. A small Web Audio chain (high-pass, slight compression, short room reverb) gives the "onboard computer" tone.
- **Barge-in:** speaking or typing stops playback and cancels the current turn.

## 6. 3D modelling (capability 3)

- **Rendering:** three.js through react-three-fiber. Dark studio lighting, soft ground shadow, bloom on emissive parts.
- **Geometry kernel:** OpenCascade compiled to WebAssembly, via `replicad`, running on the server in a worker thread (`apps/server/src/cad/`). Every part is a real solid; the browser fetches its mesh by a hash of its geometry (`/api/mesh/:key`) and draws the solid's real edges. STL and STEP come from the same solids.
- **Part definition:** a body (empty, primitive, sketch body, ISO fastener, or a replicad CAD script) plus a feature history: sketch steps, extrude/revolve/loft (add or cut, referencing sketch steps by id), fillet, chamfer, shell, standard hole, cut, mirror, thread. Each step is named, editable, suppressible and reorderable; a per-part rollback builds the history up to a chosen step. Holes are sized from ISO tables (`packages/core/src/fasteners.ts`) plus the printer's hole tolerance. A failing feature shows the solid up to that step.
- **Sketches:** closed profiles on Top/Front/Right, an offset plane, any flat face, or the tangent plane of a curved face (custom planes: origin, normal, u axis). The interactive sketcher keeps the constrained source (points, curves, constraints, driving dimensions) in `Sketch.geometry` and solves it with FreeCAD's PlaneGCS (`@salusoft89/planegcs`, WASM, in the browser); the solved `profiles` are what the kernel builds from. Profiles inside others become holes.
- **Decals:** pictures uploaded to `/api/assets` (content-hashed) and projected onto every surface facing them (planar wrap over curves) or within a depth (box). Visual only, not in STL or STEP.
- **Scripts:** run in a `node:vm` context with only replicad, params and Math; this is hardening, not a security boundary, which is acceptable because the app is local and single-user.
- **Exploded view:** each part has an explode axis and order derived from the assembly's mates. `assembly_explode` animates a single 0..1 factor, so "lay it all out" and "put yourself back together" are the same tool.
- **Callout labels:** HTML pills over the canvas with SVG leader lines to a projected anchor on each part, laid out in left and right columns with overlap avoidance, as in the reference screenshot.
- **Chrome:** File menu (new, open, rename, save as copy, export, print settings) and status chip with a Fast/Best quality switch; Part and Assembly workspaces with their own toolbars (calling the same tools as Jarvis) and a left browser (part history with edit/rollback, or the assembly's components); a sketcher with dimensions and constraints; an XYZ triad, mm grid and coordinate readout; an activity panel (background status and recent commands), the prompt bar (accepts pasted pictures), the HUD orb and the subtitle line. Only the browser last used plays Jarvis's voice.

## 7. Project building (capability 4)

A project is a folder on disk, friendly to git:

```
my-project/
  project.json        metadata, assembly tree, mates, view state
  parts/*.part.ts     parametric part scripts
  circuit/*.tsx       schematic and PCB as code
  exports/            STEP, STL, KiCad, BOM
```

- **Electronics:** circuit-as-code with `tscircuit`, which renders schematic and PCB in the browser and suits AI authoring far better than a click-driven editor. KiCad export is the hand-off for fabrication; how complete that export is needs verifying at the start of milestone 3.
- **Linking the domains:** a PCB is also a part. Its board outline and component heights become a solid in the assembly, so enclosure clearances can be checked and it appears in the exploded view.
- **BOM:** generated from parts and circuit components together.

## 8. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript throughout, npm workspaces (`apps/web`, `apps/server`, `packages/core`) |
| Web | Vite, React, react-three-fiber, zustand |
| Server | Node 22, Fastify, `ws`, `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk` |
| CAD | replicad (OpenCascade WASM) |
| Voice | faster-whisper and Piper as local child processes (Python venv) |

## 9. Milestones

1. **Talking viewport.** Server, project store, tool registry, viewport with primitive parts, explode and labels, text chat with Jarvis, Piper voice out. Proves the whole loop end to end.
2. **Real CAD and MCP out.** OpenCascade parts, mates, STEP and STL export, HTTP MCP endpoint, speech in, screenshot feedback.
3. **Electronics.** Schematic and PCB as code, PCB as an assembly part, BOM, KiCad export.
4. **Polish.** Wake word, section views, project templates, clearance checks.

## 10. Risks

| Risk | Mitigation |
|---|---|
| AI-written CAD scripts fail or produce wrong shapes | Run in a worker with a timeout, return kernel errors to the model, use `view_screenshot` to self-check |
| Agent SDK latency makes voice feel slow | Stream text to TTS per sentence; speak a short acknowledgement before long tool runs |
| OpenCascade WASM is large (tens of MB) and slow to start | Load it lazily in the worker; milestone 1 uses primitives and does not need it |
| tscircuit's KiCad export has gaps | Verify first in milestone 3; fall back to generating KiCad files directly |
