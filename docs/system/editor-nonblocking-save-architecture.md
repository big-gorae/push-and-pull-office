# [구현] 에디터 비차단 저장 아키텍처

> 설계일: 2026-08-12
>
> 범위: Tauri 제작 버전의 장면, 사건, 인물, 시스템 대사, 번역, 캠페인·루트·스레드·비주얼 문서 저장
>
> 결정: 입력 모델과 영속화 파이프라인을 분리하고, 모든 편집기가 하나의 저장 오케스트레이터를 사용한다.

> 구현 상태: 2026-08-12에 1~3단계를 적용했다. 참조 그래프 기반 부분 검증과 다문서 단일 트랜잭션은 후속 확장 항목이다.

## 1. 결론

에디터의 입력 이벤트는 메모리의 편집 세션만 변경해야 한다. YAML 기록, 전체 참조 검증, 런타임 번들 생성, 디스크 `fsync`와 IPC 응답 반영은 입력 경로 밖의 백그라운드 파이프라인에서 수행한다.

자동 저장은 단순 주기 타이머가 아니라 다음 세 신호를 결합한다.

- 마지막 입력 후 `1.5초`가 지나면 저장하는 debounce
- 계속 입력하더라도 최초 미저장 변경 후 `5초` 안에는 최신 스냅샷을 보내는 max-wait
- `⌘S`/`Ctrl+S`, 앱 종료, 미리보기·빌드처럼 디스크 동기화가 필요한 동작에서 즉시 flush하는 barrier

저장 중에도 모든 일반 입력, 선택, Undo/Redo와 작업공간 이동은 가능해야 한다. 저장 응답은 자신이 보낸 문서 버전까지만 완료 처리하며, 그 뒤에 입력된 최신 초안을 절대 덮어쓰지 않는다.

## 2. 구현 전 진단

구현 전에는 대부분의 편집기에 자동 저장과 수동 저장 단축키가 있었지만 저장 정책과 동시성 처리가 각 컴포넌트에 흩어져 있었고, 한 번의 저장 비용이 프로젝트 전체 작업으로 확대됐다.

### 2.1 확인된 비용

| 구간 | 현재 동작 | 영향 |
|---|---|---|
| 프런트엔드 | 장면·사건·인물·설정 편집기가 각자 `setTimeout(1000)`과 `saving/dirty` 상태를 구현 | 새 편집 기능이 저장 규칙을 빠뜨리거나 서로 다르게 구현할 가능성 |
| 장면 저장 UI | `src/App.tsx`의 장면 저장이 전역 `busy`를 켬 | 저장과 무관한 버튼까지 비활성화되고 사용자가 저장을 로딩으로 체감 |
| Tauri 경계 | 각 `invoke`마다 새 Python 프로세스를 시작하고 동기식 `wait_with_output`으로 종료를 기다림 | 프로세스 시작·모듈 import 비용이 매 저장마다 반복됨 |
| 후보 검증 | `validate_candidate`가 `story/` 전체를 임시 디렉터리에 복사하고 `StoryProject`를 새로 파싱·검증 | 문서 하나의 변경이 전체 파일 시스템 작업으로 확대됨 |
| 커밋 이후 | YAML 기록 뒤 `StoryProject`를 다시 만들고 전체 번들·문서 인덱스·전체 검증 결과를 생성 | 같은 프로젝트를 한 저장에서 두 번 이상 읽고 계산함 |
| IPC 응답 | 약 2.8MB의 전체 `story-runtime.json`에 준하는 런타임을 매번 반환 | 직렬화, IPC 복사, React 상위 payload 교체와 하위 재렌더 비용 |
| 복구 초안 | 큰 문서를 `JSON.stringify`한 뒤 동기식 `localStorage`에 기록 | 300ms debounce 뒤에도 WebView 메인 스레드 long task 가능 |

현재 저장 전 검증 경로를 로컬에서 읽기 전용으로 측정했을 때, 이미 메모리에 있는 장면 JSON을 `validate-scene`에 전달하는 데 약 `1.39초`가 걸렸다. `story/`는 약 `880KB`, YAML은 `108개`, 생성 런타임은 약 `2.8MB`다. 절대 시간보다 중요한 사실은 문서 하나의 저장 비용이 프로젝트 크기에 비례한다는 것이다.

### 2.2 데이터 유실 위험

