# 스토리 데이터 명세

## 1. 식별자

- 모든 ID는 영문 소문자, 숫자, 밑줄과 점만 사용한다.
- 인물 ID: `yoon_seo_a`
- 루트 ID: `seo_a`
- 장면 ID: `seo_a.email_request`
- 노드 ID: 장면 안에서만 유일한 `dialogue_01`, `choice_interpretation`
- 표정 ID: 인물 안에서만 유일한 `subjective_shy`, `actual_tense`
- 한번 배포한 ID는 문구가 바뀌어도 변경하지 않는다. 세이브 데이터와 번역 키가 ID를 참조한다.

## 2. 상태 모델

상태는 세 영역으로 나눈다.

```yaml
visible:
  protagonist:
    self_development:
      appeal: 30
      stats: {health: 0, appearance: 0, humor: 0, intelligence: 0}
      fatigue: 1
  heroines:
    yoon_seo_a:
      affection: 50
hidden:
  heroines:
    yoon_seo_a:
      suspicion: 0
      dislike: 0
      evidence_count: 0
progress:
  time: {day: 1, act: 1, slot: morning}
  events: {seen: [], missed: [], expired: []}
  memories: []
  cleared_routes: []
  unlocked_modes: [base]
  self_development:
    completed_days: []
    activity_history: []
    last_activity: ""
    hint_charges: 0
  flags:
    push_pull:
      combo: 0
      position: 0
      target: none
      last_action: none
      heroine: ""
```

- `visible`: 플레이어와 주인공이 보는 값
- `hidden`: 스토리 모드에서 감춰지는 실제 상태
- `progress`: 현재 시간, 본·놓친 사건, 회차 기억, 루트 완료와 모드 해금

스토리 모드 UI가 표시하는 관계 정보는 `visible.heroines.<id>.affection`, `progress.flags.push_pull.combo`, `progress.flags.push_pull.position`과 `progress.flags.push_pull.target`이다. 각각 `호감도`, `x1~x5`의 순간 콤보, 숫자를 숨긴 `당기기↔밀기` 연속 위치와 현재 활성 득점선으로 표시한다. 선택지별 제작 분류와 수치 변화는 디버깅 모드에서만 보인다.

`position`은 `-100~100` 범위이며 음수는 당기기, 양수는 밀기다. 기본 적정 범위는 `-56~56`, 득점선은 `-32`와 `32`다. 한 선택의 기본 이동량은 12이며 장면 강도에 따라 `8~16`에서 조정한다. `target`은 `pull`, `push`, `none` 중 하나다.

히로인의 보이는 상태에는 플레이어와 한도윤에게 공략 성공으로 보이는 `affection`만 둔다. 이 호감도는 상대의 실제 사랑이나 동의를 증명하지 않는다. 구버전 세이브의 폐기된 `initiative`는 `affection`으로 이관하고 `perceived_state`는 제거한다. 콤보가 이어질 때는 원래 장면 효과와 별도로 반복 패턴 인식에 따른 숨은 효과를 적용할 수 있다.

감정은 별도 게이지로 만들지 않는다. 각 인물의 `emotion_rules`가 의심도·비호감도 구간을 표정과 행동 경향으로 변환한다.

`survivor_view`는 유저에게 `어나더 스토리`로 표시하는 안정 ID다. 최종 선택 가능한 윤서아 또는 차민경 라우트의 첫 엔딩을 보면 해금한다. 안내 문구는 `새로운 그녀로 새로운 이야기를 만들어 보아요`로 고정한다. `survivor_view` 캠페인의 플레이어 캐릭터는 후속 결정 전까지 스토리 데이터에 고정하지 않는다.

`base`와 `survivor_view`만 `GameModeId`로 사용한다. 장면 표시 레이어는 존재하지 않는다. 게임 모드의 캠페인·연속성·콘텐츠 상태·해금 조건은 `story/game_modes.yaml` 한 곳에서 관리한다.

생존 모드는 스토리 모드의 실제 시간선이나 후일담이 아니라 별도의 평행세계 캠페인이다. 스토리 모드와 같은 출발 상황, 날짜 모티프와 한도윤의 행동 패턴을 재사용해 첫 플레이와 공감대를 만들 수 있지만, 피해자의 선택에 따라 사건의 순서·내용과 결말은 스토리 모드에서 독립적으로 갈라질 수 있다. `survivor_view`의 사건을 스토리 모드에서 누락된 사실로 소급하지 않는다.

한도윤의 지속적 공격성은 피해자의 선택 결과가 아니다. 플레이어는 한도윤을 최대한 자극하지 않는 동시에 이미 벌어지는 행동의 물리적 증거를 확보·보존해야 한다. 증거를 위해 폭력을 직접 유도하는 선택은 작성하지 않는다.

스토리 모드의 파국은 생존 모드에서 대신 설명하지 않는다. 스토리 모드 엔딩 안에서 사건의 발생과 즉각적인 결과를 플레이어가 실제로 확인할 수 있어야 한다. 다만 범죄의 세부 방법은 재현하지 않고 피해, 부재, 남은 기록과 주변인의 반응을 중심으로 연출한다.

