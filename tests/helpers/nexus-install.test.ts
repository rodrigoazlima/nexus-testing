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

// Point NEXUS_PATH/VAULT_PATH at scratch dirs before nexus-install.ts (and
// the config.ts it imports) ever evaluates its module-level consts.
const NEXUS_PATH_ENV = path.join(os.tmpdir(), `nexus-install-test-${process.pid}`);
const VAULT_PATH_ENV = path.join(os.tmpdir(), `nexus-install-test-vault-${process.pid}`);
process.env.NEXUS_PATH = NEXUS_PATH_ENV;
process.env.VAULT_PATH = VAULT_PATH_ENV;

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
  if (fs.existsSync(nexusInstall.NEXUS_PATH)) {
    fs.rmSync(nexusInstall.NEXUS_PATH, { recursive: true, force: true });
  }
});

after(() => {
  childProcessCjs.execFileSync = originalExecFileSync;
});

// Records every execFileSync call instead of actually running anything.
// `onCall` can throw per-call to simulate a failing command (e.g. `net
// session` when not elevated).
function mockExec(calls: ExecCall[], onCall?: (call: ExecCall) => void): void {
  childProcessCjs.execFileSync = ((
    cmd: string,
    args: string[],
    options?: Record<string, unknown>
  ) => {
    const call = { cmd, args, options };
    calls.push(call);
    onCall?.(call);
    return Buffer.from('');
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

describe('installFresh', () => {
  test('clones, trusts the dir, elevation-checks, then runs -CleanInstall with -VaultRoot over stdin', () => {
    writeFakeRegistry(); // clone is mocked, so seed what it would have produced
    const calls: ExecCall[] = [];
    mockExec(calls);

    nexusInstall.installFresh();

    assert.equal(calls.length, 4);
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
    assert.deepEqual(calls[3], {
      cmd: 'pwsh',
      args: ['-File', nexusInstall.SETUP_SCRIPT, '-CleanInstall', '-VaultRoot', VAULT_PATH_ENV],
      options: { stdio: ['pipe', 'inherit', 'inherit'], input: 'yes\n' },
    });
  });

  test('clones and trusts the dir before failing fast on elevation, never reaching -CleanInstall', () => {
    writeFakeRegistry();
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
});

describe('overrideAgentSchedules', () => {
  test('rewrites agent intervals to 300s, repair to 1500s, cleanup to 1560s, leaving runtime alone', () => {
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
    assert.deepEqual(intervals, { runtime: 60, repair: 1500, vision: 300, cleanup: 1560 });
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
