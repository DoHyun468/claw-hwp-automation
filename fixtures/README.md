# fixtures/ — cold-verify 회귀 코퍼스

시드 미션(`source:seed`)의 입력/정답 fixture. 설계: `../../handoff/MISSION_QUEUE.md`.
**커지면 Git LFS로 전환**(현재 일반 git, 합계 <1MB).

규칙: 검증된 ground-truth라 **byte-surgery로 축소/추출 금지**(검증됨 속성 깨짐). 더 작은 fixture가
필요하면 트랙 worktree(hwp/hwpx 도구)에서 새로 빌드한다.

| fixture | 역할 | 이슈 | 원본 (재현용) |
|---|---|---|---|
| `hwp/image-base.hwp` | ① 입력 (이미지 없는 1p baseline) | mistake 01 (sheetjs CFB.write) | `~/claw-hwp-verified-fixtures/inputs/phase_a_baseline_full.hwp` |
| `img/sample.png` | ① 삽입할 이미지 (placeholder) | mistake 01 | `claw-hancomdocs/assets/demo_zoom_b1_8.png` |
| `hwp/big-form.hwp` | ② 입력 (ktx 큰 폼, 빈 셀 — "성명" 핀포인트) | mistake 02 (round-trip 큰 폼) | `~/claw-hwp-verified-fixtures/inputs/ktx_phase1_replace.hwp` |
| `hwp/para-plain.hwp` | ③④ 입력 (무스타일 문단 control) | mistake 03·04 | `~/claw-hwp-verified-fixtures/phase-a/phase_a_styling_test_NO_BG.hwp` |
| `hwp/para-styled-ref.hwp` | ③④ **정답 ground-truth** (B8 paraShapeId=7, border_fill_id=2 회색) | mistake 03·04 | `~/claw-hwp-verified-fixtures/inputs/ktx_phase_b_styling_spec.hwp` |
| `hwp/stripe-3clean.hwp` | ④ 3문단 plain (char-shade artifact 비교용) | mistake 04 | `~/claw-hwp-verified-fixtures/phase-a/stripe_test_three_clean.hwp` |
| `hwpx/bullet-input.hwpx` | ⑤ 입력 (**작은** 5문단 plain, 글머리 없음 + 한컴 fingerprint 검증됨) | mistake 06 (web BULLET strip) | `~/claw-hwp-hwpx-edit/_verified_hwpx_samples/cs3_create.hwpx` (7.5KB) |
| `hwpx/bullet-input-large.hwpx` | ⑤ fallback (50문단 plain + 표/이미지, fingerprint) | mistake 06 | `~/Downloads/short-gov_baseline_for_kdc.hwpx` (169KB) |

## 입력 vs 정답 (중요)

③④는 "입력 = 무스타일(`para-plain`) → skill로 스타일 적용 → 정답(`para-styled-ref`의 B8 렌더)과 비교".
`para-styled-ref`는 이미 스타일된 한컴오피스 native 산출물이라 **기대 결과**지 입력이 아니다.

## TODO

- ⑤ 작은 fixture 확보됨(`bullet-input.hwpx` = cs3_create 7.5KB, 5 plain 문단). "정확히 3문단" 자르기는
  안 함 — 검증된 파일 byte-surgery는 금지, 5↔3은 미션 검증에 무관(글머리 적용 후 web 생존 체크가 본질).
  165KB 원본은 `bullet-input-large.hwpx`로 fallback 보존.
- `img/sample.png` = 데모 스샷 placeholder. 실제 image-insert 의미가 중요해지면 교체.