스토리 모드의 표면 공략 후보는 윤서아·차민경·강유진 세 명이다. 실제 최종 선택 후보는 윤서아와 차민경이며, 강유진은 호감도·밀당·개별 사건을 갖지만 결정적 선택에서 제외되는 위장 공략이다. 강유진의 호감도는 추후 확정할 전용 상한까지만 오르게 한다. 이 상한은 공략 불가를 플레이 중에 위장·연출하는 장치이며, 최종 선택 가능 여부는 `final_selectable` 계약으로 별도 고정한다. 정확한 상한 수치와 도달 연출은 후속 설계한다. 강유진은 사실관계를 확인하고 이상 징후를 알아차릴 수 있지만, 기본 결말에서 갑자기 모든 증거를 완성하거나 피해자를 구해 파국을 취소하는 해결사로 기능해서는 안 된다. 생존 모드에서의 플레이어·조력자·조연 역할은 별도로 결정한다.

삭제된 `collapse` 모드는 해금 값·루트·사건에서 사용하지 않는다.

## 3. 상태 경로와 연산

경로는 점 표기법을 사용한다.

```yaml
path: hidden.heroines.yoon_seo_a.suspicion
```

조건 연산:

- `eq`, `ne`
- `gt`, `gte`, `lt`, `lte`
- `contains`, `not_contains`
- `exists`, `not_exists`

효과 연산:

- `set`: 값을 교체
- `add`: 숫자를 더하고 manifest의 범위로 제한
- `append_unique`: 배열에 중복 없이 추가
- `remove`: 배열 원소 또는 맵 키 제거

## 4. 시간축 캠페인

게임 진행 데이터의 최상위 단위는 루트가 아니라 캠페인의 날짜와 시간대다.

```text
campaign → day → slot → eligible event → scene → node
```

- 기본 캠페인은 내부적으로 17일이며 `morning`, `lunch`, `afternoon`, `after_work` 네 시간대를 사용한다.
- 오전·오후는 고정 업무 사건, 점심·퇴근 후는 플레이어 선택 사건을 중심으로 배치한다.
- 루트는 처음 선택하는 선형 경로가 아니라 플레이 결과를 엔딩·해금 단위로 분류하는 메타데이터다.
- 날짜별 파일을 만들지 않는다. 이벤트가 `[시작일, 종료일]`, 허용 시간대와 마감을 가진다.
- 플레이어에게 별도의 타임라인·ACT 선택 화면이나 캠페인 총일수 홍보 문구를 노출하지 않는다.
- 런타임은 다음 의미 있는 사건으로 자동 진행하고 날짜가 바뀔 때만 짧은 전환 연출을 재생한다.
- 같은 시간대에 선택 가능한 사건이 여럿이면 타임라인 카드가 아니라 장면 안의 대사·상황 요약과 선택지로 고르게 한다.
- 1~16일의 `after_work` 사건 처리가 끝나면 날짜를 넘기기 전에 자기계발 밤 페이즈를 하루 한 번 연다. 별도 관리 화면을 만들지 않고 집에 돌아온 한도윤이 《여성의 마음을 지배하는 어둠의 심리학》을 몇 쪽 읽는 독백과 일반 대화 UI로 시작한 뒤, 선택 순간에만 현재 상태와 다섯 행동을 표시한다. 피로도 5 이상이면 선택 대신 혼술 사건이 강제로 발생한다. 17일은 최종 사건과 엔딩에 집중한다.
- 캠페인은 안정 ID, `entry_event_id`, `initial_state_patch`와 활성 시스템을 선언한다.
- 사건, 루트와 스레드는 `campaign_id`를 필수로 선언한다. 장면의 캠페인은 소속 루트에서 파생한다.
- 라우트의 `final_selectable`은 엔딩 도달 시 실제 최종 공략 완료로 기록할 수 있는지를 선언한다. 윤서아와 차민경 라우트는 `true`이며 엔딩에 도달하면 `progress.cleared_routes`와 모드 해금에 반영한다. 위장 공략인 강유진은 전용 표면 공략 흐름을 갖더라도 `false`를 유지한다.
- 런타임과 제작 도구는 캠페인 컬렉션의 첫 항목을 기본값으로 사용하지 않는다.
- 사건의 선행 사건, 놓침 연쇄, 연결 장면과 스레드는 같은 캠페인 안에서만 참조한다.
- manifest의 초기 상태를 복제한 뒤 캠페인의 `initial_state_patch`를 깊게 병합한다. 프로필에서는 완료 루트, 해금 모드와 회상만 명시적으로 가져온다.

## 5. 시간 이벤트

```yaml
id: seo_a.email_request
campaign_id: main
type: heroine
lane: yoon_seo_a
window: {days: [2, 3], slots: [lunch], deadline_day: 3}
priority: 60
availability: player
scene: seo_a.email_request
requires: {events: [], conditions: []}
on_seen: {effects: []}
on_missed:
  trigger_event: offscreen.seo_a_consults_min_kyung
  effects: []
presentation:
  title: 업무 전달 방식을 제한함
  summary: "..."
```

