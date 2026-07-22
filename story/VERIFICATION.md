# 요구사항 검증표

## 1. 분기와 수치에 따라 감정·대사·진행을 쉽게 변경

구현 증거:

- `manifest.yaml`: 표시 수치와 숨은 수치의 타입·범위
- `characters/*.yaml`: 수치 구간을 감정·행동·표정으로 바꾸는 `emotion_rules`
- `scenes/**/*.yaml`: `choice`, `state_gate`, `effects`, 조건부 `exit`
- `routes/*.yaml`: 진입 장면, 순서, 엔딩과 해금 조건
- `simulate`: 선택지와 수치 변화를 실행해 엔딩까지 재현
- `campaigns/main.yaml`: 15일, 3막, 4개 시간대와 타임라인 레인
- `events/**/*.yaml`: 발생 기간, 마감, 우선순위, 선행 사건과 놓침 결과
- `threads/*.yaml`: 인물별 순차 사건
- `timeline`: 특정 날짜·시간대의 발생 가능·차단 이유와 자동 사건 재현

검증 테스트:

- 공격적 선택이 서아 신고 엔딩으로 이어짐
- 문자 그대로 받아들이는 선택이 서아 모호 엔딩으로 이어짐
- 의심도에 따른 서아의 파생 감정 변화
- 서아·민경 중 한 루트를 최초 클리어하면 생존 모드가 열리고 폐기된 붕괴 모드는 열리지 않음
- 놓친 서아 사건이 보이지 않는 상담 사건을 발생시킴
- 같은 엔딩 그룹에서 조건과 우선순위에 맞는 결말 하나만 실행됨

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
- 모든 장면이 최소 하나의 시간 이벤트에 연결되는 전역 검사
- 자동 사건의 동일 레인·날짜·시간 충돌과 이벤트 의존 순환 검사

검증 테스트:

- 런타임 빌드가 노드 배열을 노드 ID 맵으로 변환
- 빌드에 원본 전체 해시 포함
- 정수 수치가 manifest 범위를 벗어나지 않도록 clamp
- 런타임 빌드가 캠페인·19개 이벤트·2개 인물 스레드·메타 해금을 포함
- 시간 이벤트의 GUI 저장이 주석을 보존하고 런타임을 다시 빌드

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

## 5. 다국어·상황별 배경·캐릭터 비주얼 객체

구현 증거:

- `locales/ko.yaml`, `locales/en.yaml`: 번역 오버라이드와 fallback 체인
- 런타임 `localization.source_strings`, `catalogs`, `coverage`
- `visuals/archetypes/`: 배경·캐릭터 공통 원형
- `visuals/backgrounds/`: 장소·시간·분위기 match와 priority를 가진 5개 구체 배경
- `visuals/characters/`: 모든 캐릭터의 구체 객체, 기본 의상·포즈·표정 자산 슬롯
- `presentation.ts`: `LocalizationService`와 다형 `VisualResolver`
- Tauri `연출·번역` 화면: locale 전환, 번역률, 상속 계층, 배경 판정 근거, 16:9 무대 프리뷰

검증 테스트:

- 영어 번역이 있는 키는 영어로 표시되고 없는 키는 한국어 원문으로 fallback
- 캐릭터 구체 객체가 원형의 렌더 전략과 기본 의상을 상속
- 장소·시간에 따라 오픈 오피스, 복도, 빈 야간 사무실이 다르게 선택됨
- 무대 해석이 배경과 출연 캐릭터 객체를 함께 합성
- 모든 장면의 모든 노드가 본편·실제 모드에서 배경을 얻음
- locale 문서 GUI 저장이 런타임 카탈로그를 다시 빌드

## 실행 결과 확인

```bash
python3 tools/story_harness.py validate
python3 -m unittest discover -s tests -v
python3 tools/story_harness.py build
python3 tools/story_harness.py timeline --day 5 --slot after_work --process-automatic
python3 tools/story_harness.py context \
  --scene seo_a.relief_smile \
  --from-route seo_a \
  --choose seo_a.email_request=pull_harder
```

완료 기준은 validator 오류 0개, 테스트 전체 통과, 시간표 판정 성공, 런타임과 컨텍스트 JSON 생성 성공이다.
