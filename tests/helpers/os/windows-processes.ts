import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sysinternals handle64.exe — the only reliable way on Windows to map an open
// file handle inside a directory back to the owning process. Downloaded on
// demand (not vendored) and cached in os.tmpdir() across runs.
const HANDLE_EXE_PATH = path.join(os.tmpdir(), 'nexus-testing-handle64.exe');
const HANDLE_LINE = /^(\S+)\s+pid:\s*(\d+)\s+type:\s*File/;

/** Best-effort: returns [] if handle64.exe can't be fetched or run, rather than failing the caller. */
export function findLockingPids(dir: string): Array<{ name: string; pid: number }> {
  try {
    if (!fs.existsSync(HANDLE_EXE_PATH)) {
      execFileSync('pwsh', [
        '-Command',
        `Invoke-WebRequest -Uri 'https://live.sysinternals.com/handle64.exe' -OutFile '${HANDLE_EXE_PATH}' -UseBasicParsing`,
      ]);
    }
    const output = execFileSync(HANDLE_EXE_PATH, ['-accepteula', '-nobanner', dir], { encoding: 'utf-8' });
    return output
      .split('\n')
      .map((line) => line.match(HANDLE_LINE))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ name: m[1], pid: Number(m[2]) }));
  } catch {
    return [];
  }
}

/** Best-effort: swallows failure (already exited, or protected) — caller just moves on. */
export function killProcess(pid: number): void {
  try {
    execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // already exited, or protected
  }
}
