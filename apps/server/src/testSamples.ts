// Files of the owner's own designs that some tests read when they are on this machine. The repository is public, so
// they are kept outside it: in JARVIS_TEST_SAMPLES, else ~/.local/share/jarvis-studio/test-samples. Tests that need
// one are skipped where it is missing.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SAMPLES = process.env.JARVIS_TEST_SAMPLES ?? join(homedir(), '.local', 'share', 'jarvis-studio', 'test-samples');

/** The path of a sample file, or null when it is not on this machine. */
export function sample(name: string): string | null {
    const path = join(SAMPLES, name);
    return existsSync(path) ? path : null;
}

/** Whether all these samples are on this machine. */
export const hasSamples = (...names: string[]): boolean => names.every((name) => sample(name) !== null);

/** The owner's design folder for the read-only scans over all of it (JARVIS_DESIGNS), or null when not set. */
export const DESIGNS: string | null = process.env.JARVIS_DESIGNS && existsSync(process.env.JARVIS_DESIGNS) ? process.env.JARVIS_DESIGNS : null;
