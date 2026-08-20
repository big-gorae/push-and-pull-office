# 게임 런타임 통합

## 데이터 흐름

```text
game_modes/campaigns/events/threads/meta/characters/routes/scenes/locales/visuals YAML
        │
        ├─ validate: 시간 범위·충돌·의존성·참조·그래프·단일 대사 검사
        ├─ timeline: 제작·디버깅용 사건 후보·차단 이유·오프스크린 진행 재현
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
  "version": 6,
  "gameModeId": "base",
  "campaignId": "main",
  "continuityId": "main",
  "currentEventId": "seo_a.relief_smile",
  "sceneId": "seo_a.relief_smile",
  "nodeId": "response_choice",
  "state": {
    "visible": {},
    "hidden": {},
    "progress": {}
  },
  "choices": [
    {
      "sceneId": "seo_a.email_request",
      "nodeId": "interpret",
      "optionId": "pull_harder"
    }
  ],
  "backlog": [
    {
      "sceneId": "seo_a.email_request",
      "nodeId": "request",
      "variantId": "default"
    }
  ]
}
```

- 장면·노드·선택지 ID가 세이브 호환성의 기준이다.
- 문구, 수치 또는 파일 위치가 바뀌어도 기존 ID는 유지한다.
- 수치 범위 제한은 런타임과 하네스가 동일한 manifest 정의를 사용한다.
- `state.progress.time`, `events.seen/missed/expired`, `memories`도 세이브에 포함한다.
- 표시 문자열과 번역 결과는 저장하지 않는다. 불러오기·백로그는 저장된 ID로 현재 locale에서 다시 해석한다.
- v2~v5 저장은 읽을 때 자기계발 기본 상태를 보충하고, 폐기된 표시 모드와 레이어는 `base` 게임 모드와 `main` 캠페인으로 변환한다.
- v6 저장은 `gameModeId`, `campaignId`, `continuityId`가 모두 있어야 한다. 알 수 없는 캠페인·모드와 미래 버전은 임의의 첫 캠페인으로 대체하지 않고 로드를 거부한다. 원본 localStorage 값은 그대로 보존한다.

슬롯 자체는 세션과 별도로 번역 독립적인 미리보기 ID만 저장한다.

```json
{
  "schema_version": 6,
  "savedAt": 1730000000000,
  "preview": {
    "kind": "scene",
    "day": 2,
    "slot": "lunch",
    "eventId": "seo_a.email_request",
    "sceneId": "seo_a.email_request",
    "nodeId": "request",
    "variantId": "default",
    "gameModeId": "base",
    "campaignId": "main",
    "continuityId": "main"
  },
  "session": {}
}
```

`preview`를 목록이 열리는 시점의 locale로 해석하므로, 저장 후 언어를 바꿔도 제목과 대사가 즉시 함께 바뀐다.
`preview.kind`는 `timeline`, `scene`, `self_development`, `ending` 중 하나이며 밤의 선택·결과 상태도 같은 v6 세션에서 이어서 불러온다. preview의 모드·캠페인 정체성은 정규화가 끝난 session에서 다시 계산한다.

## 시간 이벤트 처리

한 시간대가 시작되면 다음 순서로 처리한다.

```text
1. 마감이 지난 미발생 사건을 missed/expired로 이동
2. 각 사건의 on_missed 효과 적용
3. 해당 날짜·시간대의 고정 및 hidden 사건을 우선순위순 실행
4. player 사건 중 조건을 만족한 후보를 플레이어에게 표시
5. 선택한 사건의 장면을 실행하고 on_seen 효과 적용
6. 보이지 않는 인물 사건을 처리한 뒤 다음 시간대로 이동
7. `after_work`의 마지막 사건 뒤 1~16일이면 자기계발 밤 페이즈를 한 번 실행
```

사건 조건을 만족하지 못하면 런타임은 단순 `false`가 아니라 선행 사건, 상태 조건, 시간대와 마감 중 어떤 이유로 차단됐는지 디버그 정보로 남긴다. 스토리 모드 UI에는 이 이유를 숨기고 제작 에디터와 개발 로그에서만 표시한다.

