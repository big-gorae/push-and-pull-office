# [구현] 인게임 대사 편집 모드 설계

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

설계의 네 단계를 모두 구현했다.

- Tauri 스토리 에디터에서 `게임에서 대사 편집`으로 별도 제작용 플레이 창을 연다. 스토리 에디터는 열어 둔 채 게임을 진행할 수 있다.
- `장면·대사` 작업 공간은 왼쪽에 `1일차 → 장면` 순서의 시간 탐색기를, 중앙에 위에서 아래로 읽는 큰 대사 목록과 상세 편집기를 둔다. 내부 `node` 용어는 이 화면에서 `대사`로 표시하고 별도 미니 프리뷰는 두지 않는다.
- 중앙의 `게임에서 이 대사 보기`는 제작용 게임 창을 열거나 활성화하고 선택한 장면·대사로 바로 이동한다.
- 대사 상세의 `화면 원화`는 전체 OFF와 왼쪽·가운데·오른쪽 최대 3명의 명시적 배치를 편집한다. 새 대사에서 서정우가 아닌 일러스트 화자를 선택하면 중앙에 기본 cue가 저장된다. 캐릭터 탭에서 등록 원화를 썸네일로 고르며 비화자와 선택 화면에도 배치할 수 있다.
- 장면 탭의 `씬 기본 배경`은 썸네일 모달에서 배경을 하나 고르거나 장소·시간 자동 선택으로 되돌린다. 선택 결과는 이미지 경로가 아니라 background visual·variant 안정 ID로 저장한다.
- `무대사`를 현재 대사 다음에 추가하면 0글자 문장을 저장하고 게임에서는 대사창·HUD 없이 배경과 선택한 원화만 표시한다.
- 대사를 삭제하면 그 대사를 가리키던 시작점·다음 대사·선택지·수치 분기·합류점을 삭제 대사의 다음 화면으로 자동 연결한다.
- 디버그 모드에서 현재 대사, 선택지 문구, 사건 요약, 백로그, 날짜 전환·엔딩과 자기계발 문구를 편집한다.
- 한국어 원본과 locale별 번역을 전환해 편집하며, 번역 scalar가 아직 없으면 한국어 fallback을 바탕으로 새 번역을 만든다.
- 자기계발 합성 variant는 완성 문장을 덮어쓰지 않고 장면 wrapper와 manifest slot을 분리한 구조화 입력으로 편집한다.
- revision과 현재 값 hash를 모두 검사하고, 서로 다른 YAML 문서의 여러 필드를 전체 검증 후 한 저장 단위로 교체한 뒤 `build/story-runtime.json`을 재빌드한다.
- 저장 결과는 진행 상태를 유지한 채 현재 locale 화면에 즉시 반영되며, 직전 저장은 새 충돌 보호 patch로 되돌린다.
- 개발 서버는 문구 저장 때 재생성되는 `build/story-runtime.json`을 HMR 대상으로 취급하지 않는다. 저장 응답의 런타임과 문구 override를 적용하므로 게임 세션과 현재 장면을 유지한다.
- 모든 source action은 현재 line/column과 field path를 제공한다. 시스템 기본 앱, VS Code, Cursor, Zed 열기, Finder 보기와 위치 복사를 지원한다.
- 편집 초안은 원본 revision fingerprint와 함께 로컬 제작 세션에 보관되며, 원본이 바뀐 초안은 자동 적용하지 않는다.
- 정적 웹 게임에는 제작 기능, 로컬 쓰기 IPC와 프로젝트 경로가 노출되지 않는다.

## 2. 사용자 목표

제작자는 다음 흐름으로 대사를 한 줄씩 고칠 수 있어야 한다.

1. 게임 창을 플레이하며 다음 대사로 계속 진행한다.
2. 대사 수정은 게임 창의 `대사 편집`으로 바로 저장하거나, `스토리 에디터로 돌아가기`로 별도 에디터 창의 현재 장면을 연다.
3. 에디터에서는 노드 추가·삭제·순서 변경과 화자·표정·배경, 대사별 화면 원화까지 편집한다.
4. 게임 창에서 저장한 텍스트 수정은 현재 화면에 즉시 반영한다. 에디터 창에서 노드 구조를 바꾼 경우에는 진행 중 세션을 안전하게 보존하기 위해 게임 창을 새로 열어 변경된 런타임을 읽는다.

편집이 지원되지 않는 문장에서도 다음 작업은 항상 가능해야 한다.

- 원본 YAML 파일 열기
- Finder/Explorer에서 파일 위치 보기
- `파일 경로 · node ID · field path` 복사
- 전체 스토리 에디터의 해당 장면으로 이동

