# NovelAI V4.5 prompt configuration

`/prompts` 페이지가 이 디렉터리의 JSON을 빌드 시 직접 읽는다. 프롬프트를 바꿀 때 React 코드를 수정할 필요가 없다.

## 파일 역할

- `defaults.json`: 모델 권장값, 공통 작화 태그, Base 프리셋, 공통 UC
- `characters/<character_id>.json`: 인물별 외형, 의상, 버전, 상황, 전용 UC

캐릭터 파일의 `characterId`는 `story/characters/<character_id>.yaml`의 `id`와 같아야 한다. 화면의 이름·나이·직무·표정 설명은 생성된 `build/story-runtime.json`에서 가져오므로 이 JSON에 중복 작성하지 않는다.

## 캐릭터 상황 추가

해당 캐릭터 파일의 `looks[].situations`에 항목을 추가한다.

```json
{
  "id": "unique_situation_id",
  "label": "화면에 보일 짧은 이름",
  "description": "상황 설명",
  "expressionId": "story 캐릭터 YAML에 선언된 표정 ID",
  "basePresetId": "defaults.json에 선언된 Base ID",
  "tags": ["one pose", "one gaze", "one expression"]
}
```

- `identityTags`는 캐릭터 정체성 고정값이므로 상황마다 고치지 않는다.
- `/prompts` 조합기가 NovelAI Character Prompt 맨 앞에 성별 바인딩 태그 `girl` 또는 `boy`를 자동으로 붙인다.
- 캐릭터 선택 화면의 순서는 각 파일의 `order` 숫자로 정한다.
- `1.1::hair, eyes, face::` 같은 강조 구문은 배열 원소 하나로 유지한다.
- 신발처럼 전신에서만 필요한 태그는 `fullBodyOnlyTags`에 둔다.
- 현실/주관, 현재/과거처럼 섞이면 안 되는 외형은 별도 `look`으로 만든다.
- 태그 배열의 순서는 결과 프롬프트 순서이자 디버깅 순서다.

## 현재 공통 작화

공통 `styleTags`는 안정된 `game cg`에 최신 작화 경향만 약하게 가져오는 `year 2024`를 무가중치로 붙인다. 숫자 강조 문법, HDR, 시네마틱·망가 하이브리드, 러프 스케치 프리셋은 사용하지 않는다. 참조 프롬프트의 머리색, 홍채색, 직업, 의상, 배경, 포즈와 카메라 각도도 캐릭터·장면 내용이므로 공통 작화에 넣지 않는다.

NovelAI V4.5의 `Quality Tags`는 켜서 사용한다. 모델이 자동으로 붙이는 품질 태그를 Prompt 본문에 다시 중복하지 않는다.

여성 캐릭터는 각 파일에서 `1.2::exceptionally beautiful face, refined elegant facial features::`, 고유 눈 색·눈매, `large breasts`, `breasts`를 명시하고 `flat chest`, `small breasts`를 캐릭터 UC에 둔다. 눈에는 동공 효과를 더 붙이지 않고 Quality Tags와 `game cg, year 2024`의 기본 미형을 사용한다. 공통 UC는 큰 가슴 자체를 막지 않으며 실제 노출과 홍채색 혼합만 막는다.

설정이 잘못되면 잘못된 프롬프트를 복사하지 않도록 `/prompts` 페이지가 조합을 중단하고, 해당 파일 경로와 JSON 위치를 표시한다.
