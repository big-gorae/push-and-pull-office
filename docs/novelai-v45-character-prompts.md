# Love Office — NovelAI V4.5 캐릭터 프롬프트

> 현재 편집 원본은 `prompt-config/novelai-v45/`의 캐릭터별 JSON이다. `/prompts` 웹 도구가 해당 파일을 직접 읽어 프롬프트를 조합한다. 이 문서는 초기 조사와 수동 복사용 참고본으로 유지한다.

2026-08-01 기준. `story/characters/`와 `docs/story-1-characters.md`의 캐릭터 정본을 우선하고, 현재 콘셉트 이미지는 정본에 없는 홍채색을 정하는 보조 자료로만 사용했다.

## 바로 쓸 설정

- Model: `NovelAI Diffusion V4.5 Full`
- Add Quality Tags: `OFF`
- Undesired Content preset: `Human Focus V4.5 Full`
- Prompt Guidance: `5–6`에서 시작
- Steps: 탐색은 `28` 이하에서 시작하고, 구도가 잡힌 뒤 Enhance
- Sampler: `DPM++ 2M` 또는 `Euler Ancestral`
- Base Prompt는 메인 Prompt 칸에 넣는다.
- `+ Add Character`를 누르고 Character Prompt를 별도 칸에 넣는다.
- Add Quality Tags를 다시 켤 경우 Base 끝의 `masterpiece, very aesthetic, no text`는 삭제한다.

V4.5 Full의 자동 Quality Tags에는 `location`이 들어간다. 캐릭터 단독 스프라이트나 레퍼런스에는 불필요한 배경을 만들 수 있으므로 여기서는 끄고 최소 품질 suffix만 직접 넣었다.

## 공통 작화 Base

### 전신 캐릭터/스프라이트

여성 캐릭터:

```text
1girl, solo, full body, eye-level, three-quarter view, simple warm gray background, visual novel, game cg, official art, year 2021, adult proportions, clean lineart, varied line weight, anime coloring, soft cel shading, subtle gradients, matte colors, restrained highlights, small eye catchlights, believable clothing folds, masterpiece, very aesthetic, no text
```

서정우:

```text
1boy, solo, full body, eye-level, three-quarter view, simple warm gray background, visual novel, game cg, official art, year 2021, adult proportions, clean lineart, varied line weight, anime coloring, soft cel shading, subtle gradients, matte colors, restrained highlights, small eye catchlights, believable clothing folds, masterpiece, very aesthetic, no text
```

### 오피스 장면 CG

여성 캐릭터:

```text
1girl, solo, cowboy shot, eye-level, off-center composition, modern Korean office, mixed window light and fluorescent light, visual novel, game cg, official art, year 2021, adult proportions, clean lineart, varied line weight, anime coloring, soft cel shading, subtle gradients, matte colors, restrained highlights, small eye catchlights, believable clothing folds, masterpiece, very aesthetic, no text
```

서정우:

```text
1boy, solo, cowboy shot, eye-level, off-center composition, modern Korean office, mixed window light and fluorescent light, visual novel, game cg, official art, year 2021, adult proportions, clean lineart, varied line weight, anime coloring, soft cel shading, subtle gradients, matte colors, restrained highlights, small eye catchlights, believable clothing folds, masterpiece, very aesthetic, no text
```

`year 2021`은 최신 AI 일러스트의 평균적인 광택보다, 현대적인 상업 미소녀 게임 작화에 가까운 출발점을 잡기 위한 Love Office용 선택이다. 절대적인 정답 태그는 아니므로 같은 seed에서 `year 2019`, `year 2021`, `year 2024`만 바꿔 비교할 수 있다.

### 공통 추가 UC

먼저 UI에서 `Human Focus V4.5 Full`을 고른 뒤 아래만 추가한다.