장면 편집기는 저장 시작 시 `draftVersion`을 캡처하고, 저장 중 추가 입력이 있으면 응답의 초안으로 교체하지 않는 방어가 있다. 사건, 인물, 프로젝트 설정 편집기는 같은 규칙을 공유하지 않는다. 해당 편집기에서는 저장 중 입력이 가능하지만 성공 응답이 오면 서버가 반환한 이전 스냅샷으로 `draft`를 교체하고 `dirty=false`로 만들 수 있다.

따라서 저장 중 입력을 허용하려면 UI 비활성화 여부와 별개로 모든 문서 종류가 동일한 버전 승인 규칙을 사용해야 한다.

## 3. 목표와 비목표

### 목표

- 타이핑 경로에서 디스크 I/O, 전체 검증, 전체 런타임 교체를 제거한다.
- 지속 입력 중에도 복구 데이터의 최대 손실 구간을 5초 이하로 제한한다.
- 저장 중 새 입력을 보존하고 마지막 스냅샷으로 자동 합친다.
- 모든 문서 종류가 같은 자동 저장, 단축키, 충돌, 재시도와 상태 표시 계약을 사용한다.
- 새로운 편집 기능은 문서 어댑터를 등록하는 것만으로 자동 저장 대상이 된다.
- YAML은 계속 권위 원본이며, 오류가 있는 후보를 권위 원본에 기록하지 않는다.

### 비목표

- 여러 사용자의 실시간 공동 편집
- Git 커밋이나 배포를 저장 동작에 결합
- 모든 검증기를 한 번에 Rust로 재작성
- 사용자가 입력할 때마다 권위 YAML을 기록

## 4. 목표 아키텍처

```mermaid
flowchart LR
  UI["React 편집 UI"] -->|Command| DS["DocumentSession<T>"]
  DS -->|dirty(version)| SC["SaveCoordinator"]
  DS -->|recovery snapshot| DJ["DraftJournal"]
  SC -->|coalesced snapshot| PQ["ProjectCommitQueue"]
  PQ -->|async IPC| PS["EditorProjectService"]
  PS --> VR["Cached StoryRepository + Validator"]
  VR -->|CAS + atomic replace| YAML["story/**/*.yaml"]
  VR -->|RuntimeDelta| RS["RuntimeStore"]
  VR -->|coalesced low priority build| RT["build/story-runtime.json"]
  RS --> UI
  PS -->|SaveReceipt| SC
  SC -->|ack persistedVersion| DS
```

### 핵심 객체 책임

| 객체 | 책임 | 알지 않아야 하는 것 |
|---|---|---|
| `DocumentSession<T>` | base/draft, `editVersion`, `persistedVersion`, Undo/Redo, 저장 스냅샷과 응답 승인 | 타이머, Tauri, YAML 경로 |
| `DocumentAdapter<T>` | 문서 종류, 안정 키, 빠른 로컬 검사, 저장 DTO와 런타임 delta 해석 | React 컴포넌트 생명주기 |
| `AutosavePolicy` | debounce, max-wait, 재시도 backoff, lifecycle barrier의 due time 계산 | 문서 내용 |
| `SaveCoordinator` | 세션 등록, dirty 관찰, 수동 flush, 최신 스냅샷 병합, 상태 발행 | YAML 직렬화 방식 |
| `ProjectCommitQueue` | 프로젝트별 한 개 in-flight, 우선순위, 문서 배치와 공용 런타임 기록 직렬화 | 화면 상태 |
| `SaveRepository` | 저장 요청/응답 port | 자동 저장 정책 |
| `EditorProjectService` | 장기 실행 프로젝트 캐시, 검증, revision CAS, 원자적 기록, runtime delta와 번들 생성 | React 상태 |
| `DraftJournal` | 권위 YAML과 별개인 비동기 crash recovery | 전체 프로젝트 검증 |

상속 트리보다 작은 객체의 합성을 우선한다. 새 문서 기능은 `DocumentAdapter<T>`와 편집 명령만 제공하고, 타이머·단축키·저장 상태 UI를 다시 만들지 않는다.

## 5. 프런트엔드 계약

### 5.1 문서 세션

