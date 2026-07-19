import * as linuxProcesses from './linux-processes';
import * as windowsProcesses from './windows-processes';

// Directory-lock inspection/kill is the one piece of dir-lock-cleanup.ts with
// a genuine Linux equivalent (handle64.exe/taskkill -> lsof/kill) — pick the
// implementation once at load time rather than branching at every call site.
const impl = process.platform === 'win32' ? windowsProcesses : linuxProcesses;

export const findLockingPids = impl.findLockingPids;
export const killProcess = impl.killProcess;
