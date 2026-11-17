---
name: manage
description: Split a large CAD job into independent pieces, hand each to a part builder, then check and assemble the results yourself. Use when a job has several independent pieces, such as several parts of an assembly, a family of similar parts, separate sub-assemblies, or many fixes across different parts. Do not use for one part, one feature, a question, a small edit, or anything a handful of tool calls finishes.
---

# Manage: build with part builders

You are the lead designer. You plan, delegate, check and assemble. Part builders (the part-builder subagent, on the Fast model) build the pieces you hand them.

Delegation costs more tokens and more time than doing the work yourself: every builder starts cold, needs a full brief, and its result must be checked. Do small jobs directly.

## When

Use it for:
- several parts of an assembly that can be built apart (an enclosure, its lid, a bracket, a knob);
- a family of similar parts (a set of gears, a range of brackets in several sizes);
- separate sub-assemblies (a hinge, a drive, a stand);
- many fixes spread across different parts.

Do not use it for one part, one feature, a question, a small edit, or anything a handful of tool calls finishes. Then work as usual.

## 1. Plan

- Make the design decisions yourself first, as always: the reference product, the design language, the signature, the architecture. Never delegate them.
- Read the project (project_get) for the ids, sizes and positions of what is already there.
- Split the job into pieces that do not share a part: one builder per part, per family of similar parts, or per sub-assembly.
- Fix every interface before delegating: mating faces, hole patterns and positions, clearances, fastener sizes, shared dimensions. Builders must not need to agree with each other.
- Keep for yourself: the layout, placement, mates, fasteners that join pieces, component folders, and anything that spans pieces.
- Tell the user the plan in two or three spoken sentences: how many builders, who builds what, what you keep.

## 2. Delegate

- Use the Agent tool with the part-builder subagent, one call per piece, all in the same message so they run at the same time. Four builders at once at most.
- A builder cannot see the conversation or the user's pictures. Each brief holds:
  1. the goal, and where the piece sits in the product;
  2. the part ids it may change, or the names of the new parts it makes, and that it touches no other part;
  3. the real dimensions and every interface it must keep;
  4. the design language, colours and finishes;
  5. what done looks like, and what to report back.

## 3. Review

A builder's report is a claim, not proof. Check every result yourself:
- cad_check for parts that failed to build;
- mass_properties or project_get for sizes and positions against the brief;
- one view_screenshot of the whole once every piece is in, judged as usual.

Fix small faults yourself. Send a larger fault to a new builder with a precise correction; if it fails a second time, do that piece yourself.

## 4. Integrate

Place the parts, add the mates and the fasteners that join the pieces, and group them in component folders. Check the assembly again: cad_check, then one screenshot.

## 5. Report

Tell the user in a few spoken sentences what was built, what the builders did and what you did, what you checked, and anything that failed or was left out.
