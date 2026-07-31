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
  "schema_version": 3,
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
  ],
  "backlog": [
    {
      "sceneId": "seo_a.email_request",
      "nodeId": "request",
      "variantId": "default",
      "modeAtPresentation": "perceived"
    }
  ]
}
```

- 장면·노드·선택지 ID가 세이브 호환성의 기준이다.
- 문구, 수치 또는 파일 위치가 바뀌어도 기존 ID는 유지한다.
- 수치 범위 제한은 런타임과 하네스가 동일한 manifest 정의를 사용한다.
- `state.progress.time`, `events.seen/missed/expired`, `memories`도 세이브에 포함한다.
- 표시 문자열과 번역 결과는 저장하지 않는다. 불러오기·백로그는 저장된 ID로 현재 locale에서 다시 해석한다.
- v2 저장의 문자열 필드는 읽기 마이그레이션에만 사용하고, 다시 저장할 때 v3 ID 구조로 정규화한다.

슬롯 자체는 세션과 별도로 번역 독립적인 미리보기 ID만 저장한다.

```json
{
  "schema_version": 3,
  "savedAt": 1730000000000,
  "preview": {
    "kind": "scene",
    "day": 2,
    "slot": "lunch",
    "eventId": "seo_a.email_request",
    "sceneId": "seo_a.email_request",
    "nodeId": "request",
    "variantId": "default",
    "mode": "perceived"
  },
  "session": {}
}
```

`preview`를 목록이 열리는 시점의 locale로 해석하므로, 저장 후 언어를 바꿔도 제목과 대사가 즉시 함께 바뀐다.

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

사건 조건을 만족하지 못하면 런타임은 단순 `false`가 아니라 선행 사건, 상태 조건, 시간대와 마감 중 어떤 이유로 차단됐는지 디버그 정보로 남긴다. 스토리 모드 UI에는 이 이유를 숨기고 제작 에디터와 개발 로그에서만 표시한다.

`completion: return_to_timeline`인 사건은 장면이 끝난 뒤 일정으로 돌아간다. `honor_scene_exit`은 엔딩처럼 장면의 종료 전이를 그대로 따른다.

## 노드 처리

```text
dual_dialogue / dual_narration
  emotion_rules로 derived.characters를 계산
  priority와 conditions로 dialogue variant를 선택
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
  transitions와 대상 scene.entry_conditions를 함께 위에서부터 평가
  다음 scene을 열거나 ending을 종료 처리
```

## 모드별 렌더링

### 스토리 모드 (`base`)

- `perceived.atmosphere`
- `perceived.expression`
- `perceived.line`
- 관계 HUD는 밀당 주도권, 현재 콤보 배수와 밀기·당기기 리듬 게이지만 표시
- 날짜와 사건 마감은 일정 UI와 대사로 전달

### 원문 모드

- `reality.atmosphere`
- `reality.expression`
- `reality.line`
- `reality.inner_thought`
- 의심도, 비호감도와 증거 개수는 상시 HUD가 아니라 장면 종료 기록 또는 디버그 보기에서 제공
- 같은 노드의 `perceived`를 비교 보기로 제공 가능

### 생존 모드 (`survivor_view`)

- 기본 렌더링은 `reality`
- 스토리 모드의 진실 보기나 후일담이 아닌 평행세계 캠페인으로 로드하며, 스토리 모드 세이브의 사건 결과를 덮어쓰지 않음
- 스토리 모드의 출발 상황과 날짜 모티프는 재사용할 수 있지만 동일한 핵심 사건과 결말을 강제하지 않음
- 강유진은 스토리 모드·원문 모드에도 비공략 조연으로 로드하며, 기본 엔딩에서 파국을 취소하는 해결사 플래그로 사용하지 않음
- 한도윤의 행동·말투·접촉 빈도를 숨은 위험 축의 단서로 표시하되 정확한 수치는 노출하지 않음
- 선택지의 `action`은 피해자 관점의 구체적인 대화·기록·연결 행동으로 작성하고 `밀기/당기기`라는 판정을 노출하지 않음
- 증거 인벤토리는 표시하되 엔딩 합격선은 숨김
- 엔딩 판정은 `보복 파국`, `집착 파국`, `끝나지 않은 탈출`, `대가 있는 생존`, `진상 생존` 다섯 단계를 사용
- 생존 모드 장면과 루트는 플레이어 캐릭터 확정 후 추가

## UI 바인딩

```text
visible.heroines.<id>.initiative      → 밀당 주도권
progress.flags.push_pull.combo        → 현재 콤보 배수
progress.flags.push_pull.position     → 당기기↔밀기 연속 위치
progress.flags.push_pull.target       → 현재 활성 득점선
progress.flags.push_pull.last_action  → 최근 이동 방향
progress.flags.push_pull.heroine      → 현재 흐름의 대상 인물

