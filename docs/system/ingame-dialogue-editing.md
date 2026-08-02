# [부분 구현] 인게임 대사 편집 모드 설계

## 1. 결정

인게임 디버그 모드에 **대사 편집 모드**를 추가한다. 로컬 Tauri 제작 앱에서 실행할 때는 현재 화면의 문장이나 선택지 문구를 바로 수정하고 저장할 수 있으며, 저장 성공 시 실제 `story/**/*.yaml` 또는 `story/locales/**/*.yaml`과 생성 런타임이 함께 갱신된다.

이 기능은 현재 구조에서 구현 가능하다. 이미 다음 기반이 구현되어 있다.

- `tools/story_editor_bridge.py`의 revision 충돌 검사, 후보 검증, 원자적 YAML 교체와 런타임 재빌드
- `src-tauri/src/lib.rs`의 허용된 프로젝트 루트 관리와 Python 브리지 호출
- 런타임 localization entry의 `sourceDocument.path`, `fieldPath`, 장면·노드·variant·레이어 context
- 플레이어 디버그 모드, 이전 대사 이동, 백로그와 안정적인 장면·노드 ID

단, 컴파일된 자기계발 대사처럼 한 화면 문장이 장면 템플릿과 manifest 문구를 합쳐 만든 결과라면 완성 문장 전체를 한 필드에 덮어쓰지 않는다. 이 경우에는 원본 소유자를 나눠 편집하거나 `원본 파일 열기`로 전환한다.

정적 웹 배포판은 브라우저 보안상 로컬 파일을 쓸 수 없으므로 읽기 전용이다. GitHub Pages와 일반 웹 플레이에서는 편집 버튼을 숨기고, 로컬 제작 환경에서만 `경로 복사`를 제공한다.

## 현재 구현 상태 (2026-08-02)

1~3단계의 핵심 기능을 구현했다.

- Tauri 스토리 에디터에서 `게임에서 대사 편집`으로 같은 WebView의 제작용 플레이 테스트를 연다.
- 디버그 모드에서 현재 대사의 perceived/reality 레이어, 선택지 문구, 사건 요약, 백로그와 자기계발 UI 문구를 편집한다.
- revision과 현재 값 hash를 모두 검사하고, 같은 YAML 문서의 여러 문장을 한 번에 검증·원자 저장한 뒤 `build/story-runtime.json`을 재빌드한다.
- 저장한 한국어 원문은 진행 상태를 유지한 채 화면·선택지·백로그에 즉시 override된다.
- 자기계발 합성 variant처럼 원본이 여러 개인 문장은 저장하지 않고 각 YAML 원본과 field path를 제공한다.
- 정적 웹 게임에는 제작 기능과 프로젝트 경로가 노출되지 않는다.

남은 확장은 locale 번역 직접 편집, 합성 템플릿의 구조화 편집, 저장 Undo와 편집기별 line/column 이동이다. 현재 버전에서도 이 범위는 정확한 원본 파일 열기와 위치 복사로 처리할 수 있다.

## 2. 사용자 목표

제작자는 다음 흐름으로 대사를 한 줄씩 고칠 수 있어야 한다.

1. 게임을 플레이하다 어색한 문장을 발견한다.
2. 디버그 모드에서 `대사 편집`을 누른다.
3. 현재 레이어 또는 두 레이어의 문장을 고친다.
4. `저장하고 현재 장면에 반영`을 누른다.
5. 같은 진행 상태를 유지한 채 수정된 문장을 즉시 확인한다.

편집이 지원되지 않는 문장에서도 다음 작업은 항상 가능해야 한다.

- 원본 YAML 파일 열기
- Finder/Explorer에서 파일 위치 보기
- `파일 경로 · node ID · field path` 복사
- 전체 스토리 에디터의 해당 장면으로 이동

## 3. 실행 환경별 동작

| 환경 | 현재 문장 편집·저장 | 원본 열기 | 경로 복사 | 이유 |
|---|---:|---:|---:|---|
| Tauri 제작 앱의 플레이 테스트 | 가능 | 가능 | 가능 | 승인된 프로젝트 루트와 로컬 브리지를 사용한다. |
| 로컬 Vite 브라우저 | 기본 비활성 | 제한적 | 가능 | 임의 웹 페이지의 파일 쓰기를 허용하지 않는다. 후속 로컬 companion API를 붙일 때만 활성화한다. |
| GitHub Pages·일반 배포판 | 불가 | 불가 | 숨김 | 제작 경로와 파일 쓰기 기능을 배포판에 노출하지 않는다. |

