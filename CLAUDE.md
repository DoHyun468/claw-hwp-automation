# claw-hwp-automation — working notes (local, gitignored)

## 이 repo의 정체

claw-hwp 자동화 **오케스트레이터** (별도 repo, cross-cutting infra). HWP/HWPX 트랙도 캡처도
아니다 — 트랙들을 사용량 한도 안에서 굴리는 상위 제어층. **설계 단일 출처:
`../handoff/AUTOMATION_DESIGN.md`** (읽고 시작).

## 절대 규칙

- **커밋 코드에 절대경로 금지.** code-internal은 `import.meta.url`/`path.join`, 머신/사용자별
  경로(worktree 루트, ccusage config dir, control 파일, SSH 호스트)는 **gitignore된
  `config.local.json` + env + `os.homedir()`**. → 한 코드가 Win/Mac 동일, `main`에 `C:\…` 안 흘러감.
- 다른 repo(`claw-hwp`, `hancomdocs-capture`)의 코드를 **직접 편집·import 안 함.** 계약/CLI/상대경로로만.
- 캡처 계약: `입력=파일경로 → 출력={opens,screenshot,error}` (블랙박스).
- 사용량 측정 = **ccusage 비용($)** 기준 (원시 토큰은 캐시읽기로 부풀어 부적합). 캘리브 2026-06-01: 5h≈$28, 7d≈$400.
- `main` 자동 머지 금지(자동화는 트랙 repo의 `stag`까지만). 이 repo 자체 브랜치는 단순 관리.

## 메모리

이 폴더의 메모리 네임스페이스(`…-claw-hwp-automation`)에 자동화 전용 사실만. 트랙(.hwp/.hwpx)
작업은 각 트랙 worktree에서 — 여기서 안 함.
