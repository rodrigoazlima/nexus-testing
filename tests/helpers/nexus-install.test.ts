// Unit tests for nexus-install.ts's setup-service.ps1 invocation logic —
// verifies the exact arguments/stdin sent to git and setup-service.ps1
// without actually cloning, installing a service, or requiring elevation.
// Run with: npm run test:unit (node's built-in test runner via tsx, not
// Playwright — this must never trigger a real install).
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// require(), not import: node:child_process's ESM named exports are
// non-configurable live-binding getters that mock.method can't patch, but
// they read through to this same CJS exports object — mutating a property
// here is what nexus-install.ts's `import { execFileSync }` actually sees.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessCjs = require('node:child_process') as typeof import('node:child_process');
const originalExecFileSync = childProcessCjs.execFileSync;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

// dotenv/config is preloaded by npm run test:unit so NEXUS_BRANCH comes from
// the repository .env. Point NEXUS_PATH/VAULT_PATH at scratch dirs before
// nexus-install.ts (and the config.ts it imports) evaluates module-level
// consts, keeping the unit suite isolated from the real install and vault.
const NEXUS_PATH_ENV = path.join(os.tmpdir(), `nexus-install-test-${process.pid}`);
const VAULT_PATH_ENV = path.join(os.tmpdir(), `nexus-install-test-vault-${process.pid}`);
process.env.NEXUS_PATH = NEXUS_PATH_ENV;
process.env.VAULT_PATH = VAULT_PATH_ENV;

// installFresh() warns (does not throw) when this is unset (see
// warnIfServicePasswordMissing) — isolate tests from whatever the repo's own
// .env does or doesn't set.
const ORIGINAL_SERVICE_PASSWORD = process.env.NEXUS_SERVICE_PASSWORD;
const ORIGINAL_SERVICE_USERNAME = process.env.NEXUS_SERVICE_USERNAME;

interface ExecCall {
  cmd: string;
  args: string[];
  options?: Record<string, unknown>;
}

let nexusInstall: typeof import('./nexus-install');

before(async () => {
  nexusInstall = await import('./nexus-install');
});

afterEach(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  if (ORIGINAL_SERVICE_PASSWORD === undefined) {
    delete process.env.NEXUS_SERVICE_PASSWORD;
  } else {
    process.env.NEXUS_SERVICE_PASSWORD = ORIGINAL_SERVICE_PASSWORD;
  }
  if (ORIGINAL_SERVICE_USERNAME === undefined) {
    delete process.env.NEXUS_SERVICE_USERNAME;
  } else {
    process.env.NEXUS_SERVICE_USERNAME = ORIGINAL_SERVICE_USERNAME;
  }
  if (fs.existsSync(nexusInstall.NEXUS_PATH)) {
    fs.rmSync(nexusInstall.NEXUS_PATH, { recursive: true, force: true });
  }
});

after(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
});

// Records every execFileSync call instead of actually running anything.
// `onCall` can throw per-call to simulate a failing command (e.g. `net
// session` when not elevated), or return a string/Buffer to stand in for the
// real command's stdout (e.g. `where python`'s resolved path) — anything
// falsy falls back to an empty Buffer, matching a command that printed
// nothing.
function mockExec(calls: ExecCall[], onCall?: (call: ExecCall) => void | string | Buffer): void {
  childProcessCjs.execFileSync = ((
    cmd: string,
    args: string[],
    options?: Record<string, unknown>
  ) => {
    const call = { cmd, args, options };
    calls.push(call);
    const result = onCall?.(call);
    return result ?? Buffer.from('');
  }) as unknown as typeof originalExecFileSync;
}

function writeFakeSetupScript(): void {
  fs.mkdirSync(path.dirname(nexusInstall.SETUP_SCRIPT), { recursive: true });
  fs.writeFileSync(nexusInstall.SETUP_SCRIPT, '# fake setup-service.ps1 for tests\n');
}

// Trimmed copy of the real registry.yaml shapes overrideAgentSchedules must
// handle: the runtime exception, override exceptions, a plain agent, and a
// non-agent two-space map with a *_seconds key that must survive untouched.
const FAKE_REGISTRY = `version: 1

llm_endpoints:
  vision_llm:
    url: "http://localhost:1234/v1/chat/completions"
    timeout_seconds: 120

agents:
  runtime:
    status: active
    interval_seconds: 60

  repair:
    status: active
    interval_seconds: 86400

  vision:
    status: active
    interval_seconds: 900

  cleanup:
    status: active
    interval_seconds: 86400
`;