```text
3d, photorealistic, plastic skin, glossy skin, wet skin, giant eyes, multicolored eyes, galaxy eyes, huge breasts, gigantic breasts, cleavage, impossible clothes, overdesigned clothes, excessive jewelry, sparkles, floating particles, bloom, lens flare, rim light, bokeh, fisheye, dutch angle, text, signature, artist name, extra people
```

이 UC를 더 길게 만들지 않는다. 실제로 반복되는 오류만 하나씩 추가한다. `ai-generated`, `ai-assisted`는 V4.5 UC에 넣지 않는다.

아래 표정·행동 블록에서는 `# actual_...` 라벨을 복사하지 말고, 원하는 라벨 아래의 태그 한 묶음만 기존 표정·행동 부분과 교체한다. `cowboy shot`이나 `upper body`를 사용할 때는 화면에 나오지 않는 신발 태그도 Character Prompt에서 삭제한다.

## 유은솔

### Character Prompt — 기본 사회적 미소

```text
girl, 24-year-old Korean woman, adult, 1.1::long dark brown hair, large soft brown eyes, rounded oval face::, softly wavy hair, soft side-swept bangs, thin natural eyebrows, petite adult build, short stature, ivory cardigan, pale blue collared blouse, navy knee-length flared skirt, navy employee lanyard, black loafers, cat-sticker notebook, standing with her elbows close to her body, holding the notebook close to her chest, closed-mouth social smile, slightly raised shoulders, looking slightly toward the office exit
```

정체성 고정 부분:

```text
girl, 24-year-old Korean woman, adult, 1.1::long dark brown hair, large soft brown eyes, rounded oval face::, softly wavy hair, soft side-swept bangs, thin natural eyebrows, petite adult build, short stature
```

기본 의상 고정 부분:

```text
ivory cardigan, pale blue collared blouse, navy knee-length flared skirt, navy employee lanyard, black loafers, cat-sticker notebook
```

표정·행동 교체 블록:

```text
# actual_social_smile
standing with her elbows close to her body, holding the notebook close to her chest, closed-mouth social smile, slightly raised shoulders, looking slightly toward the office exit

# actual_tense
holding a smartphone with both hands, tense, raised shoulders, closed mouth, looking toward the office doorway

# actual_relief
holding a tumbler at waist level, relieved, gentle closed-mouth smile, relaxed shoulders, looking toward a nearby coworker

# actual_exhausted
seated at her desk, tired eyes, subtle under-eye shadows, lowered shoulders, looking down at her phone
```

드리프트가 생길 때만 추가할 Character UC:

```text
child, loli, schoolgirl, school uniform, middle-aged woman, tall woman, muscular woman, short hair, bob cut, blonde hair, blue eyes, seductive smile, large breasts
```

## 차민경

### Character Prompt — 회의 중 사실 확인

```text
girl, 28-year-old Korean woman, adult, 1.1::sleek chin-length black bob, narrow muted reddish-brown eyes, angular face::, hair tucked behind one ear, high cheekbones, defined jawline, dark straight eyebrows, tall woman, athletic balanced build, charcoal tailored blazer, burgundy silk blouse, black tailored slacks, thin metal earrings, burgundy lipstick, holding a metal pen, standing upright with one hand on her hip, one eyebrow raised, skeptical expression, direct gaze
```

정체성 고정 부분:

```text
girl, 28-year-old Korean woman, adult, 1.1::sleek chin-length black bob, narrow muted reddish-brown eyes, angular face::, hair tucked behind one ear, high cheekbones, defined jawline, dark straight eyebrows, tall woman, athletic balanced build
```

기본 의상 고정 부분:

```text
charcoal tailored blazer, burgundy silk blouse, black tailored slacks, thin metal earrings, burgundy lipstick, metal pen
```

표정·행동 교체 블록:

