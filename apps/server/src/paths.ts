import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PROJECTS_DIR = process.env.JARVIS_PROJECTS_DIR ?? join(ROOT, 'projects');
export const VOICES_DIR = join(ROOT, 'voices');
export const PIPER_PYTHON = join(ROOT, '.venv', 'bin', 'python');
export const EXPORTS_DIR = join(PROJECTS_DIR, 'exports');
/** Images used by decals and reference pictures, named by a hash of their content. */
export const ASSETS_DIR = join(PROJECTS_DIR, 'assets');
