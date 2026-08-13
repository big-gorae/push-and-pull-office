# 통합 대사 저작 시스템

## 결론

`story/` 문서를 여러 파일로 나눈 것 자체는 문제가 아니다. 장면, 시간 사건, 시스템 흐름, UI를 서로 다른 문서로 보관하는 것은 변경 범위와 검증 책임을 분리하는 데 유리하다.

개편 전 문제는 에디터가 **컴파일된 런타임 장면**을 읽어 보여 주면서, 저장할 때는 **서로 다른 원본 YAML**로 되돌아가려 했다는 데 있다. 이 때문에 다음 세 종류의 문장이 일반 장면 대사와 다른 생명주기를 가졌다.

- 밤 활동 대사는 `story/ui.yaml`에 있어 장면 에디터가 발견하지 못한다.
- 심리학 강사 대사는 UI 문구로 분류되어 장면 에디터가 발견하지 못한다.
- 자기계발 합성 대사는 `story/manifest.yaml`의 문장 조각과 장면 템플릿을 빌드 중 합쳐 만들기 때문에 완성 대사의 단일 원본이 없다.

근본 원칙은 다음과 같다.

> 플레이어에게 서사 문장으로 표시되는 모든 텍스트는 안정 ID, 한 개의 물리 원본, 한 개의 에디터 목적지를 가져야 한다.

파일을 합치는 것이 아니라 **저작 단위와 편집 계약을 통합**해야 한다.

## 구현 결과

2026-08-12 기준으로 이 설계를 전체 적용했다.

- 플레이 서사 문장 808개 전부가 수정 가능한 단일 YAML 필드를 가진다.
- 누락된 에디터 대상, 빌드에서만 생성되는 대사, 복수 원본 대사는 모두 0개다.
- 밤 활동과 심리학 강사 문구 34개를 `story/system_flows/`로 옮기고 제작 버전에 `시스템 대사` 작업 공간을 추가했다.
- 자기계발 콜백 144개를 네 장면 YAML의 완성 variant로 물리화했다.
- 장면별 심리학 강사 override도 선택지 편집기에서 직접 수정하며, 비워 두면 공통 시스템 대사를 사용한다.
- 인게임 문구 편집은 동일한 source revision과 value hash를 확인한 뒤 YAML 저장, 전체 검증, 런타임 재빌드를 한 트랜잭션으로 수행한다.
- authoring coverage는 검증의 필수 gate이며, 편집 목적지가 없는 새 플레이 대사는 빌드에 들어갈 수 없다.
- 시스템 대사 화면은 흐름과 등장 구역을 왼쪽에서 고르고, 실제 게임 화면 한 단위를 세로 카드 하나로 편집한다. 내부 ID를 몰라도 활동명과 대사 내용으로 찾을 수 있다.
- 저장 중 추가 입력 보존, 로컬 초안 복구, 항목별 변경 취소, 마지막 물리 저장 취소, `⌘F` 검색, `⌘S` 저장을 지원한다.
- 각 시스템 대사 카드의 `게임에서 보기`는 밤 활동 결과 또는 강사 분석 방향을 제작 플레이의 실제 화면으로 바로 연다.
- 장면의 자기계발 콜백은 내부 `after_*` ID 카드 7개를 한꺼번에 펼치지 않고 `운동`, `독서`, `OTT 시청`, `일찍 자기`, `심리학 추가 학습`, `강제 혼술`, `그 외` 탭으로 한 완성 대사씩 편집한다. 필수 variant 구조는 작가 화면에서 실수로 삭제·복제하지 못한다.

## 개편 전 구조의 문제

개편 전 텍스트 흐름은 다음과 같았다.

```text
story/scenes/*.yaml ───────────────┐
story/ui.yaml ─────────────────────┼─> StoryProject build ─> runtime/localization ─> 게임
story/manifest.yaml 문장 조각 ─┐   │
장면 self_development_template ─┴───┘

에디터: runtime.scenes를 표시 ─> 원본 scene YAML로 저장 시도
```

일반 대사는 표시 데이터와 저장 원본이 거의 일치했다. 합성 대사는 그렇지 않았다. 에디터에 보이는 `after_workout` 같은 variant는 빌드 결과이고, 저장 원본은 장면 템플릿과 manifest의 여러 slot이었다. bridge가 생성 variant 수정 저장을 거부했던 이유도 이 불일치였다.

개편 전 대사 관련 범위는 다음과 같았다.