```text
# actual_skeptical
holding a metal pen, standing upright with one hand on her hip, one eyebrow raised, skeptical expression, direct gaze

# actual_disgust
standing still, clenched jaw, narrowed eyes, cold gaze, looking at someone just off camera

# actual_protective
stepping in front of a coworker, firm stance, serious expression, looking sideways at the approaching person

# actual_exhausted
alone in a meeting room, holding a closed laptop, tired eyes, lowered shoulders, looking down
```

드리프트가 생길 때만 추가할 Character UC:

```text
child, loli, petite, short stature, round face, long hair, ponytail, blonde hair, blue eyes, shy, timid, blushing, school uniform, miniskirt, cleavage, seductive pose
```

## 신나경

### Character Prompt — 절차 확인

```text
girl, 29-year-old Korean woman, adult, 1.1::high dark brown ponytail, muted teal upturned eyes, lively face::, shoulder-length hair tied high, expressive eyebrows, athletic active build, cobalt blue button-up shirt, rolled-up sleeves, light gray wide-leg trousers, neat loafers, geometric earrings, cobalt employee lanyard, holding a tablet and stylus, upright posture, one eyebrow raised, focused expression, looking at the tablet
```

정체성 고정 부분:

```text
girl, 29-year-old Korean woman, adult, 1.1::high dark brown ponytail, muted teal upturned eyes, lively face::, shoulder-length hair tied high, expressive eyebrows, athletic active build
```

기본 의상 고정 부분:

```text
cobalt blue button-up shirt, rolled-up sleeves, light gray wide-leg trousers, neat loafers, geometric earrings, cobalt employee lanyard, tablet, stylus
```

표정·행동 교체 블록:

```text
# actual_fact_check
holding a tablet and stylus, upright posture, one eyebrow raised, skeptical expression, looking at the tablet

# actual_warning
holding the tablet at her side, firm upright stance, stern expression, direct gaze, pointing once with the stylus

# actual_procedural
writing on the tablet with a stylus, focused, closed mouth, looking down at the record

# actual_worn_down
holding the tablet against her side, tired eyes, restrained expression, upright posture, looking away
```

드리프트가 생길 때만 추가할 Character UC:

```text
child, loli, fragile build, slouching, shy, blushing, bob cut, low ponytail, black business suit, pencil skirt, miniskirt, high heels, cleavage
```

## 임수연 — 현재

### Character Prompt — 경계하는 손님 응대 미소

```text
girl, 34-year-old Korean woman, adult, 1.1::short softly wavy brown hair, thin round glasses, calm amber-brown eyes::, soft oval face, subtle smile lines at the outer eyes, natural adult build, olive green long cardigan, faded cream cotton blouse, long brown A-line skirt, brown loafers, holding a book with a plain bookmark, guarded posture, polite closed-mouth smile, glancing toward the doorway
```

정체성 고정 부분:

```text
girl, 34-year-old Korean woman, adult, 1.1::short softly wavy brown hair, thin round glasses, calm amber-brown eyes::, soft oval face, subtle smile lines at the outer eyes, natural adult build
```

기본 의상 고정 부분:

```text
olive green long cardigan, faded cream cotton blouse, long brown A-line skirt, brown loafers, book, plain bookmark
```

표정·행동 교체 블록:

```text
# actual_customer_service
holding a book at waist level, polite closed-mouth smile, relaxed professional posture, looking toward a customer

# actual_guarded
holding the book close to her body, guarded posture, closed mouth, glancing toward the doorway

# actual_testimony
holding an old postcard with its address removed, determined expression, steady direct gaze, upright seated posture
```

드리프트가 생길 때만 추가할 Character UC:

```text
child, loli, teenager, long hair, ponytail, office suit, employee lanyard, high heels, miniskirt, idol outfit, glamorous makeup, seductive pose
```

### 임수연 — 과거 서점 근무 버전

현재 버전과 한 프롬프트에서 섞지 않는다.