## 3. 실행 환경별 동작

| 환경 | 현재 문장 편집·저장 | 원본 열기 | 경로 복사 | 이유 |
|---|---:|---:|---:|---|
| Tauri 제작 앱의 플레이 테스트 | 가능 | 가능 | 가능 | 승인된 프로젝트 루트와 로컬 브리지를 사용한다. |
| 로컬 Vite 브라우저 | 비활성 | 비활성 | 비활성 | Tauri가 승인한 프로젝트 루트가 없으면 제작 UI 자체를 표시하지 않는다. |
| GitHub Pages·일반 배포판 | 불가 | 불가 | 숨김 | 제작 경로와 파일 쓰기 기능을 배포판에 노출하지 않는다. |

플레이어는 `import.meta.env.DEV`만으로 권한을 판단하지 않는다. 실제 Tauri IPC가 있고 스토리 에디터가 승인한 프로젝트 루트가 같은 WebView의 session storage에 전달된 경우에만 제작 기능을 표시한다.

## 4. 인게임 UI

### 4.1 현재 대사

디버그 모드에서 대사창 오른쪽 위에 제작용 작은 도구를 둔다.

```text
┌──────────────────────────────────────────────────────────────┐
│ 유은솔                            [✎ 대사 편집] [</> 원본]   │
│ “자료는 메일로 보내 주세요.”                                │
│                                                              │
│ DEBUG · common.scene / request / perceived                    │
└──────────────────────────────────────────────────────────────┘
```

- 일반 플레이 모드에서는 두 버튼과 source ID를 모두 숨긴다.
- `✎ 대사 편집`은 직접 소유 문자열과 구조화 편집 가능한 합성 문자열에서 활성화한다.
- `</> 원본`은 편집 가능 여부와 무관하게 활성화한다.
- 오토·스킵 중 편집을 열면 즉시 정지한다.

### 4.2 편집 패널

```text
┌─ 대사 편집 ──────────────────────────────────────────────────┐
│ common.day_02_practical_meeting · request                     │
│ story/scenes/common/day_02_practical_meeting.yaml             │
│                                                              │
│ 대사                                                          │
│ [ 자료는 메일로 보내 주세요.                              ]  │
│                                                              │
│ [원본 파일 열기] [취소] [저장하고 현재 장면에 반영]          │
└──────────────────────────────────────────────────────────────┘
```

- 화자, variant ID와 source field path를 접을 수 있는 고급 정보로 표시한다.
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

| 문자열 종류 | 인게임 편집 | 원본 열기 | 저장 대상 |
|---|---:|---:|---|
| 일반 `line` | 가능 | 가능 | 장면 YAML |
| 직접 작성된 dialogue variant 문장 | 가능 | 가능 | 장면 YAML의 variant |
| 선택 질문·상황·label·interpretation·action | 가능 | 가능 | 장면 YAML |
| locale 번역 문장 | 가능 | 가능 | `story/locales/<locale>.yaml` |
| 이벤트 요약과 인게임 저작 문구 | 가능 | 가능 | event 또는 UI YAML |
| 자기계발 템플릿으로 합성된 variant | 구조화 편집 | 가능 | 장면 template + manifest slot |
| ID, 조건, 효과, 화자, 표정 | 불가 | 가능 | 기존 전체 에디터에서만 수정 |

언어 탭은 `한국어 원본`과 locale별 번역을 명확히 분리한다. 없는 번역을 만들거나 직전 저장으로 삭제해 fallback 상태로 되돌리는 동작도 같은 충돌 보호를 거친다.

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
      locale: string;
      isTranslation: boolean;
      translationExists: boolean;
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
        line?: number;
        column?: number;
        editable: true;
        revision: string;
        currentValueHash: string;
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
type StoryTextEdit = {
  localization_key: string;
  locale?: string;
  expected_revision: string;
  expected_value_hash: string;
  next_value?: string;
  delete?: boolean;
  source_relative_path?: string;
  source_field_path?: string;
};

type SaveStoryTextRequest = {
  root: string;
  edits: StoryTextEdit[];
};

