# NovelAI V4.5 prompt configuration

`/prompts` 페이지가 이 디렉터리의 JSON을 빌드 시 직접 읽는다. 프롬프트를 바꿀 때 React 코드를 수정할 필요가 없다.

## 파일 역할

- `defaults.json`: 모델 권장값, 공통 작화, Base 프리셋, 공통 UC
- `characters/<character_id>.json`: 인물별 외형, 의상, 버전, 상황, 전용 UC, 부분수정 작업
- `tag-registry.json`: 프롬프트에 허용하는 태그와 확인 출처

캐릭터 파일의 `characterId`는 `story/characters/<character_id>.yaml`의 `id`와 같아야 한다. 화면의 이름·나이·직무·표정 설명은 생성된 `build/story-runtime.json`에서 가져오므로 이 JSON에 중복 작성하지 않는다.

## 태그와 자연어를 나누는 규칙

스키마 버전 2는 모든 프롬프트 조각을 두 종류로 분리한다.

- `*Tags`: NovelAI 공식 문서 또는 Danbooru 태그 사전에서 정확한 철자를 확인한 태그만 넣는다. `tag-registry.json`에 없는 태그는 빌드가 거부한다.
- `*Instructions`: 태그로 정확히 표현할 수 없는 얼굴 형태, 점의 정확한 위치, 작화 의도 같은 짧은 자연어 문장을 넣는다. 프로젝트 규칙상 영문 대문자로 시작하고 문장부호로 끝낸다.