```text
girl, 30-year-old Korean woman, adult, 1.1::shoulder-length naturally wavy brown hair, calm amber-brown eyes, soft oval face::, no glasses, subtle smile lines at the outer eyes, natural adult build, olive cardigan, faded cream cotton shirt, long brown skirt, practical flat shoes, old independent-bookstore name tag, holding a book with a plain bookmark, polite professional smile, glancing briefly toward the shop entrance
```

## 서정우 — 현실 모습

### Character Prompt — 반응을 기다리는 미소

```text
boy, 42-year-old Korean man, adult man, 1.12::round face, receding hairline, thinning short black hair::, dark brown eyes, faint uneven stubble, slightly oily forehead, short stature, stocky heavy build, protruding belly, ill-fitting charcoal suit jacket, tight shirt collar, muted navy shirt, wine-red tie, old leather briefcase, company phone, leaning his upper body toward someone just off camera, closed-mouth smile held too long, waiting expression, looking at the other person
```

정체성 고정 부분:

```text
boy, 42-year-old Korean man, adult man, 1.12::round face, receding hairline, thinning short black hair::, dark brown eyes, faint uneven stubble, slightly oily forehead, short stature, stocky heavy build, protruding belly
```

기본 의상 고정 부분:

```text
ill-fitting charcoal suit jacket, tight shirt collar, muted navy shirt, wine-red tie, old leather briefcase, company phone
```

표정·행동 교체 블록:

```text
# actual_waiting_smile
leaning his upper body toward someone just off camera, closed-mouth smile held too long, waiting expression, looking at the other person

# actual_irritated
leaning forward, irritated, furrowed brows, clenched jaw, tight closed mouth, looking at someone just off camera

# looming
standing too close to the foreground person, blocking part of the doorway, leaning forward, neutral closed-mouth smile, looking down at them
```

현실형 Character UC:

```text
bishounen, ikemen, youthful, teenager, tall man, slim man, slender, muscular, abs, sharp jawline, full hair, long hair, clean-shaven, glamorous, heroic pose, monster, grotesque, horror
```

## 서정우 — 자기 인식 속 모습

현실형과 절대 한 프롬프트에서 섞지 않는다.

```text
boy, 42-year-old Korean man, adult man, 1.1::thick neatly styled black hair, sharp jawline, relaxed dark brown eyes::, handsome middle-aged man, tall, lean build, broad shoulders, well-groomed, fitted charcoal suit, muted navy shirt, wine-red tie, relaxed posture, confident gentle smile, looking slightly down toward the viewer
```

자기 인식형 Character UC:

```text
receding hairline, thinning hair, short stature, obese, protruding belly, ill-fitting suit, stubble, oily skin, looming posture
```

## 다인물 예시 — 차민경이 유은솔 앞을 가로막는 장면

Base Prompt:

```text
2girls, cowboy shot, eye-level, modern Korean meeting room, late afternoon, mixed window light and fluorescent light, visual novel, game cg, official art, year 2021, adult proportions, clean lineart, varied line weight, anime coloring, soft cel shading, matte colors, restrained highlights, small eye catchlights, believable clothing folds, masterpiece, very aesthetic, no text. One woman stands half a step in front of the other, blocking an approaching person.
```

첫 번째 Character Prompt — 차민경, Position은 왼쪽/앞쪽:

```text
girl, 28-year-old Korean woman, adult, 1.1::sleek chin-length black bob, narrow muted reddish-brown eyes, angular face::, hair tucked behind one ear, high cheekbones, defined jawline, tall woman, athletic balanced build, charcoal tailored blazer, burgundy silk blouse, black tailored slacks, thin metal earrings, burgundy lipstick, firm protective stance, serious expression, looking toward someone off camera. She is on the left and closer to the camera.
```

두 번째 Character Prompt — 유은솔, Position은 오른쪽/뒤쪽:

```text
girl, 24-year-old Korean woman, adult, 1.1::long dark brown hair, large soft brown eyes, rounded oval face::, softly wavy hair, soft side-swept bangs, thin natural eyebrows, petite adult build, short stature, ivory cardigan, pale blue collared blouse, navy knee-length flared skirt, navy employee lanyard, holding a smartphone with both hands, tense, raised shoulders, looking toward the office doorway. She is on the right and half a step behind the other woman.
```

