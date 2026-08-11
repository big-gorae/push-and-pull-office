# [부분 구현] 새 장면 삽입·비주얼 자산 카탈로그 확정안

> 설계 확정: 2026-08-06
> 연계 설계: [인게임 장면 연출 편집 시스템](ingame-dialogue-editing.md)
> 구현 상태: 인게임 삽입 plan/commit 마법사, 출연 인물·첫 화자·원화·배경 설정, 초안 복구, 필수 successor dependency 재배선, journal 복구, asset catalog, canonical import와 runtime/프롬프트 자산의 물리 분리가 구현됐다. 여러 successor edge를 동시에 비교·선택하는 고급 UI와 기존 자산 교체 영향 미리보기는 전체 에디터 후속 범위다.

## 1. 제품 결정

Love Office 제작 앱은 플레이 중 발견한 두 사건 사이에 새 장면을 삽입하고, 그 자리에서 배경·출연 인물·화자·캐릭터 원화와 첫 대사를 설정할 수 있는 **새 장면 삽입 마법사**를 제공한다.

“장면 사이에 삽입”은 장면 YAML 하나를 만드는 작업이 아니다. 새 장면이 실제 게임에 나타나려면 다음 문서를 하나의 제작 transaction으로 생성·수정해야 한다.

- 새 `story/scenes/**/*.yaml`
- 새 `story/events/**/*.yaml`
- 대상 `story/routes/*.yaml`의 `scene_order`
- 대상 `story/threads/*.yaml`의 `events`
- 앞·뒤 사건의 `requires.events`
- 필요할 때 일정과 월드 컨텍스트
- 생성 runtime과 localization/asset index

비주얼 선택은 파일 탐색기가 아니라 **자산 카탈로그**를 통해 수행한다. 장면은 배경과 원화의 물리 경로를 저장하지 않고 안정적인 `visual_id`, `variant_id`, `character_id`, `artwork_id`만 저장한다.

## 2. 권위 원본

| 종류 | 권위 원본 | 역할 |
|---|---|---|
| 이야기 장면 | `story/scenes/**/*.yaml` | 대사, 화자, cast, stage와 장면 구조 |
| 실제 발생 순서 | `story/events/**/*.yaml` | 일정, 선행 사건, 플레이 가능 여부와 연결 장면 |
| 루트 저작 순서 | `story/routes/*.yaml` | 장면 탐색·검토 순서와 엔딩 소속 |
| 사건 스레드 순서 | `story/threads/*.yaml` | 같은 이야기 줄기의 사건 배열 |
| 비주얼 의미 | `story/visuals/**/*.yaml` | 배경·원화 ID와 실제 자산 연결 |
| 런타임 이미지 | `assets/` | 배포 게임이 실제로 읽는 이미지 |
| 제작 참고 이미지 | `art-source/` | 레퍼런스, 원본 생성물과 보관본; 게임 빌드 제외 |
| 생성 카탈로그 | `build/asset-catalog.json` | 썸네일·크기·사용처 등 파생 검색 index |

`build/`와 `build/asset-catalog.json`은 파생 결과다. 제작자가 직접 편집하지 않는다.

## 3. 삽입 진입점

마법사는 두 곳에서 연다.

1. 인게임 제작 바의 `현재 장면 뒤에 새 장면`
2. 전체 에디터 타임보드의 두 사건 사이 `+ 장면 삽입`

인게임 진입에서는 현재 플레이 trace를 사용해 다음 후보 사건을 계산한다. 후속 사건이 하나면 `A와 B 사이`를 자동 선택한다. 후속 사건이 여러 개면 마법사가 각 edge와 조건을 표시하고 제작자가 영향을 줄 경로를 명시적으로 선택해야 한다.

단순히 현재 route의 다음 `scene_order` 항목을 후속 사건으로 간주하지 않는다. 실제 후보는 campaign, thread, `requires.events`, 일정 window와 현재 branch trace를 함께 사용해 계산한다.

## 4. 마법사 흐름

### 4.1 1단계: 삽입 위치

```text
메일로 보내 주세요
seo_a.email_request
        ↓
     [새 장면]
        ↓
안도한 아침 인사
seo_a.relief_smile
```

다음을 함께 보여 준다.

- 앞·뒤 사건 ID와 연결 장면
- route와 thread
- 현재 `requires.events`
- 두 사건의 날짜 window와 slot
- 다른 분기에서 뒤 사건으로 들어오는 edge