이벤트 상태는 `eligible`, `blocked`, `upcoming`, `seen`, `missed`로 판정한다. 고정·숨은 사건은 우선순위가 높은 것부터 자동 실행하며 같은 `exclusive_group`에서는 하나만 실행한다. 마감이 지난 사건은 `on_missed` 효과를 적용하고 오프스크린 사건을 열 수 있다. 이 판정과 사건 큐는 제작·디버깅 정보이며 일반 플레이 화면에는 타임라인으로 노출하지 않는다.

## 6. 사건 종류

- `anchor`: 모든 회차의 분위기와 속도를 고정하는 날짜 사건
- `heroine`: 플레이어가 선택하는 인물 스레드 사건
- `company`: 회사가 독립적으로 진행시키는 업무·절차 사건
- `offscreen`: 주인공이 보지 않아도 발생하는 실제 사건
- `ending`: 마지막 시간대에서 상태에 따라 선택되는 결말

## 7. 장면 구조

장면은 순서가 있는 노드 그래프다.

```yaml
id: seo_a.email_request
route: seo_a
start_node: opening
state_contract:
  reads: []
  writes: []
nodes:
  - id: opening
    kind: dialogue
    speaker: yoon_seo_a
    expression: actual_tense
    line: "그 자료는 메일로 보내주세요."
    next: interpretation
  - id: interpretation
    kind: choice
    stimulus: "방금 말하거나 행동한 사실을 한 문장으로 요약한다."
    options: []
  - id: leave
    kind: exit
    transitions: []
```

지원 노드:

- `dialogue`: 화자, 대사와 연출을 기록하는 단일 대사
- `narration`: 화자 이름표가 없는 단일 서술
- `silent`: 대사창 없이 배경과 배치 원화만 보여 주는 무대사 화면
- `choice`: 조건과 효과를 가진 선택지
- `state_gate`: 수치에 따라 노드 흐름을 나누는 조건문
- `effect`: 선택 없이 상태를 변경하는 사건
- `exit`: 다른 장면 또는 엔딩으로 이동

## 8. 단일 대사와 연출

모든 `dialogue`, `narration`, `silent` 노드는 하나의 대사·서술과 하나의 연출만 가진다. `perceived`, `reality`, `speakers`, `inner_voice`, `inner_thought`, `protagonist_interpretation`은 폐기된 필드·플래그다.

```yaml
- id: request
  kind: dialogue
  speaker: yoon_seo_a
  expression: actual_tense
  line: "그 자료는 메일로 보내주세요. 제 자리로 오지 마시고요."
  next: interpretation
```

- `line`은 화면에 표시되는 유일한 문장이다.
- 속마음 전용 시스템은 없다. 실제 혼잣말이 필요한 경우에만 일반 `dialogue`와 공통 `speaker`를 사용한다.
- 장면의 사실관계와 다른 숨은 원문을 함께 저장하지 않는다.
- 표정 ID는 화자의 인물 파일에 등록되어야 한다.
- `narration`은 화자 이름표 없이 문장만 표시한다. 플레이어 UI에 `나레이션`이라는 가상 화자명을 만들지 않는다.

### 대사별 화면 원화

모든 노드는 선택적으로 `stage`를 가질 수 있다. `stage`는 대사의 화자와 별개인 화면 배치이며 `choice`에도 사용할 수 있다.

```yaml
- id: response_choice
  kind: choice
  stimulus: "두 사람이 답을 기다린다."
  stage:
    - position: left
      character: yoon_seo_a
      visual_id: character.yoon_seo_a
      artwork: office_default
    - position: right
      character: cha_min_kyung
      visual_id: character.cha_min_kyung
      artwork: office_default
  options: []
```

- `stage` 키가 없으면 인물 원화를 표시하지 않는다. 런타임은 `cast`나 화자를 근거로 원화를 자동 배치하지 않는다.
- 새 `dialogue`는 화자를 선택하기 전까지 원화가 없다. 편집기에서 한도윤이 아닌 일러스트 화자를 처음 선택하면 `stage`에 해당 인물의 기본 원화를 `center`로 명시 저장한다.
- 한도윤은 후반 반전 공개 전용 예외다. 화자이거나 `cast`에 포함되어도 평상시 수동 `stage`에 넣을 수 없다.
- 한도윤 원화는 `ending.*`의 `narration` 노드가 `presentation_flags: [protagonist_art_reveal]`를 선언하고 `stage`에 `character.han_do_yoon`을 직접 배치한 경우에만 표시한다. 원화 파일과 비주얼 정의는 이 공개를 위해 보존한다.
- 자동·직접 배치 모두 현재 화자는 정상 색으로 강조하고, 함께 보이는 비화자는 살짝 어둡고 회색인 톤으로 낮춰 발화 전환을 구분한다.
- `stage: []`는 원화 전체 OFF다.
- 직접 배치는 `left`, `center`, `right`에 최대 3명이며 위치와 인물은 각각 중복될 수 없다.
- 비화자도 표시할 수 있지만 `character`는 장면의 illustrated `cast`에 포함되어야 한다.
- `visual_id`는 해당 캐릭터의 구체 visual을, `artwork`는 그 visual의 안정적인 artwork ID를 참조한다.
- 장면 YAML에는 이미지 파일 경로를 넣지 않는다. 실제 경로는 `story/visuals/characters/*.yaml`의 `artworks`에서 해석한다.