function writeFakeRegistry(): void {
  fs.mkdirSync(path.dirname(nexusInstall.REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(nexusInstall.REGISTRY_PATH, FAKE_REGISTRY);
}

describe('clearInstall', () => {
  test('is a no-op when NEXUS_PATH does not exist', () => {
    const calls: ExecCall[] = [];
    mockExec(calls);

    assert.doesNotThrow(() => nexusInstall.clearInstall());
    assert.equal(calls.length, 0);
  });

  test('checks elevation then runs setup-service.ps1 -Uninstall when the service is installed', () => {
    writeFakeSetupScript();
    const calls: ExecCall[] = [];
    mockExec(calls);

    nexusInstall.clearInstall();

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { cmd: 'net', args: ['session'], options: { stdio: 'ignore' } });
    assert.deepEqual(calls[1], {
      cmd: 'pwsh',
      args: ['-File', nexusInstall.SETUP_SCRIPT, '-Uninstall'],
      options: { stdio: 'inherit' },
    });
    assert.equal(fs.existsSync(nexusInstall.NEXUS_PATH), false);
  });

  test('throws a clear elevation error and never calls -Uninstall when not elevated', () => {
    writeFakeSetupScript();
    const calls: ExecCall[] = [];
    mockExec(calls, (call) => {
      if (call.cmd === 'net') throw new Error('not elevated');
    });

    assert.throws(() => nexusInstall.clearInstall(), /elevated shell/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'net');
    // Threw before reaching the rmSync branch — codebase dir survives.
    assert.equal(fs.existsSync(nexusInstall.NEXUS_PATH), true);
  });
});

describe('assertSandboxRuntimeAvailable', () => {
  test('succeeds on `podman info` without trying docker or retrying', async () => {
    const calls: ExecCall[] = [];
    mockExec(calls);

    await assert.doesNotReject(() => nexusInstall.assertSandboxRuntimeAvailable({ delayMs: 5 }));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { cmd: 'podman', args: ['info'], options: { stdio: 'ignore' } });
  });

  test('falls back to `docker info` when podman fails', async () => {
    const calls: ExecCall[] = [];
    mockExec(calls, (call) => {
      if (call.cmd === 'podman') throw new Error('podman info failed (exit 125)');
    });

    await assert.doesNotReject(() => nexusInstall.assertSandboxRuntimeAvailable({ delayMs: 5 }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].cmd, 'podman');
    assert.equal(calls[1].cmd, 'docker');
  });

  test('throws a clear error naming the attempt count when neither runtime is ever reachable', async () => {
    const calls: ExecCall[] = [];
    mockExec(calls, () => {
      throw new Error('not reachable');
    });

    await assert.rejects(
      () => nexusInstall.assertSandboxRuntimeAvailable({ attempts: 2, delayMs: 5 }),
      /No working container runtime found after 2 attempts/
    );
    // 2 attempts x 2 candidates (podman, docker) each.
    assert.equal(calls.length, 4);
  });

  // The scenario reported live: podman machine mid-boot (`podman machine
  // start` just run) — `podman info` fails on the first attempt, then
  // succeeds once the WSL VM finishes coming up a moment later. A
  // single-shot check would wrongly hard-fail the whole run over this.
  test('recovers from a flapping runtime — fails once, then succeeds on a later attempt', async () => {
    const calls: ExecCall[] = [];
    let podmanCallCount = 0;
    mockExec(calls, (call) => {
      if (call.cmd === 'podman') {
        podmanCallCount++;
        if (podmanCallCount < 3) throw new Error('podman info failed (exit 125): Cannot connect to Podman');
      }
      if (call.cmd === 'docker') throw new Error('docker not installed');
    });

    await assert.doesNotReject(() => nexusInstall.assertSandboxRuntimeAvailable({ attempts: 5, delayMs: 5 }));
    assert.equal(podmanCallCount, 3);
  });
});