삽입 방식은 두 가지다.

- `이 경로에 필수로 삽입`: 뒤 사건이 새 사건 완료를 기다린다.
- `사이에 선택 사건으로 추가`: 새 사건을 보지 않아도 뒤 사건이 열릴 수 있다.

기본값은 `이 경로에 필수로 삽입`이다. 필수 삽입이 다른 정상 분기를 막는다면 저장을 거부하고 edge 선택 단계로 돌려보낸다.

### 4.2 2단계: 시작 템플릿

| 템플릿 | 복사하는 항목 | 복사하지 않는 항목 |
|---|---|---|
| 맥락만 이어받기 | route, cast, location, time, stage 기본값 | 대사, 효과, 선택지, 상태 계약 |
| 빈 장면 | route만 | 나머지 전부 |
| 장면 전체 복제 | 모든 노드와 계약 | ID와 일정 연결 |

기본값은 `맥락만 이어받기`다. 전체 복제는 고급 옵션이며 선택지·효과까지 복사된다는 경고를 표시한다.

### 4.3 3단계: 기본 정보와 일정

필수 입력은 다음과 같다.

- 장면 ID와 제목
- 사건 ID와 제목
- route, thread와 lane
- event type과 availability
- 날짜 window, slot, deadline과 duration
- scene `location`과 `time`
- event participants
- 인지·실제 사건 요약

장면 ID를 입력하면 다음 파일 위치를 제안한다.

```text
scene: story/scenes/<route-or-common>/<slug>.yaml
event: story/events/<event-type>/<slug>.yaml
```

ID와 파일명은 분리하되 한 번 저장된 ID는 파일 이동과 무관하게 유지한다.

일정 기본값은 앞·뒤 사건의 window 사이에서 가능한 가장 이른 slot이다. 유효한 자리가 없으면 마법사가 임의로 날짜를 늘리지 않고 일정 충돌을 표시한다.

### 4.4 4단계: 출연 인물

인물 선택기는 세 그룹으로 나눈다.

- 현재 장면의 illustrated cast
- 같은 route에서 사용 중인 illustrated 캐릭터
- 그 밖의 illustrated 캐릭터

`presentation: text_only` 월드 멤버는 illustrated cast 선택기에 나오지 않는다. formal/cross-functional meeting이면 별도의 실제 참석자 선택기를 열고 `world_context.participants`를 회사 월드 바이블의 `member.*`로 구성한다.

인물마다 다음 정보를 함께 보여 준다.

- 이름, ID와 route 소속
- 기본 원화 썸네일
- 등록 원화 수
- 사용 가능한 의상·포즈·표정 수
- 현재 장면에서 화자로 사용할 수 있는지 여부

### 4.5 5단계: 배경과 원화

배경 선택은 `자동 판정`이 기본이다. 선택한 location/time으로 자동 판정될 배경을 즉시 미리 보여 준다.

- 자동 판정 결과가 마음에 들면 override 없이 저장한다.
- 다른 배경을 고르면 scene `default_background`에 background visual·variant 안정 ID를 저장한다.
- 씬 기본 배경은 인지와 실제 레이어 및 씬 안의 모든 대사에 공통 적용한다. 대사마다 바꾸는 고급 override는 기본 편집 흐름에 두지 않는다.

캐릭터 원화는 선택한 cast별 artwork picker로 정한다.

- 대사마다 왼쪽·가운데·오른쪽 세 슬롯
- 캐릭터별 탭과 등록된 artwork 썸네일
- 화자와 무관한 cast 인물 배치와 선택지 화면 배치
- 레이어별 명시적 직접 배치와 전체 `OFF`
- fallback 발생 여부와 이유

장면은 실제 asset path를 저장하지 않는다.

대사 `stage`에 해당 레이어 키가 없으면 인물 원화를 표시하지 않는다. 런타임은 `cast`나 화자를 근거로 배치를 추론하지 않는다. 새 대사의 화자를 선택하면 편집기가 한도윤을 제외한 일러스트 화자를 양쪽 레이어 중앙 cue로 명시 저장한다. 레이어 키가 빈 배열이면 원화를 모두 끄고, 1~3개 cue가 있으면 화자 여부와 무관하게 지정한 인물을 표시한다. 한 레이어에서 위치와 인물은 각각 중복될 수 없으며 선택 가능한 인물은 illustrated cast로 제한한다.