```ts
type DocumentKey = `${string}:${string}`;

type DocumentSnapshot<T> = {
  key: DocumentKey;
  sessionEpoch: string;
  editVersion: number;
  baseRevision: string;
  value: Readonly<T>;
};

type SaveReceipt = {
  key: DocumentKey;
  sessionEpoch: string;
  persistedVersion: number;
  previousRevision: string;
  revision: string;
  runtimeDelta: RuntimeDelta;
  issues: ValidationIssue[];
  durableAt: number;
};

interface PersistableDocument<T> {
  readonly key: DocumentKey;
  readonly phase: "clean" | "dirty" | "queued" | "saving" | "error" | "conflict";
  edit(command: EditorCommand<T>): void;
  snapshot(): DocumentSnapshot<T>;
  acknowledge(receipt: SaveReceipt): void;
}
```

`acknowledge`의 불변식은 다음과 같다.

1. `sessionEpoch`가 다르면 이미 다른 문서를 연 응답이므로 폐기한다.
2. 응답의 `revision`은 다음 저장의 CAS 기준으로 갱신한다.
3. `persistedVersion = receipt.persistedVersion`까지만 저장 완료로 표시한다.
4. 현재 `editVersion > persistedVersion`이면 초안은 그대로 두고 즉시 `dirty`로 돌아간다.
5. 최신 버전까지 저장된 경우에만 `clean`으로 전환한다.
6. 저장 응답의 문서 본문으로 현재 draft를 교체하지 않는다. 서버 정규화가 필요하면 저장 스냅샷에 대한 `canonicalPatch`만 버전 조건부로 적용한다.

### 5.2 저장 스케줄

기본 정책은 다음과 같다.

```text
첫 변경 t=0 ── 추가 입력 ── 추가 입력 ── 1.5s idle ── 저장
      └──────────────────────── 5s max-wait ─────────┘

저장 A 진행 중 ── 입력 v11, v12, v13 ── A(v10) 완료 ── B(v13) 즉시 예약
```

- debounce: `1.5초`
- max-wait: `5초`
- 복구 journal: 변경 후 `250ms` debounce, `2초` max-wait
- 오류 재시도: 일시적 I/O 오류만 `1s, 2s, 5s, 15s` + jitter; 검증 오류는 다음 편집 전까지 재시도하지 않음
- 백그라운드 문서: 동일 정책으로 저장하되 화면에 없다는 이유로 타이머를 취소하지 않음
- 수동 저장: 현재 문서를 즉시 큐 선두로 올리고 최신 스냅샷을 flush
- 앱 종료: journal flush를 먼저 보장하고, 권위 저장은 짧은 종료 barrier 안에서 완료되지 않으면 다음 실행에 복구

단순 `setInterval`은 사용하지 않는다. 변경이 없을 때 불필요한 I/O를 만들고, 입력 직후 저장과 겹치며, 지속 입력의 최대 미저장 시간을 보장하지 못하기 때문이다.

### 5.3 큐와 병합

- 프로젝트마다 실제 커밋은 하나만 실행한다. 여러 저장이 `build/story-runtime.json`을 동시에 덮어쓰지 못하게 한다.
- 문서마다 `inFlight` 하나와 `pendingLatest` 하나만 둔다. pending 요청은 항상 더 최신 스냅샷으로 교체해 중간 버전을 버린다.
- 가까운 시간에 변경된 서로 다른 문서는 하나의 `commit_documents` 요청으로 배치할 수 있다.
- 같은 YAML 파일의 여러 텍스트 필드는 파일 단위 트랜잭션으로 합친다.
- 수동 저장은 자동 저장보다 우선하지만 진행 중인 원자적 커밋을 취소하지 않는다.
- 미리보기, 복제, 런타임 빌드처럼 디스크 일관성이 필요한 명령은 `await coordinator.barrier(scope)`를 명시적으로 사용한다. 일반 입력은 barrier를 사용하지 않는다.

### 5.4 단축키와 상태 UI

단축키는 각 편집기 컴포넌트가 아니라 앱 루트의 `SaveCommandBinding` 한 곳에서 처리한다.

- macOS: `⌘S`
- Windows/Linux: `Ctrl+S`
- 브라우저 기본 저장 동작은 항상 막는다.
- dirty가 없어도 키 입력은 소비하되 디스크 작업은 만들지 않는다.
- 저장 중 다시 누르면 현재 최신 버전을 `pendingLatest`로 보장하고 “최신 변경 저장 예약됨”을 표시한다.

상태는 전역 `busy`와 분리한다.

