// The app's Python (the .venv beside the repo, used by the Piper voice and the speech server), laid out as each OS lays
// it out, the NVIDIA libraries pip installs into it, and which setup script a platform runs. Every function takes the
// platform, so the choices for Windows and macOS can be tested on any machine.

import { readdirSync } from 'node:fs';
import path from 'node:path';

type Platform = NodeJS.Platform;
/** Lists a folder's entries; [] when it is missing. */
export type ListDir = (dir: string) => string[];

const listDir: ListDir = (dir) => {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
};

const paths = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The virtual environment's Python: .venv/bin/python, or .venv\Scripts\python.exe on Windows. */
export function venvPython(root: string, platform: Platform = process.platform): string {
    const p = paths(platform);
    return platform === 'win32' ? p.join(root, '.venv', 'Scripts', 'python.exe') : p.join(root, '.venv', 'bin', 'python');
}

/** The venv's site-packages: .venv/lib/python3.X/site-packages, or .venv\Lib\site-packages on Windows. */
export function sitePackages(root: string, platform: Platform = process.platform, list: ListDir = listDir): string[] {
    const p = paths(platform);
    if (platform === 'win32') {
        return [p.join(root, '.venv', 'Lib', 'site-packages')];
    }
    const lib = p.join(root, '.venv', 'lib');
    return list(lib).filter((name) => /^python3\.\d+$/.test(name)).sort().map((name) => p.join(lib, name, 'site-packages'));
}

/**
 * Folders of the NVIDIA libraries pip installs (nvidia-cublas-cu12 and the like, under site-packages/nvidia): their
 * lib folders on Linux, bin folders on Windows. None on macOS, which has no CUDA.
 */
export function nvidiaLibraryDirs(root: string, platform: Platform = process.platform, list: ListDir = listDir): string[] {
    if (platform === 'darwin') {
        return [];
    }
    const p = paths(platform);
    const sub = platform === 'win32' ? 'bin' : 'lib';
    const out: string[] = [];
    for (const site of sitePackages(root, platform, list)) {
        const nvidia = p.join(site, 'nvidia');
        for (const name of list(nvidia).sort()) {
            const dir = p.join(nvidia, name, sub);
            if (list(dir).length > 0) {
                out.push(dir);
            }
        }
    }
    return out;
}

/** The name of the PATH variable as this environment spells it (Windows keeps "Path"). */
function pathKey(env: NodeJS.ProcessEnv, platform: Platform): string {
    return platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
}

/**
 * The environment for a Python process that may use those libraries. The loader only reads the library path when a
 * process starts, so it is set for the child: LD_LIBRARY_PATH on Linux; on Windows PATH, and JARVIS_DLL_DIRS, which the
 * speech server passes to os.add_dll_directory (Python does not search PATH for the DLLs of native modules).
 */
export function libraryEnv(base: NodeJS.ProcessEnv, dirs: string[], platform: Platform = process.platform): NodeJS.ProcessEnv {
    const env = { ...base };
    if (dirs.length === 0 || platform === 'darwin') {
        return env;
    }
    const join = (key: string, sep: string) => [...dirs, ...(env[key] ? [env[key]] : [])].join(sep);
    if (platform === 'win32') {
        const key = pathKey(env, platform);
        env[key] = join(key, ';');
        env.JARVIS_DLL_DIRS = dirs.join(';');
    } else {
        env.LD_LIBRARY_PATH = join('LD_LIBRARY_PATH', ':');
    }
    return env;
}

export type SetupKind = 'stt' | 'voice';

/** The command that runs a setup script: the PowerShell one on Windows, the bash one elsewhere; options pass through. */
export function setupCommand(kind: SetupKind, args: string[], platform: Platform = process.platform): { command: string; args: string[] } {
    const script = kind === 'stt' ? 'setup-stt' : 'setup-voice';
    if (platform === 'win32') {
        return { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.win32.join('scripts', `${script}.ps1`), ...args] };
    }
    return { command: 'bash', args: [path.posix.join('scripts', `${script}.sh`), ...args] };
}
