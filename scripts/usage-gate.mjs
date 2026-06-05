#!/usr/bin/env node
/**
 * usage-gate.mjs — claw-hwp automation usage gate (v2: OAuth usage endpoint).
 *
 * Reads ACCOUNT-WIDE usage % straight from Anthropic's OAuth usage endpoint
 * (`/api/oauth/usage`) — the exact data behind Claude Code's `/usage`. Because it
 * is server-side, it already includes EVERY machine + every concurrent session,
 * so there is no per-machine blind spot and no $→% calibration to drift.
 *
 *   Old (v1, removed): ccusage local cost ($) + SSH peer-sum + $ plan limits.
 *   Why replaced: ccusage reads only THIS machine's JSONL, so it under-counted
 *   cross-machine usage (5h read ~1% while /usage was 15%), and the $→% mapping
 *   drifted with cache-read pricing / model mix (7d read 57% while /usage was 31%).
 *   The OAuth endpoint matched /usage exactly (5h/7d % AND reset times). See
 *   ../handoff/AUTOMATION_DESIGN.md §5.
 *
 * OS-agnostic. NO hardcoded absolute paths: the OAuth token comes from
 *   - $CLAUDE_CONFIG_DIR/.credentials.json   (Windows / Linux), or
 *   - macOS login Keychain ("Claude Code-credentials")  (darwin),
 *   - or an explicit `credentialsFile` / `credentialsCommand` in config.local.json.
 * All other machine-specific values live in gitignored config.local.json.
 *
 * Modes:
 *   (default)  print full gate decision  { gate: go|pause|stop, reason, ... }
 *   --report   print only raw utilization { util5h, util7d }  (debug)
 */
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
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
const configDir = cfg.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// minutes-of-day in a tz for a given Date (default now)
const tzMin = (tz, when = new Date()) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
      .formatToParts(when).map(x => [x.type, x.value]));
  return (+p.hour % 24) * 60 + +p.minute;
};

// --- OAuth token discovery (OS-agnostic, no absolute paths in committed code) ---
function accessToken() {
  const fromJson = s => JSON.parse(s)?.claudeAiOauth?.accessToken;
  // 1) explicit command escape hatch (e.g. a secrets manager)
  if (cfg.credentialsCommand) {
    const out = execSync(cfg.credentialsCommand, { encoding: 'utf8' }).trim();
    return out.startsWith('{') ? fromJson(out) : out;
  }
  // 2) explicit file, or the standard per-config-dir credentials file (Win/Linux)
  const f = cfg.credentialsFile ? resolve(cfg.credentialsFile) : join(configDir, '.credentials.json');
  if (existsSync(f)) return fromJson(readFileSync(f, 'utf8'));
  // 3) macOS Keychain (Claude Code stores creds here, not in a file)
  if (platform() === 'darwin') {
    const out = execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8' }).trim();
    return fromJson(out);
  }
  throw new Error(`no Claude credentials found (looked in ${f}${platform() === 'darwin' ? ' + Keychain' : ''})`);
}

// claude-code/<version> User-Agent is REQUIRED — without it the endpoint uses an
// aggressively rate-limited bucket and returns persistent 429s.
function userAgent() {
  try {
    const v = (execSync('claude --version', { encoding: 'utf8' }).match(/[0-9]+\.[0-9]+\.[0-9]+/) || [])[0];
    if (v) return `claude-code/${v}`;
  } catch { /* fall through */ }
  return 'claude-code/2.0.0';
}

async function fetchUsage() {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': userAgent(),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`usage endpoint HTTP ${res.status} (token expired? run any claude command to refresh)`);
  return res.json();
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

async function decide() {
  const stop = resolve(cfg.stopFlag);
  if (stop && existsSync(stop)) return { gate: 'stop', reason: 'STOP flag present' };

  let u;
  try { u = await fetchUsage(); }
  catch (e) {
    // fail-safe: if usage can't be read, PAUSE (conservative) rather than blindly go
    return { gate: 'pause', reason: `usage fetch failed — fail-safe pause: ${e.message}`, error: String(e.message) };
  }

  const util5h = u.five_hour?.utilization ?? 0;
  const util7d = u.seven_day?.utilization ?? 0;
  const pct5h = util5h / 100;
  const pct7d = util7d / 100;
  const reset5h = u.five_hour?.resets_at || null;
  const ctl = readControl();
  const base = {
    pct5h: +pct5h.toFixed(3), pct7d: +pct7d.toFixed(3),
    util5h, util7d, reset5h, reset7d: u.seven_day?.resets_at || null,
    sonnet7d: u.seven_day_sonnet?.utilization ?? null,
    extraUsage: u.extra_usage?.is_enabled ? (u.extra_usage.utilization ?? null) : null,
    mode: ctl.mode,
  };

  if (pct7d >= cfg.gate.weeklyStopPct)
    return { gate: 'stop', reason: `weekly ${util7d.toFixed(0)}% ≥ ${cfg.gate.weeklyStopPct * 100}% hard-stop`, ...base };
  if (ctl.mode === 'stop') return { gate: 'stop', reason: 'control mode=stop', ...base };

  let cap, why;
  if (ctl.mode === 'full') { cap = 1.0; why = 'mode=full (user override)'; }
  else {
    const resetsBy = reset5h ? tzMin(cfg.gate.tz, new Date(reset5h)) <= hhmm(cfg.gate.resetByHHMM) : false;
    const now = tzMin(cfg.gate.tz);
    const inWork = now >= hhmm(cfg.gate.workStartHHMM) && now < hhmm(cfg.gate.workEndHHMM);
    if (resetsBy) { cap = 1.0; why = `block resets by ${cfg.gate.resetByHHMM}`; }
    else if (inWork) { cap = cfg.gate.workCapPct; why = `work hours, ${cfg.gate.workCapPct * 100}% cap`; }
    else { cap = 1.0; why = 'overnight'; }
  }
  const gate = pct5h < cap ? 'go' : 'pause';
  return { gate, reason: `5h ${util5h.toFixed(0)}% vs cap ${(cap * 100).toFixed(0)}% — ${why}`, cap, ...base };
}

const result = MODE === 'report'
  ? await (async () => { const u = await fetchUsage(); return { util5h: u.five_hour?.utilization ?? 0, util7d: u.seven_day?.utilization ?? 0 }; })()
  : await decide();
process.stdout.write(JSON.stringify(result, null, MODE === 'report' ? 0 : 2) + '\n');
