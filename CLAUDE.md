# Jarvis Studio: standing rules for anyone working in this repo

Jarvis Studio is a local, single-user parametric CAD app (web UI, Node server, OpenCascade kernel) with an AI
assistant. The aim is a full CAD program in the class of SolidWorks and Fusion, with CAM later.

## The SolidWorks manual is the specification

- For every tool, setting and behaviour, the official SolidWorks online help defines what to build: which options a
  tool has, what each does, defaults, what must be selected, how selection boxes, previews, drag handles, the
  feature tree, view navigation, snaps, units and settings behave.
- `docs/SOLIDWORKS_REFERENCE.md` is our digest of that help, in our own words with source links. Read the matching
  section before designing, changing or reviewing a tool or setting. If the section is missing or marked "Not
  verified", look it up in the online help first and add it. Do not design behaviour from memory.
- `docs/FEATURE_OPTIONS.md` is the checklist of what each tool has and still lacks; tick it as work lands.
  `docs/ROADMAP.md` gives the order.
- Every tool gets the full set of options a professional CAD program gives it, without waiting to be asked per tool.
- When the kernel cannot do something the manual describes, say so in the report to the user. Never add an option
  that does not work, and never substitute different behaviour silently.

## Look

- Toolbars keep the app's own compact icon style and dark theme: no SolidWorks ribbon or tabs.
- The left panel follows SolidWorks: the history tree looks and behaves like the FeatureManager (sketches nested
  under each feature that uses them), and every tool form opens in the left panel in place of the tree
  (PropertyManager style: name, OK/Cancel at the top, collapsible sections, selection list boxes). No popups under
  the toolbar.
- Previews are see-through ghosts over the untouched model. Values can be dragged in the view where it makes sense.

## Scope

- Local only: no cloud storage, sync or computation, and no team or collaboration features.
- Every component is a part; there is no separate "hardware" category.

## Working here

- Checks: `npm run typecheck` and `npx vitest run` from the repo root. The test "makes a 10-turn spring along a
  helix, watertight and quickly" is timing-based and can fail on a busy machine; re-run its file alone before
  treating it as a failure.
- Style: 4-space indent, single quotes, short comments only where something is not obvious, sentence-case UI text
  in plain words.
- The dev server (`npm run dev`: web 4719, server 4720) hot-reloads and is usually in use by the owner with a real
  project open. Do not stop it, and do not change the open project except through a clearly named throwaway part
  that is removed again.
- Do not commit or push unless the owner asks.