플레이어는 `authoringCapabilities`를 받아 기능을 결정한다.

```ts
type AuthoringCapabilities = {
  enabled: boolean;
  canWriteSource: boolean;
  canOpenSource: boolean;
  projectRootLabel?: string;
};
```

`import.meta.env.DEV`만으로 권한을 판단하지 않는다. 실제 Tauri 명령이 프로젝트 루트를 승인한 경우에만 `canWriteSource`를 켠다.

## 4. 인게임 UI

### 4.1 현재 대사

디버그 모드에서 대사창 오른쪽 위에 제작용 작은 도구를 둔다.

```text
┌──────────────────────────────────────────────────────────────┐
│ 윤서아                            [✎ 대사 편집] [</> 원본]   │
│ “자료는 메일로 보내 주세요.”                                │
│                                                              │
│ DEBUG · common.scene / request / perceived                    │
└──────────────────────────────────────────────────────────────┘
```

- 일반 플레이 모드에서는 두 버튼과 source ID를 모두 숨긴다.
- `✎ 대사 편집`은 직접 소유한 문자열일 때만 활성화한다.
- `</> 원본`은 편집 가능 여부와 무관하게 활성화한다.
- 오토·스킵 중 편집을 열면 즉시 정지한다.

### 4.2 편집 패널

```text
┌─ 대사 편집 ──────────────────────────────────────────────────┐
│ common.day_02_practical_meeting · request                     │
│ story/scenes/common/day_02_practical_meeting.yaml             │
│                                                              │
│ 주인공이 보는 문장                                            │
│ [ 자료는 메일로 보내 주세요.                              ]  │
│                                                              │
│ 실제 문장                                                     │
│ [ 자료는 메일로 보내 주세요.                              ]  │
│                                                              │
│ [원본 파일 열기] [취소] [저장하고 현재 장면에 반영]          │
└──────────────────────────────────────────────────────────────┘
```

- 기본 포커스는 현재 표시 레이어다.
- `dual_dialogue`, `dual_narration`, `inner_voice`는 두 레이어를 같이 보여 주되 수정한 필드만 저장한다.
- 현재 레이어의 화자, variant ID와 source field path를 접을 수 있는 고급 정보로 표시한다.
- `Cmd/Ctrl+Enter`는 저장, `Esc`는 취소다.
- 저장 버튼은 문장이 실제로 바뀌었고 로컬 검증이 통과할 때만 활성화한다.
- 입력 중 게임 진행, 선택, 저장·불러오기와 모드 전환을 막는다.

### 4.3 선택지와 상황 문구

선택 화면의 디버그 모드에서는 다음 각 행에 `편집`과 `원본` 버튼을 둔다.

- 질문 `choice.prompt`
- 직전 상황 요약 `choice.stimulus`
- 각 선택지의 플레이어 문구 `option.label`
- 주인공 해석 `option.interpretation`
- 실제 행동 `option.action`

선택지의 `push_pull`, `interaction`, 조건과 효과는 이 간편 편집 패널에서 수정하지 않는다. 해당 항목은 기존 Tauri 스토리 에디터로 연다.

### 4.4 백로그와 이벤트 요약

- 백로그의 각 대사에는 디버그 모드에서 `이 대사 원본 열기`를 제공한다.
- 같은 문장이 현재 장면에 남아 있고 revision이 일치하면 백로그에서도 편집할 수 있다.
- 이벤트 요약, 날짜 전환 전후의 인게임 요약과 자기계발 결과 문구도 source locator가 있으면 `원본`을 제공한다.
- UI 코드에 박힌 문자열처럼 저작 원본이 없는 문장은 `코드 문자열`로 표시하고 파일 열기만 제공한다.

## 5. 편집 가능한 문자열 범위

| 문자열 종류 | 1차 직접 편집 | 원본 열기 | 저장 대상 |
|---|---:|---:|---|
| 일반 `perceived.line`, `reality.line` | 가능 | 가능 | 장면 YAML |
| `inner_voice` 레이어 문장 | 가능 | 가능 | 장면 YAML |
| 직접 작성된 dialogue variant 문장 | 가능 | 가능 | 장면 YAML의 variant |
| 선택 질문·상황·label·interpretation·action | 가능 | 가능 | 장면 YAML |
| locale 번역 문장 | 2차 | 가능 | `story/locales/<locale>.yaml` |
| 이벤트 요약과 인게임 저작 문구 | 2차 | 가능 | event 또는 UI YAML |
| 자기계발 템플릿으로 합성된 variant | 구조화 편집 | 가능 | 장면 template + manifest slot |
| ID, 조건, 효과, 화자, 표정 | 불가 | 가능 | 기존 전체 에디터에서만 수정 |

