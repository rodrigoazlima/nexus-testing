import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config';

// Whole-run resource profiling. A detached sampler process (started by
// global-setup before anything else, killed by global-teardown after
// uninstall) appends system CPU/memory samples to samples.jsonl, so the
// capture spans the full lifecycle: pre-install baseline, install, every
// test, and uninstall. Phase boundaries land in markers.jsonl — global
// setup/teardown write the install/uninstall ones, scripts/profile-reporter.ts
// writes one pair per test. buildReport() joins the two by timestamp.
export const PROFILE_DIR = process.env.PROFILE_DIR ?? path.join(ROOT_DIR, 'tmp', 'profile');
const SAMPLES_PATH = path.join(PROFILE_DIR, 'samples.jsonl');
const MARKERS_PATH = path.join(PROFILE_DIR, 'markers.jsonl');
const PID_PATH = path.join(PROFILE_DIR, 'sampler.pid');
export const REPORT_PATH = process.env.REPORT_PATH ?? path.join(PROFILE_DIR, 'resource-report.html');

export interface Sample {
  ts: number;
  cpu: number; // whole-system load, percent
  memUsed: number; // bytes
  memTotal: number; // bytes
}

export interface Marker {
  ts: number;
  phase: string; // 'baseline' | 'install' | 'uninstall' | 'test:<title>'
  event: 'start' | 'end';
  label?: string;
}

export interface PhaseStat {
  phase: string;
  label?: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  samples: number;
  cpuAvg: number;
  cpuMax: number;
  memAvgGb: number;
  memMaxGb: number;
  concurrent: number; // other tests overlapping this window (0 for non-test phases)
}

export function marker(phase: string, event: 'start' | 'end', label?: string): void {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.appendFileSync(MARKERS_PATH, `${JSON.stringify({ ts: Date.now(), phase, event, label })}\n`);
}

export function startSampler(intervalMs = 5_000): void {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT_DIR, 'scripts', 'profile-sampler.ts'), SAMPLES_PATH, String(intervalMs)],
    { detached: true, stdio: 'ignore', cwd: ROOT_DIR }
  );
  child.unref();
  fs.writeFileSync(PID_PATH, String(child.pid));
}

export function stopSampler(): void {
  try {
    process.kill(Number(fs.readFileSync(PID_PATH, 'utf-8')));
  } catch {
    // sampler already gone (or never started) — report just covers fewer samples
  }
}

function readJsonl<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // killing the sampler mid-append can truncate the last line — skip it
    }
  }
  return out;
}

const avg = (xs: number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1));

export function summarize(samples: Sample[], markers: Marker[]): PhaseStat[] {
  const windows = new Map<string, { start: number; end: number; label?: string }>();
  for (const m of markers) {
    const w = windows.get(m.phase) ?? { start: Infinity, end: -Infinity, label: undefined as string | undefined };
    if (m.event === 'start') w.start = Math.min(w.start, m.ts);
    else {
      w.end = Math.max(w.end, m.ts);
      w.label = m.label ?? w.label;
    }
    windows.set(m.phase, w);
  }
  // Lenient by design: a phase whose end marker never landed (crash, ctrl-c)
  // is closed at the last sample so it still shows up instead of vanishing.
  const lastTs = samples.length > 0 ? samples[samples.length - 1].ts : Date.now();
  const closed = [...windows.entries()].map(([phase, w]) => ({
    phase,
    label: w.label,
    start: w.start === Infinity ? lastTs : w.start,
    end: w.end === -Infinity ? lastTs : w.end,
  }));
  const tests = closed.filter((w) => w.phase.startsWith('test:'));

  return closed
    .map((w) => {
      const inWindow = samples.filter((s) => s.ts >= w.start && s.ts <= w.end);
      const cpu = inWindow.map((s) => s.cpu);
      const mem = inWindow.map((s) => s.memUsed / 2 ** 30);
      // With multiple workers, concurrent tests share the machine — report the
      // overlap count instead of pretending per-test usage is attributable.
      const concurrent = w.phase.startsWith('test:')
        ? tests.filter((o) => o.phase !== w.phase && o.start < w.end && o.end > w.start).length
        : 0;
      return {
        phase: w.phase,
        label: w.label,
        startTs: w.start,
        endTs: w.end,
        durationMs: w.end - w.start,
        samples: inWindow.length,
        cpuAvg: avg(cpu),
        cpuMax: cpu.length === 0 ? 0 : Math.max(...cpu),
        memAvgGb: avg(mem),
        memMaxGb: mem.length === 0 ? 0 : Number(Math.max(...mem).toFixed(1)),
        concurrent,
      };
    })
    .sort((a, b) => a.startTs - b.startTs);
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtMs(ms: number): string {
  if (ms < 90_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 90 * 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function renderHtml(stats: PhaseStat[], samples: Sample[]): string {
  const memTotalGb = samples.length > 0 ? (samples[0].memTotal / 2 ** 30).toFixed(0) : '?';
  const rows = stats
    .map(
      (p) => `<tr>
  <td>${esc(p.phase)}${p.label ? ` <small>(${esc(p.label)})</small>` : ''}</td>
  <td>${new Date(p.startTs).toISOString()}</td>
  <td>${fmtMs(p.durationMs)}</td>
  <td>${p.samples}</td>
  <td>${p.cpuAvg}</td>
  <td>${p.cpuMax}</td>
  <td>${p.memAvgGb}</td>
  <td>${p.memMaxGb}</td>
  <td>${p.concurrent > 0 ? `+${p.concurrent} overlapping` : ''}</td>
</tr>`
    )
    .join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>Resource usage report</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 4px 10px; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  small { color: #666; }
</style>
<h1>Resource usage</h1>
<p>${samples.length} samples · total RAM ${memTotalGb} GB · system-wide CPU/memory via systeminformation.
Overlapping tests (parallel workers) share the machine, so per-test numbers are indicative, not attributed.</p>
<table>
<tr><th>Phase</th><th>Start (UTC)</th><th>Duration</th><th>Samples</th><th>CPU avg %</th><th>CPU max %</th><th>Mem avg GB</th><th>Mem max GB</th><th>Concurrency</th></tr>
${rows}
</table>`;
}

/** Renders tmp/profile/resource-report.html and, if the HTML report folder exists, a copy inside it. */
export function buildReport(): void {
  const samples = readJsonl<Sample>(SAMPLES_PATH);
  const markers = readJsonl<Marker>(MARKERS_PATH);
  if (markers.length === 0) return;
  const html = renderHtml(summarize(samples, markers), samples);
  fs.writeFileSync(REPORT_PATH, html);
  console.log(`[profile] resource usage report: ${REPORT_PATH}`);
  const inPlaywrightReport = path.join(ROOT_DIR, 'playwright-report', 'resource-usage.html');
  if (fs.existsSync(path.dirname(inPlaywrightReport))) {
    fs.copyFileSync(REPORT_PATH, inPlaywrightReport);
    console.log(`[profile] also copied into HTML report folder: ${inPlaywrightReport}`);
  }
}