```yaml
stage:
  perceived:
    - position: left
      character: yoon_seo_a
      visual_id: character.yoon_seo_a
      artwork: office_default
    - position: right
      character: cha_min_kyung
      visual_id: character.cha_min_kyung
      artwork: office_default
  reality: []
```

### 4.6 6단계: 첫 비트

빈 장면과 맥락 템플릿은 최소 하나의 유효한 비트를 요구한다.

- `dual_dialogue` 또는 `dual_narration`
- 인지·실제 화자
- 인지·실제 문장과 atmosphere
- 실제 레이어 intent
- 화자 표정과 원화 표시 여부

마법사가 자동으로 빈 문자열을 정상 대사처럼 저장하지 않는다. 필수 문장이 완성되기 전에는 복구 가능한 초안으로만 유지한다.

장면의 마지막에는 뒤 장면을 default target으로 가리키는 `exit` 노드를 만든다. 일반 사건은 `completion: return_to_timeline`이므로 실제 플레이에서는 사건 큐로 돌아가지만, default target은 직접 장면 미리보기와 `honor_scene_exit` 실행에서도 연결이 끊기지 않게 한다. 다른 target이나 조건부 전환은 고급 연결 단계에서 명시한다.

`state_contract`는 완성된 노드의 조건·효과에서 자동 계산한다. 빈 장면과 맥락 템플릿은 첫 비트와 exit만 있을 때 `reads: []`, `writes: []`로 시작하며 제작자가 수동으로 점 표기 경로를 입력하지 않는다.

### 4.7 7단계: 변경 미리보기

저장 전 다음 diff를 사람이 읽을 수 있게 보여 준다.

```text
생성  story/scenes/seo_a/new_scene.yaml
생성  story/events/heroine/seo_a_new_scene.yaml
수정  story/routes/seo_a.yaml
  scene_order: seo_a.email_request 뒤에 seo_a.new_scene 추가
수정  story/threads/seo_a.yaml
  events: seo_a.email_request 뒤에 seo_a.new_scene 추가
수정  story/events/heroine/seo_a_relief_smile.yaml
  requires.events: seo_a.new_scene 추가
```

경로별 도달성, 일정 충돌, world meeting 정책과 모든 visual 참조를 이 단계에서 검증한다.

## 5. 연결 규칙

### 5.1 필수 삽입

앞 사건을 `A`, 새 사건을 `N`, 뒤 사건을 `B`라고 한다.

- `N.requires.events`에 `A`를 추가한다.
- `B.requires.events`에 직접 `A`가 있었다면 `A`를 `N`으로 교체한다.
- `B`가 다른 선행 사건도 요구하면 그대로 보존한다.
- `B`가 `A`를 요구하지 않았지만 현재 thread에서 유일한 직선 후속이라면 `N`을 추가할 수 있다.
- `B`가 다른 분기에서도 열릴 수 있다면 자동으로 `N`을 추가하지 않고 branch impact 선택을 요구한다.

필수 삽입은 `A → N → B`를 보장해야 한다. thread 배열과 route 배열의 위치만 바꾸고 event requirement를 바꾸지 않는 결과는 허용하지 않는다.

### 5.2 선택 삽입

- `N`은 `A`를 요구한다.
- `B`의 기존 requirement는 바꾸지 않는다.
- `N`과 `B`가 같은 시간대에 동시에 후보가 될 수 있으면 event priority와 exclusive group 정책을 미리 보여 준다.
- 선택 장면을 놓쳤을 때 세계가 진행되어야 하면 `on_missed`를 반드시 설정한다.

### 5.3 route와 thread

- 새 scene은 route `scene_order`에서 기준 scene 다음에 둔다.
- 새 event는 thread `events`에서 기준 event 다음에 둔다.
- 공통 장면은 관련된 모든 route에 넣을지 현재 route에만 넣을지 명시한다.
- ending 앞 삽입은 ending scene 자체를 복제하지 않고 마지막 일반 사건과 ending event 사이에 둔다.
- route entry 앞 삽입은 `entry_scene` 변경과 첫 event requirement 영향을 별도로 확인한다.

## 6. 다중 문서 저장 transaction

새 장면 삽입은 보통 4~6개의 권위 YAML을 바꾸므로 단일 파일 `os.replace`만으로 충분하지 않다. 다음 journal 기반 transaction을 사용한다.

