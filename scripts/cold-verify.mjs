#!/usr/bin/env node
/**
 * cold-verify.mjs — run a COLD-START Claude (B = real-user simulation) against A's LOCAL
 * plugin code, capture its output, run Tier1 structural checks (+ optional Tier2 Hancom
 * capture), print a verdict JSON.
 *
 * WHY: real users always invoke the skill COLD (installed plugin + SKILL.md, no dev context).
 * A fix that only works when the high-context fixer (A) babysits it is NOT a real fix.
 * See ../handoff/AUTOMATION_DESIGN.md §8.
 *
 * HOW B loads A's local fix (the proven recipe — NOT `--add-dir`):
 *   cold-start `claude -p` resolves the skill from the INSTALLED PLUGIN CACHE
 *   (`~/.claude/plugins/cache/claw-hwp/claw-hwp/<version>/`), which holds the *published*
 *   version and does NOT auto-reflect the worktree. So we OVERLAY the worktree's
 *   `skills/hwp` into the cache (backing up the original), run a plain `claude -p`, then
 *   RESTORE the cache. Cold = run B in a fresh temp dir (no dev CLAUDE.md / empty memory
 *   namespace) with normal subscription auth — NOT `--bare`.
 *
 * Usage:
 *   node cold-verify.mjs --request "<natural user ask>" --plugin <worktree>/plugins/claw-hwp \
 *        --format hwpx|hwp [--out <name|path>] [--contains "<text>"] [--tier2] [--keep] [--cache-version 1.5.4]
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, cpSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const REQUEST = arg('request'), PLUGIN = arg('plugin'), FORMAT = (arg('format') || '').toLowerCase();
const OUT = arg('out'), CONTAINS = arg('contains'), TIER2 = !!arg('tier2', false), KEEP = !!arg('keep', false);
const CACHE_VERSION = arg('cache-version');
if (!REQUEST || !PLUGIN || !['hwp', 'hwpx'].includes(FORMAT)) {
  console.error('usage: cold-verify.mjs --request "<ask>" --plugin <worktree>/plugins/claw-hwp --format hwpx|hwp [--out p] [--contains t] [--tier2] [--keep] [--cache-version V]');
  process.exit(2);
}

const deepMerge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? deepMerge(a[k] || {}, b[k]) : b[k]; return o; };
const cfg = (() => {
  const ex = JSON.parse(readFileSync(join(repoRoot, 'config.example.json'), 'utf8'));
  const lp = process.env.CLAW_AUTOMATION_CONFIG || join(repoRoot, 'config.local.json');
  return deepMerge(ex, existsSync(lp) ? JSON.parse(readFileSync(lp, 'utf8')) : {});
})();
const cv = cfg.coldVerify;
const claudeDir = cfg.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// ---- locate the installed plugin cache (published version B resolves the skill from) ----
function cacheSkillsDir() {
  const base = join(claudeDir, 'plugins', 'cache', 'claw-hwp', 'claw-hwp');
  if (!existsSync(base)) throw new Error(`plugin cache not found: ${base} — install claw-hwp so cold-start has a skill to resolve`);
  const versions = readdirSync(base).filter(v => existsSync(join(base, v, 'skills', 'hwp'))).sort();
  const ver = CACHE_VERSION || versions[versions.length - 1];
  if (!ver) throw new Error(`no versioned plugin under ${base}`);
  return join(base, ver, 'skills', 'hwp');
}

// ---- overlay worktree skills/hwp into cache (backup), run thunk, restore ----
function withOverlay(thunk) {
  const cacheHwp = cacheSkillsDir();
  const localHwp = join(PLUGIN, 'skills', 'hwp');
  if (!existsSync(localHwp)) throw new Error(`worktree plugin not found: ${localHwp}`);
  const backup = `${cacheHwp}.orig-${Date.now()}`;
  renameSync(cacheHwp, backup);           // stash published
  try {
    cpSync(localHwp, cacheHwp, { recursive: true }); // overlay local fix
    return thunk(cacheHwp);
  } finally {
    try { rmSync(cacheHwp, { recursive: true, force: true }); } catch {}
    try { renameSync(backup, cacheHwp); } catch (e) { console.error(`[WARN] cache restore failed — manual restore: mv "${backup}" "${cacheHwp}"`); }
  }
}

// ---- cold temp workdir + output path ----
const workdir = join(tmpdir(), `claw-cold-${Date.now()}-${process.pid}`);
mkdirSync(workdir, { recursive: true });
const outPath = OUT ? (isAbsolute(OUT) ? OUT : join(workdir, OUT)) : join(workdir, `output.${FORMAT}`);
const fullRequest = `${REQUEST}\n\n(자동검증: claw-hwp skill을 사용해서 작업하고, 최종 결과 파일을 정확히 이 경로에 저장: ${outPath})`;

function runColdB() {
  const cmd = `${cv.claudeBin} -p --model ${cv.model} ${(cv.extraArgs || []).join(' ')}`;
  try {
    const stdout = execSync(cmd, { cwd: workdir, input: fullRequest, encoding: 'utf8', timeout: cv.timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: (e.stdout || '') + (e.stderr ? `\n[stderr] ${e.stderr}` : '') + `\n[exit] ${e.status}`, error: 'B launch failed' };
  }
}

function findOutput() {
  if (existsSync(outPath)) return outPath;
  const cands = readdirSync(workdir).map(f => join(workdir, f))
    .filter(p => extname(p).toLowerCase() === `.${FORMAT}` && statSync(p).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return cands[0] || null;
}

function tier1(file) {
  if (!file || !existsSync(file)) return { pass: false, reason: 'no output file produced by B' };
  const buf = readFileSync(file);
  if (!buf.length) return { pass: false, reason: 'output empty' };
  if (FORMAT === 'hwpx') { if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return { pass: false, reason: 'not a ZIP (hwpx)' }; }
  else { const m = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; if (!m.every((b, i) => buf[i] === b)) return { pass: false, reason: 'not CFB/OLE (hwp)' }; }
  if (CONTAINS) {
    let inner = '';
    try { inner = FORMAT === 'hwpx' ? execSync(`unzip -p "${file}"`, { encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'] }) : buf.toString('utf16le'); } catch {}
    const found = inner.includes(CONTAINS) || inner.includes(Buffer.from(CONTAINS, 'utf16le').toString('latin1'));
    if (!found) return { pass: false, reason: `expected content not found: "${CONTAINS}"`, file, bytes: buf.length };
  }
  return { pass: true, reason: `structural OK (${FORMAT}${CONTAINS ? ' + content' : ''})`, file, bytes: buf.length };
}

function tier2(file) {
  if (!cv.captureCmd) return { skipped: true, reason: 'captureCmd not configured (1a in progress)' };
  try {
    const out = execSync(cv.captureCmd.replace('{FILE}', `"${file}"`), { encoding: 'utf8', timeout: cv.timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return { pass: !!(j.opens ?? j.ok), opens: j.opens ?? j.ok, screenshot: j.screenshot || j.screenshot_path, error: j.error || null };
  } catch (e) { return { pass: false, error: `capture failed: ${(e.message || '').slice(0, 200)}` }; }
}

// ---- run (B inside cache overlay) ----
let b, file, t1, t2;
try {
  b = withOverlay(() => runColdB());
} catch (e) {
  b = { ok: false, stdout: '', error: e.message };
}
file = b.ok ? findOutput() : null;
t1 = b.ok ? tier1(file) : { pass: false, reason: b.error };
t2 = (b.ok && t1.pass && TIER2) ? tier2(file) : { skipped: true, reason: TIER2 ? 'skipped (Tier1 failed)' : 'Tier2 not requested' };
const pass = !!(t1.pass && (t2.skipped || t2.pass));

const verdict = { pass, format: FORMAT, output: file, tier1: t1, tier2: t2, bLaunchOk: b.ok, bStdoutTail: (b.stdout || '').slice(-800), workdir: KEEP ? workdir : undefined };
if (!KEEP) { try { rmSync(workdir, { recursive: true, force: true }); } catch {} }
process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
process.exit(pass ? 0 : 1);
