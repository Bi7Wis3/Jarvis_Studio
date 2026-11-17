// Runs the setup script for this OS (PowerShell on Windows, bash elsewhere): npm run setup:stt [-- --gpu --moonshine],
// npm run setup:voice.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupCommand, type SetupKind } from '../apps/server/src/python.js';

const kind = process.argv[2];
if (kind !== 'stt' && kind !== 'voice') {
    console.error('Usage: tsx scripts/setup.ts stt|voice [options]');
    process.exit(2);
}
const { command, args } = setupCommand(kind as SetupKind, process.argv.slice(3));
const result = spawnSync(command, args, { stdio: 'inherit', cwd: join(dirname(fileURLToPath(import.meta.url)), '..') });
if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
}
process.exit(result.status ?? 1);