### 무대사 화면

배경이나 원화를 문구 없이 감상시키려면 `silent` 노드를 사용한다.

```yaml
- id: empty_office_view
  kind: silent
  line: ""
  stage: []
  next: closing
```

- `line: ""`를 명시해 의도적인 무대사임을 빈 초안과 구분한다.
- 화자·이름표·대사창·선택지는 표시하지 않는다.
- 일반 플레이에서는 HUD와 밀당 게이지도 숨기고 화면 클릭으로 다음 노드로 이동한다.
- `stage`를 비우면 배경만, 직접 배치하면 배경과 지정 원화를 함께 보여 준다.
- 장면 흐름·세이브·디버그 이전 화면 이동에서는 일반 표시 노드처럼 유지한다.

### 폐기된 이중 표현

`romance_insert`와 별도의 숨은 원문은 사용하지 않는다. 한도윤의 오해는 실제 대사를 변조하지 않고 선택지 `interpretation`, 후속 행동과 결과로 드러낸다.

## 9. 선택지

```yaml
- id: response_choice
  kind: choice
  prompt: "자료 전달 방식을 분명히 한 서아에게 어떻게 답할까?"
  stimulus: "서아가 자료는 메일로 보내고 자리로 오지 말라고 요청했다."
  interaction_context:
    kind: boundary
  options:
    - id: match_push
      label: "알겠다고 답하고 요청대로 자료만 메일로 보낸다"
      interpretation: "지금은 말수를 줄이고 다음 반응을 기다린다."
      action: "자료를 메일로 보내고 추가 접촉을 하지 않는다."
      push_pull:
        action: space
        intensity: 12
        base_score: 4
      conditions: []
      effects:
        - path: hidden.heroines.yoon_seo_a.suspicion
          op: add
          value: -12
      next: after_choice
```

선택 노드의 `stimulus`는 선택을 촉발한 직전 말이나 행동을 사실 중심의 한 문장으로 요약한다. 선택 화면은 이 요약을 문맥으로 먼저 보여 준다. `label`은 플레이어가 실제로 말하거나 수행할 구체적인 선택지, `interpretation`은 주인공이 믿는 미묘한 의미, `action`은 객관적으로 발생하는 행동이다. 세 필드를 섞지 않으며 `label`이나 `prompt`에 `밀기`, `당기기`, `push`, `pull` 같은 제작 판정을 직접 쓰지 않는다.

모든 선택 노드는 `interaction_context.kind`로 MBTI 요소의 적용 문맥을 분류한다.

- `support`: 위로, 실수 수습, 개인적 부담처럼 상대가 도움을 받아들이는 순서를 판단한다.
- `coordination`: 공동 업무의 사실, 실행안, 역할과 결정권을 조율한다.
- `boundary`: 명시적인 요청·거절·거리 두기를 원문 그대로 존중할지 판단한다.
- `not_applicable`: 인물 지원 화법을 판정하지 않는 내적 해석이나 사건 절차다.

`support`와 `coordination`의 모든 선택지는 `interaction`을 선언하고 한 노드에 서로 다른 화법 순서를 최소 두 개 둔다. `boundary`에는 `literal_respect` 선택지가 최소 하나 있어야 하며, 침범 행동을 MBTI 요소의 오답처럼 태깅하지 않는다. `not_applicable`에는 `interaction`을 선언하지 않는다.

`push_pull`은 제작·런타임 전용 분류이며 일반 선택지 화면과 결과 연출에는 노출하지 않는다. 선택지별 방향·강도와 계산 결과는 명시적으로 켠 디버깅 모드에서만 표시한다. `action`은 `approach`, `space`, `literal`, `intensity`는 `8~16`, `base_score`는 `2~5`를 사용한다. 런타임은 장면의 일반 `effects`를 먼저 적용한 뒤 이 메타데이터로 위치, 콤보, 득점선, 호감도와 반복 패턴 효과를 계산한다. 장면 효과에서 `affection`을 수동으로 변경하지 않는다.

MBTI 요소의 인물별 지원 화법을 쓴 선택은 `interaction`을 선언한다. 여러 공략 인물이 함께 있어 밀당 계산 대상도 장면 루트의 기본 히로인과 다르면 `push_pull.target`을 별도로 선언한다.

```yaml
push_pull:
  target: cha_min_kyung
  action: approach
  intensity: 12
  base_score: 4
interaction:
  target: cha_min_kyung
  support_styles:
    - factual_clarification
    - practical_resolution
```

