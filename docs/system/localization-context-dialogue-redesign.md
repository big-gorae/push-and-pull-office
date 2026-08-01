# [구현] 다국어·상황별 대사 관리 시스템 재설계

> 구현 상태: 2026-07-30 기준 데이터 계약, 엄격한 validator, TypeScript/Python
> 런타임, 전체 키 번역 편집기, v3 ID 세이브·백로그와 공통 조건 fixture가 적용되었다.

## 1. 결정

현재의 안정 ID, 한국어 원문, locale fallback, `perceived`/`reality`, 상태 조건·효과와
`state_contract`는 유지한다. 그 위에 다음 여섯 문제를 하나의 제작 파이프라인으로
해결한다.

| 기존 문제 | 설계 결정 |
|---|---|
| 번역 편집기가 일부 문장만 편집 | 모든 번역 가능 필드를 `LocalizationEntry`로 정규화하고 표·문맥 편집기를 함께 제공 |
| 실게임이 `entry_conditions`를 무시 | 하네스와 플레이어가 같은 `canEnterScene` 계약과 적합성 테스트를 사용 |
| 감정 규칙이 실게임 대사에 연결되지 않음 | 읽기 전용 파생 상태와 조건부 `dialogue variants`를 런타임에 도입 |
| UI와 스토리 번역이 분리 | UI·스토리·이벤트·인물·비주얼을 단일 문자열 레지스트리로 빌드 |
| 번역 키·변수 검증이 약함 | 고아 키, 중복 키, 변수 불일치, 출처 누락, fallback 품질을 검증 |
| 저장 슬롯이 저장 당시 언어를 보관 | 저장에는 ID와 상태만 기록하고 현재 locale로 매번 표시 |

목표는 “번역 파일이 존재한다”가 아니라 아래 흐름이 하나의 계약으로 동작하는 것이다.

```text
한국어 원문 문서 + UI 원문
        │
        ├─ 문자열 레지스트리 생성
        ├─ locale override 검증
        ├─ 상황별 대사 variant 검증
        └─ 런타임 빌드
                ↓
    에디터 / 웹 플레이어 / 하네스
       모두 같은 키·조건·선택 결과 사용
```

## 2. 설계 원칙

1. 한국어 스토리 YAML은 계속 서사 원문의 소스 오브 트루스다.
2. 번역 파일에는 비기본 언어의 override만 둔다.
3. 모든 화면 문구는 안정 키를 사용하며 TypeScript에 언어별 문장을 복제하지 않는다.
4. 상황별 대사는 상태를 변경하지 않는다. 상태 변경은 계속 `effects`만 담당한다.
5. 흐름을 바꾸는 조건은 `state_gate`, `choice.conditions`, `entry_conditions`가 담당한다.
6. 같은 흐름 안에서 문장·표정·속마음만 바꾸는 조건은 `dialogue variants`가 담당한다.
7. 실제 감정으로부터 주인공의 인지 레이어를 자동 생성하지 않는다.
8. 저장 데이터에는 번역된 문장을 넣지 않는다.
9. 실게임과 제작 도구가 서로 다른 조건 평가기를 갖더라도 동일한 적합성 fixture를 통과해야 한다.
10. 기존 세이브와 기존 장면 YAML은 단계적으로 마이그레이션할 수 있어야 한다.

## 3. 단일 현지화 레지스트리

### 3.1 원문 위치

원문은 표시 문구의 성격에 따라 다음 위치에 둔다.

- 장면·이벤트·인물·캠페인·루트: 현재 한국어 YAML 필드
- UI/HUD/오류/설정 문구: 새 `story/ui.yaml`
- 비주얼 표시명: 각 비주얼 객체의 `title` 필드
- locale 자체 표시명: 각 locale 파일의 `name`과 `native_name`

`story/locales/ko.yaml`에 중복으로 보관하던 UI·비주얼 한국어 문구는 원문 위치로
이동한다. `story/locales/en.yaml` 같은 비기본 locale 파일은 안정 키에 대한
override만 가진다.

