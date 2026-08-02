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
      stats: {stamina: 0, appearance: 0, humor: 0, taste: 0}
      fatigue: 1
  heroines:
    yoon_seo_a:
      affection: 0
      initiative: 50
      perceived_state: neutral
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

스토리 모드 UI가 표시하는 관계 정보는 `visible.heroines.<id>.initiative`, `progress.flags.push_pull.combo`, `progress.flags.push_pull.position`과 `progress.flags.push_pull.target`이다. 각각 `밀당 주도권`, `x1~x5`의 순간 콤보, 숫자를 숨긴 `당기기↔밀기` 연속 위치와 현재 활성 득점선으로 표시한다. 최초 엔딩 이후 속마음 모드에서는 라벨을 `통제 욕구`, `통제 시도 연쇄`와 `접근 시도/거리 둠`으로 바꾼다. 선택지별 제작 분류와 수치 변화는 디버깅 모드에서만 보인다.

`position`은 `-100~100` 범위이며 음수는 당기기, 양수는 밀기다. 기본 적정 범위는 `-56~56`, 득점선은 `-32`와 `32`다. 한 선택의 기본 이동량은 12이며 장면 강도에 따라 `8~16`에서 조정한다. `target`은 `pull`, `push`, `none` 중 하나다.

`affection`과 `perceived_state`는 기존 장면·세이브 호환을 위해 상태 모델에 남아 있지만 신규 장면 조건이나 UI에는 사용하지 않는다. 콤보가 이어질 때는 원래 장면 효과와 별도로 반복 패턴 인식에 따른 숨은 효과를 적용할 수 있다.

감정은 별도 게이지로 만들지 않는다. 각 인물의 `emotion_rules`가 의심도·비호감도 구간을 표정, 속마음, 행동 경향으로 변환한다.

`truth_view`는 유저에게 `속마음 모드`, `survivor_view`는 `어나더 스토리`로 표시하는 안정 ID다. 서아나 민경 루트의 첫 엔딩을 보면 둘을 동시에 해금한다. 속마음 모드의 안내 문구는 `그녀들의 일상과 속마음을 들어 보아요`, 어나더 스토리의 안내 문구는 `새로운 그녀로 새로운 이야기를 만들어 보아요`로 고정한다. `survivor_view` 캠페인의 플레이어 캐릭터는 후속 결정 전까지 스토리 데이터에 고정하지 않는다.

게임 모드와 표시 레이어는 서로 다른 값이다. `base`, `truth_view`, `survivor_view`는 `GameModeId`이고 `perceived`, `reality`는 `ViewLayer`다. 게임 모드의 캠페인·연속성·시작 레이어·콘텐츠 상태·해금 조건은 `story/game_modes.yaml` 한 곳에서 관리한다. 일반 플레이 중 모드나 레이어를 바꾸지 않으며, 디버그 레이어 미리보기는 세션에 저장하지 않는다.

생존 모드는 스토리 모드의 실제 시간선이나 후일담이 아니라 별도의 평행세계 캠페인이다. 스토리 모드와 같은 출발 상황, 날짜 모티프와 한도윤의 행동 패턴을 재사용해 첫 플레이와 공감대를 만들 수 있지만, 피해자의 선택에 따라 사건의 순서·내용과 결말은 스토리 모드에서 독립적으로 갈라질 수 있다. 스토리 모드 장면의 객관적 진실은 `truth_view`가 담당하며, `survivor_view`의 사건을 스토리 모드에서 누락된 사실로 소급하지 않는다.

한도윤의 지속적 공격성은 피해자의 선택 결과가 아니다. 플레이어는 한도윤을 최대한 자극하지 않는 동시에 이미 벌어지는 행동의 물리적 증거를 확보·보존해야 한다. 증거를 위해 폭력을 직접 유도하는 선택은 작성하지 않는다.