`interaction.target`은 실제로 그 화법을 받아 반응하는 인물이며 현재 장면 `cast` 안의 캐릭터를 가리킨다. 전용 라우트가 아직 없는 후보나 일반 조연도 자신의 `interaction_preferences`가 있으면 대상이 될 수 있다. `support_styles`는 실제 대사와 행동에 사용한 지원 화법을 발화·행동 순서대로 기록하는 비노출 저작 메타데이터다. 첫 항목이 먼저 전달되는 중심 화법이며, 편집기와 빌드는 이 순서를 보존한다. 같은 대상에 서로 다른 화법 순서를 쓴 선택은 다음 선택이나 장면 종료 전에 대상의 서로 다른 실제 반응을 제공해야 한다. 이 메타데이터는 인물별 고유 반응을 검토하는 데 사용하며 그 자체로 호감도·숨은 수치를 가감하지 않는다.

`push_pull.target`은 밀당 위치·콤보·호감도와 반복 패턴을 어느 히로인에게 적용할지 정한다. 생략하면 장면 루트의 히로인을 사용한다. 명시 여부와 관계없이 계산 인물은 현재 장면 `cast` 안에 있어야 한다. 다른 인물을 지정했다면 그 인물의 호감도와 숨은 반복 패턴 경로도 `state_contract.writes`에 선언한다. 대화 반응 대상과 밀당 계산 대상은 같을 수 있지만 의미가 다르므로 런타임은 두 필드를 서로 대신 사용하지 않는다.

### 선택 직전 강사 힌트

`progress.self_development.hint_charges`는 `0~9`의 소비형 횟수다. 밤 활동 `dark_psychology`를 한 번 수행하면 피로가 `+2` 되고 힌트가 `+1` 충전된다. 기존 세이브에 값이 없으면 `0`으로 보충한다.

선택 노드에서 힌트를 사용하면 한 번을 즉시 소비하고 같은 선택 화면 안에서 상상 속 강사가 등장한다.

1. 강사가 현재 활성 득점선에 맞는 득점 행동을 결정적으로 말한다.
2. 선택 노드의 중립적 `stimulus`를 판단 근거인 실제 관찰 증거로 함께 제시한다.

활성 득점선이 아직 `none`이면 첫 수에는 정해진 정답이 없고 이번 선택이 다음 득점 방향을 만든다고 알려 준다. 그 밖의 경우에는 어떤 종류의 행동이 득점인지 단정할 수 있다. 힌트는 `approach`·`space` 내부 ID, 이동 수치, 예상 획득량, 구체적인 선택지 하나, 인물별 정답 표현과 숨은 상태를 노출하지 않는다.

강사 문구는 게임의 허구적 리듬 규칙만 설명한다. 현실에서 타인의 경계를 우회하거나 행동을 통제하는 재현 가능한 방법은 작성하지 않는다.

자기계발로 여는 표현은 일반 `conditions` 대신 전용 메타데이터를 사용한다.

```yaml
self_development:
  expression: health.workout_answer
  equivalent_to: match_push
  converges_at: after_choice
```

`manifest.self_development.expressions`가 매력도·능력치·피로·최근 활동 요구를 소유하며 `score_bonus`는 항상 `0`이다. `requires.last_activity`는 알려진 활동 ID 하나를 가리키며 `progress.self_development.last_activity`와 정확히 일치할 때만 표현을 연다. 해금 선택지는 같은 선택 노드의 조건 없는 기준 선택지를 `equivalent_to`로 가리키고, 기준과 같은 `push_pull` 및 `effects`를 사용하며, 짧은 고유 대사 뒤 `converges_at`으로 합류해야 한다. 두 분기의 `next`부터 합류점 직전까지는 `dialogue`, `narration`, `silent`만 허용하며 `effect`, `state_gate`, `choice`, `exit`를 둘 수 없다. 즉 스탯 상호작용은 표현과 반응을 늘리지만 밀당 점수와 숨은 상태를 보정하지 않는다.

대사 variant는 `self_development: {expression: <id>}`만 선언할 수 있다. 기본 variant는 항상 하나 남기며 자기계발 조건을 붙이지 않는다. 일반 장면과 엔딩은 자기계발 상태를 직접 읽지 않는다.

능력치의 주된 보상은 TRPG처럼 조건을 만족했을 때만 나타나는 추가 사건이다. 사건은 아래처럼 명명된 스탯만 직접 읽을 수 있다.

```yaml
availability: player
type: heroine
requires:
  events: []
  conditions:
    - {path: visible.protagonist.self_development.stats.intelligence, op: gte, value: 3}
on_seen:
  effects:
    - {path: progress.memories, op: append_unique, value: cg.stat.intelligence.min_kyung}
on_missed: {effects: []}
```