type SaveStoryTextResult = {
  saved: boolean;
  revision?: string;
  runtime?: Runtime;
  owner?: StoryTextOwner;
  owners?: StoryTextOwner[];
  changes?: StoryTextChange[];
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
4. 각 edit가 직접 번역·원문 owner이거나 owner가 선언한 합성 source인지 확인한다.
5. 디스크 revision이 `expectedRevision`과 같은지 확인한다.
6. 현재 필드 값의 hash가 `expectedValueHash`와 같은지 확인한다.
7. ruamel YAML round-trip 문서에서 안정 ID를 따라 실제 scalar field를 찾는다.
8. 문장 형식과 placeholder 보존을 검사한다.
9. 후보 문서로 프로젝트 전체 story validation을 실행한다.
10. 오류가 0개일 때만 각 원본을 임시 파일, `fsync`, `os.replace` 순서로 교체한다. 교체 또는 빌드 실패 시 이미 교체된 파일도 이전 bytes로 복구한다.
11. 런타임과 localization report를 원자적으로 재빌드한다.
12. 새 runtime, owner descriptor와 Undo용 before/after change set을 플레이어에 반환한다.

검증 실패, 외부 변경 또는 프로세스 중단 시 마지막 정상 YAML은 그대로 남아야 한다. 입력 초안은 Tauri 제작 세션의 local storage에 보관하되 원본보다 우선하지 않는다.

## 9. 플레이어 hot reload

`WebGame`은 저장 응답의 새 runtime에서 편집한 localization key의 현재 locale 값을 읽어 제작용 override 상태에 반영한다.

저장 성공 후에는 다음만 수행한다.

- 현재 `PlayerSession`의 상태, 캠페인, 연속성, 선택 이력과 디버그 이전 이동 기록은 유지한다.
- 현재 문장·선택지·백로그·상황 화면은 동일 localization key의 새 값으로 다시 렌더링한다.
- 타이핑 애니메이션은 수정된 문장 처음부터 다시 표시한다.
- 구조 변경은 text patch API가 허용하지 않으므로 다음 노드와 세이브 호환성은 바뀌지 않는다.

백엔드는 runtime 재빌드까지 성공해야만 `saved: true`를 반환한다. 빌드나 응답 적용이 실패하면 기존 화면과 원본을 유지하고 저장 실패를 표시한다.

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

두 필드는 각각 수정 가능하며 한 번의 저장 요청으로 함께 검증한다. placeholder를 삭제하거나 바꾸면 저장을 거부한다. 완성 결과를 하나의 새 variant로 저장하는 기능은 제공하지 않는다.

## 11. 원본 파일 열기

기존 `reveal_in_file_manager`는 파일 선택 표시 fallback으로 그대로 유지한다. 새 `open_source_location`은 다음 안전 규칙을 따른다.

- 프로젝트 안의 상대 경로만 받는다.
- free-form shell command를 받지 않는다.
- 편집기 설정은 `system`, `vscode`, `cursor`, `zed` 같은 enum만 허용한다.
- 지원 편집기는 가능한 경우 `path:line:column`으로 연다.
- 실행 파일을 찾지 못하면 시스템 기본 앱으로 파일을 연다. field path는 별도의 `위치 복사` 버튼으로 복사한다.
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
- 충돌이 나도 textarea와 revision fingerprint가 맞는 local draft를 유지하고 `원본 다시 불러오기`를 제공한다. 다시 불러오기는 현재 디스크 값을 명시적으로 선택한 경우에만 초안을 교체한다.
- 인게임 편집 Undo는 직전 저장값으로 새 text patch를 한 번 더 수행한다. 파일 시스템을 과거 전체 상태로 되돌리지 않는다.
- Git commit, branch, push는 대사 편집 모드에서 자동 수행하지 않는다.

## 13. 코드 변경 위치

| 영역 | 변경 |
|---|---|
| `tools/story_editor_bridge.py` | text owner 조회, locale·합성 source whitelist patch, revision/value 충돌, 다중 문서 검증·복구 가능한 원자 저장 |
| `src-tauri/src/lib.rs` | 세 명령 노출과 editor enum·line/column 기반의 안전한 source open 구현 |
| `src/player/WebGame.tsx` | locale·합성 편집 패널, draft·Undo·hot override와 모든 상황별 source action |
| `src/player/storyAuthoring.ts` | Tauri IPC 경계, source locator, editor 설정, Undo patch와 에디터 복귀 target |
| `src/player/gameI18n.ts` | 현재 locale별 제작 override를 원문 fallback보다 우선 적용 |
| `src/player/web-game.css` | 중앙 토큰을 사용한 디버그 편집 패널 스타일 |

## 14. 구현 완료 단계

### 1단계: 모든 문장의 원본 열기 — 완료

- 현재 대사, 선택지, 백로그에 localization key와 source locator 표시
- `원본 파일 열기`, `Finder/Explorer에서 보기`, `경로 복사`
- 직접 소유 문자열과 합성 문자열을 구분
- 제작 Tauri에서만 노출

### 2단계: 일반 대사의 인게임 저장 — 완료

- 한국어 `direct_yaml` 문장 textarea
- revision/value 충돌 검사
- 검증 후 원자적 저장과 런타임 재빌드
- 현재 진행 상태를 유지한 hot reload

### 3단계: 선택지·이벤트·번역 확장 — 완료

- choice의 다섯 문자열 필드
- 이벤트 요약과 UI 저작 문구
- locale별 번역 편집
- 백로그에서 과거 문장 편집

### 4단계: 합성 템플릿 구조화 편집 — 완료

- 장면 wrapper와 manifest slot을 별도 입력으로 제공
- placeholder 보호
- 전체 activity variant 재컴파일·검증

## 15. 인수 조건

- 디버그 모드가 아니면 편집·원본 버튼과 source 정보가 보이지 않는다.
- Tauri에서 일반 대사 한 줄을 저장하면 해당 YAML scalar만 바뀐다.
- 저장 후 현재 장면을 다시 시작하지 않아도 수정 문장이 표시된다.
- 두 레이어 중 한쪽만 수정하면 다른 레이어, 화자, 표정, 다음 노드와 효과가 바뀌지 않는다.
- 외부 파일 변경 뒤 저장하면 원본을 덮지 않고 충돌을 표시한다.
- validation error가 생기면 원본과 runtime을 모두 마지막 정상 상태로 보존한다.
- 자기계발 합성 문장은 일반 variant로 저장되지 않는다.
- 선택지 label 편집은 ID, 조건, 효과와 `push_pull`을 바꾸지 않는다.
- 없는 locale 번역은 새 scalar로 생성하고 Undo하면 fallback 상태로 되돌아간다.
- 합성 대사를 저장하면 wrapper와 slot만 바뀌고 생성 variant는 직접 덮어쓰지 않는다.
- 직전 저장 Undo도 새 revision/value hash를 검사하므로 이후 외부 변경을 덮지 않는다.
- 백로그와 선택 화면을 포함한 모든 저작 문구에서 최소 `원본 파일 열기` 또는 정확한 경로 복사가 가능하다.
- 웹 배포판에서는 로컬 쓰기 IPC와 절대 경로가 노출되지 않는다.

## 16. 테스트 계약

### Python

- localization key가 안정 ID를 따라 실제 YAML field를 찾는다.
- 존재하지 않는 key, 비문자열 field와 story 밖 경로를 거부한다.
- revision 충돌과 value 충돌을 각각 검출한다.
- 저장 실패 시 YAML과 runtime이 바뀌지 않는다.
- direct variant는 저장되고 compiled template variant는 거부된다.
- 없는 locale scalar의 생성·삭제 Undo와 합성 wrapper·manifest slot의 다중 문서 저장·Undo가 실제 임시 프로젝트에서 성공한다.
- 주석과 키 순서를 보존한다.

### Rust/Tauri

- 승인되지 않은 프로젝트와 절대 경로를 거부한다.
- source open이 프로젝트 밖으로 탈출하지 않는다.
- free-form 실행 명령을 받을 수 없다.
- 편집기는 `system`, `vscode`, `cursor`, `zed` enum 외 값을 거부한다.

### Player

- 일반 모드에서 제작 UI가 없다.
- authoring capability가 없으면 편집 버튼이 없다.
- 저장 중 진행·오토·스킵이 멈춘다.
- 저장 성공 후 session state는 같고 표시 문장만 바뀐다.
- choice와 backlog가 정확한 localization key를 전달한다.
- locale별 hot override와 직전 change set의 충돌 보호 Undo patch를 생성한다.

### E2E

- 제작 IPC가 있는 플레이 화면 → 합성 source 3개 확인 → 없는 번역 저장 → 화면 즉시 반영 → 삭제 Undo
- 외부 파일 변경 → 충돌 → 초안 보존
- 합성 대사 → wrapper·slot 구조화 편집과 각 원본 열기 fallback
- 웹 게임 빌드 → 제작 IPC와 편집 UI 부재

## 17. 제외 범위

- 인게임에서 노드 추가·삭제·연결 변경
- 조건, 효과, 상태 계약과 ID 수정
- 자동 Git commit·push
- 여러 제작자의 동시 편집과 실시간 병합
- 정적 웹 배포판에서 사용자의 로컬 저장소 직접 수정

구조 변경은 기존 Tauri 스토리 에디터가 담당하고, 인게임 편집 모드는 **플레이하면서 문장을 빠르게 고치는 좁고 안전한 도구**로 유지한다.