스토리 모드의 파국은 생존 모드에서 대신 설명하지 않는다. 스토리 모드 엔딩 안에서 사건의 발생과 즉각적인 결과를 플레이어가 실제로 확인할 수 있어야 한다. 다만 범죄의 세부 방법은 재현하지 않고 피해, 부재, 남은 기록과 주변인의 반응을 중심으로 연출한다.

강유진은 스토리 모드와 `truth_view`에 계속 등장하는 비공략 조연이다. 사실관계를 확인하고 다른 인물의 이상 징후를 알아차릴 수는 있지만, 기본 결말에서 갑자기 모든 증거를 완성하거나 피해자를 구해 파국을 취소하는 해결사로 기능해서는 안 된다. 한도윤이 유진을 직접 사건 당사자로 끌어들인 특수 엔딩 `공략 불가`에서만 공식 대응한다. 생존 모드에서의 플레이어·조력자·조연 역할은 별도로 결정한다.

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
- 1~16일의 `after_work` 사건 처리가 끝나면 날짜를 넘기기 전에 자기계발 밤 페이즈를 하루 한 번 연다. 17일은 최종 사건과 엔딩에 집중한다.
- 캠페인은 안정 ID, `entry_event_id`, `initial_state_patch`와 활성 시스템을 선언한다.
- 사건, 루트와 스레드는 `campaign_id`를 필수로 선언한다. 장면의 캠페인은 소속 루트에서 파생한다.
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
  perceived: {title: 서아가 거리를 재는 점심, summary: "..."}
  reality: {title: 업무 전달 방식을 제한함, summary: "..."}
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
    kind: dual_dialogue
    speaker: yoon_seo_a
    perceived: {}
    reality: {}
    next: opening_inner
  - id: opening_inner
    kind: dual_dialogue
    presentation_flags: [inner_voice]
    speakers: {perceived: han_do_yoon, reality: yoon_seo_a}
    perceived: {}
    reality: {}
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

- `dual_dialogue`: 인지 화면과 실제 화면을 동시에 기록하는 대사
- `dual_narration`: 화자가 없는 이중 서술
- `choice`: 조건과 효과를 가진 선택지
- `state_gate`: 수치에 따라 노드 흐름을 나누는 조건문
- `effect`: 선택 없이 상태를 변경하는 사건
- `exit`: 다른 장면 또는 엔딩으로 이동

## 8. 이중 레이어

모든 `dual_dialogue`와 `dual_narration`은 두 레이어를 반드시 가진다. 대사와 생각은 같은 노드의 위아래 보조문단으로 합치지 않고 각각 독립된 발화 노드로 이어 붙인다.

```yaml
- id: request
  kind: dual_dialogue
  speaker: yoon_seo_a
  perceived:
    atmosphere: warm_romance
    expression: subjective_shy
    line: "그 자료는 메일로 보내주세요. 제 자리로 오지 마시고요."
  reality:
    atmosphere: cold_office
    expression: actual_tense
    line: "그 자료는 메일로 보내주세요. 제 자리로 오지 마시고요."
    intent: boundary
  next: request_inner

- id: request_inner
  kind: dual_dialogue
  presentation_flags: [inner_voice]
  speakers:
    perceived: han_do_yoon
    reality: yoon_seo_a
  perceived:
    atmosphere: warm_romance
    line: "(직접 찾아올 핑계가 없어져서 아쉬운가? 눈을 피하는 게 귀엽네.)"
  reality:
    atmosphere: cold_office
    line: "(또 내 자리로 오면 민경 선배에게 말해야 해.)"
    intent: boundary
  next: interpretation
```

