# 어둠의 심리학 강사 생성 이력

## v1

- 파일: `v1-adjust-sunglasses-seed-1258461250.png`
- 생성일: 2026-08-12
- NovelAI 모델: NAI Diffusion V4.5 Full
- 크기: 832×1216
- Steps: 23
- Guidance: 5
- Sampler: Euler Ancestral
- Seed: 1258461250
- 디자인 정본: `docs/dark-psychology-instructor-character-design.md`
- 프롬프트 정본: `docs/novelai-v45-dark-psychology-instructor-prompts.md`
- 상태: 보존. v2 디자인이나 이후 생성본으로 덮어쓰거나 삭제하지 않는다.

v1은 후덕한 체격, 눈을 덮는 더벅머리, 검은 선글라스, 네이비 정장과 선글라스를 올리는 손동작이 반영된 첫 생성본이다. 피부 흉터는 패인 여드름 흉터보다 주근깨에 가깝게 생성되었고, 턱을 든 각도와 비대칭 입꼬리는 설계보다 약하게 반영되었다.

## v2

공통 설정:

- 생성일: 2026-08-12
- NovelAI 모델: NAI Diffusion V4.5 Full
- 크기: 832×1216
- Steps: 23
- Guidance: 5
- Sampler: Euler Ancestral
- 디자인 정본: `docs/dark-psychology-instructor-v2-character-design.md`
- 상태: 기존 세 생성본과 목 비례 보정본을 모두 보존. 서로 덮어쓰거나 v1을 대체하지 않는다.

### 1차 · seed 3317162182

- 파일: `v2-adjust-sunglasses-seed-3317162182.png`
- 장점: 긴 중안부, 큰 매부리코, 돌출 광대, 패인 볼, 깡마른 체격과 정돈된 눈가림 머리가 강하게 반영되었다.
- 차이: 셔츠가 흰색으로 생성되었고 금시계가 누락되었으며 금목걸이에 펜던트가 붙었다.

### 2차 · seed 1306478870

- 파일: `v2-adjust-sunglasses-seed-1306478870.png`
- 보정: 순수 검은 셔츠, 오른손목 금시계와 펜던트 없는 금 체인을 자연어 가중 지시로 강화했다.
- 차이: 셔츠가 다시 흰색으로 생성되었고 금시계가 누락되었으며 금목걸이가 넓은 금판처럼 생성되었다.

### 3차 · seed 2418888508

- 파일: `v2-adjust-sunglasses-seed-2418888508.png`
- 보정: 검증 태그 `black shirt`, `open shirt`, `wristwatch`를 추가했다.
- 장점: 올블랙 정장과 검은 셔츠가 명확하게 반영되었다.
- 차이: 코와 손이 설계보다 캐리커처화되었고, 손목시계가 금색이 아닌 검은색으로 생성되었으며 금목걸이는 보이지 않는다.

### 1차 기반 목 비례·코잔등 보정 · seed 3317162182

- 파일: `v2-adjust-sunglasses-normal-neck-clean-nose-seed-3317162182.png`
- 기준: 1차의 seed와 얼굴·구도·표정 프롬프트를 유지했다.
- 보정: 검증 태그 `long neck`을 Undesired Content에서 강하게 제외하고, 턱선부터 쇄골까지를 정상 성인 비례로 제한했다. 코잔등은 점, 주근깨, 얼룩, 흉터 없이 깨끗하게 지정했다.
- 결과: 비정상적으로 길었던 목이 정상 범위로 짧아졌고 코잔등의 점 형태 자국이 제거되었다. 1차의 흰 셔츠와 펜던트는 사용자가 선택한 인상을 보존하기 위해 이번 보정 범위에서 건드리지 않았다.

### 비미남형 매부리코 후보 · seed 505059432

- 파일: `v2-homely-hooked-nose-seed-505059432.png`
- 생성 방식: Opus 표준 `Generate 1 Image · 0 Anlas` 단일 생성.
- 장점: 아래로 굽은 큰 매부리코, 광대 아래부터 턱까지 긴 얼굴, 각진 턱과 미남형에서 벗어난 투박한 인상이 반영되었다.
- 차이: 광대의 바깥 돌출은 설계보다 약하고, 금목걸이에 작은 펜던트가 붙었다.

### 강사 v2 현재 채택본 · seed 2999493819

- 파일: `v2-love-office-style-tan-seed-2999493819.png`
- 상태: 사용자가 현재 강사 v2 원화로 채택했다. 후속 보정 전까지 기준 이미지로 사용하며 삭제하거나 덮어쓰지 않는다.
- 생성 방식: Opus 표준 `Generate 1 Image · 0 Anlas` 단일 생성.
- 작화 보정: 기존 캐릭터 공통 앵커인 `visual novel`, `game cg`, `official art`, `year 2024`, `clean lineart`, `varied line weight`, `soft cel shading`, `subtle gradients`, `matte colors`, `restrained highlights`, `masterpiece`, `very aesthetic`를 적용했다.
- 피부 보정: 검증 태그 `tan`과 따뜻한 중간 갈색·올리브 브라운 지시를 함께 사용해 얼굴, 귀, 목과 손의 피부톤을 통일했다.
- 장점: 정장 주름, 레이어드 셀 음영, 선 굵기 변화와 따뜻한 피부톤이 복원되었고, 아래로 굽은 매부리코와 돌출 광대, 긴 광대–턱 거리가 유지되었다.
- 차이: 왜소한 체격보다 어깨와 팔이 건장하게 생성되었고 금목걸이가 여러 겹으로 늘어났다.

현재 강사 v2 채택본은 seed 2999493819이다. 1차는 얼굴 골격과 전체 인상, seed 505059432는 비미남형 매부리코, 목 비례·코잔등 보정본은 정상 목, 3차는 올블랙 의상 참고 후보로 각각 보존한다. 채택본 역시 후속 보정 시 덮어쓰지 않고 새 파일로 파생한다.