1. 모든 대상 파일의 revision과 value hash를 확인한다.
2. 프로젝트 내부 임시 작업 사본에 모든 변경을 적용한다.
3. 전체 story validation, 모든 route `explore`, runtime build와 asset validation을 실행한다.
4. 후보 YAML과 runtime을 각각 같은 파일시스템의 임시 파일로 쓰고 `fsync`한다.
5. `.story-editor/transactions/<transaction-id>.json`에 대상·이전 hash·후보 hash·backup 위치를 기록하고 `fsync`한다.
6. 대상 YAML을 하나씩 원자 교체한다.
7. 생성 runtime과 파생 index를 교체한다.
8. journal을 `complete`로 표시한 뒤 backup을 정리한다.

앱 시작 시 incomplete journal이 있으면 다음 중 하나를 자동 수행한다.

- 모든 권위 YAML이 후보 hash면 YAML을 유지하고 runtime을 다시 빌드한다.
- 일부 YAML만 후보 hash면 backup으로 전체 rollback한다.
- 외부 변경으로 hash가 어느 쪽과도 다르면 자동 수정하지 않고 복구 화면을 연다.

`story/` YAML이 항상 권위 원본이다. runtime 교체 직전에 앱이 종료되어도 다음 실행에서 source hash 불일치를 감지해 다시 빌드한다.

`.story-editor/`는 프로젝트 로컬 제작 상태이며 `.gitignore`에 포함한다. transaction journal에 대사 본문이나 토큰을 불필요하게 복제하지 않고 파일 hash와 backup 위치만 기록한다.

## 7. Tauri API

```ts
type SceneInsertionDraft = {
  anchorEventId: string;
  successorEventId?: string;
  insertionMode: "required" | "optional";
  template: "context" | "blank" | "full_clone";
  scene: NewSceneInput;
  event: NewEventInput;
  routeId: string;
  threadId: string;
  affectedSuccessors: string[];
  expectedRevisions: Record<string, string>;
};
```

명령은 다음으로 고정한다.

| 명령 | 책임 |
|---|---|
| `plan_scene_insertion` | 후보 edge, 일정, 생성 경로와 다중 문서 diff를 계산하되 쓰지 않음 |
| `commit_scene_insertion` | 계획 fingerprint 확인, journal transaction, 검증·저장·runtime 반환 |
| `recover_authoring_transaction` | incomplete journal 상태 조회와 안전 복구 |
| `get_asset_catalog` | 필터 가능한 배경·캐릭터·원화·표정 catalog 반환 |
| `import_visual_asset` | 외부 이미지를 canonical 위치로 복사하고 visual YAML 후보 생성 |

`commit_scene_insertion`은 `plan_scene_insertion`이 반환한 `planFingerprint`를 요구한다. 계획 이후 대상 파일이 바뀌었으면 재계획 없이는 저장하지 않는다.

## 8. 물리 자산 구조

배포 게임이 읽는 파일과 제작 참고 파일을 분리한다.

```text
assets/
├── backgrounds/
│   └── <background-id>/
│       ├── <variant-id>.png
│       └── <variant-id>.webp
├── characters/
│   └── <character-id>/
│       └── <artwork-id>/
│           ├── base.png
│           └── expressions/
│               └── <expression-id>.png
├── ui/
│   ├── hud/
│   └── icons/
└── cg/
    └── <scene-or-gallery-id>/

art-source/
├── references/
│   └── <character-or-background-id>/
├── generation-history/
└── archive/
```

규칙은 다음과 같다.

- `assets/`에는 runtime 또는 UI에서 실제 참조하는 파일만 둔다.
- `art-source/`는 Vite asset glob, runtime bundle과 배포 대상에서 제외한다.
- 파일명은 kebab-case, registry ID는 기존 점 표기 stable ID를 사용한다.
- canonical 폴더 slug는 ID의 종류 접두사를 뺀 뒤 `_`를 `-`로 바꾼 값이다. 예를 들어 `background.office_open`은 `assets/backgrounds/office-open/`, `yoon_seo_a`는 `assets/characters/yoon-seo-a/`를 사용한다.
- 같은 이미지의 작업본·원본·비교본을 runtime 폴더에 섞지 않는다.
- 한 파일을 여러 의미 ID가 우연히 공유하지 않는다. 의도적으로 공유하면 visual archetype이 소유한다.
- 이미지 교체는 같은 ID를 유지할 수 있지만 catalog가 hash 변경과 사용처를 보여 준다.