- `reality.line`은 객관적으로 발화된 문장이다. 특별한 환청·기억 왜곡 연출이 아니라면 `perceived.line`도 핵심 사실관계를 유지한다.
- `protagonist_interpretation`과 `inner_thought`는 폐기된 필드이며 신규·수정 장면에서 사용하지 않는다.
- 생각과 내적 관찰은 `presentation_flags: [inner_voice]`인 별도 `dual_dialogue`로 작성한다.
- `inner_voice`는 레이어마다 주체가 다를 수 있으므로 공통 `speaker` 대신 `speakers.perceived`와 `speakers.reality`를 모두 선언한다.
- 레이어의 speaker가 문자열이면 그 인물의 1인칭 속말이므로 `line`을 괄호로 감싸고 해당 이름표를 표시한다.
- 레이어의 speaker가 명시적 `null`이면 인물의 생각이 아니라 권위적 서술이다. 괄호 없이 쓰고 이름표를 표시하지 않는다.
- `intent`는 현실 레이어의 실제 의도를 분류하며 플레이어에게 대사 아래 설명문으로 그대로 출력하지 않는다.
- 속마음 모드에서는 `reality`를 표시하고, 스토리 모드에서는 `perceived`를 표시한다.
- 표정 ID는 화자의 인물 파일에 등록되어야 한다.
- `dual_narration`은 화자 이름표 없이 문장만 표시한다. 플레이어 UI에 `나레이션`이라는 가상 화자명을 만들지 않는다.

### `romance_insert`

`romance_insert`는 한도윤이 실제 대사 끝에 없었던 짧은 한 구절을 덧붙여 기억하는 제한적 예외다.

```yaml
presentation_flags: [romance_insert]
perceived:
  line: "월요일에 뵙겠습니다. 다음에 또 봬요."
reality:
  line: "월요일에 뵙겠습니다."
```

- 한 노드에서 실제와 달라지는 부분은 한 문장 또는 한 절이어야 한다.
- 실제 사건, 선택 결과와 상태 변화는 `reality`와 `effects`를 따른다.
- 일반적인 호감 해석, 표정 미화와 따뜻한 분위기에는 이 플래그를 쓰지 않는다.
- 스토리 모드 렌더러는 이 플래그에 최종 선택된 고유 베일 효과를 적용하고, 속마음 모드는 효과 없이 `reality.line`만 표시한다.
- 제작용 플래그 이름은 플레이어 UI와 도움말에 노출하지 않는다.
- 스토리 1의 배치와 시각값은 `docs/story-1-romance-insert.md`를 원문으로 삼는다.

## 9. 선택지

```yaml
- id: response_choice
  kind: choice
  prompt: "자료 전달 방식을 분명히 한 서아에게 어떻게 답할까?"
  stimulus: "서아가 자료는 메일로 보내고 자리로 오지 말라고 요청했다."
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

`push_pull`은 제작·런타임 전용 분류이며 일반 선택지 화면과 결과 연출에는 노출하지 않는다. 선택지별 방향·강도와 계산 결과는 명시적으로 켠 디버깅 모드에서만 표시한다. `action`은 `approach`, `space`, `literal`, `intensity`는 `8~16`, `base_score`는 `2~5`를 사용한다. 런타임은 장면의 일반 `effects`를 먼저 적용한 뒤 이 메타데이터로 위치, 콤보, 득점선, 주도권과 반복 패턴 효과를 계산한다. 장면 효과에서 `affection`, `perceived_state`, `initiative`를 수동으로 변경하지 않는다.

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

`interaction.target`은 실제로 그 화법을 받아 반응하는 인물이며 현재 장면 `cast` 안의 캐릭터를 가리킨다. 공략 불가 조연도 자신의 `interaction_preferences`가 있으면 대상이 될 수 있다. `support_styles`는 실제 대사와 행동에 사용한 지원 화법을 기록하는 비노출 저작 메타데이터다. 인물별 고유 반응을 검토하는 데 사용하며 그 자체로 호감도·주도권·숨은 수치를 가감하지 않는다.

`push_pull.target`은 밀당 위치·콤보·주도권과 반복 패턴을 어느 히로인에게 적용할지 정한다. 생략하면 장면 루트의 히로인을 사용한다. 명시 여부와 관계없이 계산 인물은 현재 장면 `cast` 안에 있어야 한다. 다른 인물을 지정했다면 그 인물의 주도권과 숨은 반복 패턴 경로도 `state_contract.writes`에 선언한다. 대화 반응 대상과 밀당 계산 대상은 같을 수 있지만 의미가 다르므로 런타임은 두 필드를 서로 대신 사용하지 않는다.

자기계발로 여는 표현은 일반 `conditions` 대신 전용 메타데이터를 사용한다.

```yaml
self_development:
  expression: stamina.workout_answer
  equivalent_to: match_push
  converges_at: after_choice