```yaml
# story/ui.yaml
schema_version: 1
id: game_ui
strings:
  app.title: 밀당 오피스
  menu.newGame: 새 게임
  deadline.days: "{{count}}일 남음"
```

```yaml
# story/locales/en.yaml
schema_version: 1
id: en
name: English
native_name: English
fallback: ko
strings:
  app.title: Love Office
  menu.newGame: New Game
  deadline.days: "{{count}} days left"
```

### 3.2 `LocalizationEntry`

빌드 단계는 모든 원문을 단순 `key → string`이 아니라 출처와 문맥을 가진 항목으로
정규화한다.

```ts
type LocalizationEntry = {
  key: string;
  source: string;
  domain: "ui" | "campaign" | "character" | "event" | "route" | "scene" | "visual";
  sourceDocument: {
    kind: string;
    id: string;
    path: string;
    fieldPath: string;
  };
  context?: {
    sceneId?: string;
    nodeId?: string;
    variantId?: string;
    optionId?: string;
    layer?: "perceived" | "reality";
    speakerId?: string;
  };
  placeholders: string[];
  maxLength?: number;
  multiline: boolean;
};
```

런타임의 현지화 번들은 다음처럼 직접 번역과 fallback 결과를 분리한다.

```ts
type LocalizationBundleV2 = {
  schema_version: 2;
  default_locale: string;
  supported_locales: string[];
  locale_names: Record<string, { name: string; native_name: string }>;
  entries: Record<string, LocalizationEntry>;
  direct_catalogs: Record<string, Record<string, string>>;
  resolved_catalogs: Record<string, Record<string, string>>;
  coverage: Record<string, {
    total: number;
    direct: number;
    resolved: number;
    ratio: number;
    missing: string[];
    fallback_used: string[];
    orphan: string[];
    invalid_placeholders: string[];
    by_domain: Record<string, { total: number; direct: number }>;
  }>;
};
```

기존 `source_strings`와 `catalogs`는 한 번의 호환 기간 동안 각각 `entries.source`와
`resolved_catalogs`의 읽기 전용 별칭으로 남긴 뒤 제거한다.

### 3.3 플레이어 API

`GAME_LOCALES`, 언어별 `UI_MESSAGES`, `GameLocale` union을 제거한다.

```ts
type LocaleId = string;

class LocalizationService {
  constructor(runtime: Runtime, requestedLocale?: LocaleId);
  t(key: string, variables?: MessageVariables): string;
  hasDirect(key: string): boolean;
  entry(key: string): LocalizationEntry | undefined;
}
```

- 지원 언어 목록은 `runtime.localization.supported_locales`에서 읽는다.
- 설정에 저장된 locale가 사라졌으면 default locale로 되돌린다.
- 타이틀, HUD, 메뉴, 오류, 스토리 모두 `t()`를 사용한다.
- locale 추가는 `manifest.yaml`과 locale YAML 추가만으로 플레이어에 나타나야 한다.
- `document.documentElement.lang`, 날짜·숫자 서식도 선택 locale에서 파생한다.

UI 키의 오타는 빌드 전에 잡기 위해 레지스트리에서 `UiMessageKey` 타입을 생성한다.
생성 파일은 직접 편집하지 않으며 `story_harness.py build`와 프런트 빌드가 항상 먼저
갱신한다.

## 4. 번역 제작 화면

### 4.1 두 가지 편집 방식

번역 작업공간은 “문맥 편집”과 “전체 문자열 표”를 함께 제공한다.

#### 문맥 편집

선택한 장면과 노드에 속한 모든 항목을 한 화면에 보여 준다.

```text
장면: seo_a.email_request / locale: English

노드: request
  perceived 대사
  reality 대사

노드: request_inner / inner_voice
  perceived 화자 / 괄호 발화
  reality 화자 / 괄호 발화

선택지
  stimulus
  match_push / label / interpretation / action
  pull_harder / label / interpretation / action

연결 이벤트
  perceived title / summary
  reality title / summary
```