첫 구현은 한국어 원본과 장면 YAML의 직접 소유 문자열에 집중한다. 다른 언어로 플레이 중이면 `현재 번역 편집`과 `한국어 원본 편집`을 명확히 나누기 전까지 직접 저장 버튼을 비활성화하고 원본 위치를 제공한다.

## 6. 원본 위치 계약

런타임의 표시 문자열마다 다음 descriptor를 얻을 수 있어야 한다.

```ts
type StoryTextOwner =
  | {
      kind: "direct_yaml";
      documentKind: "scene" | "event" | "ui" | "locale";
      documentId: string;
      relativePath: string;
      fieldPath: string;
      revision: string;
      currentValueHash: string;
      editable: true;
    }
  | {
      kind: "composed_template";
      editable: false;
      reason: "MULTIPLE_SOURCE_OWNERS";
      sources: Array<{
        label: string;
        relativePath: string;
        fieldPath: string;
      }>;
    }
  | {
      kind: "code" | "generated";
      editable: false;
      reason: string;
      sources: Array<{
        relativePath: string;
        fieldPath?: string;
      }>;
    };
```

플레이어는 표시 중인 localization key로 descriptor를 조회한다. 기존 `localization.entries[key].sourceDocument`를 출발점으로 쓰되, 별도의 authoring index가 실제 소유권을 보정한다.

특히 `self_development_template`을 컴파일한 문장은 현재 런타임상 `scene.nodes.<id>.variants...`처럼 보이지만 실제 완성 문장의 소유자는 다음 둘이다.

- 장면 YAML의 `self_development_template.<layer>.line`
- `story/manifest.yaml`의 `conversation_topics.<activity>.slots.<slot>`

이 문장을 일반 variant로 오인해 저장하면 안 된다. 빌더가 `owner.kind: composed_template`과 두 source를 기록하고, bridge가 다시 검증한다.

authoring index는 배포 게임 번들에 넣지 않는다. Tauri의 `load_project` 또는 새 `load_authoring_index` 명령으로만 전달한다.

## 7. 저장 API

전체 컴파일 장면을 플레이어에서 다시 보내 `save_scene`하는 방식은 사용하지 않는다. 컴파일된 variant가 저작 매크로를 덮을 수 있기 때문이다. 인게임 편집 전용의 좁은 text patch API를 추가한다.

```ts
type SaveStoryTextRequest = {
  root: string;
  localizationKey: string;
  expectedRevision: string;
  expectedValueHash: string;
  nextValue: string;
};

type SaveStoryTextResult = {
  saved: boolean;
  revision?: string;
  runtime?: Runtime;
  owner?: StoryTextOwner;
  issues: ValidationIssue[];
  errorCode?:
    | "REVISION_CONFLICT"
    | "VALUE_CONFLICT"
    | "MULTIPLE_SOURCE_OWNERS"
    | "FIELD_NOT_EDITABLE"
    | "VALIDATION_FAILED";
};
```

명령 이름은 다음으로 고정한다.

- Tauri: `get_story_text_owner`, `save_story_text`, `open_source_location`
- Python bridge: `text-owner`, `save-text`

## 8. 저장 처리 순서

`save-text`는 다음 순서를 한 트랜잭션처럼 수행한다.

1. Tauri에서 프로젝트 루트가 사용자가 연 허용 루트인지 확인한다.
2. localization key를 authoring index에서 찾는다.
3. 상대 경로를 canonicalize하고 반드시 `story/` 내부인지 확인한다.
4. owner가 `direct_yaml`이고 허용된 문자열 field인지 확인한다.
5. 디스크 revision이 `expectedRevision`과 같은지 확인한다.
6. 현재 필드 값의 hash가 `expectedValueHash`와 같은지 확인한다.
7. ruamel YAML round-trip 문서에서 안정 ID를 따라 실제 scalar field를 찾는다.
8. 문장 형식과 placeholder 보존을 검사한다.
9. 후보 문서로 프로젝트 전체 story validation을 실행한다.
10. 오류가 0개일 때만 임시 파일, `fsync`, `os.replace` 순서로 원본을 교체한다.
11. 런타임과 localization report를 재빌드한다.
12. 새 runtime, revision과 owner descriptor를 플레이어에 반환한다.