```

`manifest.self_development.expressions`가 매력도·능력치·피로·최근 활동 요구와 `score_bonus`를 소유한다. `requires.last_activity`는 알려진 활동 ID 하나를 가리키며 `progress.self_development.last_activity`와 정확히 일치할 때만 표현을 연다. 직전 밤 선택을 다음 날 짧게 회수하는 대사에는 `score_bonus: 0`을 사용한다. 해금 선택지는 같은 선택 노드의 조건 없는 기준 선택지를 `equivalent_to`로 가리키고, 기준과 같은 `push_pull` 및 `effects`를 사용하며, 짧은 고유 대사 뒤 `converges_at`으로 합류해야 한다. 두 분기의 `next`부터 합류점 직전까지는 `dual_dialogue`와 `dual_narration`만 허용하며 `effect`, `state_gate`, `choice`, `exit`를 둘 수 없다. 보너스는 밀당의 `score` 또는 `turn` 판정이 성립할 때만 보이는 주도권에 `0~3`을 더한다. 위치, 콤보, 득점선, hidden 상태, 사건과 엔딩 판정은 바꾸지 않으며, 보이는 주도권 `visible.heroines.<id>.initiative`는 일반 조건에서 읽을 수 없다.

대사 variant는 `self_development: {expression: <id>}`만 선언할 수 있다. 기본 variant는 항상 하나 남기며 자기계발 조건을 붙이지 않는다. `visible.protagonist.self_development`와 `progress.self_development` 경로는 일반 장면·사건·엔딩 조건에서 직접 읽지 않는다.

직전 밤 활동을 다음 날 스몰토크로 회수할 때는 같은 다섯 활동 variant를 장면마다 복제하지 않고 저작 전용 `self_development_template`을 사용할 수 있다. 활동별 공통 소재는 `manifest.self_development.conversation_topics`가 소유한다.

```yaml
self_development:
  conversation_topics:
    workout:
      variant_id: after_workout
      expression: feedback.last_workout
      slots:
        formal_opener: "요즘 운동을 다시 시작했습니다."
        formal_pitch: "앉아 있는 시간이 길어서 체력부터 챙기려고요."
```

`slots`의 값은 조사나 어미 조각이 아니라 그대로 발화할 수 있는 완결된 한국어 문장으로 작성한다. 장면 템플릿이 참조하는 모든 `{{slot_id}}`는 모든 대화 소재에 존재해야 하며, 알 수 없거나 비어 있는 슬롯은 빌드 오류다. `variant_id`와 `expression`은 배포 뒤 유지하고, `expression`은 해당 활동을 `requires.last_activity`로 요구하면서 `score_bonus: 0`인 표현을 가리킨다.

```yaml
- id: activity_pitch
  kind: dual_dialogue
  speaker: han_do_yoon
  perceived:
    atmosphere: warm_office
    line: "오늘은 가볍게 안부만 묻는다."
  reality:
    atmosphere: neutral_office
    line: "오늘은 가볍게 안부만 묻는다."
    intent: work_only
  self_development_template:
    source: last_activity
    perceived:
      line: "{{formal_opener}} {{formal_pitch}}"
    reality:
      line: "{{formal_opener}} {{formal_pitch}}"
      intent: self_promotion
  next: activity_response
