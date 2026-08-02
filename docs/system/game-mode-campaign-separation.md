# [구현 완료] 게임 모드·캠페인 분리 설계

> 상태 기준: 2026-08-02
> 이전 제안 번호: 1
> 관련 구현: `story/game_modes.yaml`, `story/schema/game_modes.schema.json`, `tools/story_harness.py`, `src/player/gameModes.ts`, `src/player/WebGame.tsx`, `src/player/playerRuntime.ts`, `src/player/playerStorage.ts`

## 1. 목적

스토리 모드, 속마음 모드, 어나더 스토리를 화면 레이어가 아니라 안정적인 게임 모드로 관리한다. 게임 모드는 사용할 캠페인, 시작 레이어, 레이어 정책, 연속성, 콘텐츠 준비 상태와 해금 조건을 선언한다.

이 설계의 핵심 불변식은 다음과 같다.

- `GameModeId`와 `ViewLayer`는 서로 다른 타입이다.
- `base`와 `truth_view`는 같은 `main` 캠페인과 `main` 연속성을 사용한다.
- `survivor_view`는 별도 `survivor` 연속성의 평행세계다.
- `perceived`는 언제나 한도윤의 인식이며 다른 주인공 시점으로 재사용하지 않는다.
- 세션은 모드와 캠페인을 명시적으로 받아야 하며 첫 번째 항목으로 대체하지 않는다.
- 이벤트, 루트와 스레드는 캠페인 소속을 명시하고 다른 캠페인 세션에 노출되지 않는다.

## 2. 안정 ID와 목표 관계

| 게임 모드 | 캠페인 | 연속성 | 시작 레이어 | 정책 | 현재 콘텐츠 상태 |
|---|---|---|---|---|---|
| `base` | `main` | `main` | `perceived` | `fixed` | `playable` |
| `truth_view` | `main` | `main` | `reality` | `fixed` | `playable` |
| `survivor_view` | 미연결, 예약 ID `survivor` | `survivor` | `reality` | `fixed` | `coming_soon` |

기존 캠페인 ID `main`은 배포된 안정 ID이므로 `campaign.main`으로 바꾸지 않는다. 실제 생존 캠페인이 준비되기 전에는 존재하지 않는 캠페인을 참조하지 않고 `planned_campaign_id: survivor`만 예약한다.

## 3. 타입 계약

```ts
type GameModeId = "base" | "truth_view" | "survivor_view";
type ViewLayer = "perceived" | "reality";
type LayerPolicy = "fixed" | "switchable";
type ContentStatus = "playable" | "coming_soon";
```

`ViewMode`는 호환용 별칭을 거쳐 `ViewLayer`로 이름을 바꾼다. 루트의 기존 `mode` 필드는 제거하고 `campaign_id`로 교체한다. 속마음 모드는 본편 루트를 복제하지 않고 같은 캠페인의 같은 장면 그래프를 현실 레이어로 재생한다.

## 4. 모드 레지스트리

권위 원본은 `story/game_modes.yaml` 하나다. 빌드는 이를 런타임의 `game_modes` 맵으로 컴파일한다.

```yaml
schema_version: 1
id: game_modes
modes:
  base:
    campaign_id: main
    continuity_id: main
    initial_layer: perceived
    layer_policy: fixed
    content_status: playable
    unlock: {always: true}

  truth_view:
    campaign_id: main
    continuity_id: main
    initial_layer: reality
    layer_policy: fixed
    content_status: playable
    unlock:
      any:
        - conditions: [{path: progress.cleared_routes, op: contains, value: seo_a}]
        - conditions: [{path: progress.cleared_routes, op: contains, value: min_kyung}]

  survivor_view:
    campaign_id: null
    planned_campaign_id: survivor
    continuity_id: survivor
    initial_layer: reality
    layer_policy: fixed
    content_status: coming_soon
    unlock:
      any:
        - conditions: [{path: progress.cleared_routes, op: contains, value: seo_a}]
        - conditions: [{path: progress.cleared_routes, op: contains, value: min_kyung}]
```

`content_status`는 정적 제작 상태다. `locked`, `ready`, `coming_soon` 같은 플레이어별 접근 상태는 프로필과 모드 정의를 평가해 계산하며 YAML에 저장하지 않는다.

