# 요구사항 검증표

## 1. 분기와 수치에 따라 감정·대사·진행을 쉽게 변경

구현 증거:

- `manifest.yaml`: 표시 수치와 숨은 수치의 타입·범위
- `characters/*.yaml`: 수치 구간을 감정·행동·표정으로 바꾸는 `emotion_rules`
- `scenes/**/*.yaml`: `choice`, `state_gate`, `effects`, 조건부 `exit`
- `routes/*.yaml`: 진입 장면, 순서, 엔딩과 해금 조건
- `simulate`: 선택지와 수치 변화를 실행해 엔딩까지 재현

검증 테스트:

- 공격적 선택이 서아 신고 엔딩으로 이어짐
- 문자 그대로 받아들이는 선택이 서아 모호 엔딩으로 이어짐
- 유진 루트의 두 상반된 엔딩 도달
- 의심도에 따른 서아의 파생 감정 변화

## 2. 주인공 분위기·대사와 실제 속마음·표정 기록

구현 증거:

- `dual_dialogue`, `dual_narration`의 `perceived`와 `reality`
- `perceived`: 분위기, 표정, 대사, 주인공 해석
- `reality`: 분위기, 실제 표정, 실제 대사, 속마음, 의도
- 캐릭터 파일의 레이어별 표정 사전

검증 테스트:

- reality 레이어 제거 시 validator 오류
- 다른 인물 또는 잘못된 레이어의 표정 참조 시 validator 오류
- AI 컨텍스트 안에 두 레이어가 모두 포함됨

## 3. 게임 시스템 구현 용이성

구현 증거:

- `build/story-runtime.json`: ID 맵으로 정규화된 단일 런타임 파일
- `RUNTIME_INTEGRATION.md`: 노드 실행, 세이브, UI, 모드, 이벤트 훅 계약
- 안정적인 장면·노드·선택지 ID
- 하네스와 엔진이 공유하는 상태 연산과 범위 제한
- 캐릭터 콘셉트 아트 경로 검증

검증 테스트:

- 런타임 빌드가 노드 배열을 노드 ID 맵으로 변환
- 빌드에 원본 전체 해시 포함
- 정수 수치가 manifest 범위를 벗어나지 않도록 clamp

## 4. AI 에이전트의 상황·분기 인식

구현 증거:

- 저장소 루트 `AGENTS.md`: 모든 에이전트가 따라야 할 작업 순서
- `AI_AUTHORING_RULES.md`: 인지와 현실, 상태 변화, 표현 불변 조건
- 장면별 `state_contract`: 읽기·쓰기 의존성 명시
- `context --from-route --choose`: 선택 경로를 시뮬레이션해 목표 장면 직전 상태 생성
- 컨텍스트의 `branch_trace`, `state_snapshot`, `derived_emotions`, 제한된 cast

검증 테스트:

- 선언하지 않은 상태 쓰기 시 validator 오류
- 이전 선택 뒤 정확한 의심도와 파생 감정이 컨텍스트에 포함됨
- 현재 장면에 없는 인물은 AI cast 컨텍스트에서 제외됨

## 실행 결과 확인

```bash
python3 tools/story_harness.py validate
python3 -m unittest discover -s tests -v
python3 tools/story_harness.py build
python3 tools/story_harness.py context \
  --scene seo_a.relief_smile \
  --from-route seo_a \
  --choose seo_a.email_request=pull_harder
```

완료 기준은 validator 오류 0개, 테스트 전체 통과, 런타임과 컨텍스트 JSON 생성 성공이다.