일반 플레이에서는 별도 타임라인 화면을 열지 않는다. 런타임이 다음 의미 있는 사건까지 자동으로 진행하고, 날짜가 달라질 때만 짧은 날짜 전환 연출을 재생한다. 같은 시각에 고를 사건이 여럿이면 이벤트의 `presentation`을 장면 안의 상황 요약과 선택지로 렌더링한다.

`completion: return_to_timeline`은 기존 ID 호환을 위해 유지하는 내부 처리 이름이다. 장면이 끝나면 화면을 전환하는 대신 사건 큐로 돌아가 즉시 다음 의미 있는 장면을 계산한다. `honor_scene_exit`은 엔딩처럼 장면의 종료 전이를 그대로 따른다.

## 노드 처리

```text
dialogue / narration
  emotion_rules로 derived.characters를 계산
  priority, conditions와 self_development.expression으로 dialogue variant를 선택
  단일 speaker, line과 연출을 렌더링하고 next로 이동

choice
  conditions가 참이고 self_development.expression이 충족된 option만 표시
  stimulus로 직전 말·행동의 요약을 먼저 표시
  선택된 effects를 순서대로 적용
  self_development.expression은 추가 상호작용만 열고 밀당 점수는 보정하지 않음
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

## 게임 모드 렌더링

### 스토리 모드 (`base`)

- `expression`
- `line`
- 관계 HUD는 호감도, 현재 콤보 배수와 밀기·당기기 리듬 게이지만 표시
- 날짜와 사건 마감은 별도 타임라인이 아니라 날짜 전환과 장면의 대사·선택지로 전달

### 생존 모드 (`survivor_view`)

- 단일 대사와 연출을 렌더링
- 스토리 모드의 진실 보기나 후일담이 아닌 평행세계 캠페인으로 로드하며, 스토리 모드 세이브의 사건 결과를 덮어쓰지 않음
- 스토리 모드의 출발 상황과 날짜 모티프는 재사용할 수 있지만 동일한 핵심 사건과 결말을 강제하지 않음
- 강유진은 최종 선택 불가능한 표면 공략 후보로 로드하고 호감도 상한 80을 적용하되, 기본 엔딩에서 파국을 취소하는 해결사 플래그로 사용하지 않음
- 한도윤의 행동·말투·접촉 빈도를 숨은 위험 축의 단서로 표시하되 정확한 수치는 노출하지 않음
- 선택지의 `action`은 피해자 관점의 구체적인 대화·기록·연결 행동으로 작성하고 `밀기/당기기`라는 판정을 노출하지 않음
- 증거 인벤토리는 표시하되 엔딩 합격선은 숨김
- 엔딩 판정은 `보복 파국`, `집착 파국`, `끝나지 않은 탈출`, `대가 있는 생존`, `진상 생존` 다섯 단계를 사용
- 생존 모드 장면과 루트는 플레이어 캐릭터 확정 후 추가

## UI 바인딩

```text
visible.heroines.<id>.affection      → 호감도
progress.flags.push_pull.combo        → 현재 콤보 배수
progress.flags.push_pull.position     → 당기기↔밀기 연속 위치
progress.flags.push_pull.target       → 현재 활성 득점선
progress.flags.push_pull.last_action  → 최근 이동 방향
progress.flags.push_pull.heroine      → 현재 흐름의 대상 인물

visible.protagonist.self_development.appeal           → 밤 화면의 매력도
visible.protagonist.self_development.stats.<stat>      → 건강 | 외모 | 유머 | 지성
visible.protagonist.self_development.fatigue           → 피로도
progress.self_development.completed_days               → 밤 활동을 마친 날짜
progress.self_development.activity_history             → 선택한 활동 ID 기록
progress.self_development.last_activity                → 최근 활동 ID
progress.self_development.hint_charges                 → 선택 직전 머릿속 강사 힌트 잔여 횟수

hidden.heroines.<id>.suspicion        → 의심도
hidden.heroines.<id>.dislike          → 비호감도
hidden.heroines.<id>.evidence_count   → 증거 개수