두 Character Prompt의 순서는 화면의 왼쪽→오른쪽 순서와 맞춘다. 색이나 헤어가 서로 새면 각 Character UC에 상대방의 대표 태그를 짧게 넣는다.
다인물 생성에서는 공통 추가 UC의 `extra people`를 반드시 삭제한다.

## 일관성 유지 규칙

1. 각 인물의 `정체성 고정 부분`은 철자와 동의어까지 그대로 유지한다.
2. 한 번에 `의상`, `표정·행동`, `배경·카메라` 중 한 블록만 바꾼다.
3. 표정은 하나, 시선은 하나, 손동작은 하나만 지정한다. 이전 표정·포즈 태그는 반드시 삭제한다.
4. 비교할 때는 seed와 나머지 설정을 고정하고 한 블록만 바꾼다. seed는 캐릭터 정체성 잠금 장치가 아니다.
5. 괜찮은 기준 이미지가 나온 뒤 V4.5의 Precise Reference를 `Character` 모드로 사용한다. Strength가 너무 높아 표정·각도까지 굳으면 낮춘다.
6. 여러 인물을 한 장에 넣을 때 여러 Character Reference를 동시에 넣으면 외형이 서로 섞인다. 다인물은 별도 Character Prompt 박스를 사용한다.
7. 손·안경 다리·귀걸이·사원증 줄·가방끈이 만나는 부분은 좋은 전체컷을 고른 뒤 Inpaint로 고친다. 긴 `perfect hands` 주문으로 해결하려 하지 않는다.

## 눈 색에 대한 임시 결정

정본에 눈 색이 명시된 인물은 유은솔뿐이다. 생성 간 랜덤 드리프트를 막기 위해 나머지는 현재 콘셉트 자산을 참고하여 아래처럼 임시 고정했다.

- 차민경: `muted reddish-brown eyes`
- 신나경: `muted teal eyes`
- 임수연: `amber-brown eyes`
- 서정우: `dark brown eyes`

이 네 값은 캐릭터 정본이 아니다. 최종 팔레트를 결정하면 각 인물의 Identity와 Character UC에서 한 번만 일괄 교체한다.

## 조사 근거

- NovelAI 공식 — Models: https://docs.novelai.net/en/image/models/
- NovelAI 공식 — Tagging: https://docs.novelai.net/en/image/tags/
- NovelAI 공식 — Add Quality Tags: https://docs.novelai.net/en/image/qualitytags/
- NovelAI 공식 — Strengthening & Weakening: https://docs.novelai.net/en/image/strengthening-weakening/
- NovelAI 공식 — Undesired Content: https://docs.novelai.net/en/image/undesiredcontent/
- NovelAI 공식 — Multi-Character Prompting: https://docs.novelai.net/en/image/multiplecharacters/
- NovelAI 공식 — Precise Reference: https://docs.novelai.net/en/image/precisereference/
- NovelAI 공식 — Prompt Chunks: https://docs.novelai.net/en/image/promptchunks/
- NovelAI 공식 — Steps & Guidance: https://docs.novelai.net/en/image/stepsguidance/
- NovelAI 공식 — Sampling: https://docs.novelai.net/en/image/sampling/
- 현행 커뮤니티 가이드: https://hothottuk.neocities.org/en
- V4.5 artist/quality 실험 토론: https://www.reddit.com/r/NovelAi/comments/1kzhm4r/need_help_with_v45_full_prompting/
- V4.5 artist tag order 토론: https://www.reddit.com/r/NovelAi/comments/1uswsz8/about_the_ordering_of_artist_tags/
- V4.5 최소 UC 토론: https://www.reddit.com/r/NovelAi/comments/1tzmijp/
