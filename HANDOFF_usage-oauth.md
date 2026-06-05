# HANDOFF → Mac: usage-gate 재설계 (ccusage $ → OAuth usage 엔드포인트)

**From:** Windows 세션 · branch `feat/win-compat` · 2026-06-05
**What:** `scripts/usage-gate.mjs` v1(ccusage 비용+peer SSH) → **v2(Anthropic OAuth usage 엔드포인트)** 전면 교체.

## 왜 바꿨나 (윈도우에서 측정·검증함)

`/usage` 실제값 ↔ v1 게이트가 크게 어긋남 (방향이 정반대라 둘 다 버그):

| 창 | `/usage` (gt) | v1 게이트 | 원인 |
|---|---|---|---|
| 5h | 15% | ~1% (15배 **과소**) | **스코프** — ccusage는 이 머신 로컬 JSONL만. 계정 전체(맥+동시세션) 못 봄 |
| 7d | 31% | 57.6% (1.86배 **과대**) | **캘리브** — `limit7dUSD=$465`가 실제(~$860)의 절반. `$→%`가 캐시가격·모델믹스로 drift |

→ ccusage 비용($)을 `/usage`% proxy로 쓰는 게 **구조적으로 불가**. peer SSH 합산도 머신 N≥3이면 여전히 샘.

## v2 = OAuth 엔드포인트 (이게 곧 `/usage`)

```
GET https://api.anthropic.com/api/oauth/usage
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20
  User-Agent: claude-code/<version>     ← 필수. 없으면 per-token 버킷 429 폭탄
  Content-Type: application/json
→ { five_hour:{utilization 0-100, resets_at}, seven_day:{...}, seven_day_sonnet:{...}, extra_usage:{...} }
```

윈도우에서 로컬 토큰으로 호출 → `/usage`와 **5h/7d % + 리셋시각 전부 정확히 일치** 확인.
서버사이드라 **모든 머신·동시세션 자동 포함** → 스코프 버그 소멸, `$→%` 캘리브 소멸. peer/$-한도 코드 통째 제거.

## ⚠️ 맥이 반드시 검증할 것 — Keychain

윈도우/리눅스는 토큰이 `$CLAUDE_CONFIG_DIR/.credentials.json` 파일에 있음.
**macOS는 파일이 아니라 login Keychain에 저장**(`Claude Code-credentials`). 그래서 v2는 `platform()==='darwin'`이면:

```sh
security find-generic-password -s "Claude Code-credentials" -w
# → {"claudeAiOauth":{"accessToken":...}} JSON 반환 기대
```

이 코드는 **윈도우에서 테스트 못 함**. 맥에서 위 명령이 실제로 토큰 JSON을 뱉는지 먼저 확인해줘.
service 이름이 다르면(`-s` 값) 맞춰 고치거나, 안 되면 config.local.json에 escape hatch:
- `"credentialsFile": "..."` (토큰 JSON 파일 경로) 또는
- `"credentialsCommand": "security find-generic-password -s '...' -w"` (stdout=JSON 또는 raw 토큰)

## 맥이 할 일

1. 이 브랜치(`feat/win-compat`) 받아서 `scripts/usage-gate.mjs`, `config.example.json`, `README.md` 확인.
2. `node scripts/usage-gate.mjs` 실행 → `util7d`가 맥 `/usage` 주간%와 같은지 대조. 다르면 위 Keychain 이슈.
3. config.local.json에서 `plan`/`peer` 키 제거(이제 무시됨). `machineId:"mac"` 유지.
4. OK면 맥 자기 브랜치(`feat/mac-...`)에 동일 반영 → 사용자가 수동 머지.
5. `handoff/AUTOMATION_DESIGN.md §5`(ccusage $ 캘리브 설계) 갱신 필요 — 머지 시점에 OAuth 엔드포인트 기준으로 다시 씀.

## 게이트 정책(그대로 유지)
주간 ≥80% → stop / control mode=stop → stop / mode=full → 100% / 5h윈도우가 `resetByHHMM`(10:00)까지 리셋 → 100% / 업무시간(09:30–21:00) → 50% 캡 / 야간 → 100%. 토큰 못 읽으면 **fail-safe = pause**.
