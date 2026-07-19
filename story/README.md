# 스토리 제작 시스템

`story/`는 서술형 기획 문서와 실제 게임 구현 사이의 구조화 원본이다. Markdown 문서는 콘셉트와 의도를 설명하고, 이 디렉터리의 YAML은 분기·수치·대사·표정·속마음·런타임 진행을 정의한다.

## 디렉터리

```text
story/
├── manifest.yaml          # 수치, 열거형, 초기 상태, 전체 파일 규칙
├── SPEC.md                # 데이터 형식 명세
├── RUNTIME_INTEGRATION.md # 게임 엔진 처리·세이브·UI 계약
├── VERIFICATION.md        # 요구사항별 구현 및 테스트 증거
├── AI_AUTHORING_RULES.md  # AI 에이전트용 작성 계약
├── characters/            # 인물별 감정 모델, 표정, 신고 규칙
├── routes/                # 루트 해금, 진입 장면, 엔딩
├── scenes/                # 실제 대사와 분기 노드 그래프
├── templates/             # 새 장면 작성 템플릿
└── schema/                # 에디터용 JSON Schema
```

생성물은 `build/`에 저장하며 원본으로 편집하지 않는다.

## 기본 명령

```bash
python3 tools/story_harness.py validate
python3 tools/story_harness.py build
python3 tools/story_harness.py simulate --route seo_a --strategy first
python3 tools/story_harness.py context --scene seo_a.email_request
python3 -m unittest discover -s tests -v
```

특정 선택을 재현하려면 `장면 ID=선택지 ID` 형식으로 전달한다.

```bash
python3 tools/story_harness.py simulate \
  --route seo_a \
  --choose seo_a.email_request=match_push \
  --choose seo_a.relief_smile=interpret_pull
```

이전 선택 결과가 반영된 상태로 AI 컨텍스트를 만들려면 목표 장면까지 경로를 시뮬레이션한다.

```bash
python3 tools/story_harness.py context \
  --scene seo_a.relief_smile \
  --from-route seo_a \
  --choose seo_a.email_request=pull_harder
```

이 경우 컨텍스트의 `state_snapshot`, `derived_emotions`, `branch_trace`는 해당 선택 직후 상태를 사용한다.

## 작성 순서

1. `templates/scene.template.yaml`을 복사해 장면 ID와 루트를 정한다.
2. 장면에서 읽고 쓸 상태를 `state_contract`에 먼저 선언한다.
3. 각 대사 노드에 `perceived`와 `reality`를 모두 작성한다.
4. 수치 변화는 선택지나 전이의 `effects`에서만 기록한다.
5. 새 표정은 인물 파일의 `expressions`에 먼저 등록한다.
6. 새 장면을 루트 파일의 `scene_order` 또는 엔딩 목록에 연결한다.
7. `validate`, `simulate`, `build`, `context` 순서로 확인한다.

## 원본 우선순위

충돌이 생기면 다음 순서를 따른다.

1. `manifest.yaml`과 `SPEC.md`의 시스템 규칙
2. `characters/*.yaml`의 인물 불변 조건
3. `routes/*.yaml`의 해금·엔딩 규칙
4. `scenes/**/*.yaml`의 장면 내용
5. `docs/*.md`의 설명 문서

설명 문서를 바꾸어도 게임 데이터는 자동으로 바뀌지 않는다. 실제 구현에 반영하려면 YAML을 수정하고 하네스를 통과시켜야 한다.