progress.flags.story_mode.target               → none | yoon_seo_a | cha_min_kyung | kang_yoo_jin
progress.flags.story_mode.final_interpretation → betrayal | romance
progress.flags.story_mode.home_incident        → none | reported | crossed_line | caught | escaped
progress.flags.story_mode.yoo_jin_intervention → 강유진이 직접 사건 당사자가 되는 임시 특수 엔딩 진입 여부
```

제16일에는 공식 절차를 실행하지 않는다. 제17일 `anchor.day_17_home_surprise`가 발생하고 공략 대상이 명백히 퇴거를 요구한 뒤 엔딩 장면에서 현장 신고를 기록한다. 증거가 충분하면 경찰의 정식 신병 처리 뒤 `story_mode.grooms_face`로, 부족하면 최종 해석과 현장 행동에 따라 네 파국으로 갈라진다. 회사 처분은 경찰 대응 후일담 노드에서만 렌더링한다.

각 스토리 모드 선택지는 아래 제작 메타데이터를 가진다.

```yaml
interaction_context:
  kind: coordination # support | coordination | boundary | not_applicable
push_pull:
  target: cha_min_kyung # 생략하면 장면 루트의 히로인
  action: approach # approach | space | literal
  intensity: 12    # 8..16
  base_score: 4    # 2..5
interaction:
  target: cha_min_kyung
  support_styles: [factual_clarification, practical_resolution]