스탯 조건 사건은 `player` 선택형 `heroine` 또는 `company` 사건이고, 기존 사건을 대체하지 않으며 놓쳐도 효과나 다른 사건을 만들지 않는다. 사건을 보면 `manifest.gallery.entries`에 등록된 원화 메모리를 하나 이상 지급해야 한다. 매력도·피로도·최근 활동·힌트 횟수는 사건 조건으로 사용하지 않는다.

### 원화 갤러리

`manifest.gallery.entries`는 안정 원화 ID, 제목·설명 UI 키, 실제 이미지 경로, 영구 해금용 `unlock_memory`를 소유한다. 기본 공개 원화는 `default_unlocked: true`를 사용하고, 스탯 사건 원화는 `source_stat`과 `source_minimum`을 선언한다. 사건이 지급한 `progress.memories`는 자동 저장 시 플레이어 프로필에 합쳐지므로 새 회차에서도 해금 상태가 유지된다.

타이틀과 게임 메뉴의 `갤러리`는 등록된 모든 슬롯과 수집 수를 보여 준다. 잠긴 슬롯은 제목과 이미지를 숨기며, 해금된 원화만 확대 감상할 수 있다.

직전 밤 활동을 다음 날 스몰토크로 회수할 때는 각 화면에 실제로 표시될 완성 문장을 장면의 명시적 variant로 저장한다.

```yaml
- id: activity_pitch
  kind: dialogue
  speaker: han_do_yoon
  variants:
    - id: after_workout
      self_development: {expression: feedback.last_workout}
      line: "요즘 운동을 다시 시작했습니다. 앉아 있는 시간이 길어서 건강부터 챙기려고요."
    - id: default
      default: true
      line: "오늘은 가볍게 안부만 묻는다."
  next: activity_response
```

각 활동 variant는 `self_development.expression`으로 최근 활동 조건을 선언하고, 조건 없는 `default`를 마지막에 둔다. 각 `line`은 하나의 장면 YAML 필드가 직접 소유한다. 빌드는 이를 수정하거나 합성하지 않는다. 따라서 런타임 대사 선택, 백로그, 세이브, 번역, 에디터가 같은 안정 variant ID와 같은 완성 문장을 다룬다.

활동 콜백은 상대가 먼저 외모 변화를 알아보는 보상이 아니다. 한도윤이 운동·옷차림·OTT·짧은 영상·수면을 스몰토크나 자기소개 소재로 먼저 꺼내고, 상대는 그 발화에만 상황에 맞게 반응한다. 특히 하룻밤 활동만으로 체중 감소, 체형 변화나 객관적인 매력 상승을 서술하지 않는다. 활동 콜백은 문구와 짧은 현실 반응만 바꾸며 `effects`, 밀당 점수, 사건과 엔딩에는 영향을 주지 않는다.

## 10. 전이 우선순위

`state_gate`와 `exit`의 전이는 위에서 아래로 평가하며 처음 참인 항목을 사용한다. 마지막에는 조건 없는 `default: true` 전이가 정확히 하나 있어야 한다.

```yaml
transitions:
  - conditions:
      - path: hidden.heroines.yoon_seo_a.evidence_count
        op: gte
        value: 3
    scene: ending.seo_a.report
  - default: true
    scene: seo_a.relief_smile
```

## 11. 상태 계약

장면은 접근하는 상태를 명시해야 한다.

```yaml
state_contract:
  reads:
    - hidden.heroines.yoon_seo_a.suspicion
    - progress.flags.push_pull
  writes:
    - visible.heroines.yoon_seo_a.affection
    - hidden.heroines.yoon_seo_a.suspicion
    - hidden.heroines.yoon_seo_a.dislike
    - hidden.heroines.yoon_seo_a.evidence_count
    - progress.flags.push_pull
```

하네스는 조건에서 읽는 경로와 효과에서 쓰는 경로가 계약에 없으면 오류로 처리한다. 이 계약은 게임 코드의 의존성과 AI 컨텍스트를 동시에 제한한다.

## 12. 캐릭터 MBTI 요소와 감정 규칙

내부 기획에서는 캐릭터별 반응 화법 축을 **MBTI 요소**라고 부른다. 공략 대상과 주요 대화 상대는 `interaction_preferences`에 지원을 받아들이는 기본 순서를 기록할 수 있다.

```yaml
interaction_preferences:
  authoring_shorthand: MBTI 요소의 F 성향을 떠올리되 감정 인정부터 시작하는 지원 순서로만 사용한다.
  support_order:
    - emotional_validation
    - ask_before_helping
    - autonomy_return
    - practical_resolution
  prefers:
    - 놀람이나 부담을 먼저 구체적으로 알아차리는 말
  resists:
    - 동의를 묻지 않고 결정을 대신하는 해결책
  context_overrides:
    - 마감이 임박하면 복구 행동을 먼저 요청할 수 있다.
```