describe('installFresh', () => {
  test('clones, trusts the dir, elevation-checks, password-checks, resolves python, then runs -CleanInstall with -VaultRoot over stdin (no -ServiceAccount/-Python when unresolved)', () => {
    writeFakeRegistry(); // clone is mocked, so seed what it would have produced
    process.env.NEXUS_SERVICE_PASSWORD = 'test-password';
    delete process.env.NEXUS_SERVICE_USERNAME; // explicit, not just relying on afterEach from a prior test
    const calls: ExecCall[] = [];
    mockExec(calls); // `where python` returns nothing (default empty buffer) -> no -Python arg

    nexusInstall.installFresh();

    assert.equal(calls.length, 5);
    assert.deepEqual(calls[0], {
      cmd: 'git',
      args: [
        'clone',
        '--branch',
        nexusInstall.BRANCH,
        nexusInstall.REPO_URL,
        nexusInstall.NEXUS_PATH,
      ],
      options: { stdio: 'inherit' },
    });
    assert.deepEqual(calls[1], {
      cmd: 'git',
      args: [
        'config',
        '--global',
        '--add',
        'safe.directory',
        nexusInstall.NEXUS_PATH.replace(/\\/g, '/'),
      ],
      options: { stdio: 'inherit' },
    });
    assert.deepEqual(calls[2], { cmd: 'net', args: ['session'], options: { stdio: 'ignore' } });
    assert.deepEqual(calls[3], { cmd: 'where', args: ['python'], options: {} });
    assert.deepEqual(calls[4], {
      cmd: 'pwsh',
      args: ['-File', nexusInstall.SETUP_SCRIPT, '-CleanInstall', '-VaultRoot', VAULT_PATH_ENV],
      options: { stdio: ['pipe', 'inherit', 'inherit'], input: 'yes\n' },
    });
  });

  test('passes -ServiceAccount <NEXUS_SERVICE_USERNAME> when set (the default-account case is covered above)', () => {
    writeFakeRegistry();
    process.env.NEXUS_SERVICE_PASSWORD = 'test-password';
    process.env.NEXUS_SERVICE_USERNAME = 'OTHERDOMAIN\\otheruser';
    const calls: ExecCall[] = [];
    mockExec(calls);

    nexusInstall.installFresh();

    assert.deepEqual(calls[4], {
      cmd: 'pwsh',
      args: [
        '-File',
        nexusInstall.SETUP_SCRIPT,
        '-CleanInstall',
        '-VaultRoot',
        VAULT_PATH_ENV,
        '-ServiceAccount',
        'OTHERDOMAIN\\otheruser',
      ],
      options: { stdio: ['pipe', 'inherit', 'inherit'], input: 'yes\n' },
    });
  });

  // Regression test for a live 2026-07-20 failure: setup-service.ps1 hands
  // NSSM the bare literal "python", which Windows resolves at *service*
  // launch time under the service-logon session — a session that doesn't
  // inherit the interactive shell's PATH. `where python` here (still in the
  // working interactive shell) resolves the absolute path up front so NSSM
  // never has to do that PATH lookup itself.
  test('resolves and passes -Python <absolute path> when `where python` succeeds', () => {
    writeFakeRegistry();
    process.env.NEXUS_SERVICE_PASSWORD = 'test-password';
    delete process.env.NEXUS_SERVICE_USERNAME;
    const calls: ExecCall[] = [];
    mockExec(calls, (call) => {
      if (call.cmd === 'where') return 'C:\\Python311\\python.exe\r\n';
    });

    nexusInstall.installFresh();

    assert.deepEqual(calls[4], {
      cmd: 'pwsh',
      args: [
        '-File',
        nexusInstall.SETUP_SCRIPT,
        '-CleanInstall',
        '-VaultRoot',
        VAULT_PATH_ENV,
        '-Python',
        'C:\\Python311\\python.exe',
      ],
      options: { stdio: ['pipe', 'inherit', 'inherit'], input: 'yes\n' },
    });
  });

  test('omits -Python when `where python` fails (not installed / not on PATH)', () => {
    writeFakeRegistry();
    process.env.NEXUS_SERVICE_PASSWORD = 'test-password';
    delete process.env.NEXUS_SERVICE_USERNAME;
    const calls: ExecCall[] = [];
    mockExec(calls, (call) => {
      if (call.cmd === 'where') throw new Error('INFO: Could not find files for the given pattern(s).');
    });

    assert.doesNotThrow(() => nexusInstall.installFresh());

    assert.deepEqual(calls[4], {
      cmd: 'pwsh',
      args: ['-File', nexusInstall.SETUP_SCRIPT, '-CleanInstall', '-VaultRoot', VAULT_PATH_ENV],
      options: { stdio: ['pipe', 'inherit', 'inherit'], input: 'yes\n' },
    });
  });

  test('clones and trusts the dir before failing fast on elevation, never reaching -CleanInstall', () => {
    writeFakeRegistry();
    process.env.NEXUS_SERVICE_PASSWORD = 'test-password';
    const calls: ExecCall[] = [];
    mockExec(calls, (call) => {
      if (call.cmd === 'net') throw new Error('not elevated');
    });

    assert.throws(() => nexusInstall.installFresh(), /elevated shell/);
    assert.deepEqual(
      calls.map((c) => c.cmd),
      ['git', 'git', 'net']
    );
  });

  // Regression test for a live 2026-07-20 failure: setup-service.ps1's own
  // "no password -> run as LocalSystem" fallback is unreachable in our
  // invocation shape (confirmed live: its Read-Host prompt DID fire, proving
  // [Environment]::UserInteractive is true even with our piped stdin) — any
  // non-null SecureString it gets back, including an empty one from the
  // already-closed pipe, is truthy, so it always takes the "set ObjectName
  // with this password" branch instead. So this warns (not throws) and lets
  // the install proceed, on the understanding that it will very likely still
  // hit that same logon failure rather than a clean LocalSystem install.
  test('warns naming the invoking user (COMPUTERNAME\\USERNAME) but still completes the install when NEXUS_SERVICE_PASSWORD and NEXUS_SERVICE_USERNAME are both unset', () => {
    writeFakeRegistry();
    delete process.env.NEXUS_SERVICE_PASSWORD;
    delete process.env.NEXUS_SERVICE_USERNAME;
    const calls: ExecCall[] = [];
    mockExec(calls);
    const warnings: string[] = [];
    console.warn = (msg?: unknown) => void warnings.push(String(msg));

    assert.doesNotThrow(() => nexusInstall.installFresh());

    assert.equal(calls.length, 5);
    assert.equal(calls[4].cmd, 'pwsh');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /NEXUS_SERVICE_PASSWORD is not set/);
    assert.match(warnings[0], new RegExp(`${process.env.COMPUTERNAME}\\\\${process.env.USERNAME}`));
  });

  test('warns naming the NEXUS_SERVICE_USERNAME override (not the invoking user) when password is unset but a username override is set', () => {
    writeFakeRegistry();
    delete process.env.NEXUS_SERVICE_PASSWORD;
    process.env.NEXUS_SERVICE_USERNAME = 'OTHERDOMAIN\\otheruser';
    const calls: ExecCall[] = [];
    mockExec(calls);
    const warnings: string[] = [];
    console.warn = (msg?: unknown) => void warnings.push(String(msg));

    assert.doesNotThrow(() => nexusInstall.installFresh());

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /OTHERDOMAIN\\otheruser/);
  });
});

