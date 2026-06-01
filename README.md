# claw-hwp-automation

claw-hwp 자동화 **오케스트레이터** (cross-cutting infra — HWP/HWPX 트랙도, 캡처도 아님).
설계 단일 출처: **`../handoff/AUTOMATION_DESIGN.md`**.

하는 일(목표): 미션 큐(GitHub Issues)를 사용량 한도 안에서 드레인 → 워크트리에서 해결 →
검증(Tier1 + 한컴 캡처) → `stag` 통합. `main`은 사용자 수동 머지.

## 원칙
- **커밋 코드엔 절대경로 없음.** 머신별 값은 gitignore된 `config.local.json`에만 (→ `config.example.json` 복사해서 채움). OS무관 한 코드.
- 다른 repo(claw-hwp, hancomdocs-capture)는 **계약/상대경로로만** 참조. 트랙 코드 안 건드림.

## 현재 (Phase 1b)
- `scripts/usage-gate.mjs` — 사용량 게이트. ccusage 비용 기준(캘리브레이션 2026-06-01: 5h≈$28, 7d≈$400).
  - `node scripts/usage-gate.mjs` → 게이트 결정 JSON `{ gate: go|pause|stop, reason, ... }`
  - `node scripts/usage-gate.mjs --report` → 이 머신 사용량만 `{cost5hUSD, cost7dUSD}` (peer가 SSH로 호출)
  - 게이트 정책: 주간 ≥80% → stop / control mode=stop → stop / mode=full → 100% / 5h블록이 10시까지 리셋 → 100% / 업무시간(09:30–21:00) → 50% 캡 / 야간 → 100%. 머신 간은 SSH로 합산.

## 셋업
```
cp config.example.json config.local.json   # machineId, (옵션) peer SSH 채움
npm run gate
```