현재처럼 한 노드에서 하나의 `translationKey`만 선택하지 않는다. 에디터는
`LocalizationEntry.context`로 현재 문맥에 속한 항목 전체를 조회한다.

#### 전체 문자열 표

- locale, domain, 장면, 인물, 번역 상태, fallback 사용 여부로 필터
- 원문, 번역, 키, 화자, 레이어, 출처 파일 표시
- 미번역만 보기, 고아 키만 보기, 변수 오류만 보기
- 여러 행 붙여넣기와 일괄 저장
- 키를 선택하면 실제 장면·노드·필드로 이동
- CSV/XLIFF 내보내기·가져오기는 같은 레지스트리를 사용

### 4.2 저장 규칙

- 기본 locale 선택 시 원문 필드의 담당 편집 화면으로 이동한다.
- 비기본 locale 선택 시 해당 locale YAML만 수정한다.
- 여러 키 저장은 locale 파일 하나에 대한 단일 revision 트랜잭션으로 처리한다.
- 자동 저장 전 전체 locale 검증을 수행한다.
- 저장 실패 시 기존 locale 파일과 런타임을 모두 유지한다.
- 초안 복구 키는 `workspace + locale + localization key`를 사용한다.

### 4.3 번역 상태

각 항목은 다음 상태 중 하나다.

- `direct`: 해당 locale에 직접 번역됨
- `fallback`: 상위 locale 또는 한국어 원문 사용
- `missing`: 원문도 없어 키 자체가 표시될 위험
- `invalid`: 변수·형식 검증 실패
- `orphan`: 현재 레지스트리에 없는 오래된 키

fallback은 정상 실행 상태이지만 “번역 완료”로 계산하지 않는다.

## 5. 실게임 장면 진입 조건

### 5.1 공통 계약

다음 순수 함수의 의미를 TypeScript와 Python에서 동일하게 유지한다.

```ts
type EntryDecision = {
  allowed: boolean;
  trace: Array<{
    condition: Condition;
    actual: JsonValue;
    met: boolean;
  }>;
};

canEnterScene(runtime, state, sceneId): EntryDecision
```

장면 진입 경로는 모두 이 결정을 거친다.

1. 캠페인·루트 시작
2. 시간 이벤트에서 장면 시작
3. `exit`에서 다른 장면으로 이동
4. 디버그 점프와 에디터 미리보기
5. 하네스 시뮬레이션

### 5.2 이벤트 처리

이벤트에 연결된 장면의 `entry_conditions`도 이벤트 eligibility에 포함한다.

- 조건 불충족 이벤트는 `blocked`이며 차단 이유에 장면 조건을 기록한다.
- 장면 진입 성공 전에는 이벤트를 `seen`으로 기록하거나 `on_seen` 효과를 적용하지 않는다.
- `on_seen` 적용 뒤 조건이 바뀌는 설계는 금지한다. 진입 조건은 이벤트 시작 전 상태로 평가한다.

### 5.3 장면 전이

`exit.transitions`에서 장면 후보를 평가할 때 다음 순서를 적용한다.

1. transition 자체 조건 평가
2. 대상 장면의 `entry_conditions` 평가
3. 둘 다 충족하면 해당 전이 선택
4. 아니면 다음 transition 평가
5. 마지막 조건 없는 fallback 전이 선택

조건을 만족하는 대상이 전혀 없으면 `dead-end`로 조용히 종료하지 않고
`scene-entry-rejected` 런타임 오류와 전체 trace를 남긴다.

validator는 조건부 진입 장면을 가리키는 전이 뒤에 도달 가능한 fallback이 있는지
검사한다.

### 5.4 구현 중복 방지

Python 하네스와 TypeScript 플레이어가 같은 코드를 실행할 수는 없으므로
`tests/fixtures/condition-conformance.json`을 공통 규격으로 둔다.

- 모든 연산자와 값 타입
- 없는 경로
- 배열 포함
- 숫자 경계
- scene entry와 transition 결합
- event eligibility와 entry 결합