## 9. 비주얼 registry

### 9.1 배경

배경은 기존 `story/visuals/backgrounds/*.yaml` 구조를 유지하되 물리 경로를 canonical 폴더로 이동한다.

```yaml
id: background.office_open
kind: background
variants:
  late_afternoon:
    asset: assets/backgrounds/office-open/late-afternoon.png
    match:
      locations: [open_office, office_desk]
      times: [late_afternoon]
    priority: 60
```

asset picker의 필터 기준은 location, time, atmosphere, mode, tag와 aspect ratio다.

### 9.2 캐릭터 원화

캐릭터마다 구체 character visual은 하나를 유지하고 그 안에 여러 `artworks`를 둔다.

```yaml
id: character.yoon_seo_a
kind: character
character: yoon_seo_a
default_artwork: office_default
artworks:
  office_default:
    asset: assets/characters/yoon-seo-a/office-default/base-cutout.png
    outfits: [office]
    poses: [neutral, guarded]
    expression_assets:
      actual_social_smile: assets/characters/yoon-seo-a/office-default/expressions/actual-social-smile.png
  cardigan_smile:
    asset: assets/characters/yoon-seo-a/cardigan-smile/base.png
    outfits: [office_cardigan]
    poses: [guarded]
```

`artwork_id`는 캐릭터 visual 안에서 안정적이다. 장면 stage는 `character.yoon_seo_a`의 asset path가 아니라 `cardigan_smile`만 저장한다.

기존 `fallback_asset`과 최상위 `expression_assets`는 `default_artwork`의 호환 입력으로 한 번 읽은 뒤 migration에서 새 구조로 옮긴다.

## 10. 생성 asset catalog

`story_harness.py build`는 `build/asset-catalog.json`을 만든다.

```ts
type AssetCatalogEntry = {
  id: string;
  kind: "background_variant" | "character_artwork" | "expression" | "ui" | "cg";
  ownerId: string;
  relativePath: string;
  width: number;
  height: number;
  aspectRatio: number;
  sha256: string;
  tags: string[];
  usedBy: Array<{ document: string; fieldPath: string }>;
  thumbnailKey: string;
};
```

catalog는 다음을 가능하게 한다.

- 현재 인물의 원화만 필터링
- location/time에 맞는 배경 우선 표시
- 미사용 runtime 자산 탐지
- 끊긴 path와 중복 hash 탐지
- 같은 artwork가 사용되는 모든 장면 확인
- 이미지 교체 전 영향 범위 확인

썸네일 파일은 `.story-editor/cache/thumbnails/`에 생성하고 Git에 포함하지 않는다.

## 11. 자산 가져오기 UX

새 파일을 등록할 때는 다음 순서를 사용한다.

1. `배경 추가` 또는 특정 캐릭터의 `원화 추가` 선택
2. 외부 이미지 선택
3. stable ID, variant/artwork ID와 표시 이름 입력
4. 권장 비율·최소 해상도·alpha 여부 검사
5. canonical 목적 경로와 visual YAML diff 미리보기
6. 파일 복사와 YAML 변경을 journal transaction으로 저장

기존 목적 파일이 있으면 자동 덮어쓰지 않는다.

- `새 ID로 가져오기`
- `기존 자산 교체` 후 사용처 확인
- `취소`

세 선택지만 제공한다. 교체 시 이전 이미지는 `art-source/archive/<owner-id>/`로 이동하고 복구 위치를 transaction 결과에 기록한다.

## 12. 기존 자산 migration

평평한 runtime 배경, 캐릭터 원화, HUD와 CG는 migration 명령으로 canonical 폴더에 비파괴 복사하고 story 참조를 전환했다. 프롬프트 전용 이미지는 `art-source/references/characters/<character>/`로 옮겼으며 Prompt Builder도 그 경로만 읽는다. 따라서 게임용 `assets/`와 제작 참고·보관용 `art-source/`가 물리적으로 분리되어 있다.

1. 새 schema가 legacy와 `artworks`를 모두 읽게 한다.
2. `tools/story_editor_bridge.py visual-migration-plan`이 모든 runtime 이동과 registry 변경을 출력한다.
3. `tools/story_editor_bridge.py apply-visual-migration`이 기존 파일을 삭제하지 않고 canonical 위치로 복사한 뒤 YAML 변경을 transaction으로 수행한다.
4. prompt builder, Vite glob, manifest gallery와 테스트 fixture를 새 경로로 갱신한다.
5. 전체 `npm run verify`와 asset catalog 오류 0개를 확인한다.
6. legacy path 참조가 0개일 때만 호환 읽기를 제거한다.

