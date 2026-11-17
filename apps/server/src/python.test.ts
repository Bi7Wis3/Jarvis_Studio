import { describe, expect, it } from 'vitest';
import { libraryEnv, nvidiaLibraryDirs, setupCommand, sitePackages, venvPython, type ListDir } from './python.js';

/** A folder tree for ListDir: every path listed with its entries. */
const tree = (folders: Record<string, string[]>): ListDir => (dir) => folders[dir] ?? [];

describe('venvPython', () => {
    it('finds the venv Python where each OS puts it', () => {
        expect(venvPython('/home/me/jarvis', 'linux')).toBe('/home/me/jarvis/.venv/bin/python');
        expect(venvPython('/Users/me/jarvis', 'darwin')).toBe('/Users/me/jarvis/.venv/bin/python');
        expect(venvPython('C:\\Users\\me\\jarvis', 'win32')).toBe('C:\\Users\\me\\jarvis\\.venv\\Scripts\\python.exe');
    });
});

describe('nvidiaLibraryDirs', () => {
    it('lists the lib folders of the pip-installed NVIDIA packages on Linux, in every python3.X of the venv', () => {
        const list = tree({
            '/r/.venv/lib': ['python3.13', 'not-python'],
            '/r/.venv/lib/python3.13/site-packages/nvidia': ['__init__.py', 'cublas', 'cudnn', 'empty'],
            '/r/.venv/lib/python3.13/site-packages/nvidia/cublas/lib': ['libcublas.so.12', 'libcublasLt.so.12'],
            '/r/.venv/lib/python3.13/site-packages/nvidia/cudnn/lib': ['libcudnn.so.9'],
        });
        expect(sitePackages('/r', 'linux', list)).toEqual(['/r/.venv/lib/python3.13/site-packages']);
        expect(nvidiaLibraryDirs('/r', 'linux', list)).toEqual([
            '/r/.venv/lib/python3.13/site-packages/nvidia/cublas/lib',
            '/r/.venv/lib/python3.13/site-packages/nvidia/cudnn/lib',
        ]);
    });

    it('lists the bin folders on Windows and nothing on macOS', () => {
        const list = tree({
            'C:\\r\\.venv\\Lib\\site-packages\\nvidia': ['cublas'],
            'C:\\r\\.venv\\Lib\\site-packages\\nvidia\\cublas\\bin': ['cublas64_12.dll'],
        });
        expect(nvidiaLibraryDirs('C:\\r', 'win32', list)).toEqual(['C:\\r\\.venv\\Lib\\site-packages\\nvidia\\cublas\\bin']);
        expect(nvidiaLibraryDirs('/r', 'darwin', () => ['anything'])).toEqual([]);
    });

    it('finds nothing when the venv has no NVIDIA packages', () => {
        expect(nvidiaLibraryDirs('/r', 'linux', tree({ '/r/.venv/lib': ['python3.12'] }))).toEqual([]);
    });
});

describe('libraryEnv', () => {
    const dirs = ['/a/lib', '/b/lib'];

    it('puts the folders first on LD_LIBRARY_PATH on Linux, keeping what was there', () => {
        expect(libraryEnv({ HOME: '/h' }, dirs, 'linux')).toEqual({ HOME: '/h', LD_LIBRARY_PATH: '/a/lib:/b/lib' });
        expect(libraryEnv({ LD_LIBRARY_PATH: '/x' }, dirs, 'linux').LD_LIBRARY_PATH).toBe('/a/lib:/b/lib:/x');
    });

    it('adds them to PATH as Windows spells it, and passes them for os.add_dll_directory', () => {
        const env = libraryEnv({ Path: 'C:\\Windows' }, ['C:\\n\\bin'], 'win32');
        expect(env.Path).toBe('C:\\n\\bin;C:\\Windows');
        expect(env.PATH).toBeUndefined();
        expect(env.JARVIS_DLL_DIRS).toBe('C:\\n\\bin');
    });

    it('changes nothing on macOS or without folders, and never changes the environment it was given', () => {
        const base = { LD_LIBRARY_PATH: '/x' };
        expect(libraryEnv(base, dirs, 'darwin')).toEqual(base);
        expect(libraryEnv(base, [], 'linux')).toEqual(base);
        libraryEnv(base, dirs, 'linux');
        expect(base).toEqual({ LD_LIBRARY_PATH: '/x' });
    });
});

describe('setupCommand', () => {
    it('runs the PowerShell script on Windows and the bash one elsewhere, with the same options', () => {
        expect(setupCommand('stt', ['--gpu', '--moonshine'], 'win32')).toEqual({
            command: 'powershell',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\\setup-stt.ps1', '--gpu', '--moonshine'],
        });
        expect(setupCommand('stt', ['--moonshine'], 'linux')).toEqual({ command: 'bash', args: ['scripts/setup-stt.sh', '--moonshine'] });
        expect(setupCommand('voice', [], 'darwin')).toEqual({ command: 'bash', args: ['scripts/setup-voice.sh'] });
        expect(setupCommand('voice', [], 'win32').args).toContain('scripts\\setup-voice.ps1');
    });
});
