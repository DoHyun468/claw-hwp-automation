# claw-hwp-automation

claw-hwp 자동화 **오케스트레이터** (cross-cutting infra — HWP/HWPX 트랙도, 캡처도 아님).
설계 단일 출처: **`../handoff/AUTOMATION_DESIGN.md`**.

하는 일(목표): 미션 큐(GitHub Issues)를 사용량 한도 안에서 드레인 → 워크트리에서 해결 →
검증(Tier1 + 한컴 캡처) → `stag` 통합. `main`은 사용자 수동 머지.

## 원칙
- **커밋 코드엔 절대경로 없음.** 머신별 값은 gitignore된 `config.local.json`에만 (→ `config.example.json` 복사해서 채움). OS무관 한 코드.
- 다른 repo(claw-hwp, hancomdocs-capture)는 **계약/상대경로로만** 참조. 트랙 코드 안 건드림.

## 현재 (Phase 1b)
- `scripts/usage-gate.mjs` — 사용량 게이트. **Anthropic OAuth usage 엔드포인트**(`/api/oauth/usage`)에서
  계정 전체 사용량 %를 직접 읽음 — Claude Code `/usage`와 동일 데이터(서버사이드라 모든 머신·동시 세션 포함).
  - `node scripts/usage-gate.mjs` → 게이트 결정 JSON `{ gate: go|pause|stop, reason, util5h, util7d, ... }`
  - `node scripts/usage-gate.mjs --report` → 원시 사용량 `{util5h, util7d}` (디버그)
  - 게이트 정책: 주간 ≥80% → stop / control mode=stop → stop / mode=full → 100% / 5h윈도우가 10시까지 리셋 → 100% / 업무시간(09:30–21:00) → 50% 캡 / 야간 → 100%.
  - 토큰 출처(OS무관): `$CLAUDE_CONFIG_DIR/.credentials.json`(Win/Linux) 또는 macOS Keychain `Claude Code-credentials`(darwin). 절대경로 없음.
  - ⚠️ 미공개 엔드포인트 — 스펙 바뀔 수 있음. `User-Agent: claude-code/<version>` 필수(없으면 429).
  - (v1 폐기: ccusage 비용($)+SSH peer 합산 — 로컬 머신만 봐서 다머신 과소·$→% drift. 상세 `../handoff/AUTOMATION_DESIGN.md §5`)

- `scripts/cold-verify.mjs` — **콜드스타트(B) 검증**. A(fixer)의 worktree 수정본을 B가 *발견하는 위치*에
  올려놓고 빈 temp에서 `claude -p`(B) 기동 → 산출물 채점. (본질 = 콜드 사용자가 SKILL만 보고 성공하나. 상세 `../handoff/AUTOMATION_DESIGN.md §8`.)
  - **hwp/hwpx**: 설치된 플러그인 **캐시 overlay** → byte Tier1(매직바이트/`--contains`) [+ `--tier2` 캡처]. 산출 = 로컬 파일.
  - **hancomdocs**(1c): 캐시에 없음 → worktree를 `<temp>/.claude/skills/`에 두고 **`--add-dir`** 로 B가 로드(auth.json 동행). **capture-only**(byte Tier1 없음) — B가 클라우드 문서 편집 후 캡처. **1c-1**=콜드 기동+캡처(`pass:null` 수동). **1c-2**=`--expect "<기대결과>"` → **vision judge**(별도 claude -p)가 캡처를 직접 보고 `{match,reason}` 자동 판정 → `pass` 결정. 캡처는 `<workdir>-captures`로 빼고 workdir(토큰) 삭제.
  - `node scripts/cold-verify.mjs` (인자 없이) → usage. hancomdocs auth 주입·검증②·미결은 `../handoff/AUTOMATION_DESIGN_6TRACK.md §8`.

## 셋업
```
cp config.example.json config.local.json   # machineId 채움 (토큰은 자동 발견)
npm run gate
```
