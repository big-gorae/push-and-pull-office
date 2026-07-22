# 게임 런타임 통합

## 데이터 흐름

```text
campaigns/events/threads/meta/characters/routes/scenes/locales/visuals YAML
        │
        ├─ validate: 시간 범위·충돌·의존성·참조·그래프·이중 레이어 검사
        ├─ timeline: 현재 시각의 사건 후보·차단 이유·오프스크린 진행 재현
        ├─ simulate: 선택과 수치 변화 재현
        └─ build
             ↓
build/story-runtime.json
             ↓
       게임 엔진 로더
```

게임은 개별 YAML을 직접 읽을 필요가 없다. `story-runtime.json`에는 시간·분기 데이터뿐 아니라 fallback이 해석된 문자열 카탈로그와 상속이 해석된 비주얼 객체도 포함된다.

## 런타임 상태

세이브 파일에는 다음만 저장하면 된다.

```json
{
  "schema_version": 1,
  "current_event": "seo_a.relief_smile",
  "current_scene": "seo_a.relief_smile",
  "current_node": "response_choice",
  "state": {
    "visible": {},
    "hidden": {},
    "progress": {}
  },
  "choice_history": [
    {
      "scene": "seo_a.email_request",
      "node": "interpret",
      "option": "pull_harder"
    }
  ]
}
```

- 장면·노드·선택지 ID가 세이브 호환성의 기준이다.
- 문구, 수치 또는 파일 위치가 바뀌어도 기존 ID는 유지한다.
- 수치 범위 제한은 런타임과 하네스가 동일한 manifest 정의를 사용한다.
- `state.progress.time`, `events.seen/missed/expired`, `memories`도 세이브에 포함한다.

## 시간 이벤트 처리

한 시간대가 시작되면 다음 순서로 처리한다.

```text
1. 마감이 지난 미발생 사건을 missed/expired로 이동
2. 각 사건의 on_missed 효과 적용
3. 해당 날짜·시간대의 고정 및 hidden 사건을 우선순위순 실행
4. player 사건 중 조건을 만족한 후보를 플레이어에게 표시
5. 선택한 사건의 장면을 실행하고 on_seen 효과 적용
6. 보이지 않는 인물 사건을 처리한 뒤 다음 시간대로 이동
```

사건 조건을 만족하지 못하면 런타임은 단순 `false`가 아니라 선행 사건, 상태 조건, 시간대와 마감 중 어떤 이유로 차단됐는지 디버그 정보로 남긴다. 본편 UI에는 이 이유를 숨기고 제작 에디터와 개발 로그에서만 표시한다.

`completion: return_to_timeline`인 사건은 장면이 끝난 뒤 일정으로 돌아간다. `honor_scene_exit`은 엔딩처럼 장면의 종료 전이를 그대로 따른다.

## 노드 처리

```text
dual_dialogue / dual_narration
  현재 모드에 맞는 레이어를 렌더링하고 next로 이동

choice
  conditions가 참인 option만 표시
  선택된 effects를 순서대로 적용
  option.next로 이동

state_gate
  transitions를 위에서부터 평가
  처음 참인 node로 이동

effect
  effects를 순서대로 적용하고 next로 이동

exit
  transitions를 위에서부터 평가
  다음 scene을 열거나 ending을 종료 처리
```

## 모드별 렌더링

### 본편

- `perceived.atmosphere`
- `perceived.expression`
- `perceived.line`
- 호감도, 밀당 주도권, 현재 상태

### 원문 모드

- `reality.atmosphere`
- `reality.expression`
- `reality.line`
- `reality.inner_thought`
- 의심도, 비호감도, 증거 개수
- 같은 노드의 `perceived`를 비교 보기로 제공 가능

### 생존 모드 (`survivor_view`)

- 기본 렌더링은 `reality`
- 한도윤의 행동·말투·접촉 빈도를 숨은 위험 축의 단서로 표시하되 정확한 수치는 노출하지 않음
- 선택지의 `action`은 피해자 관점의 구체적인 대화·기록·연결 행동으로 작성하고 `밀기/당기기`라는 판정을 노출하지 않음
- 증거 인벤토리는 표시하되 엔딩 합격선은 숨김
- 엔딩 판정은 `보복 파국`, `집착 파국`, `끝나지 않은 탈출`, `대가 있는 생존`, `진상 생존` 다섯 단계를 사용
- 생존 모드 장면과 루트는 플레이어 캐릭터 확정 후 추가

## UI 바인딩

```text
visible.heroines.<id>.affection       → 호감도
visible.heroines.<id>.initiative      → 밀당 주도권
visible.heroines.<id>.perceived_state → 밀기/당기기/중립

hidden.heroines.<id>.suspicion        → 의심도
hidden.heroines.<id>.dislike          → 비호감도
hidden.heroines.<id>.evidence_count   → 증거 개수
```

원문 모드가 아니면 hidden 값을 UI나 게임 로그에 노출하지 않는다.

## 배경·캐릭터 아트 자산

장면은 파일 경로가 아니라 캐릭터의 expression ID를 참조한다. `VisualResolver`가 캐릭터 객체의 의상·포즈·표정 자산을 조합하고, 아직 레이어 자산이 없으면 `fallback_asset`을 사용한다.

```text
(character_id, expression_id, outfit_id, pose_id) → character visual object → sprite asset
```

배경은 `scene.location + scene.time + node.atmosphere + view_mode`로 후보를 거른 뒤 priority와 일치 차원 점수가 가장 높은 variant를 사용한다. 캐릭터 YAML의 `visual.concept_art`는 제작 참고 자산이며, 현재 구체 객체의 `fallback_asset`으로도 사용된다. 레이어 스프라이트가 추가되면 장면 데이터 변경 없이 교체할 수 있다.

## 엔진 이벤트 훅

구현 시 다음 이벤트를 노출하면 디버깅과 연출을 분리하기 쉽다.

- `scene_entered(scene_id, state_snapshot)`
- `node_entered(scene_id, node_id)`
- `choice_presented(enabled_option_ids)`
- `choice_selected(option_id)`
- `state_changed(path, before, after)`
- `expression_changed(character_id, expression_id)`
- `scene_transitioned(from_scene, to_scene)`
- `ending_reached(ending_id)`

하네스의 시뮬레이션 trace도 같은 개념을 사용하므로 엔진 로그와 비교할 수 있다.

## 현지화

빌드는 한국어 YAML에서 다음 안정 키를 자동 수집한다.

```text
scenes.<scene_id>.nodes.<node_id>.perceived.line
scenes.<scene_id>.nodes.<node_id>.reality.line
scenes.<scene_id>.nodes.<node_id>.reality.inner_thought
scenes.<scene_id>.nodes.<choice_node>.options.<option_id>.label
```

`LocalizationService`는 선택 locale의 카탈로그, locale fallback, 기본 한국어 원문 순으로 조회한다. `coverage.<locale>.missing`은 번역 QA에 사용한다. 레이어와 선택 의미를 번역 키에서도 분리해 원문과 왜곡 문장이 섞이지 않게 한다.
- `time_slot_started(day, slot, act)`
- `event_became_eligible(event_id, reasons)`
- `event_started(event_id, availability)`
- `event_missed(event_id, trigger_event_id)`
- `offscreen_event_resolved(event_id)`