| 범위 | 수량 | 현재 편집 상태 |
|---|---:|---|
| 직접 장면 대사 | 484줄 | 장면 에디터에서 편집 가능 |
| 선택지 문구 | 137개 | 장면 에디터에서 편집 가능 |
| 자기계발 합성 결과 | 144줄 | 런타임에는 있으나 단일 원본이 없어 직접 저장 불가 |
| 밤 활동 인트로·결과 | 14줄 | `ui.yaml`에 있어 장면 에디터에 없음 |
| 심리학 강사 발언 | 3줄 | `ui.yaml`에 있어 장면 에디터에 없음 |
| 시간 사건 제목·요약 | 150개 | 시간 설계 에디터에서 편집 가능 |

검증기가 오류를 내지 않는 것은 데이터가 유효하고 번역 키가 존재하기 때문이다. 이것은 **저작 화면이 모든 문장을 다룬다**는 사실을 증명하지 않는다. 현재 검증에는 편집 가능성 계약이 없다.

## 목표 모델

### 1. 저작 대사 단위

모든 플레이 서사 문장을 `AuthoringTextUnit` 계약으로 인덱싱한다. 구현에서는 별도 중복 테이블 대신 localization registry의 `LocalizationEntry`가 이 역할을 맡는다. 각 entry의 `sourceDocument`, `context`와 revision owner가 저작 위치를 구성한다.

```ts
type AuthoringTextUnit = {
  id: string;
  surface: "scene" | "timeline" | "night" | "analysis_hint" | "ending";
  role: "dialogue" | "narration" | "choice" | "summary";
  documentKind: "scene" | "system_flow" | "event";
  documentId: string;
  fieldPath: string;
  source: string;
  revision: string;
  editorTarget: {
    workspace: "scene" | "timeline" | "system";
    sequenceId: string;
    nodeId?: string;
    variantId?: string;
    optionId?: string;
  };
};
```

필수 불변식은 다음과 같다.

- 게임이 서사 영역에 표시하는 모든 문장은 정확히 한 `AuthoringTextUnit`을 참조한다.
- 모든 단위는 수정 가능한 실제 YAML 필드를 가리킨다.
- `generated`, `composed_template`, `MULTIPLE_SOURCE_OWNERS` 상태는 플레이 대사에서 허용하지 않는다.
- 에디터는 합성되지 않은 source-equivalent node 또는 직접 YAML entry를 draft로 사용한다.
- 미리보기만 draft를 임시 컴파일한다.

### 2. 장면과 시스템 흐름의 공통 모델

밤 활동과 분석 강사는 일반 루트 장면은 아니지만 서사 노드다. 이들을 UI 문자열로 유지하지 않고 `system_flow` 문서로 옮긴다.

```text
story/system_flows/night_activity.yaml
story/system_flows/analysis_hint.yaml
```

장면과 시스템 흐름은 공통 `NarrativeSequence` 인터페이스를 사용한다.

```ts
type NarrativeSequence = {
  id: string;
  kind: "story_scene" | "system_flow";
  title: string;
  start_node: string;
  node_order: string[];
  nodes: Record<string, StoryNode>;
};
```

루트 연결, 일정 배치, 장소와 world context는 `story_scene`에만 요구한다. 반복 조건, 호출 파라미터와 시스템 동작 연결은 `system_flow`가 가진다. 대사·서술·선택지·variant·화자·배경·원화 편집은 같은 노드 에디터를 재사용한다.

`story/ui.yaml`에는 버튼, 제목, 상태 라벨처럼 서사가 아닌 영구 UI 문구만 남긴다.

## 요구사항별 설계

### 밤 활동

`system.night_activity` 흐름을 만든다.

```text
귀가 인트로
  ├─ 피로가 높음 -> 강제 혼술 -> 활동 결과
  └─ 보통 -> 활동 선택 -> 활동 결과
```

저작 노드 구성은 다음과 같다.

- `arrive_home`: 한도윤의 양 레이어 인트로 대사
- `forced_intro`: 고피로 강제 진행 대사
- `choose_activity`: 운동·독서·OTT·수면 선택지
- `activity_result`: 활동 ID별 명시적 variant 6개와 양 레이어 결과
- `finish_night`: 다음 날로 넘기는 시스템 이탈

활동 수치 변화, 피로 제한, 힌트 충전 같은 규칙은 manifest의 mechanics에 남겨도 된다. 단, manifest의 activity는 prose key를 소유하지 않고 시스템 흐름의 option/variant ID만 참조한다.

```yaml
self_development:
  activities:
    - id: workout
      choice_ref: system.night_activity.choose_activity.workout
      result_variant: workout
      appeal_delta: 3
      fatigue_delta: 2
```

게임의 밤 전용 화면은 유지할 수 있다. 화면 컴포넌트가 `i18n.ui("selfDevelopment.intro")`를 읽는 대신 `system.night_activity`의 현재 노드를 렌더링하도록 바꾼다.

### 심리학 강사

`system.analysis_hint` 흐름을 만든다.