`authoring_shorthand`는 MBTI 요소를 빠르게 논의하기 위한 작가 참고용이며 선택지·대사·상시 HUD에서 성격 검사 결과나 정답표로 노출하지 않는다. 캐릭터 탭은 예외로, `player_profile.fields.mbti`에 등록한 유형을 해당 인물의 해금형 수집 정보로 표시한다. 실제 상호작용 데이터와 판정은 유형명이 아니라 행동 기반 `support_order`와 `support_styles`를 사용한다. `support_order`는 평상시 기본값이고 현재 상황, 명시적인 요청과 거절이 항상 우선한다. 순서에 맞는 대화는 고유 반응, 정보와 후속 콜백을 만들지만 실제 호감도 보너스·숨은 악영향을 자동으로 바꾸지 않는다. 장면 선택지의 객관적인 거리와 타이밍은 계속 `push_pull`에서 별도로 판정한다.

지원 화법의 안정 ID는 다음과 같다.

- `emotional_validation`: 감정과 부담을 구체적으로 인정한다.
- `factual_clarification`: 사실, 영향 범위와 근거를 확인한다.
- `practical_resolution`: 실행 가능한 해결책을 제시한다.
- `ask_before_helping`: 도움의 필요와 범위를 먼저 묻는다.
- `autonomy_return`: 최종 결정권을 상대에게 돌려준다.
- `concise_reassurance`: 근거와 조치 뒤에 짧게 안심시킨다.
- `literal_respect`: 명시적인 말, 요청과 거절을 그대로 존중한다.

인물 파일은 수치를 감정으로 해석한다.

```yaml
emotion_rules:
  - id: guarded
    priority: 20
    conditions:
      - stat: suspicion
        op: gte
        value: 40
    emotion: fear
    behavior: avoids_being_alone
    default_expression: actual_tense
```

우선순위가 높은 규칙부터 평가하며 첫 번째 일치 규칙을 사용한다. 감정 규칙은 표현을 결정하지만 상태를 직접 변경하지 않는다.

## 13. 다국어 문자열

한국어 장면 YAML과 `story/ui.yaml`은 기본 언어의 소스 오브 트루스다. 빌드는 인물·이벤트·장면·UI 표시 문자열을 출처 메타데이터가 있는 안정 키 레지스트리로 수집하고 `locales/<locale>.yaml`의 번역을 덮어쓴다.

```yaml
schema_version: 1
id: en
name: English
native_name: English
fallback: ko
strings:
  scenes.seo_a.email_request.title: Send It by Email
  scenes.seo_a.email_request.nodes.request.line: "Please send those materials by email."
```

- 키는 `scenes.<scene_id>.nodes.<node_id>...`처럼 배포 후 유지되는 ID로 만든다.
- 번역이 없으면 locale의 `fallback`, 마지막에는 기본 한국어 원문으로 되돌아간다.
- 런타임의 `localization.entries`, `direct_catalogs`, `resolved_catalogs`, `coverage`는 출처, 직접 번역, fallback 결과와 도메인별 누락을 제공한다.
- locale YAML의 중복 키, 고아 키, 원문과 다른 `{{placeholder}}` 집합은 빌드 오류다.
- 비주얼 제목과 locale 이름도 원본 문서에서 같은 레지스트리로 수집한다.
- 개발·릴리스 profile은 번역 누락, 동일 번역, 권장 길이와 필수 UI 도메인 coverage를 서로 다른 강도로 검사한다.
- 표시 언어는 세이브 상태가 아니라 사용자 설정으로 보관한다.

## 14. 비주얼 객체와 상속

배경과 캐릭터 일러스트는 장면에 파일 경로를 직접 반복하지 않는다. 모든 연출 자산은 공통 `VisualObject`를 토대로 한 다형 객체다.

```text
VisualObject
├── BackgroundArchetype → Background → Variant
└── CharacterArchetype  → Character  → Outfit + Pose + ExpressionAsset
```

- `extends`는 원형의 기본 렌더 전략, 배치와 공통 파츠를 상속한다.
- 구체 캐릭터 객체는 `character`를 정확히 하나 가리키고, 기본 자산이 준비되지 않았을 때 사용할 `fallback_asset`을 가진다.
- `layered_sprite`가 준비되면 기존 장면을 바꾸지 않고 의상·포즈·표정 자산만 추가한다.
- 상속은 공통값 재사용에만 사용하고, 의상·포즈·표정은 합성으로 조합한다.

배경 변형은 상황을 선언적으로 판정한다.

```yaml
variants:
  night:
    asset: assets/backgrounds/empty-office-night.png
    match:
      locations: [empty_office, design_team_desk]
      times: [evening, night]
    priority: 100
```

장면의 `location`, `time`과 일치하는 후보 중 우선순위 점수가 가장 높은 변형을 사용한다. validator는 모든 장면이 배경을 얻는지 검사한다.

한 씬에서 배경을 자주 바꾸지 않는 경우에는 씬 기본 배경을 안정 ID로 고정할 수 있다.

```yaml
default_background:
  visual_id: background.office_open
  variant_id: late_afternoon
```

