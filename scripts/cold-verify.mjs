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
 * HANCOMDOCS variant (--format hancomdocs): claw-hancomdocs is NOT installed as a plugin (no
 *   cache entry), so the cache-overlay above doesn't apply. Instead we drop the worktree skill
 *   into `<workdir>/.claude/skills/claw-hancomdocs/` and launch B with `--add-dir <workdir>`
 *   — the documented way to load a `.claude/skills/` from a NON-repo dir (plain cwd discovery
 *   needs a git root, which a temp dir lacks). auth.json travels with the copied scripts/ so B
 *   has the Hancom Docs session (= a real user who ran login.js once). No local output FILE —
 *   B edits a cloud doc; grading = capture (manual compare in 1c-1, auto judge in 1c-2).
 *   NOTE: `--add-dir` is intentional HERE ONLY; hwp/hwpx still use the cache overlay (NOT --add-dir).
 *
 * Usage:
 *   node cold-verify.mjs --request "<natural user ask>" --plugin <worktree>/plugins/claw-hwp \
 *        --format hwpx|hwp [--out <name|path>] [--contains "<text>"] [--tier2] [--keep] [--cache-version 1.5.4]
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute, dirname, extname, sep } from 'node:path';
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
const isHancom = FORMAT === 'hancomdocs';
if (!REQUEST || !PLUGIN || !['hwp', 'hwpx', 'hancomdocs'].includes(FORMAT)) {
  console.error('usage: cold-verify.mjs --request "<ask>" --plugin <worktree-root> --format hwp|hwpx|hancomdocs [--out p] [--contains t] [--tier2] [--keep] [--cache-version V]\n  hwp/hwpx   : --plugin <worktree>/plugins/claw-hwp   (cache overlay, byte Tier1)\n  hancomdocs : --plugin <claw-hancomdocs repo root>   (skills-dir + --add-dir, capture-only)');
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

// ---- hancomdocs: drop worktree skill into <workdir>/.claude/skills/ (B loads via --add-dir) ----
// claw-hancomdocs isn't a published plugin → no cache to overlay. Copy SKILL.md + scripts
// (incl. machine auth.json) into a temp skills dir; symlink node_modules (deps already on machine).
function overlaySkillsDir(wd, repoRoot) {
  const dst = join(wd, '.claude', 'skills', 'claw-hancomdocs');
  mkdirSync(dst, { recursive: true });
  const skill = join(repoRoot, 'SKILL.md');
  if (!existsSync(skill)) throw new Error(`claw-hancomdocs SKILL.md not found at ${skill} (pass --plugin <claw-hancomdocs repo root>)`);
  cpSync(skill, join(dst, 'SKILL.md'));
  const scriptsSrc = join(repoRoot, 'scripts');
  if (!existsSync(join(scriptsSrc, 'auth.json'))) throw new Error(`auth.json missing in ${scriptsSrc} — run login.js (B needs the Hancom Docs session)`);
  // copy scripts but skip heavy/irrelevant dirs; auth.json IS copied (B needs the session)
  cpSync(scriptsSrc, join(dst, 'scripts'), { recursive: true, filter: (s) => {
    const rel = s.slice(scriptsSrc.length);
    return !rel.includes(`${sep}node_modules`) && !rel.includes(`${sep}captures`);
  } });
  // deps already installed on the machine → symlink instead of copying hundreds of MB
  const nm = join(scriptsSrc, 'node_modules');
  if (existsSync(nm)) { try { symlinkSync(nm, join(dst, 'scripts', 'node_modules')); } catch {} }
  return dst;
}

// hancomdocs: collect B's capture PNGs (skill self-check output) for compare
function collectCaptures(wd) {
  const capDir = join(wd, '.claude', 'skills', 'claw-hancomdocs', 'scripts', 'captures');
  if (!existsSync(capDir)) return [];
  try { return readdirSync(capDir).filter(f => f.toLowerCase().endsWith('.png')).map(f => join(capDir, f)); } catch { return []; }
}

// ---- cold temp workdir + output path ----
const workdir = join(tmpdir(), `claw-cold-${Date.now()}-${process.pid}`);
mkdirSync(workdir, { recursive: true });
const outPath = OUT ? (isAbsolute(OUT) ? OUT : join(workdir, OUT)) : join(workdir, `output.${FORMAT}`);
const fullRequest = isHancom
  ? `${REQUEST}\n\n(자동검증: claw-hancomdocs 스킬로 작업해. doctor.js부터 돌리고, 스킬 지시대로 캡처로 결과를 남겨. 로컬 파일 저장 안 해도 됨 — 검증은 캡처로 한다.)`
  : `${REQUEST}\n\n(자동검증: claw-hwp skill을 사용해서 작업하고, 최종 결과 파일을 정확히 이 경로에 저장: ${outPath})`;

function runColdB() {
  const addDir = isHancom ? `--add-dir "${workdir}" ` : '';   // hancomdocs: load .claude/skills/ from temp (non-repo) workdir
  const cmd = `${cv.claudeBin} -p --model ${cv.model} ${addDir}${(cv.extraArgs || []).join(' ')}`;
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

// ---- run ----
let verdict, exitCode;
if (isHancom) {
  // hancomdocs: skills-dir overlay (no cache, no byte Tier1). B edits a cloud doc; grade = capture.
  let b, skillDst;
  try {
    skillDst = overlaySkillsDir(workdir, PLUGIN);
    b = runColdB();
  } catch (e) {
    b = { ok: false, stdout: '', error: e.message };
  }
  const captures = b.ok ? collectCaptures(workdir) : [];
  // 1c-1 = manual compare: produce captures, leave pass undetermined. (1c-2 = auto judge: file/capture vs ground-truth.)
  const launchedAndCaptured = !!(b.ok && captures.length);
  verdict = {
    pass: null, needsManualCompare: true, mode: 'capture-only (1c-1: 콜드 기동+캡처 산출, 비교 수동)',
    format: FORMAT, captures, captureCount: captures.length,
    bLaunchOk: b.ok, bError: b.error || null, bStdoutTail: (b.stdout || '').slice(-800),
    skillDir: skillDst || null, workdir,   // hancomdocs always keeps workdir (captures live here)
    note: launchedAndCaptured ? '레퍼런스 픽스처 캡처와 수동 비교 (검증②). 자동 비교 = 1c-2.' : 'B가 캡처를 못 남김 — bStdoutTail/bError 확인.',
  };
  exitCode = launchedAndCaptured ? 0 : 1;   // 0 = 파이프라인 완주(수동 판정 대기), 1 = 콜드 기동/캡처 실패
} else {
  // hwp/hwpx: cache overlay + byte Tier1 (+ optional Tier2 capture)
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
  verdict = { pass, format: FORMAT, output: file, tier1: t1, tier2: t2, bLaunchOk: b.ok, bStdoutTail: (b.stdout || '').slice(-800), workdir: KEEP ? workdir : undefined };
  if (!KEEP) { try { rmSync(workdir, { recursive: true, force: true }); } catch {} }
  exitCode = pass ? 0 : 1;
}
process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
process.exit(exitCode);
