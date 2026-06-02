#!/usr/bin/env node
/**
 * cold-verify.mjs — run a COLD-START Claude (B = real-user simulation) against the LOCAL
 * plugin code, capture its output, run Tier1 structural checks (+ optional Tier2 Hancom
 * capture), and print a verdict JSON.
 *
 * WHY: real users always invoke the skill COLD (published plugin + SKILL.md, no dev
 * context). A fix that only works when the high-context fixer (A) babysits it is NOT a real
 * fix. So A calls this to prove the fix works for a cold user. See ../handoff/AUTOMATION_DESIGN.md §8.
 *
 * COLD = run B in a fresh temp dir (no dev CLAUDE.md auto-loaded, empty memory namespace for
 * that path) with NORMAL subscription auth + plugin — NOT `--bare` (which also strips OAuth
 * auth + plugin-sync, i.e. too bare to mimic a real user). B must exercise A's LOCAL plugin
 * (the worktree code), not the published version → pass --plugin <worktree plugin dir>.
 *
 * Usage:
 *   node cold-verify.mjs --request "<natural user ask>" --plugin <dir> --format hwpx|hwp \
 *        [--out <path>] [--contains "<text expected in output>"] [--tier2] [--keep]
 *
 * ⚠️ The exact way B loads the LOCAL plugin (so the skill resolves to the worktree code, not
 * the marketplace build) is environment-specific — tune `coldVerify.extraArgs` /
 * `coldVerify.claudeBin` in config.local.json to match the proven cold-start recipe.
 */
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- args ----
function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const REQUEST = arg('request');
const PLUGIN = arg('plugin');
const FORMAT = (arg('format') || '').toLowerCase();
const OUT = arg('out');
const CONTAINS = arg('contains');
const TIER2 = !!arg('tier2', false);
const KEEP = !!arg('keep', false);
if (!REQUEST || !PLUGIN || !['hwp', 'hwpx'].includes(FORMAT)) {
  console.error('usage: cold-verify.mjs --request "<ask>" --plugin <dir> --format hwpx|hwp [--out p] [--contains t] [--tier2] [--keep]');
  process.exit(2);
}

// ---- config ----
const deepMerge = (a, b) => {
  const o = { ...a };
  for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? deepMerge(a[k] || {}, b[k]) : b[k];
  return o;
};
const cfg = (() => {
  const ex = JSON.parse(readFileSync(join(repoRoot, 'config.example.json'), 'utf8'));
  const lp = process.env.CLAW_AUTOMATION_CONFIG || join(repoRoot, 'config.local.json');
  return deepMerge(ex, existsSync(lp) ? JSON.parse(readFileSync(lp, 'utf8')) : {});
})();
const cv = cfg.coldVerify;

// ---- cold temp workdir (no dev CLAUDE.md, empty memory namespace) ----
const stamp = `${Date.now()}-${process.pid}`;
const workdir = join(tmpdir(), `claw-cold-${stamp}`);
mkdirSync(workdir, { recursive: true });
const outPath = OUT ? (isAbsolute(OUT) ? OUT : join(workdir, OUT)) : join(workdir, `output.${FORMAT}`);

// real-user request + a minimal automation note pinning the output path (so we can find it)
const fullRequest = `${REQUEST}\n\n(자동검증 메모: 최종 결과 파일을 정확히 이 경로에 저장해줘: ${outPath})`;

function runColdB() {
  // execSync → platform shell (handles claude/claude.cmd). Request via stdin → no arg-quoting.
  const args = ['-p', '--model', cv.model, '--add-dir', `"${PLUGIN}"`, ...(cv.extraArgs || [])];
  const cmd = `${cv.claudeBin} ${args.join(' ')}`;
  let stdout = '';
  try {
    stdout = execSync(cmd, { cwd: workdir, input: fullRequest, encoding: 'utf8', timeout: cv.timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    stdout = (e.stdout || '') + (e.stderr ? `\n[stderr] ${e.stderr}` : '') + `\n[exit] ${e.status}`;
    return { ok: false, stdout, error: 'B launch failed (check coldVerify.claudeBin/extraArgs + plugin load)' };
  }
  return { ok: true, stdout };
}

function findOutput() {
  if (existsSync(outPath)) return outPath;
  // fallback: newest file with the right extension produced under workdir
  const cands = readdirSync(workdir).map(f => join(workdir, f))
    .filter(p => extname(p).toLowerCase() === `.${FORMAT}` && statSync(p).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return cands[0] || null;
}

// ---- Tier 1: structural (magic + optional content) ----
function tier1(file) {
  if (!file || !existsSync(file)) return { pass: false, reason: 'no output file produced by B' };
  const buf = readFileSync(file);
  if (buf.length === 0) return { pass: false, reason: 'output is empty' };
  if (FORMAT === 'hwpx') {
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return { pass: false, reason: 'not a ZIP (hwpx) — bad PK magic' };
  } else { // hwp = CFB/OLE
    const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (!cfb.every((b, i) => buf[i] === b)) return { pass: false, reason: 'not a CFB/OLE (hwp) — bad magic' };
  }
  if (CONTAINS) {
    let found = false;
    try {
      const inner = FORMAT === 'hwpx'
        ? execSync(`unzip -p "${file}"`, { encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'] })
        : buf.toString('utf16le') + buf.toString('latin1');
      found = inner.includes(CONTAINS) || Buffer.from(CONTAINS, 'utf16le').toString('latin1') && inner.includes(Buffer.from(CONTAINS, 'utf16le').toString('latin1'));
    } catch { found = false; }
    if (!found) return { pass: false, reason: `expected content not found: "${CONTAINS}"`, file };
  }
  return { pass: true, reason: `structural OK (${FORMAT}${CONTAINS ? ' + content' : ''})`, file, bytes: buf.length };
}

// ---- Tier 2: Hancom open + capture (hancomdocs-capture, separate repo, contract) ----
function tier2(file) {
  if (!cv.captureCmd) return { skipped: true, reason: 'captureCmd not configured (1a in progress)' };
  try {
    const cmd = cv.captureCmd.replace('{FILE}', `"${file}"`);
    const out = execSync(cmd, { encoding: 'utf8', timeout: cv.timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/\{[\s\S]*\}/); // tolerate RESULT_JSON={...} wrapper
    const j = m ? JSON.parse(m[0]) : {};
    return { pass: !!(j.opens ?? j.ok), opens: j.opens ?? j.ok, screenshot: j.screenshot || j.screenshot_path, error: j.error || null };
  } catch (e) {
    return { pass: false, error: `capture failed: ${(e.message || '').slice(0, 200)}` };
  }
}

// ---- run ----
const b = runColdB();
const file = b.ok ? findOutput() : null;
const t1 = b.ok ? tier1(file) : { pass: false, reason: b.error };
const t2 = (b.ok && t1.pass && TIER2) ? tier2(file) : { skipped: true, reason: TIER2 ? 'skipped (Tier1 failed)' : 'Tier2 not requested' };
const pass = !!(t1.pass && (t2.skipped || t2.pass));

const verdict = {
  pass,
  format: FORMAT,
  output: file,
  tier1: t1,
  tier2: t2,
  bLaunchOk: b.ok,
  bStdoutTail: (b.stdout || '').slice(-800),
  workdir: KEEP ? workdir : undefined,
};
if (!KEEP) { try { rmSync(workdir, { recursive: true, force: true }); } catch {} }
process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
process.exit(pass ? 0 : 1);