```

`interaction_context`는 선택 노드에, `push_pull`과 `interaction`은 각 선택지에 보존되지만 일반 플레이 화면에는 표시하지 않는다. `support`·`coordination`은 모든 옵션의 반응 대상과 화법 순서를 검증하고, `boundary`는 `literal_respect` 선택을 보장하며, `not_applicable`은 인물 화법을 판정하지 않는다. 런타임은 `push_pull.target`만 밀당 계산 인물로 사용하며, 생략된 경우에만 장면 루트의 히로인을 사용한다. 계산 인물은 현재 장면 `cast` 안에 있어야 한다. `interaction.target`은 실제 화법을 받아 반응하는 인물이고 `support_styles`는 발화·행동 순서대로 보존하는 반응 저작·검수용 메타데이터다. 전용 라우트가 없는 후보나 조연도 반응 대상이 될 수 있지만, 런타임은 `interaction.target`을 점수 대상의 대체값으로 사용하거나 그 인물의 히로인 상태를 임의 생성하지 않는다. 지원 화법 메타데이터 자체는 호감도·숨은 수치에 아무 효과도 주지 않는다.

명시적인 요청·거절·접촉 중단이 나온 선택에서는 인물의 평상시 순서보다 `literal_respect`를 우선한다. 이 화법은 요청을 그대로 지킨다는 저작 계약이지 점수 보너스가 아니며, `literal` 계산으로 한도윤의 흐름이 끊겨도 현실의 경계 존중에 숨은 악영향을 자동 생성하지 않는다.

런타임은 장면의 일반 `effects`를 먼저 적용하고 `push_pull.target ?? route.heroine`에 리듬 결과를 적용한다. 여러 선택이 서로 다른 계산 인물을 가진 공용 장면에 진입할 때는 선택 전에 콤보 대상을 미리 바꾸지 않는다. 실제 선택 뒤 계산 인물이 달라졌을 때만 기존 흐름을 끊고 새 인물의 흐름을 시작한다. 다른 인물로 확정 이동하거나 사건 마감을 넘기면 콤보와 활성 득점선을 초기화하되 위치는 유지한다.

이름이 비슷하지만 `option.push_pull.target`은 계산할 **인물 ID**이고, `progress.flags.push_pull.target`은 현재 향하는 **득점선 방향**(`pull`, `push`, `none`)이다. 현재 콤보 인물은 `progress.flags.push_pull.heroine`에 저장한다.

자기계발 해금 선택지는 `self_development.expression`, 같은 선택 노드의 `equivalent_to`, 합류 노드 `converges_at`을 선언한다. 요구 수치와 최근 활동 ID는 `manifest.self_development.expressions`가 소유하고 `score_bonus`는 항상 `0`이다. 해금 선택지는 기준 선택지와 `push_pull` 및 `effects`가 같아야 하며 고유 대사·행동·짧은 반응만 추가한다. 능력치의 주된 보상은 `event.requires.conditions`가 `visible.protagonist.self_development.stats.<stat>`을 읽어 여는 추가 `player` 사건이다. 매력도·피로도·최근 활동·힌트 횟수, 보이는 호감도와 자기계발 상태는 그 밖의 일반 조건과 엔딩에서 읽지 않는다.

스탯 조건 사건은 `on_seen.effects`로 등록된 갤러리 `unlock_memory`를 `progress.memories`에 추가한다. 자동·수동 저장이 이를 플레이어 프로필의 `memories`에 합치며, 타이틀과 게임 메뉴의 갤러리는 `runtime.gallery.entries`와 프로필 메모리를 비교해 잠금 상태를 복원한다.

직전 밤 활동의 스몰토크는 각 장면 YAML의 명시적 `variants.after_*`와 `default` 완성 문장으로 저장한다. 빌더는 문장을 합성하지 않고 이 variant를 그대로 런타임에 옮기므로 플레이어 resolver, 세이브, 백로그, localization key와 에디터의 물리 원본이 일치한다. 밤 활동 화면과 심리학 강사 오버레이의 서사 문장은 `story/system_flows/`가 소유하고, `story/ui.yaml`에는 버튼·상태 라벨 같은 비서사 UI만 둔다.

리듬 막대는 대사창 바로 위 오른쪽에 충분한 폭과 대비로 배치한다. 적정 구간은 기존보다 넓은 시각 영역으로 표현하되 `중앙 적정 범위 안` 같은 설명 문구를 화면에 반복하지 않는다. 선택지별 `approach`/`space`/`literal`, 강도, 수치 합산과 숨은 효과는 디버깅 모드를 명시적으로 켰을 때만 표시한다.

구버전 세이브에 남은 폐기 상태 필드는 로드 정규화 과정에서 제거한다. 히로인의 보이는 상태에는 `visible.heroines.<id>.affection`만 사용한다.

hidden 값은 일반 UI나 게임 로그에 노출하지 않는다.

## 배경·캐릭터 아트 자산

장면은 파일 경로가 아니라 캐릭터의 expression ID를 참조한다. `VisualResolver`가 캐릭터 객체의 의상·포즈·표정 자산을 조합하고, 아직 전용 자산이 없으면 `fallback_asset`을 사용한다.

```text
(character_id, expression_id, outfit_id, pose_id) → character visual object → sprite asset
```

배경은 `scene.location + scene.time`으로 후보를 거른 뒤 priority와 일치 차원 점수가 가장 높은 variant를 사용한다. 캐릭터 YAML의 `visual.concept_art`는 제작 참고 자산이며, 현재 구체 객체의 `fallback_asset`으로도 사용된다. 전용 스프라이트가 추가되면 장면 데이터 변경 없이 교체할 수 있다.

`dialogue`의 현재 화자는 `node.speaker`를 사용한다. 런타임은 단일 `stage`에 명시된 원화만 무대에 표시하며, `text_only` 월드 멤버와 화자가 없는 `narration`에는 임의의 일러스트를 만들지 않는다. `나레이션`이라는 가상 이름은 출력하지 않는다.

디버깅 모드는 캐릭터 X/Y/크기 조절과 이전 대화 이동을 제공한다. 이 배치값은 제작용 설정으로 저장하며 스토리 YAML에 자산 경로나 임시 좌표를 복제하지 않는다.

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
scenes.<scene_id>.nodes.<node_id>.line
scenes.<scene_id>.nodes.<choice_node>.stimulus
scenes.<scene_id>.nodes.<choice_node>.options.<option_id>.label
scenes.<scene_id>.nodes.<choice_node>.options.<option_id>.interpretation
scenes.<scene_id>.nodes.<choice_node>.options.<option_id>.action
menu.newGame
```

`LocalizationService`와 웹 게임 `GameLocalizer`는 동일한 `resolved_catalogs`를 조회한다. 지원 언어 목록도 런타임 데이터에서 읽으며 코드 allowlist를 두지 않는다. `coverage.<locale>.missing`, `fallback_used`, `orphan`, `invalid_placeholders`, `by_domain`은 번역 QA에 사용한다.
- `time_slot_started(day, slot, act)`
- `event_became_eligible(event_id, reasons)`
- `event_started(event_id, availability)`
- `event_missed(event_id, trigger_event_id)`
- `offscreen_event_resolved(event_id)`