```

`source`는 `last_activity`만 허용한다. 제공한 각 레이어 overlay에는 `line`이 필수이며, `perceived`는 `atmosphere`, `expression`, `line`을, `reality`는 여기에 `intent`까지 더해 같은 이름의 기본 레이어 스칼라를 덮어쓸 수 있다. 공통 speaker 또는 레이어별 speakers는 노드에만 남아 템플릿이 바꾸지 못한다. 생략한 스칼라는 기본 노드 값을 상속하고, 기본 `perceived`·`reality` 전체는 활동이 없을 때 사용할 조건 없는 fallback이다. 따라서 평소 업무 대사의 현실 intent가 `work_only`여도 활동 variant만 `self_promotion`으로 구분할 수 있다. 빌드는 각 `conversation_topics` 항목을 `variant_id`와 `self_development.expression`을 가진 일반 대사 variant로 펼치고 fallback은 안정 ID `default`인 기본 variant로 만든 뒤, 저작 매크로를 런타임 출력에서 제거한다. 따라서 런타임 대사 선택, 백로그, 세이브와 번역은 기존의 안정 variant ID만 다룬다.

활동 콜백은 상대가 먼저 외모 변화를 알아보는 보상이 아니다. 한도윤이 운동·옷차림·OTT·짧은 영상·수면을 스몰토크나 자기소개 소재로 먼저 꺼내고, 상대는 그 발화에만 상황에 맞게 반응한다. 특히 하룻밤 활동만으로 체중 감소, 체형 변화나 객관적인 매력 상승을 서술하지 않는다. 생성된 콜백은 문구와 짧은 현실 반응만 바꾸며 `effects`, 밀당 점수, 사건과 엔딩에는 영향을 주지 않는다.

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
    - visible.heroines.yoon_seo_a.initiative
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

`authoring_shorthand`는 MBTI 요소를 빠르게 논의하기 위한 작가 참고용이며 플레이어에게 성격 검사 결과나 정답표로 노출하지 않는다. 실제 데이터는 유형이 아니라 행동 기반 `support_order`와 `support_styles`를 사용한다. `support_order`는 평상시 기본값이고 현재 상황, 명시적인 요청과 거절이 항상 우선한다. 순서에 맞는 대화는 고유 반응, 정보와 후속 콜백을 만들지만 실제 호감도·주도권 보너스·숨은 악영향을 자동으로 바꾸지 않는다. 장면 선택지의 객관적인 거리와 타이밍은 계속 `push_pull`에서 별도로 판정한다.

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
  scenes.seo_a.email_request.nodes.request.reality.line: "Please send those materials by email."
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
- 구체 캐릭터 객체는 `character`를 정확히 하나 가리키고, 레이어 자산이 준비되지 않았을 때 사용할 `fallback_asset`을 가진다.
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
      atmospheres: [dread]
    priority: 100
```

장면의 `location`, `time`, 현재 노드의 `atmosphere`, 표시 모드와 일치하는 후보 중 우선순위 점수가 가장 높은 변형을 사용한다. validator는 모든 장면의 모든 노드가 두 모드에서 배경을 얻는지 검사한다.

## 15. 런타임 빌드

`build` 명령은 YAML을 하나의 JSON으로 합친다.

- 게임 모드, 캠페인, 이벤트, 스레드, 메타, 캐릭터, 비주얼 객체, 루트와 장면을 ID 맵으로 변환
- UI를 포함한 단일 문자열 레지스트리, locale fallback 카탈로그와 번역 coverage 포함
- 별도 `build/localization-report.json` 생성
- visual 상속을 해석한 구체 객체와 자산 경로 포함
- 원본 파일 위치를 `_source`에 기록
- manifest 초기 상태, 수치 정의와 `self_development` 활동·표현 레지스트리 포함
- `self_development_template`을 manifest의 대화 소재로 치환해 안정 ID의 일반 대사 variant로 확장하고 저작 매크로 제거
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
- `route_eligible`은 `illustrated`이고 연결 캐릭터가 `main_heroine`인 멤버에게만 허용한다.
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