- 화자는 별도 text-only 인물 또는 시스템 화자 `dark_psychology_instructor`로 등록한다.
- `none`, `approach`, `space` 세 variant를 완성 문장으로 저장한다.
- 선택 화면 오버레이는 현재 방향을 파라미터로 넘겨 해당 variant를 고른다.
- 양 레이어 대사를 명시한다. 같은 문장을 쓰더라도 두 레이어의 원본을 갖는다.
- 에디터에서 화자, 문장, 레이어 차이, 오버레이 연출을 편집한다.

분석 오버레이의 관찰 문구나 버튼 라벨은 UI에 남길 수 있지만, 강사가 말하는 문장은 system flow에 있어야 한다.

### 자기계발 합성 대사

런타임 합성을 폐지하고 144개 완성 문장을 명시적 장면 variant로 물리화한다.

현재 4개 장면의 12개 template node마다 다음 7개 variant를 실제 장면 YAML에 저장한다.

- `after_workout`
- `after_reading`
- `after_ott`
- `after_sleep`
- `after_dark_psychology`
- `after_solo_drinking`
- `default`

각 variant에는 완성된 단일 `line`이 들어간다. 기존 `self_development.expression` 조건 메타데이터는 유지할 수 있다.

다음 항목은 제거한다.

- 장면의 `self_development_template`
- manifest의 `conversation_topics` prose slot
- `SelfDevelopmentDialogueCompiler`
- 생성 variant 수정 거부 로직

공통 문장을 빠르게 바꾸고 싶다면 에디터의 **대량 생성/치환 도구**가 여러 명시적 variant를 수정하게 한다. 공유 조각을 런타임 원본으로 남기지 않는다. 편의 기능의 결과도 저장 직후 완성 대사로 물리 파일에 기록되어야 한다.

## 에디터 정보 구조

### 작업 공간 탐색

제작 버전 상단에 별도 `시스템 대사` 작업 공간을 둔다. 날짜별 장면 탐색기는 스토리 장면만 유지해 시간 순서를 흐리지 않는다.

```text
장면·대사
  1일차
  2일차
  ...
시스템 대사
  밤 활동
    도입 대사
    활동 선택지
    활동 결과
  심리학 강사
    강사 분석
```

### 중앙 대사 목록

스토리 장면과 시스템 흐름 모두 화면 문장 중심의 세로 대사 목록을 사용한다.

- 실제 화면 문장으로 검색
- 흐름 → 구역 → 실제 표시 장면의 3단 탐색
- 대사·내레이션·선택지·조건 분기 표시
- variant를 펼치면 각 완성 문장을 개별 행으로 검색·선택 가능
- `스토리`, `밤 활동`, `강사`, `시간 사건` 출처 배지
- 현재 문장의 물리 파일 저장 상태 표시
- 카드 단위 변경 취소와 마지막 저장 취소
- 저장 중 계속 입력해도 후속 초안을 보존하고 다음 트랜잭션으로 저장

### 상세 편집기

기존 화자·양 레이어·표정·원화·배경·선택지 편집기를 재사용한다. system flow가 특정 기능을 쓰지 않으면 해당 필드만 숨긴다.

`연출·번역`의 전체 문자열 표는 한국어 원본을 읽기 전용으로 고정할 필요가 없다. 모든 원문 행에 `저작 위치로 이동`을 제공하고, 수정은 해당 sequence/event editor의 동일 저장 서비스로 보낸다. 번역 저장은 계속 locale 문서를 사용한다.

### 인게임 왕복

게임의 모든 서사 렌더러는 현재 `text_unit_id`를 알고 있어야 한다.

- `이 문구 편집`은 정확한 에디터 위치를 연다.
- 에디터의 `게임에서 보기`는 story scene과 system flow 모두 지원한다.
- 저장 후 동일 ID의 런타임 문장만 갱신한다.
- 뒤로 가기와 현재 세션 상태는 유지한다.

## 저장 구조

### 편집기는 authoring projection을 읽는다

`ProjectPayload`는 런타임, localization entry 기반 authoring projection, 문서 메타데이터를 함께 제공한다. 별도의 두 번째 텍스트 인덱스를 만들면 다시 동기화 문제가 생기므로 `runtime.localization.entries`를 단일 authoring text projection으로 사용한다.

```ts
type ProjectPayload = {
  runtime: Runtime;
  // runtime.localization.entries가 AuthoringTextUnit projection을 담당한다.
  documents: {
    scenes: Record<string, DocumentMeta>;
    system_flows: Record<string, DocumentMeta>;
    // ...
  };
};
```