Python과 TypeScript 테스트가 같은 fixture의 입력과 결과를 읽어야 한다.

## 6. 상황별 대사와 감정 연결

### 6.1 책임 분리

상황에 따라 “다른 사건으로 간다”와 “같은 사건을 다르게 말한다”를 구분한다.

- `state_gate`, `choice.conditions`, `entry_conditions`: 게임 흐름 변경
- `dialogue variants`: 같은 노드의 대사·표정·속마음 변경
- `emotion_rules`: 상태에서 읽기 전용 감정·행동·기본 실제 표정 파생
- `effects`: 영속 상태 변경

variant에는 `effects`, `next`, 다른 장면 전이를 넣을 수 없다.

### 6.2 파생 상태

인물의 `emotion_rules`를 실게임에서도 계산해 다음 읽기 전용 컨텍스트를 만든다.

```ts
type DerivedCharacterState = {
  rule_id: string | null;
  emotion: string | null;
  behavior: string | null;
  default_expression: string | null;
};

type EvaluationContext = {
  state: RuntimeState;
  derived: {
    characters: Record<string, DerivedCharacterState>;
  };
};
```

조건에서는 다음 경로를 읽을 수 있다.

```text
derived.characters.yoon_seo_a.emotion
derived.characters.yoon_seo_a.behavior
derived.characters.yoon_seo_a.rule_id
```

- `derived.*`는 읽기만 허용한다.
- `state_contract.reads`에는 사용하는 파생 경로를 선언한다.
- 하네스 컨텍스트는 파생 결과와 어떤 감정 규칙이 선택됐는지 함께 제공한다.
- 감정 규칙이 없거나 일치하지 않으면 null 결과를 반환한다.

### 6.3 대사 variant 구조

기존 inline 레이어는 `default` variant로 해석해 호환한다. 새 장면은 다음 구조를
사용한다.

```yaml
- id: response
  kind: dual_dialogue
  speaker: yoon_seo_a
  variants:
    - id: guarded
      priority: 100
      conditions:
        - path: derived.characters.yoon_seo_a.emotion
          op: eq
          value: fear
      perceived:
        atmosphere: warm_romance
        expression: subjective_shy
        line: "메일로 보내주세요."
      reality:
        atmosphere: cold_office
        line: "메일로 보내주세요."
        intent: boundary
    - id: default
      default: true
      perceived: { ... }
      reality: { ... }
  next: response_inner

- id: response_inner
  kind: dual_dialogue
  presentation_flags: [inner_voice]
  speakers:
    perceived: han_do_yoon
    reality: yoon_seo_a
  variants:
    - id: guarded
      priority: 100
      conditions:
        - path: derived.characters.yoon_seo_a.emotion
          op: eq
          value: fear
      perceived:
        atmosphere: warm_romance
        line: "(부끄러워서 짧게 말한 건가?)"
      reality:
        atmosphere: cold_office
        line: "(혼자 마주치지 말아야 해.)"
        intent: boundary
    - id: default
      default: true
      perceived: { ... }
      reality: { ... }
  next: leave
```

선택 규칙은 transition과 동일하게 명시적이다.

1. priority 내림차순
2. 같은 priority에서는 YAML 순서
3. 첫 번째 조건 충족 variant
4. 정확히 하나의 `default: true`

번역 키에는 variant ID가 들어간다.

```text
scenes.<scene>.nodes.<node>.variants.<variant>.perceived.line
scenes.<scene>.nodes.<node>.variants.<variant>.reality.line
```

variant ID도 배포 후 안정 ID로 취급한다.

### 6.4 표정 해석

실제 레이어의 표정은 다음 우선순위로 정한다.

1. 선택된 variant의 `reality.expression`
2. 화자의 `DerivedCharacterState.default_expression`
3. 캐릭터 비주얼 객체의 기본 실제 표정

인지 레이어의 표정은 실제 감정 규칙에서 자동 생성하지 않는다. 선택된 variant의
`perceived.expression` 또는 명시적인 인지 레이어 기본값만 사용한다.

