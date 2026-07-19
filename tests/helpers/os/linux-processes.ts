import { execFileSync } from 'node:child_process';

// lsof's -F (field) output format: each open-file record is a run of single-
// letter-prefixed lines — 'p<pid>' starts a new process, 'c<command>' names
// it. Requesting only the p/c fields keeps parsing to just those two prefixes.
const PID_FIELD = /^p(\d+)/;
const COMMAND_FIELD = /^c(.+)/;

/** Best-effort: returns [] if lsof isn't installed or nothing has dir open, rather than failing the caller. */
export function findLockingPids(dir: string): Array<{ name: string; pid: number }> {
  try {
    const output = execFileSync('lsof', ['-Fpc', '+D', dir], { encoding: 'utf-8' });
    const holders: Array<{ name: string; pid: number }> = [];
    let pid: number | undefined;
    for (const line of output.split('\n')) {
      const pidMatch = line.match(PID_FIELD);
      if (pidMatch) {
        pid = Number(pidMatch[1]);
        continue;
      }
      const commandMatch = line.match(COMMAND_FIELD);
      if (commandMatch && pid !== undefined) {
        holders.push({ name: commandMatch[1], pid });
      }
    }
    return holders;
  } catch {
    // lsof not installed, or exits non-zero when nothing under dir is open — same "no holders" outcome either way
    return [];
  }
}

/** Best-effort: swallows failure (already exited, or not ours to kill) — caller just moves on. */
export function killProcess(pid: number): void {
  try {
    execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
  } catch {
    // already exited, or not ours to kill
  }
}
