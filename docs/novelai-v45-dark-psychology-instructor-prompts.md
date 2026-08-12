# 어둠의 심리학 강사 v1 — NovelAI V4.5 원화 프롬프트

> 정본 외형과 연출 금지 사항은 [v1 캐릭터 디자인](./dark-psychology-instructor-character-design.md)을 우선한다. 아래 문장은 NovelAI Diffusion V4.5 Full에서 바로 복사해 시험할 수 있는 v1 수동 생성안이다. [v2 디자인](./dark-psychology-instructor-v2-character-design.md)은 별도 후보이며 이 프롬프트로 덮어쓰지 않는다.

## 공통 설정

- Model: `NovelAI Diffusion V4.5 Full`
- Add Quality Tags: `ON`
- Undesired Content preset: `Human Focus V4.5 Full`
- Prompt Guidance: `5–6`
- Steps: `28` 이하에서 탐색 후 Enhance
- Sampler: `DPM++ 2M` 또는 `Euler Ancestral`
- Variety: `OFF`
- Noise Schedule: `Recommended`

1·2번 원화는 Base Prompt 하나와 Character Prompt 하나를 사용한다. 3번 책 표지는 Base Prompt 하나와 `+ Add Character` 세 개를 사용하고, Character Position을 각각 `Center / Left / Right`로 둔다.

## 확인한 단부루 태그

| 개념 | 채택 태그 | 적용 |
|---|---|---|
| 검은 선글라스 | `sunglasses` | 세 원화 공통 |
| 양쪽 눈을 덮는 앞머리 | `hair over eyes` | 세 원화 공통 |
| 헝클어진 머리 | `messy hair` | 세 원화 공통 |
| 바가지 머리 | `bowl cut` | 세 원화 공통 |
| 뚜렷한 옆 가르마 | `side part` | 세 원화 공통 |
| 약간 통통한 체형 | `plump` | `fat`, `fat man`, `obese` 대신 사용 |
| 안경 고쳐쓰기 | `adjusting eyewear` | 원화 1 |
| 두 손가락 이상을 안경에 댐 | `hand on eyewear` | 원화 1 |
| 화면 속 청자를 가리킴 | `pointing at viewer` | 원화 2 |
| 여성 두 명 | `2girls` | 원화 3 |
| 소파와 소파 위 자세 | `couch`, `on couch` | 원화 3 |
| 다리 꼬기 | `crossed legs` | 원화 3 |

`acne scars`, `blackheads`, `nasolabial folds`는 정확히 대응하는 단부루 태그가 검색되지 않았다. 얼굴 흉터·모공·팔자주름은 태그를 발명하지 않고 영어 자연어 지시로 고정한다. `mature male`은 매력적인 중년 남성, `fat man`은 뚱뚱한 남성을 뜻해 이 디자인에는 사용하지 않는다. 눈이 선글라스와 머리에 가려져 있으므로 직접 눈맞춤을 뜻하는 `looking at viewer`가 아니라 몸이 정면을 향한다는 `facing viewer`를 사용한다.

## 공통 UC

아래 내용을 1·2번의 Undesired Content 추가 칸에 사용한다.

```text
bishounen, tall, muscular, abs, long hair, obese, receding hairline, glasses, open mouth, teeth, blush, sweat, slouching, 3d, photorealistic, bloom, lens flare, bokeh, fisheye, text, signature, artist name

A youthful handsome face, a sharp jawline, a slim model body, a beard, stubble, a receding hairline, baldness, slicked-back hair, a modern neat center part, a symmetrical friendly smile, a wide grin, visible eyes, timid posture, embarrassment, a wrinkled or badly fitted suit, flashy gold jewelry, sports sunglasses, perfectly smooth flawless skin, grotesque pores, diseased skin, horror-villain lighting, or caricature proportions. Malformed hands, merged fingers, extra fingers, or a hand covering the raised mouth corner.
```

## 원화 1 — 선글라스를 올리며 설명

### Base Prompt

```text
1boy, solo, upper body, simple background, grey background, facing viewer, visual novel, year 2024

Use a neutral camera placed only slightly below eye level, with a subtle three-quarter turn and enough space around the hand. Use polished commercial game CG rendering, clean dark linework, soft cel shading, restrained highlights, believable anatomy, and the same contemporary Korean visual-novel finish as the other Love Office character art.
```

### Character Prompt