| 상태 | 표시 | 입력 가능 |
|---|---|---|
| `clean` | `저장됨 14:03:21` | 가능 |
| `dirty` | `변경됨 · 자동 저장 예정` | 가능 |
| `queued` | `저장 대기 중` | 가능 |
| `saving` | `백그라운드 저장 중…` | 가능 |
| `saving + dirty` | `이전 변경 저장 중 · 최신 변경 대기` | 가능 |
| `error` | `저장 실패 · 초안 보존됨` | 가능 |
| `conflict` | `외부 변경 충돌 · 비교 필요` | 가능, 자동 저장만 일시 정지 |

저장 때문에 폼, 작업공간 이동, Undo/Redo를 비활성화하지 않는다. 복제·프로젝트 교체·런타임 실행처럼 일관된 디스크 스냅샷이 필요한 동작만 해당 범위의 barrier 동안 기다린다.

## 6. 백엔드 저장 서비스

### 6.1 즉시 개선

Tauri command를 `async`로 바꾸고 기존 Python 실행은 `spawn_blocking`에서 수행한다. 이 변경만으로 저장 비용 자체가 줄지는 않지만 Tauri command executor의 blocking 구간을 격리하고 취소·timeout·추적 ID를 붙일 기반을 만든다.

응답은 전체 `Runtime`과 전체 문서 인덱스가 아니라 아래 delta만 반환한다.

```ts
type RuntimeDelta = {
  generation: number;
  changed: Array<{ collection: RuntimeCollection; id: string; value: unknown }>;
  removed?: Array<{ collection: RuntimeCollection; id: string }>;
  sourceSha256?: string;
};
```

React는 정규화된 `RuntimeStore`에 delta를 적용한다. 상위 `ProjectPayload` 전체 교체와 모든 작업공간의 연쇄 렌더를 피한다.

### 6.2 목표 형태

프로젝트를 열 때 Python worker 또는 동등한 `EditorProjectService`를 프로젝트당 하나 장기 실행한다. 첫 로드에서 `StoryProject`, 소스 revision, 참조 그래프와 컴파일 캐시를 만들고 이후 요청은 NDJSON 또는 구조화 IPC로 전달한다.

저장 트랜잭션은 다음 순서를 지킨다.

1. 요청의 `baseRevision`과 현재 파일 revision을 비교한다.
2. 캐시의 해당 문서에 후보 overlay를 적용한다.
3. 변경 문서의 스키마와 참조 그래프에서 영향받는 검증기만 실행한다.
4. 전체 불변식 검증은 디스크 복사 없이 캐시된 프로젝트 snapshot 위에서 실행한다.
5. 오류가 없으면 같은 디렉터리에 임시 파일을 쓰고 파일 `fsync` 후 원자적 rename을 한다.
6. 필요 플랫폼에서는 부모 디렉터리도 `fsync`한다.
7. 캐시와 revision을 새 generation으로 승격한다.
8. 변경 문서의 `RuntimeDelta`와 `SaveReceipt`를 반환한다.
9. 여러 커밋을 합쳐 저우선순위 런타임 번들 빌드를 수행하고 원자적으로 교체한다.

권위 YAML 커밋 전 검증은 유지한다. 최적화 대상은 안전성 삭제가 아니라 전체 디렉터리 복사, 중복 파싱과 전체 응답이다.

### 6.3 YAML과 런타임의 일관성

저장 상태를 두 단계로 구분한다.

- `sourceDurableGeneration`: YAML이 원자적으로 저장된 generation
- `runtimeBuiltGeneration`: `build/story-runtime.json`이 반영한 generation

에디터 미리보기는 저장 응답의 `RuntimeDelta`를 즉시 사용한다. 제작 플레이 실행, 명시적 런타임 빌드와 배포는 `runtimeBuiltGeneration >= sourceDurableGeneration` barrier를 통과해야 한다. 번들 빌드가 실패해도 이미 검증·기록된 YAML을 조용히 되돌리지 않고, 런타임 동기화 오류를 별도 상태로 보여 준다.

## 7. 복구와 충돌

### 복구 journal

동기식 `localStorage` 대신 비동기 `DraftJournal`을 사용한다. 구현 후보는 IndexedDB worker 또는 Tauri app-data의 append-only journal이다. journal 항목은 `DocumentKey`, `baseRevision`, `editVersion`, snapshot/patch, checksum과 시간을 가진다.

- journal 기록은 권위 저장보다 빠르고 검증을 요구하지 않는다.
- 권위 저장이 해당 버전을 승인한 뒤에만 그 이하 journal을 정리한다.
- 앱 재시작 시 base revision이 같으면 자동 복구하고, 다르면 충돌 화면을 연다.
- 손상된 마지막 record는 checksum으로 무시하고 이전 정상 record를 사용한다.