### 6.5 런타임 해석 결과

```ts
type ResolvedDialogueNode = {
  sceneId: string;
  nodeId: string;
  variantId: string;
  perceived: Layer;
  reality: Layer;
  speakers: Partial<Record<ViewMode, string | null>>;
  trace: VariantDecisionTrace[];
};

resolveDialogueNode(runtime, session, node): ResolvedDialogueNode
```

웹 플레이어, 백로그, 저장 미리보기, Tauri 미리보기는 원본 node를 직접 렌더링하지
않고 이 결과를 사용한다.

### 6.6 에디터 UX

- 상태 슬라이더를 바꾸면 선택 variant와 이유를 즉시 표시
- 모든 variant를 우선순위 순서로 표시
- 현재 선택된 variant 강조
- variant 추가 시 안정 ID 입력
- default 삭제 금지
- 조건이 겹치는 variant 경고
- 어떤 테스트 상태에서도 선택되지 않는 variant 경고
- variant별 두 레이어를 항상 같은 편집 단위로 표시
- variant를 복제할 때 번역 키 충돌 여부 검사

## 7. locale 독립 저장과 백로그

### 7.1 저장 스키마 v3

```ts
type SaveSlotV3 = {
  schema_version: 3;
  savedAt: number;
  preview: {
    kind: "timeline" | "scene" | "ending"; // timeline은 호환용 내부 사건 큐 미리보기
    day: number;
    slot: string;
    eventId?: string;
    sceneId?: string;
    nodeId?: string;
    variantId?: string;
    mode: ViewMode;
    endingId?: string;
  };
  session: PlayerSessionV3;
};
```

`sceneTitle`과 `line` 같은 번역 완료 문자열은 제거한다. 저장 목록을 열 때
`preview`의 ID를 현재 locale의 레지스트리로 해석한다.

### 7.2 백로그

백로그도 문장이 아니라 당시 선택된 ID를 기록한다.

```ts
type BacklogEntryV3 = {
  kind: "dialogue" | "narration" | "choice";
  sceneId: string;
  nodeId: string;
  variantId?: string;
  optionId?: string;
  speakerId?: string;
  modeAtPresentation: ViewMode;
};
```

- 상태가 나중에 바뀌어도 저장된 `variantId`로 당시 대사를 복원한다.
- locale를 바꾸면 같은 backlog가 새 언어로 즉시 다시 렌더링된다.
- 속마음 모드 비교는 같은 variant의 다른 레이어를 읽는다.

### 7.3 이전 세이브 마이그레이션

v2 세이브를 읽을 때 다음 순서로 v3 preview를 만든다.

1. `session.sceneId`, `session.nodeId`, `session.mode` 사용
2. 현재 상태로 variant를 다시 계산하되 기존 장면은 `default` 사용
3. legacy `timeline` 미리보기면 마지막 내부 사건 로그와 현재 day/slot 사용하되 플레이어용 타임라인 화면은 열지 않음
4. 기존 `sceneTitle`, `line`은 마이그레이션 실패 시 표시하는 legacy fallback으로만 보존
5. 다음 저장 시 v3로 기록

마이그레이션은 원본 localStorage를 덮어쓰기 전에 파싱과 session 정규화를 완료해야
한다.

## 8. 현지화 검증

### 8.1 오류

다음은 빌드를 중단한다.

- locale YAML 내부의 중복 mapping key
- locale 파일 ID와 manifest locale ID 불일치
- fallback 순환 또는 존재하지 않는 fallback
- 기본 원문에 없는 번역 키
- `{{name}}`, `{{count}}` 같은 placeholder 집합 불일치
- 지원 UI locale에 필요한 접근성 키 누락
- `title_key` 등 코드·비주얼 참조가 레지스트리에 없음
- 같은 안정 키가 서로 다른 원문 출처에서 생성
- variant ID 중복 또는 default variant 누락·중복
- `derived.*` 경로에 쓰기 시도

### 8.2 경고

