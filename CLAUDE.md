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
- 사용량 측정 = **Anthropic OAuth usage 엔드포인트**(`GET /api/oauth/usage`, `/usage`와 동일·계정전체·서버사이드).
  반환 `five_hour.utilization`/`seven_day.utilization`(0–100) 그대로 사용 — `$→%` 변환·캘리브 없음.
  헤더 `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` + **`User-Agent: claude-code/<ver>` 필수**(없으면 429).
  토큰: `$CLAUDE_CONFIG_DIR/.credentials.json`(Win/Linux) 또는 **macOS Keychain**(darwin, 파일 아님 주의).
  **ccusage·peer SSH 합산 = v1 폐기** (로컬 머신만 봐서 다머신 과소; $→% drift). 미공개 엔드포인트라 깨질 수 있음.
- `main` 자동 머지 금지(자동화는 트랙 repo의 `stag`까지만). 이 repo 자체 브랜치는 단순 관리.

## 메모리

이 폴더의 메모리 네임스페이스(`…-claw-hwp-automation`)에 자동화 전용 사실만. 트랙(.hwp/.hwpx)
작업은 각 트랙 worktree에서 — 여기서 안 함.