### 외부 변경 충돌

revision CAS 실패 시 해당 문서만 `conflict`로 전환하고 자동 저장을 멈춘다. 사용자의 최신 초안과 journal은 유지한다. 선택지는 `외부 버전 보기`, `내 변경과 비교`, `병합 후 저장`, `내 버전으로 덮어쓰기`로 분리하며, 마지막 동작은 명시적 확인 없이는 실행하지 않는다.

## 8. 확장 규칙

새 편집 기능은 다음 등록만 제공해야 한다.

```ts
const adapter: DocumentAdapter<MyDocument> = {
  kind: "my_documents",
  keyOf: (value) => `my_documents:${value.id}`,
  validateLocal: validateMyDocumentShape,
  toSavePayload: (snapshot) => ({ document: snapshot.value }),
  applyRuntimeDelta: applyMyDocumentDelta,
};

registry.register(adapter);
```

금지 사항:

- 컴포넌트 안에 새 `setTimeout(...save...)` 구현
- 문서별 `window.addEventListener("keydown", ...)` 구현
- 저장 성공 시 무조건 `setDraft(serverValue)` 또는 `setDirty(false)`
- 일반 입력 제어에 전역 `busy` 사용
- 저장 응답으로 전체 runtime/payload 교체

ESLint 규칙 또는 코드 검색 기반 검증으로 `invoke("save_*"` 호출을 저장 인프라 모듈 밖에서 금지한다. 이것이 신규 기능이 자동 저장 계약을 우회하지 못하게 하는 가장 실용적인 확장성 장치다.

## 9. 성능 SLO와 계측

| 지표 | 목표 |
|---|---|
| 키 입력 처리 p95 | `8ms` 이하 |
| 키 입력 중 main-thread long task | `50ms` 초과 0회 |
| 저장 중 입력 유실·커서 점프 | 0회 |
| journal durability lag | p95 `500ms` 이하, 최대 `2초` |
| 권위 YAML durability lag | idle 후 p95 `2초` 이하, 지속 입력 중 최대 `5초` + commit 시간 |
| warm 단일 문서 검증+커밋 | p95 `500ms` 이하 |
| 저장 IPC 응답 크기 | 단일 문서 기준 p95 `100KB` 이하 |
| 외부 변경 감지 | 잘못된 overwrite 0회 |

각 요청에 `traceId`, `DocumentKey`, `editVersion`, queue wait, validate, serialize, fsync, runtime delta, bundle build 시간을 기록한다. UI에는 개발자용으로 최근 저장 trace를 볼 수 있게 하고, `npm run benchmark:editor`에 저장 중 연속 입력 시나리오를 추가한다.

## 10. 검증 전략

### 단위 테스트

- fake clock으로 debounce와 max-wait 경계 검증
- in-flight 중 1회/100회 수정 후 최신 버전만 pending인지 검증
- 오래된 epoch와 오래된 version 응답이 draft를 바꾸지 않는지 검증
- 수동 저장이 pending 자동 저장을 중복하지 않고 승격하는지 검증
- validation error, transient I/O error, revision conflict의 재시도 정책 검증

### 속성·장애 주입 테스트

- 임의의 `edit/save success/save failure/switch document/undo` 순서에서 `persistedVersion <= editVersion` 불변식 검증
- 임시 파일 write, file fsync, rename, directory fsync 각 지점에서 프로세스를 종료하고 원본 또는 새 파일 중 하나가 완전하게 남는지 검증
- 두 문서가 동시에 dirty일 때 runtime generation이 역행하지 않는지 검증

### E2E

- 저장을 인위적으로 3초 지연한 상태에서 200자를 입력하고 커서·문자·Undo 이력이 유지되는지 검증
- 저장 A 진행 중 입력 B 후 A 응답이 와도 B가 화면과 journal에 남는지 검증
- `⌘S`/`Ctrl+S`가 모든 작업공간에서 같은 동작과 상태를 보이는지 검증
- 저장 중 작업공간 이동 후 돌아왔을 때 최신 draft와 상태가 유지되는지 검증
- 외부에서 YAML을 바꾼 뒤 자동 저장이 원본을 덮지 않고 conflict로 멈추는지 검증

## 11. 단계별 전환

### 0단계 — 기준선 계측

- 저장 단계별 trace와 응답 크기 측정
- 저장 중 입력 E2E와 현재 유실 위험을 재현하는 회귀 테스트 추가
- 전역 `busy`가 비활성화하는 UI 목록 기록