검증 실패, 외부 변경 또는 프로세스 중단 시 마지막 정상 YAML은 그대로 남아야 한다. 입력 초안은 Tauri 제작 세션의 local storage에 보관하되 원본보다 우선하지 않는다.

## 9. 플레이어 hot reload

현재 `WebGame`은 import된 runtime 상수를 직접 사용한다. 제작 모드에서는 이를 `RuntimeProvider` 또는 `useAuthoringRuntime` 상태로 감싼다.

저장 성공 후에는 다음만 수행한다.

- 새 runtime으로 현재 scene ID와 node ID를 다시 조회한다.
- 현재 `PlayerSession`의 상태, 캠페인, 연속성, 선택 이력과 디버그 이전 이동 기록은 유지한다.
- 현재 문장을 새 runtime에서 다시 resolve한다.
- 타이핑 애니메이션은 수정된 문장 처음부터 다시 표시한다.
- 구조 변경은 text patch API가 허용하지 않으므로 다음 노드와 세이브 호환성은 바뀌지 않는다.

runtime 교체에 실패하면 화면에는 기존 runtime을 유지하고 `파일은 저장됐지만 미리보기 갱신에 실패함`을 표시한 뒤 `런타임 다시 불러오기`를 제공한다.

## 10. 템플릿 합성 대사 UX

합성 대사에서 `대사 편집`을 누르면 완성 문장 textarea 대신 소유자를 나눠 보여 준다.

```text
이 문장은 두 원본을 합쳐 만들었습니다.

장면 공통 문장
오늘도 잘 부탁합니다. {{office_pitch}} 그럼 참석자표부터 볼까요?
[장면 원본 열기]

운동 활동 문구
요즘 운동을 다시 시작했습니다. 앉아 있는 시간이 길어서 체력부터 챙기려고요.
[manifest 원본 열기]
```

1차 구현에서는 두 필드를 읽기 전용으로 보여 주고 각각 원본을 연다. 2차 구현에서 placeholder를 보존하는 구조화 편집을 추가한다. 완성 결과를 하나의 새 variant로 저장하는 기능은 제공하지 않는다.

## 11. 원본 파일 열기

기존 `reveal_in_file_manager`는 파일 선택 표시 fallback으로 그대로 유지한다. 새 `open_source_location`은 다음 안전 규칙을 따른다.

- 프로젝트 안의 상대 경로만 받는다.
- free-form shell command를 받지 않는다.
- 편집기 설정은 `system`, `vscode`, `cursor`, `zed` 같은 enum만 허용한다.
- 지원 편집기는 가능한 경우 `path:line:column`으로 연다.
- 실행 파일을 찾지 못하면 시스템 기본 앱으로 파일을 열고 field path를 clipboard에 복사한다.
- line과 column은 빌드 시 고정하지 않고 현재 YAML을 읽어 요청 시 계산한다.

버튼 동작은 다음 우선순위를 쓴다.

1. 설정한 코드 편집기에서 해당 줄 열기
2. 시스템 기본 앱에서 파일 열기
3. Finder/Explorer에서 파일 선택
4. 상대 경로와 field path 복사

전체 Tauri 스토리 에디터가 열려 있으면 `전체 에디터에서 열기`가 가장 앞에 오며 scene ID와 node ID를 전달한다.

## 12. 충돌과 Undo

- 파일이 외부에서 바뀌면 자동 덮어쓰지 않고 `REVISION_CONFLICT`를 표시한다.
- 같은 revision에서 해당 필드만 바뀐 경우도 `VALUE_CONFLICT`로 막는다.
- 충돌 패널은 `내 초안`, `현재 디스크 값`, `다시 불러오기`, `초안 복사`를 제공한다.
- 인게임 편집 Undo는 직전 저장값으로 새 text patch를 한 번 더 수행한다. 파일 시스템을 과거 전체 상태로 되돌리지 않는다.
- Git commit, branch, push는 대사 편집 모드에서 자동 수행하지 않는다.

## 13. 코드 변경 위치

| 영역 | 변경 |
|---|---|
| `tools/story_harness.py` | localizable entry의 실제 authoring owner를 계산하는 index 생성 |
| `tools/story_editor_bridge.py` | text owner 조회, whitelist text patch, revision/value 충돌, 원자적 저장 |
| `src-tauri/src/lib.rs` | 세 명령 노출과 안전한 source open 구현 |
| `src/player/WebGame.tsx` | runtime 상태화, 편집 패널, 현재 대사·선택지·백로그 source action |
| `src/player/gameI18n.ts` | 표시 localization key와 source owner 조회 연결 |
| `src/player/web-game.css` | 중앙 토큰을 사용한 디버그 편집 패널 스타일 |
| `story/ui.yaml` | 대사 편집, 저장 상태, 충돌과 fallback 문구 |