- 번역이 없어 fallback 사용
- 원문과 번역이 완전히 같음
- locale별 권장 길이 초과
- 사용하지 않는 locale 파일
- 특정 domain의 직접 번역률이 manifest 기준 미만
- 조건이 완전히 겹치는 대사 variant

번역률 부족은 개발 중에는 경고, 출시 profile에서는 오류로 승격할 수 있다.

```yaml
# manifest.yaml
localization_quality:
  profiles:
    development:
      missing_translation: warning
    release:
      required_locales:
        en:
          minimum_direct_ratio: 1.0
          required_domains: [ui, scene, event, character]
```

### 8.3 리포트

`validate`와 `build`는 다음 파일을 생성하거나 JSON 출력 옵션으로 제공한다.

```text
build/localization-report.json
```

리포트에는 locale·domain·장면별 direct/fallback/missing/orphan과 placeholder 오류를
포함한다. 에디터와 CI는 같은 리포트를 읽는다.

## 9. 구현 경계

### 9.1 주요 파일

| 영역 | 변경 대상 |
|---|---|
| 소스·스키마 | `story/manifest.yaml`, `story/ui.yaml`, `story/schema/scene.schema.json`, locale/UI schema |
| 런타임 타입 | `src/types.ts` |
| 문자열 수집·검증 | `tools/story_harness.py` |
| 생성 타입 | `src/generated/localizationKeys.ts` |
| 공통 조건·감정·variant 판정 | `src/storyLogic.ts` |
| 웹 실행 | `src/player/playerRuntime.ts`, `src/player/WebGame.tsx` |
| 현지화 | `src/player/gameI18n.ts`, `src/presentation.ts` |
| 저장 | `src/player/playerStorage.ts` |
| 에디터 | `src/PresentationEditor.tsx`, 새 localization table 컴포넌트 |
| 브리지 | `tools/story_editor_bridge.py` |
| 테스트 | Python harness/bridge 테스트, Vitest player/localization 테스트 |

### 9.2 금지하는 지름길

- UI 번역을 계속 TypeScript 객체에 복제
- emotion 이름만 보고 플레이어가 임의로 대사를 합성
- variant 안에 효과나 다음 노드를 숨김
- entry condition 실패를 이미 본 이벤트로 기록
- fallback으로 표시된 문장을 번역 완료율에 포함
- 저장 슬롯에 현재 언어의 완성 문장을 다시 캐시
- validator와 에디터가 서로 다른 번역 키 목록을 계산

## 10. 마이그레이션 순서

### Phase 1 — 공통 판정과 회귀 방지

1. 조건 적합성 fixture 작성
2. `canEnterScene`과 event/transition 통합
3. 플레이어·하네스 parity 테스트
4. 현재 빈 `entry_conditions`에서도 기존 진행이 동일한지 확인

### Phase 2 — 단일 현지화 레지스트리

1. `story/ui.yaml`과 UI schema 추가
2. `LocalizationEntry` 생성기 추가
3. 비주얼 title을 원문 필드로 이동
4. direct/resolved catalog 분리
5. 플레이어의 하드코딩 locale와 `UI_MESSAGES` 제거
6. 기존 런타임 필드 호환 별칭 추가

### Phase 3 — 번역 제작 화면

1. 전체 문자열 표 추가
2. 현재 장면 문맥의 모든 키 편집
3. locale 파일 단위 트랜잭션 저장
4. 누락·fallback·orphan·변수 오류 필터
5. 기존 단일 문장 편집기를 새 레지스트리 조회로 교체

### Phase 4 — 상황별 대사

1. scene schema와 타입에 variants 추가
2. 파생 감정 컨텍스트를 player runtime으로 이동
3. `resolveDialogueNode` 구현
4. 웹 플레이어·백로그·미리보기를 resolved node 기반으로 교체
5. 기존 장면을 자동 `default` variant로 읽는 호환 계층 추가

### Phase 5 — locale 독립 세이브

