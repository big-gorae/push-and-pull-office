# 게임 런타임 통합

## 데이터 흐름

```text
characters/routes/scenes YAML
        │
        ├─ validate: 참조·계약·그래프·이중 레이어 검사
        ├─ simulate: 선택과 수치 변화 재현
        └─ build
             ↓
build/story-runtime.json
             ↓
       게임 엔진 로더
```

게임은 개별 YAML을 직접 읽을 필요가 없다. `story-runtime.json`에는 캐릭터, 루트와 노드가 ID 맵으로 정규화되어 있다.

## 런타임 상태

세이브 파일에는 다음만 저장하면 된다.

```json
{
  "schema_version": 1,
  "current_scene": "seo_a.relief_smile",
  "current_node": "response_choice",
  "state": {
    "visible": {},
    "hidden": {},
    "progress": {}
  },
  "choice_history": [
    {
      "scene": "seo_a.email_request",
      "node": "interpret",
      "option": "pull_harder"
    }
  ]
}
```

- 장면·노드·선택지 ID가 세이브 호환성의 기준이다.
- 문구, 수치 또는 파일 위치가 바뀌어도 기존 ID는 유지한다.
- 수치 범위 제한은 런타임과 하네스가 동일한 manifest 정의를 사용한다.

## 노드 처리

```text
dual_dialogue / dual_narration
  현재 모드에 맞는 레이어를 렌더링하고 next로 이동

choice
  conditions가 참인 option만 표시
  선택된 effects를 순서대로 적용
  option.next로 이동

state_gate
  transitions를 위에서부터 평가
  처음 참인 node로 이동

effect
  effects를 순서대로 적용하고 next로 이동

exit
  transitions를 위에서부터 평가
  다음 scene을 열거나 ending을 종료 처리
```

## 모드별 렌더링

### 본편

- `perceived.atmosphere`
- `perceived.expression`
- `perceived.line`
- 호감도, 밀당 주도권, 현재 상태

### 원문 모드

- `reality.atmosphere`
- `reality.expression`
- `reality.line`
- `reality.inner_thought`
- 의심도, 비호감도, 증거 개수
- 같은 노드의 `perceived`를 비교 보기로 제공 가능

### 생존자 모드

- 기본 렌더링은 `reality`
- 한도윤의 해석은 위험 예측 정보나 해금된 기록으로만 표시
- 선택지의 `action`을 피해자 관점 행동으로 별도 장면에서 작성

### 붕괴 모드

- 기본은 `perceived`이지만 `presentation_flags`에 따라 원문이 침범한다.
- `original_text_lock`: reality.line으로 강제 교체
- `ui_glitch`: 호감도와 밀당 UI를 일시적으로 숨김
- `ui_label_reveal`: 호감도 등 UI의 실제 의미를 표시

## UI 바인딩

```text
visible.heroines.<id>.affection       → 호감도
visible.heroines.<id>.initiative      → 밀당 주도권
visible.heroines.<id>.perceived_state → 밀기/당기기/중립

hidden.heroines.<id>.suspicion        → 의심도
hidden.heroines.<id>.dislike          → 비호감도
hidden.heroines.<id>.evidence_count   → 증거 개수
```

원문 모드가 아니면 hidden 값을 UI나 게임 로그에 노출하지 않는다.

## 표정과 아트 자산

장면은 파일 경로가 아니라 캐릭터의 expression ID를 참조한다. 엔진 자산 테이블에서 실제 이미지로 연결한다.

```text
(character_id, expression_id, costume_id) → sprite asset
```

캐릭터 YAML의 `visual.concept_art`는 제작 참고 자산이며 런타임 스프라이트를 대신하지 않는다.

## 엔진 이벤트 훅

구현 시 다음 이벤트를 노출하면 디버깅과 연출을 분리하기 쉽다.

- `scene_entered(scene_id, state_snapshot)`
- `node_entered(scene_id, node_id)`
- `choice_presented(enabled_option_ids)`
- `choice_selected(option_id)`
- `state_changed(path, before, after)`
- `expression_changed(character_id, expression_id)`
- `scene_transitioned(from_scene, to_scene)`
- `ending_reached(ending_id)`

하네스의 시뮬레이션 trace도 같은 개념을 사용하므로 엔진 로그와 비교할 수 있다.

## 현지화

초기 구현에서는 YAML의 한국어 문장을 직접 사용할 수 있다. 번역이 시작되면 ID를 다음처럼 만들고 런타임 빌드 단계에서 문자열 테이블로 분리한다.

```text
scene.<scene_id>.<node_id>.perceived.line
scene.<scene_id>.<node_id>.reality.line
scene.<scene_id>.<node_id>.reality.inner_thought
scene.<scene_id>.<choice_node>.<option_id>.label
```

레이어와 선택 의미를 번역 키에서도 분리해 원문과 왜곡 문장이 섞이지 않게 한다.
