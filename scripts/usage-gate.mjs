#!/usr/bin/env node
/**
 * usage-gate.mjs — claw-hwp automation usage gate.
 *
 * Reads local Claude usage via ccusage (COST-based — raw token totals are inflated
 * by cache reads, so cost tracks the /usage % linearly), computes % vs plan limits,
 * optionally sums a peer machine's usage over SSH, applies the gate policy, prints a
 * decision JSON.  OS-agnostic: NO hardcoded absolute paths — machine-specific values
 * come from a gitignored config.local.json (see config.example.json) + env.
 * Calibrated 2026-06-01: 5h ≈ $28, 7d ≈ $400 (see ../handoff/AUTOMATION_DESIGN.md §5).
 *
 * Modes:
 *   (default)  print full gate decision  { gate: go|pause|stop, reason, ... }
 *   --report   print only this machine's { cost5hUSD, cost7dUSD }  (peer calls this over SSH)
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv.includes('--report') ? 'report' : 'gate';

const deepMerge = (a, b) => {
  const out = { ...a };
  for (const k of Object.keys(b || {})) {
    out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])
      ? deepMerge(a[k] || {}, b[k]) : b[k];
  }
  return out;
};
const cfg = (() => {
  const ex = JSON.parse(readFileSync(join(repoRoot, 'config.example.json'), 'utf8'));
  const lp = process.env.CLAW_AUTOMATION_CONFIG || join(repoRoot, 'config.local.json');
  return deepMerge(ex, existsSync(lp) ? JSON.parse(readFileSync(lp, 'utf8')) : {});
})();
const resolve = p => (!p ? p : isAbsolute(p) ? p : join(repoRoot, p));
const hhmm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

const ccEnv = () => ({
  ...process.env,
  CLAUDE_CONFIG_DIR: cfg.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
});
const ccusage = argStr =>
  JSON.parse(execSync(`npx -y ccusage@latest ${argStr}`, { encoding: 'utf8', env: ccEnv(), stdio: ['ignore', 'pipe', 'ignore'] }));
const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// minutes-of-day in a tz for a given Date (default now)
const tzMin = (tz, when = new Date()) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
      .formatToParts(when).map(x => [x.type, x.value]));
  return (+p.hour % 24) * 60 + +p.minute;
};

function localUsage() {
  let cost5hUSD = 0, blockEndTime = null;
  try {
    const b = ccusage('blocks --active --json').blocks?.[0];
    if (b && b.isActive) { cost5hUSD = b.costUSD || 0; blockEndTime = b.endTime || null; }
  } catch { /* no active block / ccusage unavailable */ }
  let cost7dUSD = 0;
  try {
    const days = ccusage(`daily --json --since ${ymd(new Date(Date.now() - 7 * 864e5))}`).daily || [];
    cost7dUSD = days.reduce((s, d) => s + (d.totalCost || 0), 0);
  } catch { /* ignore */ }
  return { cost5hUSD: +cost5hUSD.toFixed(4), cost7dUSD: +cost7dUSD.toFixed(4), blockEndTime };
}

function peerUsage() {
  if (!cfg.peer?.enabled) return { ok: false, reason: 'disabled', cost5hUSD: 0, cost7dUSD: 0 };
  try {
    const out = execSync(`ssh ${cfg.peer.sshHost} "node ${cfg.peer.remoteRepoPath}/scripts/usage-gate.mjs --report"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    const j = JSON.parse(out);
    return { ok: true, cost5hUSD: j.cost5hUSD || 0, cost7dUSD: j.cost7dUSD || 0 };
  } catch {
    // conservative: assume peer is consuming its share of the 5h budget
    return { ok: false, reason: 'unreachable', cost5hUSD: cfg.plan.limit5hUSD * cfg.gate.workCapPct, cost7dUSD: 0 };
  }
}

function readControl() {
  const p = resolve(cfg.controlFile);
  if (!p || !existsSync(p)) return { mode: 'auto' };
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    if (c.until && Date.now() > Date.parse(c.until)) return { mode: 'auto', expired: true };
    return c;
  } catch { return { mode: 'auto' }; }
}

function decide() {
  const stop = resolve(cfg.stopFlag);
  if (stop && existsSync(stop)) return { gate: 'stop', reason: 'STOP flag present' };

  const local = localUsage();
  const peer = peerUsage();
  const cost5h = local.cost5hUSD + peer.cost5hUSD;
  const cost7d = local.cost7dUSD + peer.cost7dUSD;
  const pct5h = cost5h / cfg.plan.limit5hUSD;
  const pct7d = cost7d / cfg.plan.limit7dUSD;
  const ctl = readControl();
  const base = {
    combined5hUSD: +cost5h.toFixed(2), pct5h: +pct5h.toFixed(3),
    combined7dUSD: +cost7d.toFixed(2), pct7d: +pct7d.toFixed(3),
    mode: ctl.mode, peerOk: peer.ok,
    local: { cost5hUSD: local.cost5hUSD, cost7dUSD: local.cost7dUSD },
    peer: { cost5hUSD: peer.cost5hUSD, cost7dUSD: peer.cost7dUSD, ok: peer.ok },
  };

  if (pct7d >= cfg.gate.weeklyStopPct)
    return { gate: 'stop', reason: `weekly ${(pct7d * 100).toFixed(0)}% ≥ ${cfg.gate.weeklyStopPct * 100}% hard-stop`, ...base };
  if (ctl.mode === 'stop') return { gate: 'stop', reason: 'control mode=stop', ...base };

  let cap, why;
  if (ctl.mode === 'full') { cap = 1.0; why = 'mode=full (user override)'; }
  else {
    const resetsBy = local.blockEndTime
      ? tzMin(cfg.gate.tz, new Date(local.blockEndTime)) <= hhmm(cfg.gate.resetByHHMM) : false;
    const now = tzMin(cfg.gate.tz);
    const inWork = now >= hhmm(cfg.gate.workStartHHMM) && now < hhmm(cfg.gate.workEndHHMM);
    if (resetsBy) { cap = 1.0; why = `block resets by ${cfg.gate.resetByHHMM}`; }
    else if (inWork) { cap = cfg.gate.workCapPct; why = `work hours, ${cfg.gate.workCapPct * 100}% cap`; }
    else { cap = 1.0; why = 'overnight'; }
  }
  const gate = pct5h < cap ? 'go' : 'pause';
  return { gate, reason: `5h ${(pct5h * 100).toFixed(0)}% vs cap ${(cap * 100).toFixed(0)}% — ${why}`, cap, ...base };
}

const result = MODE === 'report' ? (() => { const u = localUsage(); return { cost5hUSD: u.cost5hUSD, cost7dUSD: u.cost7dUSD }; })() : decide();
process.stdout.write(JSON.stringify(result, MODE === 'report' ? undefined : null, MODE === 'report' ? 0 : 2) + '\n');