장면 draft는 합성이 제거되어 source와 구조가 같은 runtime scene에서 만들고, 시스템 대사 draft는 localization entry의 직접 source에서 만든다. 저장 성공 후 전체 검증과 runtime rebuild를 수행하고, localization entry projection과 runtime을 함께 교체한다.

### 한 문장 한 소유자

원문 저장은 다음 정보가 모두 일치할 때만 허용한다.

- `text_unit_id`
- `document_id`
- `field_path`
- `expected_revision`
- `expected_value_hash`

합성 source 배열을 저장하는 별도 예외는 제거한다. 하나의 문장을 고치는데 두 파일을 동시에 수정해야 한다면 저작 모델이 아직 잘못된 것이다.

### 트랜잭션

여러 variant를 일괄 수정하는 경우에도 다음 순서를 지킨다.

1. 모든 대상 source revision 확인
2. 임시 story 사본에 변경 적용
3. 전체 validator와 build 실행
4. 성공한 경우에만 원본 파일을 atomic replace
5. authoring projection과 runtime 동시 갱신
6. 변경 단위 전체를 한 번에 undo 가능하게 기록

## 검증 계약

`npm run verify`에 authoring coverage gate를 추가한다.

```text
narrative_text_units: N
editable_units: N
missing_editor_target: 0
generated_only: 0
multiple_source_owners: 0
narrative_text_in_ui_yaml: 0
narrative_text_in_manifest: 0
hardcoded_player_narrative: 0
```

검증 규칙은 다음과 같다.

1. `vn-line`, `vn-flow-dialogue`, 강사 발언 영역과 같은 서사 렌더러는 `AuthoringTextUnit` 참조만 받는다.
2. 모든 text unit의 source file과 field path가 실제 문자열을 가리킨다.
3. 모든 text unit의 editor target을 열었을 때 해당 문장이 선택된다.
4. 모든 원문을 임시 값으로 수정하고 저장·재빌드했을 때 같은 runtime key가 바뀌는 round-trip 테스트를 수행한다.
5. system flow의 모든 조건 variant와 선택지를 탐색한다.
6. 기본 언어 문장을 `ui.yaml` 번역 테이블을 통해 우회 저장하지 않는다.
7. Play Build에는 source path, revision 같은 저작 메타데이터가 필요하지 않다. Authoring Build의 project payload에서만 제공한다.

이 gate가 있어야 새 시스템 대사가 추가될 때 에디터 누락이 다시 발생하지 않는다.

## 마이그레이션 순서

### 1단계 · 편집 가능성 인덱스 — 완료

- `AuthoringTextUnit`과 authoring projection 추가
- 현재 모든 문장의 소유권 보고서 생성
- 누락이 있어도 우선 warning으로 표시
- 전체 대사 검색에서 scene, event, UI narrative를 함께 조회

### 2단계 · 시스템 흐름 — 완료

- `night_activity.yaml` 추가
- `analysis_hint.yaml` 추가
- 밤 전용 화면과 선택 분석 오버레이가 system flow를 읽도록 변경
- `ui.yaml`에서 밤 활동·강사 서사와 활동 선택지 문구 제거
- 에디터 `시스템 대사` 작업 공간 추가

### 3단계 · 합성 대사 물리화 — 완료

- 기존 compiler로 144개 현재 결과를 한 번 생성하는 migration command 작성
- 결과를 4개 장면 YAML의 명시적 variant로 기록
- 결과와 기존 runtime 문장이 byte-for-byte 동일한지 검사
- template와 conversation topic 제거
- compiler와 read-only rejection 제거

### 4단계 · 강제 검증 — 완료

- authoring coverage를 error gate로 전환
- 플레이어의 narrative 영역에서 raw UI string 사용 금지
- 각 요구사항 E2E 추가

## 완료 조건

다음이 모두 증명되어야 완료다.

- 밤 활동 인트로, 강제 인트로, 모든 활동 선택지와 양 레이어 결과를 에디터에서 수정·저장·재실행할 수 있다.
- 심리학 강사의 세 방향 대사를 에디터에서 수정·저장·재실행할 수 있다.
- 자기계발 조건으로 나오는 144개 완성 대사를 개별 검색, 수정, 저장할 수 있다.
- 인게임에서 본 모든 대사가 `에디터에서 열기`로 정확한 항목에 이동한다.
- 전체 대사 검색이 story scene, system flow, event summary를 빠짐없이 포함한다.
- 저장 결과가 실제 YAML에 기록되고 재시작 후에도 유지된다.
- 편집 가능한 플레이 대사의 generated/multi-source 소유권이 0개다.
- 새 대사를 에디터 목적지 없이 추가하면 검증이 실패한다.

이 완료 조건을 만족하면 `story/`는 계속 여러 문서로 관리하면서도 작가에게는 하나의 통합 대사 시스템으로 보인다.