```text
boy, brown hair, short hair, bowl cut, side part, hair over eyes, messy hair, sunglasses, plump, business suit, white shirt, collared shirt, necktie, standing, closed mouth, smirk, adjusting eyewear, hand on eyewear, facing viewer

He is an early-forties adult Korean man of average height with a thick neck, softly rounded shoulders, full cheeks, a soft jaw, and a moderately plump body; he is noticeably heavyset but not fat or obese. Give him thick dark-brown hair in an old-fashioned asymmetric bowl cut, with a forced side part and shaggy bangs hanging across both eyes and over the upper edge of his sunglasses.

Use matte-black rectangular sunglasses with dark opaque lenses. Keep both eyes completely hidden behind the lenses and the long fringe. Give both cheeks visible shallow rolling acne scars mixed with small pitted marks, many enlarged dark pores and blackheads clustered across the nose tip and nostril wings, and deep nasolabial folds. Preserve a normal human skin tone and make the texture clearly readable without turning it into dirt, disease, gore, or a monster face.

Dress him in a perfectly fitted deep-navy single-breasted suit, a crisp pure-white shirt, a dark wine silk tie, a black leather belt, and a thin silver wristwatch. Keep the jacket shoulders, sleeve length, collar, shirt, and tie immaculate and unwrinkled.

Lift his chin slightly by about five to eight degrees and keep his chest open. Raise only his right mouth corner, on the viewer-left side, into a confident closed-mouth smirk; keep the left mouth corner level so the asymmetry is obvious. Deepen the nasolabial fold beside the raised corner.

Place his right index and middle fingers against the sunglasses near the bridge and show him slowly pushing the frame upward only a small distance. Do not move the sunglasses onto his forehead and do not reveal his eyes. Keep the hand clear of his mouth so the raised mouth corner remains the focal point. His pose must look calm and completely certain, as if every sentence is an unquestionable answer.
```

## 원화 2 — 손가락질하며 의기양양하게 가르침

### Base Prompt

```text
1boy, solo, cowboy shot, simple background, grey background, facing viewer, visual novel, year 2024

Use a camera placed only slightly below eye level and weak perspective so the pointing hand remains anatomical and does not become larger than the face. Use polished commercial game CG rendering, clean dark linework, soft cel shading, restrained highlights, believable anatomy, and the same contemporary Korean visual-novel finish as the other Love Office character art.
```

### Character Prompt

```text
boy, brown hair, short hair, bowl cut, side part, hair over eyes, messy hair, sunglasses, plump, business suit, white shirt, collared shirt, necktie, standing, closed mouth, smirk, pointing at viewer, facing viewer

He is an early-forties adult Korean man of average height with a thick neck, softly rounded shoulders, full cheeks, a soft jaw, and a moderately plump body; he is noticeably heavyset but not fat or obese. Give him thick dark-brown hair in an old-fashioned asymmetric bowl cut, with a forced side part and shaggy bangs hanging across both eyes and over the upper edge of his sunglasses.

Use matte-black rectangular sunglasses with dark opaque lenses. Keep both eyes completely hidden behind the lenses and the long fringe. Give both cheeks visible shallow rolling acne scars mixed with small pitted marks, many enlarged dark pores and blackheads clustered across the nose tip and nostril wings, and deep nasolabial folds. Preserve a normal human skin tone and make the texture clearly readable without turning it into dirt, disease, gore, or a monster face.

Dress him in a perfectly fitted deep-navy single-breasted suit, a crisp pure-white shirt, a dark wine silk tie, a black leather belt, and a thin silver wristwatch. Keep the jacket shoulders, sleeve length, collar, shirt, and tie immaculate and unwrinkled.

Lift his chin slightly by about five to eight degrees and hold his chest open. Raise only his right mouth corner, on the viewer-left side, into a confident closed-mouth smirk; keep the left mouth corner level. Extend his right arm and point one relaxed index finger toward the viewer as if he has just identified the decisive answer. Keep the gesture instructional rather than angry or threatening. Hold his left hand near the front of his jacket at waist height, continuing the lecture with absolute ease. Keep the pointing finger, hand, wrist, elbow, and shoulder anatomical.
```

원화 2에는 위의 공통 UC를 그대로 사용한다.

## 원화 3 — 《여성의 마음을 지배하는 어둠의 심리학》 책 표지

책 표지는 단일 Character Prompt에 세 사람을 섞지 않는다. Base Prompt에 인원수와 구도를 적고, 강사와 두 성인 여성을 각각 별도 Character Prompt로 추가한다.

### Base Prompt