검증하지 않은 복합 문구를 태그처럼 쉼표로 나열하지 않는다. 먼저 [Danbooru 태그 검색기](https://danbooru-tag.mephistopheles.moe/)에서 검색하고, 검색되는 정확한 태그는 `tag-registry.json`에 출처와 함께 등록한다. 검색되지 않거나 위치 관계가 핵심인 설명은 `*Instructions`로 옮긴다.

## 프롬프트 하네스

새로운 시각 개념을 태그로 쓰기 전에는 다음처럼 한 개념씩 검색한다. 한국어와 영어를 모두 지원하며, 영문 태그명·한국어명·설명·분류·사용 수와 현재 레지스트리 등록 여부를 보여준다.

```bash
npm run prompt:harness -- search "눈물점"
npm run prompt:harness -- search "mole under eye" --limit 8
```

결과에서 철자만 비슷한 태그를 고르지 말고 설명과 분류가 의도와 맞는지 확인한다. 적절한 결과가 없으면 태그를 만들지 않고 `*Instructions`에 자연어 문장을 넣는다. 검색 API에는 전체 프롬프트, 캐릭터 설정, 쉼표로 나눈 태그 목록을 보내지 않는다. 하네스도 이런 프롬프트 형태의 검색을 거부한다.

로컬 설정과 출처 레지스트리는 네트워크 없이 검증한다.

```bash
npm run prompt:validate
```

## 캐릭터 상황 추가

해당 캐릭터 파일의 `looks[].situations`에 항목을 추가한다.

```json
{
  "id": "unique_situation_id",
  "label": "화면에 보일 짧은 이름",
  "description": "상황 설명",
  "expressionId": "story 캐릭터 YAML에 선언된 표정 ID",
  "basePresetId": "defaults.json에 선언된 Base ID",
  "tags": ["smile", "looking at viewer"],
  "instructions": ["Keep the smile subtle and asymmetric."],
  "undesiredTags": [],
  "undesiredInstructions": []
}
```

- `identityTags`와 `identityInstructions`는 캐릭터 정체성 고정값이므로 상황마다 고치지 않는다.
- 의상은 `outfits`에 독립 모듈로 두고 상황과 섞지 않는다.
- `/prompts` 조합기가 NovelAI Character Prompt 맨 앞에 성별 바인딩 태그 `girl` 또는 `boy`를 자동으로 붙인다.
- 캐릭터 선택 화면의 순서는 각 파일의 `order` 숫자로 정한다.
- `1.1::hair, eyes, face::` 같은 강조 구문은 배열 원소 하나로 유지한다. 숫자 바로 뒤에는 반드시 `::`를 쓰며 `year 2024`처럼 강조가 아닌 숫자에는 붙이지 않는다.
- 신발처럼 전신에서만 필요한 요소는 `fullBodyOnlyTags` 또는 `fullBodyOnlyInstructions`에 둔다.
- 현실/주관, 현재/과거처럼 섞이면 안 되는 외형은 별도 `look`으로 만든다.
- 태그 배열의 순서는 결과 프롬프트 순서이자 디버깅 순서다.

모든 캐릭터와 모든 `look`에 같이 제공할 표정은 `defaults.json`의 `commonSituations`에 한 번만 선언한다. 일반 상황은 캐릭터 고유 상황 뒤에 자동으로 붙고, 해당 캐릭터의 `identityTags`, `identityInstructions`, 기본 의상, 공통 작화 앵커를 항상 다시 합성한다. 공통 상황의 긍정 태그가 특정 캐릭터의 평상시 UC와 충돌할 때만 `omitCharacterUndesiredTags`에 정확히 충돌하는 태그를 적는다. 이 예외는 해당 상황에서만 적용되며 공통 UC와 다른 캐릭터 UC를 약화하지 않는다.

현재 공통 표정은 정색하고 노려보기, 분노, 혐오, 공포, 공포에 빠져 울기의 다섯 가지다. `glare`는 검색 결과 의도와 일치하는 일반 표정 태그가 없어 만들지 않았고, 검증된 `serious`, `closed mouth`, `looking at viewer`와 눈꺼풀·눈썹의 자연어 지시를 조합한다. 나머지는 Danbooru 검색기로 확인한 `angry`, `scowl`, `furrowed brow`, `v-shaped eyebrows`, `disgust`, `grimace`, `scared`, `wide-eyed`, `sweat`, `trembling`, `crying`, `crying with eyes open`, `tears` 등을 사용한다.

`공통 · 데포르메 SD 종이 얼굴`은 의도적으로 작화와 구도가 바뀌는 예외다. `identityMode: "face_only"`로 각 `look`의 `faceOnlyIdentityTags`와 `faceOnlyIdentityInstructions`만 사용하고, `includeOutfit: false`, `useSharedStyle: false`로 몸·의상·상업 미연시 CG 지시를 제외한다. 검증된 `chibi`, `head only`, `papercraft (medium)`, `paper texture`, `outline`, `faux traditional media`를 사용하며, 머리카락과 턱선을 따라 종이를 오린 얇은 절단면은 자연어 지시로 고정한다. UC에는 `upper body`, `full body`, `cowboy shot`과 생물학적 절단 머리·목·어깨·몸·직사각형 종이·스티커·입체 인형을 넣어 얼굴 모양의 평평한 종이 오리기만 남긴다.

## 권장 생성 순서

1. NovelAI Diffusion V4.5 Full, Quality Tags 켬, Variety 끔, Noise Schedule은 Recommended로 시작한다.
2. Base Prompt와 Character Prompt를 각각 대응하는 입력란에 붙인다. 한 입력란만 쓸 때는 Combined Prompt를 사용한다.
3. 메인 로비 얼굴과 작화를 고정하려면 페이지의 콘셉트 아트를 `Precise Reference > Character & Style Reference`에 넣는다. Vibe Transfer와 동시에 쓰지 않는다.
4. 표정·포즈가 참조 이미지에 고정되면 Precise Reference Strength를 낮춘다.
5. 비교할 때는 페이지의 A/B 모드를 켜고 같은 Seed와 같은 설정을 유지한 채 B에서 태그 한 덩어리 또는 문장 하나만 바꾼다.
6. 얼굴 점이나 장신구처럼 작은 위치 요소는 전체 재생성을 반복하지 말고 `Inpaint`에서 작은 영역 하나씩 수정한다. 차민경은 페이지에 표시되는 세 개의 부분수정 프롬프트를 각각 따로 적용한다.

Steps는 28 이하에서 시작하고, Sampler는 `DPM++ 2M` 또는 `Euler Ancestral`을 사용한다. Prompt Guidance Rescale은 기본 0으로 두며, 색이 과포화되거나 뭉개질 때만 동일 Seed A/B로 비교한다. 여러 인물이 한 이미지에 등장할 때만 NovelAI의 Character Prompt 위치 그리드를 사용한다. 현재 프리셋은 모두 단독 인물이므로 위치 그리드를 설정에 억지로 넣지 않는다.

## 현재 공통 작화

공통 `styleTags`는 메인 로비의 윤서아·차민경·강유진 콘셉트 아트를 기준으로 한다. 검증 태그인 `visual novel`, `year 2024`와, 자연어 작화 지시인 상업 미연시 게임 CG 마감, 부드러운 셀 음영, 선명한 눈, 섬세한 얼굴 비례, 따뜻한 발광 색감을 공통 앵커로 사용한다. 숫자 강조 문법, HDR, 시네마틱·망가 하이브리드, 러프 스케치 프리셋은 사용하지 않는다. 참조 프롬프트의 머리색, 홍채색, 직업, 의상, 배경, 포즈와 카메라 각도도 캐릭터·장면 내용이므로 공통 작화에 넣지 않는다.

NovelAI V4.5의 `Quality Tags`는 켜서 사용한다. 모델이 자동으로 붙이는 품질 태그를 Prompt 본문에 다시 중복하지 않는다.

메인 로비와 동일한 얼굴·작화를 우선할 때는 `/prompts`에 표시되는 선택 캐릭터의 콘셉트 아트를 내려받아 NovelAI의 `Precise Reference > Character & Style Reference`에 추가한다. 프롬프트는 새로운 표정·행동·장면을 지시하고, 참조 이미지는 로비 얼굴과 작화를 고정한다. 원본의 표정·각도·포즈까지 지나치게 따라오면 Strength를 낮춘다.

`beautiful`, `gorgeous`, `exceptionally beautiful face` 같은 막연한 문구는 캐릭터 미형 앵커로 쓰지 않는다. V4.5 Full의 Quality Tags가 `very aesthetic`, `masterpiece` 같은 공식 품질 태그를 자동 적용하고, 인물의 생김새는 검증 태그와 캐릭터별 눈매·얼굴형·턱선처럼 눈에 보이는 형태 지시로 지정한다.

일반 여성 캐릭터는 `narrow waist`, 강화된 `large breasts`, `breasts`를 사용한다. 강유진은 `curvy`, `wide hips`, `long legs`, `slim legs`로 활기찬 굴곡형 실루엣을 유지하되, 가슴은 `1.1::medium breasts::`로 중간보다 약간 풍만한 비례에 두고 불가능한 허리·척추·관절 비율이나 머리보다 큰 가슴을 금지한다. 정본의 164cm 키와 하이웨이스트 와이드 팬츠를 유지하며, 셔츠는 푸른색 없이 완전히 흰 fitted button-up으로 고정한다. 홍채는 모든 상황에서 선명한 로즈핑크로 고정하고 `aqua eyes`, `black eyes`는 강유진 전용 UC로 막는다. 태그가 없는 보조개와 큐피드 보우는 전체 생성 상황으로 제공하지 않고 강유진의 Focused Inpaint 작업으로만 제공한다. 모든 여성 캐릭터의 UC에는 `flat chest`, `small breasts`를 유지한다.

윤서아는 메인 로비의 젊고 귀여운 인상을 정체성으로 고정한다. 큰 둥근 갈색 눈, 작은 둥근 타원형 얼굴, 부드러운 볼, 작은 턱과 자연스러운 혈색을 사용하고, 기본 상황은 얼굴을 충분히 보여 주는 `character_upper_body` 구도로 만든다. 미소가 있는 상황에서만 올라간 볼, 굽은 아래 눈꺼풀, 반달형 눈웃음, 살짝 비대칭인 입꼬리와 은은한 잇몸 미소를 조합한다. 팔자주름, 꺼진 볼, 두드러진 광대, 눈밑 처짐과 진한 화장은 윤서아 전용 UC로 막는다. 차민경의 얼굴에는 오른쪽 눈 아래 가로로 나란한 눈물점 두 개를 두고, 왼쪽 아래 목에는 점 하나, 쇄골 아래와 가슴골 위 사이의 중앙 데콜테에는 점 하나를 둔다. 세 위치는 별도의 가중 태그와 짧은 위치 문장으로 고정하며 `multiple moles`나 위치를 밀어내는 상충 UC를 넣지 않는다. 작은 점이 실제 결과에서 보이도록 기본 상황은 `character_upper_body` 구도를 사용한다. 차민경의 냉미녀 인상은 찡그림·좁힌 눈·무감정이 아니라 부드럽게 좁아지는 타원형 얼굴, 큰 아몬드형 눈, 정돈된 자세와 아주 옅은 자신감 있는 미소로 만든다. 눈에는 동공 효과를 더 붙이지 않고 로비 콘셉트 아트 기반의 공통 작화 앵커를 사용한다. 공통 UC는 큰 가슴 자체를 막지 않으며 실제 노출과 홍채색 혼합만 막는다.

설정이 잘못되면 잘못된 프롬프트를 복사하지 않도록 `/prompts` 페이지가 조합을 중단하고, 해당 파일 경로와 JSON 위치를 표시한다.

## 검증

```bash
npx vitest run src/prompt-builder/promptComposer.test.ts
npm run prompt:validate
npm run test:prompt-harness
npm run verify
```

`tag-registry.json`의 `checkedAt`은 마지막 확인일이다. 태그 사전이 바뀌었거나 새 태그를 추가할 때는 출처를 다시 확인하고 날짜를 갱신한다. 공개 Danbooru CSV와 전체 후보를 로컬 대조하려면 CSV를 표준 입력으로 넘겨 `node tools/audit_novelai_prompt_tags.mjs --csv -`를 사용한다. 이 감사 명령과 `prompt:validate`는 프롬프트 문자열을 외부 서비스에 업로드하지 않는다.
