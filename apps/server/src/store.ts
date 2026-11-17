import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_VIEW, type Project, type ProjectEntry } from '@jarvis/core';
import { fitProjectFolders, repairProjectFolders } from '@jarvis/core/folders';
import { fitAssembly, repairAssembly } from '@jarvis/core/mates';
import { PROJECTS_DIR } from './paths.js';
import { demoProject } from './seed.js';

type Listener = (project: Project) => void;

const MAX_UNDO = 100;

export function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

/** The single source of truth for the open project. Browsers only render what this holds. */
export class ProjectStore {
    private project: Project;
    private undoStack: string[] = [];
    private redoStack: string[] = [];
    private listeners = new Set<Listener>();
    /** A scratch store (see `scratch`): in memory only, no undo history, no project files touched. */
    private readonly memory: boolean;

    constructor(scratch?: Project) {
        this.memory = scratch !== undefined;
        if (scratch) {
            this.project = JSON.parse(JSON.stringify(scratch));
            return;
        }
        mkdirSync(PROJECTS_DIR, { recursive: true });
        this.project = this.loadLast() ?? demoProject();
        this.save();
    }

    /**
     * A throwaway copy of `project` for trying changes (tool previews): mutations apply to the copy only, are not
     * saved, have no undo history and reach no listeners but the scratch store's own.
     */
    static scratch(project: Project): ProjectStore {
        return new ProjectStore(project);
    }

    get(): Project {
        return this.project;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Applies a change to the project. Model changes are undoable; view-only changes are not. */
    mutate(change: (draft: Project) => void, options: { undoable?: boolean } = {}): void {
        const before = JSON.stringify(this.project);
        const draft: Project = JSON.parse(before);
        change(draft);
        // Feature tree folders follow any change of the step order (@jarvis/core/folders).
        fitProjectFolders(this.project, draft);
        // Mates of deleted parts go with them.
        fitAssembly(this.project, draft);
        if ((options.undoable ?? true) && !this.memory) {
            this.undoStack.push(before);
            if (this.undoStack.length > MAX_UNDO) {
                this.undoStack.shift();
            }
            this.redoStack = [];
        }
        this.commit(draft);
    }

    undo(): boolean {
        this.files();
        return this.step(this.undoStack, this.redoStack);
    }

    redo(): boolean {
        this.files();
        return this.step(this.redoStack, this.undoStack);
    }

    list(): string[] {
        return readdirSync(PROJECTS_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5));
    }

    /** Saved projects with their display names, for the project tree. */
    catalog(): ProjectEntry[] {
        return this.list()
            .map((entry) => {
                try {
                    return { slug: entry, name: this.read(join(PROJECTS_DIR, `${entry}.json`)).name };
                } catch {
                    return { slug: entry, name: entry };
                }
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Creates and opens an empty project. A name already in use gets a number, so no saved project is overwritten. */
    create(name: string): void {
        this.files();
        const taken = new Set(this.list());
        let unique = name.trim() || 'Untitled';
        for (let n = 2; taken.has(slug(unique)); n++) {
            unique = `${name.trim() || 'Untitled'} ${n}`;
        }
        name = unique;
        this.undoStack = [];
        this.redoStack = [];
        this.commit({ name, parts: [], view: { ...DEFAULT_VIEW } });
    }

    open(name: string): boolean {
        this.files();
        const file = join(PROJECTS_DIR, `${slug(name)}.json`);
        if (!existsSync(file)) {
            return false;
        }
        this.undoStack = [];
        this.redoStack = [];
        this.commit(this.read(file));
        return true;
    }

    /** Renames the open project; its file moves to the new name. Returns false if the name is taken. */
    rename(name: string): boolean {
        this.files();
        const next = name.trim();
        const from = slug(this.project.name);
        if (!next || (slug(next) !== from && this.list().includes(slug(next)))) {
            return false;
        }
        this.mutate((draft) => {
            draft.name = next;
        }, { undoable: false });
        if (slug(next) !== from) {
            // The project was just saved under its new name; the old file is a stale copy.
            rmSync(join(PROJECTS_DIR, `${from}.json`), { force: true });
        }
        return true;
    }

    /** Saves a copy of the open project under a new (numbered if taken) name and opens it. */
    saveAs(name: string): void {
        this.files();
        const copy: Project = JSON.parse(JSON.stringify(this.project));
        this.create(name);
        this.commit({ ...copy, name: this.project.name });
    }

    /**
     * Moves a saved project to the .trash folder, where it can be recovered by hand.
     * Deleting the open project opens another one, or a new empty project when none is left.
     */
    remove(name: string): boolean {
        this.files();
        const entry = slug(name);
        const file = join(PROJECTS_DIR, `${entry}.json`);
        if (!existsSync(file)) {
            return false;
        }
        const trash = join(PROJECTS_DIR, '.trash');
        mkdirSync(trash, { recursive: true });
        renameSync(file, join(trash, `${entry}-${Date.now()}.json`));
        if (slug(this.project.name) === entry) {
            const next = this.list()[0];
            if (!next || !this.open(next)) {
                this.create('Untitled');
            }
        }
        return true;
    }

    private step(from: string[], to: string[]): boolean {
        const snapshot = from.pop();
        if (!snapshot) {
            return false;
        }
        to.push(JSON.stringify(this.project));
        // Undo applies to the model only: the camera, explode and labels stay as they are now.
        const next: Project = JSON.parse(snapshot);
        next.view = { ...this.project.view };
        if (next.view.focus && !next.parts.some((p) => p.id === next.view.focus)) {
            next.view.focus = null;
        }
        this.commit(next);
        return true;
    }

    private commit(next: Project): void {
        this.project = next;
        this.save();
        for (const listener of this.listeners) {
            listener(next);
        }
    }

    private read(file: string): Project {
        const project: Project = JSON.parse(readFileSync(file, 'utf8'));
        project.view = { ...DEFAULT_VIEW, ...project.view };
        repairProjectFolders(project);
        repairAssembly(project);
        return project;
    }

    private loadLast(): Project | null {
        const marker = join(PROJECTS_DIR, '.last');
        if (!existsSync(marker)) {
            return null;
        }
        const file = join(PROJECTS_DIR, `${readFileSync(marker, 'utf8').trim()}.json`);
        return existsSync(file) ? this.read(file) : null;
    }

    /** Project and history operations are not available on a scratch store. */
    private files(): void {
        if (this.memory) {
            throw new Error('Not available in a preview.');
        }
    }

    private save(): void {
        if (this.memory) {
            return;
        }
        const name = slug(this.project.name);
        writeFileSync(join(PROJECTS_DIR, `${name}.json`), JSON.stringify(this.project, null, 2));
        writeFileSync(join(PROJECTS_DIR, '.last'), name);
    }
}