```text
1boy, 2girls, full body, indoors, couch, on couch, sitting, crossed legs, visual novel, year 2024, no text

Create a vertical premium dating-advice book-cover illustration with exactly three adults. Place the male instructor in the center of a wide luxurious dark leather couch and place one glamorous adult woman on each side, forming a clear balanced triangular composition. Use a polished high-budget advertising pose, rich controlled studio lighting, clean commercial game-CG linework, soft cel shading, and restrained highlights. Leave generous clean negative space above the heads for a title and a smaller clean area near the bottom for an author name to be added later. Generate no readable letters, logos, watermarks, or symbols.
```

### Character 1 — 강사 · Position `Center`

```text
boy, brown hair, short hair, bowl cut, side part, hair over eyes, messy hair, sunglasses, plump, business suit, white shirt, collared shirt, necktie, sitting, on couch, crossed legs, closed mouth, smirk, facing viewer

He is the same early-forties adult Korean male instructor from the character art: average height, thick neck, full cheeks, soft jaw, moderately plump body, old-fashioned asymmetric dark-brown bowl cut with a forced side part, shaggy bangs covering both eyes, matte-black rectangular sunglasses, visible shallow acne scarring on both cheeks, dark enlarged pores and blackheads across the nose, and deep nasolabial folds. Keep both eyes hidden.

Dress him in the same perfectly fitted deep-navy suit, crisp pure-white shirt, dark wine silk tie, black belt, and thin silver watch. Seat him at the exact center of the couch with one leg confidently crossed over the other, his chin slightly raised, one arm resting across the couch back, and only his right mouth corner, on the viewer-left side, raised in a closed-mouth smirk. Preserve his unattractive facial structure and skin texture; do not beautify or slim him for the cover.
```

### Character 2 — 왼쪽 표지 모델 · Position `Left`

```text
girl, black hair, long hair, long eyelashes, curvy, narrow waist, wide hips, long legs, large breasts, breasts, sitting, on couch, smile, looking at another

She is a glamorous Korean woman in her late twenties, unmistakably adult, with long glossy black hair and a full-busted curvy silhouette. Dress her in an elegant fitted black evening gown with tasteful coverage and polished editorial styling. Seat her close to the instructor's left side and angle her upper body toward him with a confident advertising-model smile. Keep her identity distinct from every existing Love Office heroine.
```

### Character 3 — 오른쪽 표지 모델 · Position `Right`

```text
girl, brown hair, long hair, wavy hair, long eyelashes, curvy, narrow waist, wide hips, long legs, large breasts, breasts, sitting, on couch, smile, looking at another

She is a glamorous Korean woman in her early thirties, unmistakably adult, with long softly wavy auburn-brown hair and a full-busted curvy silhouette. Dress her in an elegant fitted deep-red evening gown with tasteful coverage and polished editorial styling. Seat her close to the instructor's right side and angle her upper body toward him with a confident advertising-model smile. Keep her identity distinct from the woman on the left and from every existing Love Office heroine.
```

### 책 표지 추가 UC

Human Focus V4.5 Full을 선택한 뒤 아래를 추가한다.

```text
child, loli, school uniform, flat chest, small breasts, 3d, photorealistic, text, signature, artist name, bloom, lens flare, bokeh, fisheye

Anyone younger than twenty-five, exactly resembling an existing Love Office heroine, more or fewer than exactly one man and two adult women, duplicated people, merged bodies, fused limbs, malformed hands, extra fingers, an empty couch, women looking uncomfortable, women mocking or laughing at the man, parody faces, clown imagery, devil horns, fake certificates, cash, readable typography, a handsome or slim male instructor, visible male eyes, smooth flawless male skin, a symmetrical friendly male smile, nudity, exposed breasts, nipples, transparent clothing, or an explicit sexual pose.
```

## 생성 순서

1. 원화 1을 먼저 생성해 얼굴, 가르마, 선글라스, 흉터 위치와 오른쪽 입꼬리를 확정한다.
2. 같은 seed와 Character Reference를 사용해 원화 2의 포즈만 바꾼다.
3. 1번 결과를 강사 Character Reference로 사용해 책 표지를 생성한다.
4. 책 표지의 두 여성은 각각 별도 Character Prompt와 위치를 유지한다.
5. 최종 선택 뒤 세 원화에서 가르마 방향, 선글라스 프레임, 흉터 분포와 넥타이 색이 같은지 비교한다.
6. 책 제목과 저자명은 이미지 생성이 끝난 뒤 별도 편집 단계에서 올린다.