`carry_policy`는 모드 데이터에 두지 않는다. 엔진은 프로필에서 `cleared_routes`, `unlocked_modes`, `memories`만 새 세션으로 복사하고 나머지 세션 상태는 항상 새로 만든다.

## 5. 캠페인 소속과 시작 계약

캠페인은 다음 필드를 추가한다.

| 필드 | 의미 |
|---|---|
| `entry_event_id` | 새 캠페인이 처음 실행할 자동 사건 |
| `initial_state_patch` | manifest 초기 상태 위에 깊게 병합할 캠페인별 값 |
| `systems.self_development` | 캠페인에서 자기계발 밤 페이즈 사용 여부 |

`TimelineEvent`, `Route`, `TimelineThread`는 `campaign_id`를 필수로 가진다. 장면 소속은 `scene.route -> route.campaign_id`로 파생한다.

검증기는 다음 교차 참조를 강제한다.

- 사건의 lane은 소속 캠페인의 lane이어야 한다.
- 사건이 연결한 장면의 루트는 같은 캠페인이어야 한다.
- 사건의 선행 사건, `on_missed.trigger_event`와 스레드는 같은 캠페인이어야 한다.
- 스레드의 모든 사건은 스레드와 같은 캠페인이어야 한다.
- 캠페인 진입 사건은 같은 캠페인의 `automatic` 사건이고 초기 상태에서 도달 가능해야 한다.
- `playable` 모드는 존재하는 캠페인을 참조해야 한다.
- `coming_soon` 모드는 캠페인이 없어도 되지만 세션을 만들 수 없다.

스케줄러, 시뮬레이터, 편집기와 CLI는 캠페인을 명시적으로 받거나 루트에서 파생한다. `next(iter(campaigns))`, `Object.values(campaigns)[0]` 같은 첫 캠페인 선택은 허용하지 않는다.

## 6. 세션·저장 계약

현재 구현이 이미 v4이므로 분리된 세션과 슬롯은 v5를 사용한다.

```ts
type PlayerSession = {
  version: 5;
  gameModeId: GameModeId;
  campaignId: string;
  continuityId: string;
  viewLayer: ViewLayer;
  // 기존 진행 상태
};
```

`layerPolicy`는 모드 레지스트리의 권위 값이므로 세션에 중복 저장하지 않는다. 로드 시 세션의 모드, 캠페인, 연속성과 레이어가 현재 레지스트리와 호환되는지 검사한다.

백로그는 `layerAtPresentation`을 저장하고 현재 세션 레이어가 아니라 당시 레이어로 다시 그린다. 디버그 레이어 미리보기는 UI 로컬 상태이며 일반 세이브에 기록하지 않는다.

슬롯 미리보기는 최소한 `gameModeId`, `campaignId`, `continuityId`, `viewLayer`를 포함한다.

## 7. v4에서 v5 마이그레이션

| v4 값 | v5 변환 |
|---|---|
| `campaignId: main`, `mode: perceived` | `base`, `main`, `main`, `perceived` |
| `campaignId: main`, `mode: reality` | `truth_view`, `main`, `main`, `reality` |
| 알 수 없는 캠페인 또는 레이어 | 원본을 보존하고 불러오기 거부 |

기존 reality 세션이 속마음 모드 시작인지 플레이 중 전환인지 구분할 수 없으므로 `truth_view`로 결정적으로 변환한다. 두 경우 모두 같은 캠페인과 연속성을 사용하며 저장 당시의 reality 표시를 유지한다.

마이그레이션은 입력을 변경하지 않는 순수 함수로 작성한다. 실패한 슬롯을 첫 캠페인이나 비슷한 장면으로 대체하지 않는다.

## 8. 시작 API와 오류

```ts
type StartGameResult =
  | {ok: true; session: PlayerSession}
  | {ok: false; code:
      | "unknown_mode"
      | "locked"
      | "coming_soon"
      | "missing_campaign"
      | "invalid_entry_event"};
```

`startGameMode(runtime, profile, gameModeId)`는 모드 접근 상태를 확인한 뒤 세션을 만든다. 저수준 `createCampaignSession`도 `gameModeId`를 필수로 받으며 기본값을 가지지 않는다.