### 1단계 — 공통 세션과 오케스트레이터

- `DocumentSession`, `SaveCoordinator`, `AutosavePolicy`, 루트 단축키 구현
- 장면 편집기를 첫 adapter로 전환
- 저장 `busy`를 문서 상태로 분리하고 in-flight/pendingLatest 규칙 적용
- 기존 Python 백엔드를 그대로 사용해 동시성 정확성을 먼저 확보

### 2단계 — 모든 편집기 전환

- 사건, 인물, 설정, 시스템 대사, 번역을 adapter로 이전
- 컴포넌트별 타이머, keydown listener, `saving/dirty` 중복 제거
- 비동기 `DraftJournal` 도입

### 3단계 — 백엔드 비용 제거

- async Tauri command와 프로젝트별 직렬 큐 도입
- 장기 실행 Python worker, 캐시된 `StoryProject`, overlay 검증 구현
- 전체 runtime 응답을 `RuntimeDelta`로 전환

### 4단계 — 증분 검증과 번들 coalescing

- 참조 그래프 기반 영향 범위 검증
- 다문서 배치 커밋과 런타임 generation barrier 구현
- 성능 SLO를 CI benchmark gate로 승격

각 단계는 독립 배포 가능해야 한다. 1단계에서 입력 유실과 UI 차단을 먼저 제거하고, 3~4단계에서 저장 완료 시간과 프로젝트 크기 확장성을 개선한다.

### 적용 결과 (2026-08-12)

- `DocumentSession`, `AutosavePolicy`, `SaveCoordinator`, 루트 `SaveCommandBinding`을 도입했다.
- 장면, 사건, 인물, 프로젝트 설정, 시스템 대사, 번역과 제작 플레이 원문 편집을 같은 버전 승인 규칙으로 이전했다.
- IndexedDB 기반 `DraftJournal`로 초안 기록을 입력 경로 밖으로 옮겼고, 기존 `localStorage` 초안은 읽기 전용 마이그레이션 경로만 유지했다.
- Tauri command를 비동기로 전환하고 프로젝트별 저장 mutex 및 상주 Python NDJSON worker를 추가했다. 워커는 `StoryProject` 캐시를 재사용하며 비정상 종료 시 한 번 재시작한다.
- 임시 `story/` 전체 복사를 제거하고 메모리 overlay로 후보를 검증한다.
- 저장 응답은 기존 런타임이 있을 때 JSON patch와 변경 문서 metadata만 반환한다. 프런트는 변경 경로의 조상만 복사하는 구조 공유 방식으로 patch를 적용한다.
- 복제와 런타임 빌드는 `SaveCoordinator.barrier(projectRoot)` 뒤에 실행한다.
- 저장 command 직접 호출 및 동기식 draft `localStorage` 쓰기를 막는 아키텍처 회귀 테스트를 추가했다.

로컬 기준 `npm run benchmark:editor-save`의 상주 워커 warm 단일 인물 문서 저장은 약 `309ms`, 응답은 약 `6.3KB`, runtime patch는 `8개` 연산이었다. 수치는 장비와 프로젝트에 따라 달라지므로 CI에서는 회귀 추세로 사용한다.

## 12. 완료 조건

- 모든 제작 편집기가 공통 `SaveCoordinator`에 등록돼 있다.
- 편집기 컴포넌트에는 자동 저장 타이머와 저장 단축키 listener가 없다.
- 저장 중에도 입력, Undo/Redo, 문서 탐색이 동작한다.
- in-flight 저장 중 입력을 포함한 경쟁 상태 E2E가 통과한다.
- `⌘S`/`Ctrl+S`가 현재 문서의 최신 스냅샷을 즉시 flush한다.
- crash recovery 최대 손실 구간과 외부 변경 충돌 정책이 테스트로 고정돼 있다.
- 저장 응답은 전체 runtime이 아닌 delta이며, 런타임 generation이 역행하지 않는다.
- warm 저장 성능과 입력 응답성이 9절 SLO를 만족한다.

현재 완료 조건 중 참조 그래프 기반 부분 검증과 runtime bundle 저우선순위 coalescing은 4단계 후속 최적화다. 현 구현은 전체 불변식 검증을 유지하되 디렉터리 복사·중복 파싱·대용량 IPC·메인 스레드 전체 복사를 제거해 warm 저장 SLO를 충족한다.
