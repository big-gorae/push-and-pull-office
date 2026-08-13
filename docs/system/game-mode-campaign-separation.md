# [구현] 게임 모드·캠페인 분리

> 상태 기준: 2026-08-13
> 관련 구현: `story/game_modes.yaml`, `story/schemas/game_modes.schema.json`, `tools/story_harness.py`, `src/player/gameModes.ts`, `src/player/WebGame.tsx`, `src/player/playerRuntime.ts`, `src/player/playerStorage.ts`

## 결정

게임 모드는 캠페인과 연속성, 콘텐츠 준비 상태, 해금 조건만 선언한다. 장면 표시 레이어나 속마음 전용 모드는 존재하지 않는다.

| 게임 모드 | 캠페인 | 연속성 | 상태 |
|---|---|---|---|
| `base` | `main` | `main` | `playable` |
| `survivor_view` | 예약 ID `survivor` | `survivor` | `coming_soon` |

- `base`는 메인 캠페인의 유일한 플레이 모드다.
- `survivor_view`는 별도 평행세계 캠페인을 위한 예약 모드다.
- 세션에는 장면 표시 레이어를 저장하지 않는다.
- 이벤트, 루트와 스레드는 캠페인 소속을 명시하며 다른 캠페인 세션에 노출되지 않는다.
- 새 게임 화면은 `base`와 `survivor_view` 카드만 표시한다.

## 저장 호환

현재 플레이어 세션 스키마는 v6이다. v5 이하 저장에서 읽은 과거 레이어 필드는 마이그레이션 과정에서 버리고 `base` 세션으로 정규화한다. 이 호환 코드는 폐기된 모드를 다시 노출하거나 해당 대사를 복원하지 않는다.

## 폐기된 계약

다음 항목은 구현·제작·QA 근거로 사용하지 않는다.

- 장면의 인지/현실 이중 레이어
- 속마음 전용 게임 모드와 레이어 전환
- 같은 장면의 두 레이어 비교 재생
- 레이어별 화자·표정·배경·스테이지

현재 기계 계약은 `story/SPEC.md`, 런타임 계약은 `story/RUNTIME_INTEGRATION.md`가 소유한다.