1. SaveSlot/Backlog v3 타입 추가
2. ID 기반 preview 렌더러 추가
3. v2 → v3 마이그레이션
4. 언어 전환 후 저장 슬롯·백로그 재번역 테스트

### Phase 6 — 엄격한 QA와 정리

1. 중복 YAML key 검출 loader
2. orphan·placeholder·레퍼런스 검증
3. domain별 coverage와 release profile
4. 호환 기간 종료 후 `source_strings`, 기존 resolved `catalogs`, 문자열 캐시 제거

각 phase는 독립 배포가 가능해야 하며, phase가 끝날 때마다 기존 세이브와 기본 한국어
플레이가 유지돼야 한다.

## 11. 테스트 계획

### 11.1 현지화

- 새 locale YAML을 추가하면 코드 수정 없이 언어 선택기에 표시
- UI와 장면 문구가 같은 `LocalizationService`에서 조회
- direct와 fallback coverage가 구분
- 모든 `LocalizationEntry`가 에디터 표에서 검색·편집 가능
- 현재 장면 문맥에 일반 line, 별도 `inner_voice` line, choice stimulus, option 3종과 event presentation 포함
- unknown key, duplicate key, placeholder 불일치가 저장과 빌드를 차단
- visual title과 locale name이 coverage에 포함

### 11.2 장면 진입

- simulator와 player가 같은 entry fixture 결과 반환
- entry 실패 이벤트가 seen 처리되지 않음
- 다음 transition이 대상 scene entry 실패 시 fallback 선택
- route entry 실패가 명시적 오류와 trace를 반환

### 11.3 상황별 대사

- 감정 규칙 priority와 default가 동일하게 계산
- 상태 변화에 따라 variant가 바뀜
- 같은 상태에서는 에디터와 player가 같은 variant ID 선택
- reality expression의 명시값이 파생 기본 표정보다 우선
- perceived expression이 reality emotion에서 자동 생성되지 않음
- variant가 effects나 next를 가지면 schema 오류
- 조건 불충족 시 default variant 선택

### 11.4 저장

- 한국어 저장 후 영어 전환 시 슬롯 제목·대사가 영어로 렌더링
- backlog가 당시 variant ID를 유지
- 상태 변화 뒤 backlog를 열어도 당시 variant가 유지
- v2 저장을 읽고 다음 저장에서 v3로 변환
- 번역 키가 제거됐을 때 legacy fallback 또는 안정적인 키 표시

## 12. 완료 조건

다음 항목이 모두 증명되어야 재설계가 완료된 것으로 본다.

1. `GAME_LOCALES`와 언어별 `UI_MESSAGES`가 제거돼 있다.
2. 모든 표시 문구가 하나의 `LocalizationEntry` 레지스트리에 포함된다.
3. 에디터에서 레지스트리의 모든 비기본 언어 항목을 수정할 수 있다.
4. 고아 키와 placeholder 불일치가 validator 오류가 된다.
5. player와 simulator가 같은 entry condition fixture를 통과한다.
6. 조건부 대사 variant가 실제 플레이에서 선택되고 에디터와 같은 결과를 낸다.
7. emotion rule의 실제 표정 fallback이 player에도 적용된다.
8. save와 backlog에 번역 완료 문자열이 저장되지 않는다.
9. 언어를 전환하면 기존 저장·백로그·UI·스토리 전체가 즉시 같은 locale로 표시된다.
10. 기존 v2 세이브와 기존 inline 장면이 마이그레이션 또는 호환 계층으로 동작한다.
11. validator, Python 테스트, player 테스트, 전체 빌드와 대표 분기 시뮬레이션이 모두 통과한다.

## 13. 요구사항 대응표

| 요청 항목 | 해결 섹션 |
|---|---|
| 2. 번역 편집 범위 | 3, 4 |
| 3. `entry_conditions` 실게임 적용 | 5 |
| 4. 감정 규칙과 상황별 대사 | 6 |
| 5. UI·스토리 번역 통합 | 3 |
| 6. 번역 QA 강화 | 8 |
| 7. locale 독립 세이브 | 7 |
