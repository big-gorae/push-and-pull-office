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
  cleared_routes: []
  unlocked_modes: [base]
  flags: {}
```

- `visible`: 플레이어와 주인공이 보는 값
- `hidden`: 본편에서 감춰지는 실제 상태
- `progress`: 루트 완료, 모드 해금과 단발성 사건 플래그

감정은 별도 게이지로 만들지 않는다. 각 인물의 `emotion_rules`가 의심도·비호감도 구간을 표정, 속마음, 행동 경향으로 변환한다.

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

## 4. 장면 구조

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

## 5. 이중 레이어

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

- `line`은 화면에서 들리는 문장이다. 주인공이 문장 자체를 편집하면 두 레이어의 `line`이 다를 수 있다.
- `protagonist_interpretation`은 사실이 아니라 주인공의 해석이다.
- `inner_thought`와 `intent`는 실제 인물의 상태다.
- 원문 모드에서는 `reality`를 표시하고, 본편에서는 `perceived`를 표시한다.
- 표정 ID는 화자의 인물 파일에 등록되어야 한다.

## 6. 선택지

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

## 7. 전이 우선순위

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

## 8. 상태 계약

장면은 접근하는 상태를 명시해야 한다.

```yaml
state_contract:
  reads:
    - hidden.heroines.yoon_seo_a.suspicion
  writes:
    - visible.heroines.yoon_seo_a.affection
```

하네스는 조건에서 읽는 경로와 효과에서 쓰는 경로가 계약에 없으면 오류로 처리한다. 이 계약은 게임 코드의 의존성과 AI 컨텍스트를 동시에 제한한다.

## 9. 캐릭터 감정 규칙

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

## 10. 런타임 빌드

`build` 명령은 YAML을 하나의 JSON으로 합친다.

- 캐릭터, 루트, 장면을 ID 맵으로 변환
- 원본 파일 위치를 `_source`에 기록
- manifest 초기 상태와 수치 정의 포함
- 빌드 시각과 원본 해시 기록
- 게임 엔진은 YAML이 아니라 생성된 JSON만 읽어도 된다.

## 11. AI 컨텍스트 패키지

`context` 명령은 현재 장면 작성에 필요한 정보만 추린 JSON을 만든다.

- AI 작성 규칙
- 현재 루트와 장면 전체
- 출연 인물의 프로필·표정·감정 규칙
- 장면이 읽고 쓰는 상태 스냅샷
- 직접 연결된 다음 장면의 ID와 제목
- 허용되는 수치·연산·열거형
- 선택 경로를 시뮬레이션한 `branch_trace`

이 패키지 밖의 사실을 추측해서 새 설정으로 확정하지 않는다.