- `default_background`이 없으면 장소·시간 자동 판정을 사용한다.
- 지정하면 씬 안의 모든 노드에서 같은 배경 variant를 기본으로 사용한다.
- scene에는 `visual_id`와 `variant_id`만 저장하며 실제 asset 경로는 background visual이 소유한다.
- 존재하지 않는 visual, 추상 visual, 캐릭터 visual 또는 존재하지 않는 variant는 검증 오류다.

## 15. 런타임 빌드

`build` 명령은 YAML을 하나의 JSON으로 합친다.

- 게임 모드, 캠페인, 이벤트, 스레드, 메타, 캐릭터, 비주얼 객체, 루트와 장면을 ID 맵으로 변환
- UI를 포함한 단일 문자열 레지스트리, locale fallback 카탈로그와 번역 coverage 포함
- 별도 `build/localization-report.json` 생성
- visual 상속을 해석한 구체 객체와 자산 경로 포함
- 원본 파일 위치를 `_source`에 기록
- manifest 초기 상태, 수치 정의와 `self_development` 활동·표현 레지스트리 포함
- 시스템 흐름과 장면의 명시적 대사·variant를 합성 없이 안정 ID 맵으로 변환
- 빌드 시각과 원본 해시 기록
- 게임 엔진은 YAML이 아니라 생성된 JSON만 읽어도 된다.

모드 레지스트리는 런타임의 `game_modes` 맵으로 빌드한다. `playable` 모드는 존재하는 캠페인을 참조해야 하고, `coming_soon` 모드는 캠페인 없이 예약 ID만 가질 수 있다. 캠페인별 이벤트 컬렉션은 `campaign_id`로 필터링하며 다른 캠페인의 사건을 실행하거나 만료 처리하지 않는다.

## 16. AI 컨텍스트 패키지

`context` 명령은 현재 장면 작성에 필요한 정보만 추린 JSON을 만든다.

- AI 작성 규칙
- 현재 루트와 장면 전체
- 출연 인물의 프로필·표정·감정 규칙
- 장면이 읽고 쓰는 상태 스냅샷
- 직접 연결된 다음 장면의 ID와 제목
- 허용되는 수치·연산·열거형
- 선택 경로를 시뮬레이션한 `branch_trace`
- 현재 장면 시작 노드의 두 모드별 `visual_scene`
- 번역 키·카탈로그·누락률을 포함한 `localization`

이 패키지 밖의 사실을 추측해서 새 설정으로 확정하지 않는다.

## 17. 회사 월드 바이블

`story/world/`는 회사 장면의 조직 사실을 담는 기계 판독용 소스다. 각 YAML은 하나의 엔티티를 정의하며 ID 접두사는 종류와 일치해야 한다.

```text
company.*
├── role.*
├── team.* ↔ member.* → story/characters/* (일러스트 인물만)
├── project.* → team.* + member.* + role.*
└── meeting.* → required teams + required project responsibilities
```

- `team.member_ids`와 `member.team`은 양방향으로 일치해야 한다.
- `member.name`은 설정상 본명이고 `member.display_name`은 플레이어가 보는 호칭이다. 텍스트 전용 동료는 `오차장`, `문부장`처럼 성과 직급을 결합한 짧은 호칭을 사용한다.
- `member.manager`는 같은 회사의 더 높은 랭크이며 인원 관리 권한이 있어야 하고 보고 순환은 금지한다.
- `presentation: illustrated`는 스토리 캐릭터 하나와 연결된다. `text_only`는 스토리 캐릭터·일러스트 캐스트·공략 라우트를 가질 수 없다.
- `route_eligible`은 현재 구현된 전용 라우트를 가진 멤버에게만 `true`다. 이 값은 `illustrated`이고 연결 캐릭터가 `main_heroine`일 때만 허용한다. 표면 공략 후보라도 전용 라우트가 아직 없으면 `false`로 두고 `story/meta/story_mode.yaml`에서 후보 상태를 선언한다.
- 프로젝트 배정자는 해당 프로젝트의 참여 팀에 소속해야 한다.

권한과 구성을 검증해야 하는 회의 장면은 다음처럼 제한된 월드 참조를 선언한다.

```yaml
world_context:
  company: company.dawon_living
  project: project.harudam_spring_campaign
  interaction: meeting.cross_function_kickoff
  participants:
    - member.han_do_yoon
    - member.yoon_seo_a
    - member.cha_min_kyung
    - member.kang_yoo_jin
    - member.oh_se_jin
    - member.jeong_da_eun
    - member.moon_ji_hye
```

`cast`는 화면에 그릴 인물의 `story_character` ID만 포함한다. `world_context.participants`는 일러스트가 없는 동료까지 포함한 실제 참석자 전원의 `member.*` ID다. validator는 회의 정책의 최소·최대 인원, 필수 팀·프로젝트 책임, 비일러스트 동료 최소치를 모두 검사한다.

`build`는 `world.entities`, `world.by_kind`, `world.story_character_members`를 출력한다. `context`는 장면에 선언된 회사·프로젝트·회의·참석자와 그들의 팀·직급만 `world_context`에 제공하여 다른 조직 사실을 임의로 혼합하지 못하게 한다.
