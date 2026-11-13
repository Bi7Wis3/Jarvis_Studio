# Audit against the SolidWorks manual

Started 2026-11-13 at the owner's request: every tool that was added is reviewed against the SolidWorks online help
(digest in `../SOLIDWORKS_REFERENCE.md`), because several are incomplete or behave differently.

One file per area, same layout in each:

- A summary table: tool, verdict (matches / differs / incomplete / broken), the number of gaps by priority.
- Per tool: what SolidWorks does (options and behaviour, with the help page), what the app does (with file and line),
  then the gaps, each with a priority and a size.

Priorities: P1 the tool is wrong, loses work or cannot do its basic job; P2 an option or behaviour a SolidWorks user
expects and will miss quickly; P3 secondary options and polish.
Sizes: S under an hour, M a few hours, L a day or more (new kernel work, new data model).

Nothing in these files is a fix; they are the work list.
