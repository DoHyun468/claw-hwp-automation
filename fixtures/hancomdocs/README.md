# fixtures/hancomdocs/ — claw-hancomdocs Phase 2 편집 op의 cold-verify 픽스처

> **상태: 스키마/규칙만 (2026-06-09). 픽스처 바이너리·cold-verify hancomdocs 코드는 Phase 1c.**
> hancomdocs auth 주입(아래 ⚠️)이 풀려야 실제 자동 검증이 돈다.

## hwp/hwpx 픽스처와 본질이 다름 (capture-only)

| | hwp/hwpx (상위 `../`) | **hancomdocs (여기)** |
|---|---|---|
| 입력 | 로컬 byte 파일 | 한컴독스에 **열/업로드할** 입력 문서 |
| 산출 | B가 만든 **로컬 파일** | **클라우드 문서 변경** (로컬 파일 아님) |
| 정답 | ground-truth **파일**(byte/구조 비교) | **편집 op + 기대 캡처**(시각 레퍼런스) |
| 검증 | Tier1 매직바이트/구조 | **캡처 self-verify만** |

**§12#1 확정 (2026-06-09): hancomdocs는 다운로드/구조검증 안 함 — capture-only.**
이유: **캡처가 가장 정확한 검증**(한컴 본가가 만든 포맷이라 byte를 다시 의심할 이유 약함). 매 op마다
다운로드+byte검증을 강제하면 claw-hancomdocs가 무거운 끝(claw-hwp)으로 끌려가 바벨 전략의 *가벼운 끝* 정체성이 흐려짐.

## 픽스처 구성 (3요소)

1. **입력 문서** — 작은 1~2p `.hwpx`(한컴 native fingerprint 검증된 것). 한컴독스에서 열어 편집 시작점.
2. **op 명세** — 무슨 편집을 하는지 (예: P1 `다운로드`, `찾기`, `되돌리기` / 표 셀 채우기 / 글머리 적용). `ui-map/MENU_MAP.md`의 P1부터.
3. **레퍼런스 캡처** — 그 op를 정확히 수행한 뒤의 **기대 렌더 스크린샷**. cold가 재현했는지 비교 기준.

## A(담당 클로드)의 픽스처 백업 규칙 — 비교②의 핵심

cold-verify는 콜드스타트(B) 검증이 본질이고, hancomdocs에선 **"B가 SKILL만 보고 원본 픽스처와 같은
내용을 재현하나"** 를 본다([[automation-stag-night-model]]의 2층 검증 중 통합 전 단계). 그래서:

1. 담당 클로드(A/fixer)는 **원본 픽스처를 백업/다른 이름으로 보존**(원본은 로컬에도 있음). 원본 = **콜드가 재현해야 할 ground-truth 내용**.
2. A는 그 **사본을 편집해가며** 코드를 개발(검증①: 내가 고친 코드로 목표가 나오나 — 캡처로 확인).
3. cold-verify가 B를 콜드 기동 → B가 SKILL만 보고 같은 op 수행 → **A가 B의 산출(캡처)을 원본 픽스처와 비교**(검증②). B의 "됐어요" 자기보고는 신뢰 안 함 — A의 독립 비교가 통과해야 진짜 fix.

→ **2번 연달아 검증**(①내 결과 ②콜드 결과 vs 원본)이 정상. 둘 다 캡처 기반이라 담당 클로드가 편집하며 자동으로 수행됨.

## 규칙 (상위 `../README.md` 계승)

- **byte-surgery로 축소/추출 금지** — 더 작은 입력이 필요하면 트랙 worktree(claw-hancomdocs)에서 새로 빌드.
- 작게 시작: P1 op + 최소 입력부터. §12#1이 capture-only로 확정됐으니 ground-truth는 **파일 아닌 레퍼런스 캡처**.
- 커지면 Git LFS(상위 룰 동일).

## ⚠️ 미해결 (Phase 1c, cold-verify 일반화)

- **hancomdocs auth 주입**: hwp/hwpx 콜드는 빈 temp로 자기완결(로컬 byte op). 하지만 hancomdocs B는
  **한컴독스 로그인 세션(auth.json) + Chromium + 네트워크** 필요. "빈 temp" 콜드 에이전트에 세션을 어떻게
  줄지 미정. auth.json은 머신종속·gitignored·**머신 간 공유 금지**([[hancomdocs-mac-win-separate-accounts]]).
- cold-verify.mjs의 플러그인 캐시 경로(`claw-hwp`→`claw-hancomdocs`) 파라미터화 + 비교② 구현 = Phase 1c.
- 단일 출처: `../../handoff/AUTOMATION_DESIGN.md §8` + `AUTOMATION_DESIGN_6TRACK.md §8`.