## 9. 해금 권위

모드 해금 조건의 권위 원본은 모드 레지스트리다.

- 엔딩 장면은 완료한 루트와 회상 같은 서사 결과를 기록한다.
- 엔진은 완료된 루트와 레지스트리를 사용해 `unlocked_modes`를 재계산한다.
- 프로필의 기존 `unlockedModes`는 레거시 또는 명시적 해금으로 인정한다.
- `normalizePlayerProfile`과 UI에서 `clearedRoutes.length > 0`을 하드코딩하지 않는다.
- 기존 `meta/unlocks.yaml`의 모드 기술 규칙과 엔딩 장면의 중복 `unlocked_modes` 효과는 제거한다.

## 10. UI 규칙

- 새 게임 화면에는 승인된 세 모드 카드만 둔다.
- 카드의 잠금, 준비 중과 시작 가능 여부는 모드 레지스트리로 계산한다.
- `base`는 `main/perceived`, `truth_view`는 `main/reality`로 시작한다.
- 첫 엔딩 뒤 `survivor_view` 카드는 잠금 해제된 설명을 보여 주지만 `coming_soon`이므로 세션을 만들지 않는다.
- 일반 플레이 중 게임 모드와 레이어를 바꾸지 않는다.
- 디버그 모드에서만 현재 mode, campaign, continuity, layer와 비저장 레이어 미리보기를 제공한다.

## 11. 구현 결과

1. 본 문서와 스토리 데이터 명세 수정 완료
2. 모드 레지스트리와 JSON Schema 추가 완료
3. 캠페인·사건·루트·스레드 소속 데이터 마이그레이션 완료
4. 빌더와 validator의 다중 캠페인 지원 완료
5. TypeScript 런타임 타입과 세션 v5 구현 완료
6. v4 저장 마이그레이션과 복구 가능한 오류 구현 완료
7. 새 게임 UI와 디버그 전용 레이어 미리보기 구현 완료
8. 편집기·CLI·스케줄러의 첫 캠페인 자동 선택 제거 완료
9. 단위·하네스·E2E 회귀 테스트 추가 완료

## 12. 인수 조건

- 세 모드 카드의 상태가 `story/game_modes.yaml`로 결정된다.
- 기본 모드와 속마음 모드는 같은 캠페인에서 서로 다른 고정 레이어를 사용한다.
- 어나더 스토리는 실제 캠페인이 없어도 잠금 해제 상태를 표현할 수 있지만 시작되지는 않는다.
- 캠페인 순서를 바꾸어도 시작 캠페인이 변하지 않는다.
- 한 캠페인 세션에서 다른 캠페인의 사건이 노출·실행·만료되지 않는다.
- 알 수 없는 모드와 캠페인은 조용히 대체되지 않는다.
- v4 세이브는 결정적으로 v5로 변환되거나 원본을 보존한 채 거부된다.
- 일반 플레이 중 레이어를 바꿀 수 없다.
- 백로그는 당시 레이어로 표시된다.
- 서로 다른 연속성의 세션 상태가 병합되지 않는다.

## 13. 제외 범위

- 어나더 스토리의 주인공과 개별 사건 작성
- 클라우드 계정과 기기 간 동기화
- perceived와 reality의 서사적 의미 변경
- 플레이 도중 다른 모드로 세션을 변환하는 기능

## 14. 검증 근거

- 스토리 validator: 캠페인 1개, 사건 24개, 스레드 2개, 루트 2개, 장면 14개, 오류 0, 경고 0
- 플레이어 단위 테스트 72개: 모드 접근·시작 오류, 캠페인 순서 독립성, 초기 패치, 타 캠페인 사건의 노출·자동 실행·만료 격리, 별도 연속성 상태 격리, v3/v4→v5 변환과 거부 경로 포함
- 브라우저 E2E 4개: 승인된 카드 3개, 첫 엔딩 해금, 속마음 고정 reality 레이어, 어나더 스토리 준비 중 차단, 디버그 식별자와 비저장 레이어 미리보기 확인
- 빌드 재현성: `story-runtime.json`과 원본 YAML 해시 일치