describe('overrideAgentSchedules', () => {
  test('rewrites agent intervals to vision 90s, repair 1500s, cleanup 1560s, leaving runtime alone', () => {
    writeFakeRegistry();

    nexusInstall.overrideAgentSchedules();

    const rewritten = fs.readFileSync(nexusInstall.REGISTRY_PATH, 'utf-8');
    const intervals: Record<string, number> = {};
    let agent = '';
    for (const line of rewritten.split('\n')) {
      const key = line.match(/^  ([\w-]+):\s*$/);
      if (key) agent = key[1];
      const m = line.match(/^\s+interval_seconds: (\d+)\s*$/);
      if (m) intervals[agent] = Number(m[1]);
    }
    assert.deepEqual(intervals, { runtime: 60, repair: 1500, vision: 90, cleanup: 1560 });
    // Non-interval *_seconds keys outside agents: must survive untouched.
    assert.match(rewritten, /timeout_seconds: 120/);
  });
});

describe('warnIfEnvLocalMissing', () => {
  test('warns when no .env.local exists anywhere under NEXUS_PATH', () => {
    fs.mkdirSync(nexusInstall.NEXUS_PATH, { recursive: true });
    const warnings: string[] = [];
    console.warn = (msg?: unknown) => void warnings.push(String(msg));

    nexusInstall.warnIfEnvLocalMissing();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WARNING/);
    assert.ok(warnings[0].includes(nexusInstall.NEXUS_PATH));
  });

  test('logs a found count and does not warn when .env.local files exist', () => {
    fs.mkdirSync(path.join(nexusInstall.NEXUS_PATH, 'dashboard'), { recursive: true });
    fs.mkdirSync(path.join(nexusInstall.NEXUS_PATH, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(nexusInstall.NEXUS_PATH, 'dashboard', '.env.local'), '');
    fs.writeFileSync(path.join(nexusInstall.NEXUS_PATH, 'agents', '.env.local'), '');

    const warnings: string[] = [];
    const logs: string[] = [];
    console.warn = (msg?: unknown) => void warnings.push(String(msg));
    console.log = (msg?: unknown) => void logs.push(String(msg));

    nexusInstall.warnIfEnvLocalMissing();

    assert.equal(warnings.length, 0);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes('found 2 .env.local file(s)'));
  });

  test('treats .env.local under node_modules/.git as missing', () => {
    fs.mkdirSync(path.join(nexusInstall.NEXUS_PATH, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(nexusInstall.NEXUS_PATH, '.git'), { recursive: true });
    fs.writeFileSync(path.join(nexusInstall.NEXUS_PATH, 'node_modules', '.env.local'), '');
    fs.writeFileSync(path.join(nexusInstall.NEXUS_PATH, '.git', '.env.local'), '');

    const warnings: string[] = [];
    console.warn = (msg?: unknown) => void warnings.push(String(msg));

    nexusInstall.warnIfEnvLocalMissing();

    assert.equal(warnings.length, 1);
  });
});
