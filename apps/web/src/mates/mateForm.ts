// What the Mate form would do with its selection and options: the mates it makes (prepared as the server will make
// them), how they would solve (the preview), and the tool call OK sends.

import type { Part } from '@jarvis/core';
import {
    alignsAxes, hasAlignment, hasDistanceEnds, hasFlip, MateSystem, nextMateName, prepareMate, refGeometry, type AssemblyMates,
    type AssemblyResult, type Mate, type MateRef, type MateStatus, type MateType,
} from '@jarvis/core/mates';
import { formPairs, formTypes, type MateFormState } from './mateState';

export interface FormPlan {
    /** The types the selection takes, and the one in use (chosen, else suggested). */
    valid: MateType[];
    type: MateType | null;
    /** The mates OK would make, prepared (alignment, value, side and holds filled in). */
    mates: Mate[];
    /** Which options apply to this selection and type. */
    alignment: boolean;
    flip: boolean;
    ends: boolean;
    alignAxes: boolean;
    lockRotation: boolean;
    /** What to tell the user when nothing can be made. */
    problem: string | null;
}

/** The assembly as the form sees it: the edited mate left out (the form stands in for it). */
export function assemblyWithout(assembly: AssemblyMates | undefined, editing: string | null): AssemblyMates | undefined {
    return assembly && editing ? { ...assembly, mates: assembly.mates.filter((m) => m.id !== editing) } : assembly;
}

export function formPlan(form: MateFormState, parts: readonly Part[], assembly: AssemblyMates | undefined): FormPlan {
    const { valid, suggested } = formTypes(form, parts);
    const type = form.type && valid.includes(form.type) ? form.type : suggested;
    const pairs = formPairs(form);
    const none: FormPlan = { valid, type, mates: [], alignment: false, flip: false, ends: false, alignAxes: false, lockRotation: false, problem: null };
    if (!pairs.length) {
        return { ...none, problem: form.multiple ? 'Pick the common reference, then an entity on each component to mate to it.'
            : 'Pick two entities on two components: faces, edges or vertices in the view, planes and origins in the tree.' };
    }
    if (!type) {
        const same = pairs.some(([a, b]) => (a.ref.part ?? null) === (b.ref.part ?? null) && (a.ref.copy ?? 0) === (b.ref.copy ?? 0));
        return { ...none, problem: same ? 'Both entities are on the same component: pick one on another component.' : 'These entities take no standard mate.' };
    }
    const edited = form.editing ? assembly?.mates.find((m) => m.id === form.editing) : undefined;
    const others = assemblyWithout(assembly, form.editing)?.mates ?? [];
    let alignment = false;
    let flip = false;
    let ends = false;
    let axes = false;
    const mates = pairs.map(([a, b], i): Mate => {
        const ga = refGeometry(a.ref, parts);
        const gb = refGeometry(b.ref, parts);
        const both = !!ga && !!gb;
        alignment ||= both && hasAlignment(type, ga!, gb!);
        flip ||= both && hasFlip(type, ga!, gb!);
        ends ||= both && type === 'distance' && hasDistanceEnds(ga!, gb!);
        axes ||= both && type === 'coincident' && alignsAxes(ga!, gb!);
        const refs: MateRef[] = [a.ref, b.ref];
        const same = edited && edited.type === type && JSON.stringify(edited.refs.map((r) => r.pick)) === JSON.stringify(refs.map((r) => r.pick))
            && !!edited.lockRotation === (type === 'concentric' && form.lockRotation);
        const value = form.value !== null && form.value.trim() !== '' && Number.isFinite(Number(form.value)) ? Math.abs(Number(form.value)) : undefined;
        const raw: Mate = {
            id: form.editing ?? `preview-${i}`,
            name: form.name.trim() && pairs.length === 1 ? form.name.trim() : edited?.name ?? nextMateName(others, type),
            type,
            refs,
            ...(form.alignment && both && hasAlignment(type, ga!, gb!) ? { alignment: form.alignment } : {}),
            ...((type === 'distance' || type === 'angle') && value !== undefined ? { value: type === 'angle' ? Math.min(180, value) : value } : {}),
            ...(form.flip !== null && both && hasFlip(type, ga!, gb!) ? { flip: form.flip } : {}),
            ...(type === 'concentric' && form.lockRotation ? { lockRotation: true } : {}),
            ...(type === 'coincident' && form.alignAxes && both && alignsAxes(ga!, gb!) ? { alignAxes: true } : {}),
            ...(type === 'distance' && both && hasDistanceEnds(ga!, gb!) ? { ends: form.ends } : {}),
            ...(same && edited?.hold ? { hold: edited.hold } : {}),
        };
        return prepareMate(raw, parts);
    });
    return {
        valid, type, mates, alignment, flip, ends, alignAxes: axes, lockRotation: type === 'concentric', problem: null,
    };
}

/** How the form's mates would solve: the parts moved and each new mate's state. */
export function previewPlan(plan: FormPlan, parts: readonly Part[], assembly: AssemblyMates | undefined, editing: string | null):
    { result: AssemblyResult; states: MateStatus[] } {
    const system = new MateSystem(parts, assemblyWithout(assembly, editing), { extra: plan.mates });
    const only = [...new Set(plan.mates.flatMap((m) => m.refs.flatMap((r) => (r.part ? [r.part] : []))))];
    const result = system.solve({ only, analyse: true });
    return { result, states: plan.mates.map((m) => result.mates[m.id] ?? { state: 'ok' }) };
}

/** A reference as the tools take it (the server finds faces, edges and vertices again itself). */
const sendRef = (ref: MateRef) => ({ ...(ref.part ? { part: ref.part } : {}), ...(ref.copy ? { copy: ref.copy } : {}), pick: ref.pick });

/** The fields of a prepared mate as mates_add and mates_update take them. */
export function mateArgs(m: Mate): Record<string, unknown> {
    return {
        type: m.type,
        refs: m.refs.map(sendRef),
        ...(m.alignment ? { alignment: m.alignment } : {}),
        ...(m.value !== undefined ? { value: m.value } : {}),
        ...(m.flip !== undefined ? { flip: m.flip } : {}),
        ...(m.lockRotation ? { lockRotation: true } : {}),
        ...(m.alignAxes ? { alignAxes: true } : {}),
        ...(m.ends ? { ends: m.ends } : {}),
    };
}

/** The tool call OK makes: add the new mates (or only position the parts), or update the edited one. */
export function applyCall(form: MateFormState, plan: FormPlan, assembly: AssemblyMates | undefined): { name: string; args: Record<string, unknown> } | null {
    if (!plan.mates.length) {
        return null;
    }
    if (form.editing) {
        const m = plan.mates[0];
        return { name: 'mates_update', args: { updates: [{ id: form.editing, ...mateArgs(m), name: m.name, lockRotation: !!m.lockRotation, alignAxes: !!m.alignAxes }] } };
    }
    const mates = plan.mates.map((m) => ({ ...mateArgs(m), ...(plan.mates.length === 1 && form.name.trim() ? { name: form.name.trim() } : {}) }));
    const folder = form.newFolder || (form.multiple && form.multiFolder);
    const base = form.multiple && form.multiFolder ? 'MultiMate' : 'Folder';
    let n = 1;
    while ((assembly?.folders ?? []).some((f) => f.name === `${base}${n}`)) {
        n++;
    }
    return {
        name: 'mates_add',
        args: { mates, ...(form.positionOnly ? { positionOnly: true } : folder ? { newFolder: `${base}${n}` } : {}) },
    };
}
