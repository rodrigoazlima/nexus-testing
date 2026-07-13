// Detached system-usage sampler — started by global-setup, killed by
// global-teardown (see tests/helpers/profile.ts). Appends one JSON line per
// sample; killing it mid-append at worst truncates the final line, which the
// report reader skips.
import fs from 'node:fs';
import path from 'node:path';
import si from 'systeminformation';

const [outPath, intervalArg] = process.argv.slice(2);
const intervalMs = Number(intervalArg ?? 5_000);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

async function sample(): Promise<void> {
  const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);
  fs.appendFileSync(
    outPath,
    `${JSON.stringify({
      ts: Date.now(),
      cpu: Number(load.currentLoad.toFixed(1)),
      memUsed: mem.active,
      memTotal: mem.total,
    })}\n`
  );
}

void sample().catch(() => {});
setInterval(() => void sample().catch(() => {}), intervalMs);
