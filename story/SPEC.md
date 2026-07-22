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
  flags: {}
```

- `visible`: 플레이어와 주인공이 보는 값
- `hidden`: 본편에서 감춰지는 실제 상태
- `progress`: 현재 시간, 본·놓친 사건, 회차 기억, 루트 완료와 모드 해금

감정은 별도 게이지로 만들지 않는다. 각 인물의 `emotion_rules`가 의심도·비호감도 구간을 표정, 속마음, 행동 경향으로 변환한다.

`survivor_view`는 유저에게 `생존 모드`로 표시하는 안정 ID다. 서아나 민경 루트의 엔딩을 하나라도 보면 해금한다. 플레이어 캐릭터는 후속 결정 전까지 스토리 데이터에 고정하지 않는다.

생존 모드는 본편과 동일한 날짜·시간대·핵심 사건을 `reality` 시점으로 다시 진행한다. 들리는 대사와 사건의 핵심 사실은 본편과 모순되지 않아야 하며, 본편에서 순화되거나 누락된 한도윤의 공격적 태도와 피해자만 겪은 맥락을 추가로 드러낸다.

한도윤의 지속적 공격성은 피해자의 선택 결과가 아니다. 플레이어는 한도윤을 최대한 자극하지 않는 동시에 이미 벌어지는 행동의 물리적 증거를 확보·보존해야 한다. 증거를 위해 폭력을 직접 유도하는 선택은 작성하지 않는다.

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

게임 진행의 최상위 단위는 루트가 아니라 캠페인의 날짜와 시간대다.

```text
campaign → day → slot → eligible event → scene → node
```

- 기본 캠페인은 15일이며 `morning`, `lunch`, `afternoon`, `after_work` 네 시간대를 사용한다.
- 오전·오후는 고정 업무 사건, 점심·퇴근 후는 플레이어 선택 사건을 중심으로 배치한다.
- 루트는 처음 선택하는 선형 경로가 아니라 플레이 결과를 엔딩·해금 단위로 분류하는 메타데이터다.
- 날짜별 파일을 만들지 않는다. 이벤트가 `[시작일, 종료일]`, 허용 시간대와 마감을 가진다.

## 5. 시간 이벤트

```yaml
id: seo_a.email_request
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

이벤트 상태는 `eligible`, `blocked`, `upcoming`, `seen`, `missed`로 판정한다. 고정·숨은 사건은 우선순위가 높은 것부터 자동 실행하며 같은 `exclusive_group`에서는 하나만 실행한다. 마감이 지난 사건은 `on_missed` 효과를 적용하고 오프스크린 사건을 열 수 있다.

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
    next: interpretation
  - id: interpretation
    kind: choice
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

모든 `dual_dialogue`와 `dual_narration`은 두 레이어를 반드시 가진다.

```yaml
perceived:
  atmosphere: warm_romance
  expression: subjective_shy
  line: "자료는 메일로 보내주셔도 돼요."
  protagonist_interpretation: "직접 찾아올 핑계가 사라져 아쉬운 것이다."
reality:
  atmosphere: cold_office
  expression: actual_tense
  line: "그 자료는 메일로 보내주세요. 제 자리로 오지 마시고요."
  inner_thought: "또 내 자리로 오면 민경 선배에게 말해야 한다."
  intent: boundary
```

- `reality.line`은 객관적으로 발화된 문장이다. 특별한 환청·기억 왜곡 연출이 아니라면 `perceived.line`도 핵심 사실관계를 유지한다.
- `protagonist_interpretation`은 사실이 아니라 주인공의 해석이다.
- `inner_thought`와 `intent`는 실제 인물의 상태다.
- 원문 모드에서는 `reality`를 표시하고, 본편에서는 `perceived`를 표시한다.
- 표정 ID는 화자의 인물 파일에 등록되어야 한다.

## 9. 선택지

```yaml
- id: match_push
  label: "나도 며칠 거리를 둔다"
  interpretation: "그녀의 밀기에 맞춰 긴장감을 유지한다."
  action: "사적인 접근을 사흘 중단한다."
  conditions: []
  effects:
    - path: visible.heroines.yoon_seo_a.affection
      op: add
      value: 8
    - path: hidden.heroines.yoon_seo_a.suspicion
      op: add
      value: -12
  next: after_choice
```

`label`은 플레이어가 보는 선택지, `interpretation`은 주인공이 믿는 의미, `action`은 객관적으로 발생하는 행동이다. 세 필드를 섞지 않는다.

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
  writes:
    - visible.heroines.yoon_seo_a.affection
```

하네스는 조건에서 읽는 경로와 효과에서 쓰는 경로가 계약에 없으면 오류로 처리한다. 이 계약은 게임 코드의 의존성과 AI 컨텍스트를 동시에 제한한다.

## 12. 캐릭터 감정 규칙

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

한국어 장면 YAML은 기본 언어의 소스 오브 트루스다. 빌드는 인물·이벤트·장면의 표시 문자열을 안정적인 키로 수집하고 `locales/<locale>.yaml`의 번역을 덮어쓴다.

```yaml
schema_version: 1
id: en
name: English
fallback: ko
strings:
  scenes.seo_a.email_request.title: Send It by Email
  scenes.seo_a.email_request.nodes.request.reality.line: "Please send those materials by email."
```

- 키는 `scenes.<scene_id>.nodes.<node_id>...`처럼 배포 후 유지되는 ID로 만든다.
- 번역이 없으면 locale의 `fallback`, 마지막에는 기본 한국어 원문으로 되돌아간다.
- 런타임의 `localization.coverage`는 직접 번역 수, 전체 키와 누락 키를 제공한다.
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

- 캠페인, 이벤트, 스레드, 메타, 캐릭터, 비주얼 객체, 루트와 장면을 ID 맵으로 변환
- locale fallback을 해석한 문자열 카탈로그와 번역 coverage 포함
- visual 상속을 해석한 구체 객체와 자산 경로 포함
- 원본 파일 위치를 `_source`에 기록
- manifest 초기 상태와 수치 정의 포함
- 빌드 시각과 원본 해시 기록
- 게임 엔진은 YAML이 아니라 생성된 JSON만 읽어도 된다.

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