hidden.heroines.<id>.suspicion        → 의심도
hidden.heroines.<id>.dislike          → 비호감도
hidden.heroines.<id>.evidence_count   → 증거 개수

progress.flags.story_mode.target               → none | yoon_seo_a | cha_min_kyung
progress.flags.story_mode.final_interpretation → betrayal | romance
progress.flags.story_mode.home_incident        → none | reported | crossed_line | caught | escaped
progress.flags.story_mode.yoo_jin_intervention → 공략 불가 특수 엔딩 진입 여부
```

제16일에는 공식 절차를 실행하지 않는다. 제17일 `anchor.day_17_home_surprise`가 발생하고 공략 대상이 명백히 퇴거를 요구한 뒤 엔딩 장면에서 현장 신고를 기록한다. 증거가 충분하면 경찰의 정식 신병 처리 뒤 `story_mode.grooms_face`로, 부족하면 최종 해석과 현장 행동에 따라 네 파국으로 갈라진다. 회사 처분은 경찰 대응 후일담 노드에서만 렌더링한다.

각 스토리 모드 선택지는 아래 제작 메타데이터를 가진다.

```yaml
push_pull:
  action: approach # approach | space | literal
  intensity: 12    # 8..16
  base_score: 4    # 2..5
```

`push_pull`은 선택지에 표시하지 않는다. 런타임은 이 값으로 전역 리듬 상태를 갱신한다. 다른 인물로 이동하거나 사건 마감을 넘기면 콤보와 활성 득점선을 초기화하되 위치는 유지한다.

최초 엔딩 이후 `밀당 주도권`은 `통제 욕구`, `현재 콤보`는 `통제 시도 연쇄`, 리듬 게이지는 `접근 시도/거리 둠`으로 라벨을 교체한다.

`visible.heroines.<id>.affection`과 `visible.heroines.<id>.perceived_state`는 기존 데이터 호환을 위해 남아 있어도 스토리 모드 UI와 신규 장면 조건에는 사용하지 않는다.

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

빌드는 한국어 스토리 YAML과 `story/ui.yaml`에서 다음 안정 키를 자동 수집한다.

```text
scenes.<scene_id>.nodes.<node_id>.perceived.line
scenes.<scene_id>.nodes.<node_id>.reality.line
scenes.<scene_id>.nodes.<node_id>.reality.inner_thought
scenes.<scene_id>.nodes.<choice_node>.options.<option_id>.label
scenes.<scene_id>.nodes.<node_id>.variants.<variant_id>.reality.inner_thought
menu.newGame
```

`LocalizationService`와 웹 게임 `GameLocalizer`는 동일한 `resolved_catalogs`를 조회한다. 지원 언어 목록도 런타임 데이터에서 읽으며 코드 allowlist를 두지 않는다. `coverage.<locale>.missing`, `fallback_used`, `orphan`, `invalid_placeholders`, `by_domain`은 번역 QA에 사용한다.
- `time_slot_started(day, slot, act)`
- `event_became_eligible(event_id, reasons)`
- `event_started(event_id, availability)`
- `event_missed(event_id, trigger_event_id)`
- `offscreen_event_resolved(event_id)`