작업 중인 원화와 사용 여부가 불명확한 파일은 자동 삭제하지 않고 `art-source/archive` 후보로만 보고한다.

## 13. 검증 규칙

### 장면 삽입

- 새 scene과 event ID가 전역에서 유일하다.
- scene route, event campaign/thread와 route campaign이 일치한다.
- 새 scene이 route에 연결되고 새 event가 thread와 scene을 참조한다.
- 필수 삽입의 `A → N → B` event dependency가 실제로 성립한다.
- 모든 route choice와 event 후보가 `explore`로 도달 가능하다.
- 모든 scene은 적어도 한 event에 스케줄된다.
- event window, deadline, duration과 slot이 캠페인 범위 안이다.
- cast, participants와 meeting policy가 일치한다.
- 새 scene의 모든 비트가 두 레이어와 background를 resolve한다.

### 자산

- 모든 runtime asset이 프로젝트 내부 `assets/`에 존재한다.
- `art-source/` 경로를 runtime visual이 참조하지 않는다.
- background variant와 character artwork ID가 owner 안에서 유일하다.
- character artwork가 다른 character의 stage에서 사용되지 않는다.
- scene은 asset path를 직접 소유하지 않는다.
- 이미지 형식, 최소 크기와 aspect 정책을 만족한다.
- 대소문자만 다른 경로와 동일 ID의 다른 hash 충돌을 거부한다.

## 14. 인수 조건

- 플레이 중 `현재 장면 뒤에 삽입`으로 마법사를 열 수 있다.
- 직선 경로 A와 B 사이에 장면을 넣으면 실제 새 플레이가 A → 새 장면 → B 순서로 진행된다.
- 새 장면, 사건, route, thread와 뒤 사건 dependency가 한 번의 transaction으로 저장된다.
- 중간 검증 실패와 앱 비정상 종료가 기존 정상 프로젝트를 손상시키지 않는다.
- 새 장면에서 배경, cast, 화자, artwork와 첫 대사를 썸네일 기반으로 설정할 수 있다.
- 같은 캐릭터의 다른 artwork를 장면 또는 비트별로 선택할 수 있다.
- 배경 auto 결과와 fixed 후보를 location/time 기준으로 탐색할 수 있다.
- 앱 재시작 뒤 동일한 장면 순서, 배경과 캐릭터 원화가 재현된다.
- `assets/`에는 배포 자산만, `art-source/`에는 제작 참고 자산만 남는다.
- 모든 장면과 visual YAML에는 안정 ID만 있고 scene에 이미지 경로가 없다.

## 15. 테스트 계약

### Python

- 필수·선택 삽입의 dependency 변환
- route/thread/scene/event 다중 후보 diff
- 분기 영향과 일정 충돌 거부
- transaction journal 완료·부분 교체·외부 변경 복구
- asset path, hash, dimensions와 사용처 index
- legacy visual에서 artworks migration plan

### Rust/Tauri

- plan fingerprint와 revision 충돌
- 외부 이미지의 canonical 경로 복사
- 프로젝트 밖 path, symlink 탈출과 자동 덮어쓰기 거부
- incomplete transaction 시작 복구

### Player/Editor

- 현재 trace에서 정확한 successor 후보 표시
- 마법사 단계별 초안 복구
- 배경·원화 썸네일 필터와 fallback 경고
- 대사별 원화 OFF, 캐릭터 탭, 왼쪽·가운데·오른쪽 3슬롯과 비화자·선택지 렌더링
- 대사 stage 저장 뒤 원본 YAML과 재빌드 runtime의 동일한 stable ID 보존
- 삽입 성공 후 새 runtime으로 현재 플레이 계속

### E2E

- A와 B 사이 필수 장면 생성 → 파일 5종 확인 → 실제 플레이 순서 확인
- 선택 장면 생성 → 놓침 처리와 B 접근 확인
- 캐릭터 원화 가져오기 → picker 선택 → 재시작 후 동일 이미지 확인
- transaction 도중 강제 중단 fixture → 다음 시작에서 rollback/rebuild 확인