## 14. 구현 순서

### 1단계: 모든 문장의 원본 열기

- 현재 대사, 선택지, 백로그에 localization key와 source locator 표시
- `원본 파일 열기`, `Finder/Explorer에서 보기`, `경로 복사`
- 직접 소유 문자열과 합성 문자열을 구분
- 제작 Tauri에서만 노출

이 단계만 완료해도 사용자는 게임을 보면서 각 YAML 대사를 빠르게 직접 고칠 수 있다.

### 2단계: 일반 대사의 인게임 저장

- 한국어 `direct_yaml` 문장 textarea
- revision/value 충돌 검사
- 검증 후 원자적 저장과 런타임 재빌드
- 현재 진행 상태를 유지한 hot reload

### 3단계: 선택지·이벤트·번역 확장

- choice의 다섯 문자열 필드
- 이벤트 요약과 UI 저작 문구
- locale별 번역 편집
- 백로그에서 과거 문장 편집

### 4단계: 합성 템플릿 구조화 편집

- 장면 wrapper와 manifest slot을 별도 입력으로 제공
- placeholder 보호
- 모든 activity variant 미리보기

## 15. 인수 조건

- 디버그 모드가 아니면 편집·원본 버튼과 source 정보가 보이지 않는다.
- Tauri에서 일반 대사 한 줄을 저장하면 해당 YAML scalar만 바뀐다.
- 저장 후 현재 장면을 다시 시작하지 않아도 수정 문장이 표시된다.
- 두 레이어 중 한쪽만 수정하면 다른 레이어, 화자, 표정, 다음 노드와 효과가 바뀌지 않는다.
- 외부 파일 변경 뒤 저장하면 원본을 덮지 않고 충돌을 표시한다.
- validation error가 생기면 원본과 runtime을 모두 마지막 정상 상태로 보존한다.
- 자기계발 합성 문장은 일반 variant로 저장되지 않는다.
- 선택지 label 편집은 ID, 조건, 효과와 `push_pull`을 바꾸지 않는다.
- 백로그와 선택 화면을 포함한 모든 저작 문구에서 최소 `원본 파일 열기` 또는 정확한 경로 복사가 가능하다.
- 웹 배포판에서는 로컬 쓰기 IPC와 절대 경로가 노출되지 않는다.

## 16. 테스트 계약

### Python

- localization key가 안정 ID를 따라 실제 YAML field를 찾는다.
- 존재하지 않는 key, 비문자열 field와 story 밖 경로를 거부한다.
- revision 충돌과 value 충돌을 각각 검출한다.
- 저장 실패 시 YAML과 runtime이 바뀌지 않는다.
- direct variant는 저장되고 compiled template variant는 거부된다.
- 주석과 키 순서를 보존한다.

### Rust/Tauri

- 승인되지 않은 프로젝트와 절대 경로를 거부한다.
- source open이 프로젝트 밖으로 탈출하지 않는다.
- free-form 실행 명령을 받을 수 없다.

### Player

- 일반 모드에서 제작 UI가 없다.
- authoring capability가 없으면 편집 버튼이 없다.
- 저장 중 진행·오토·스킵이 멈춘다.
- 저장 성공 후 session state는 같고 표시 문장만 바뀐다.
- choice와 backlog가 정확한 localization key를 전달한다.

### E2E

- 현재 대사 편집 → 저장 → YAML 확인 → 화면 즉시 반영
- 외부 파일 변경 → 충돌 → 초안 보존
- 합성 대사 → 두 source 안내 → 원본 열기 fallback
- 웹 게임 빌드 → 제작 IPC와 편집 UI 부재

## 17. 제외 범위

- 인게임에서 노드 추가·삭제·연결 변경
- 조건, 효과, 상태 계약과 ID 수정
- 자동 Git commit·push
- 여러 제작자의 동시 편집과 실시간 병합
- 정적 웹 배포판에서 사용자의 로컬 저장소 직접 수정

구조 변경은 기존 Tauri 스토리 에디터가 담당하고, 인게임 편집 모드는 **플레이하면서 문장을 빠르게 고치는 좁고 안전한 도구**로 유지한다.
