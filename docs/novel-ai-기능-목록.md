# Novel AI 기능 목록

NovelAI로 캐릭터 스탠딩 이미지와 이벤트 CG를 제작할 때 자주 사용하는 기능을 목적별로 정리한 참고 문서다. 동일 캐릭터 유지, 표정 차분 제작, 부분 수정, 화풍 통일 등 작업 목적에 따라 적합한 기능이 다르다.

## 빠른 선택 가이드

| 하고 싶은 작업 | 우선 사용할 기능 | 보조 기능 |
| --- | --- | --- |
| 같은 캐릭터를 다른 포즈·장면에 등장시키기 | Precise Reference의 Character Reference | Inpaint |
| 몸과 옷을 유지하면서 표정만 바꾸기 | 얼굴 영역 Inpaint | Director Tools의 Emotion |
| 같은 구도의 표정 차분을 빠르게 만들기 | Director Tools의 Emotion | Inpaint |
| 기존 이미지의 구도와 형태를 살려 변형하기 | Image2Image | Inpaint |
| 여러 이미지의 화풍·색감·분위기 통일하기 | Vibe Transfer | 고정 스타일 프롬프트 |
| 프롬프트 변경 결과를 비교하기 | Seed 고정 | 동일 생성 설정 유지 |
| 완성 이미지의 디테일과 해상도 높이기 | Enhance, Upscale | — |
| 이미지 확장·간단한 덧그림·부분 편집하기 | Canvas | Image2Image, Inpaint |

## 1. Inpaint

이미지에서 마스크로 선택한 부분만 다시 생성하는 기능이다. 선택하지 않은 몸, 옷, 배경 등의 영역은 가능한 한 유지하면서 특정 부위를 수정할 수 있다.

### 적합한 작업

- 표정만 변경
- 눈, 손, 입처럼 잘못 생성된 부분 수정
- 옷 일부나 액세서리 변경
- 배경의 작은 물건 추가 또는 제거

### 한계

캐릭터를 회사에서 집으로 옮기거나 정면 자세를 달리는 자세로 바꾸는 등 구도 전체를 변경하는 작업에는 적합하지 않다. 이런 작업에는 Character Reference를 사용해 새 이미지를 생성하는 편이 낫다.

### 활용 예시

얼굴만 마스킹한 뒤 다음과 같은 표정 프롬프트를 입력한다.

```text
angry expression, clenched teeth
```

[NovelAI Inpaint 문서](https://docs.novelai.net/en/image/inpaint/)

## 2. Precise Reference — Character Reference

기준 이미지를 참조해 얼굴, 머리, 눈, 복장 등 캐릭터의 시각적 특징을 유지하면서 새로운 포즈와 장면을 생성하는 기능이다. 동일 캐릭터를 여러 이벤트 CG에 반복 등장시킬 때 핵심적으로 사용한다. 원문 기준 V4.5 모델에서 사용할 수 있다.

### 주요 설정

- **Strength:** 참조 이미지의 시각적 특징을 가져오는 강도
- **Fidelity:** 프롬프트보다 참조 이미지를 엄격하게 우선하는 정도

두 값을 너무 높이면 얼굴뿐 아니라 원본의 표정, 얼굴 각도, 포즈까지 복제하려는 경향이 생길 수 있다.

### 실험 시작값

아래 값은 공식 권장값이 아니라 시행착오를 줄이기 위한 출발점이다.

| 목적 | Strength | Fidelity |
| --- | ---: | ---: |
| 동일인 유지 우선 | 0.60~0.75 | 0.65~0.85 |
| 포즈·구도 크게 변경 | 0.45~0.65 | 0.55~0.75 |

조정 요령:

- 얼굴이 달라지면 Fidelity를 조금 올린다.
- 원본 포즈를 계속 따라 하면 Strength를 조금 내린다.
- 의상 재현이 약하면 의상의 핵심 특징을 프롬프트에서 다시 강조한다.

### 좋은 참조 이미지

- 단순한 배경
- 중립적인 표정
- 전신 정면 이미지
- 얼굴 특징이 잘 보이는 확대 이미지
- 여러 각도가 필요하다면 `turnaround`, `multiple views`, `reference sheet` 형태의 설정화

### 주의 사항

- 참조 이미지 하나당 생성 이미지에 5 Anlas가 추가로 든다.
- 여러 Character Reference를 동시에 사용하면 인물별로 분리되지 않고 특징이 섞일 수 있다.
- Precise Reference와 Vibe Transfer는 동시에 사용할 수 없다.

[NovelAI Precise Reference 문서](https://docs.novelai.net/en/image/precisereference/)

## 3. Director Tools — Emotion

기준 이미지의 캐릭터 표정을 빠르게 변경하는 기능이다. 한 명의 애니메이션 캐릭터가 정면을 보고 있고 기본 표정이 중립적일 때 특히 잘 작동한다.

### 주요 설정

- **Emotion Level:** 표정이 적용되는 강도
- **Emotion Prompt:** 표정에 추가할 특징

### 추천 용도

미연시 스탠딩 이미지의 `happy`, `sad`, `angry`, `embarrassed`, `surprised` 같은 표정 차분을 빠르게 만드는 데 적합하다.

### 한계

변화가 얼굴에만 한정되지 않아 머리나 의상이 미세하게 달라질 수 있다. 완전히 같은 몸과 옷을 유지해야 한다면 얼굴만 마스킹한 Inpaint가 더 안전하다.

[NovelAI Director Tools 문서](https://docs.novelai.net/en/image/directortools/)

## 4. Image2Image

기존 이미지를 바탕으로 이미지 전체를 다시 생성하는 기능이다.

### 주요 설정과 효과

- **Strength가 낮을 때:** 원본 구도와 형태를 많이 유지
- **Strength가 높을 때:** 프롬프트에 따라 이미지 전체를 크게 변경
- **Noise가 높을 때:** 새로운 세부 묘사를 추가하기 쉬우나 반복 사용 시 아티팩트가 생길 수 있음

### 적합한 작업

- 러프 스케치를 완성 이미지로 변환
- 같은 자세에서 복장이나 배경을 조금 변경
- 기존 결과물의 분위기와 구도를 유지하며 변형

### 한계

완전히 다른 상황과 포즈로 바꾸면서 얼굴만 동일하게 유지하는 용도에는 적합하지 않다. Strength를 낮추면 기존 포즈에 묶이고, 높이면 얼굴이 달라질 수 있다. 캐릭터 일관성이 중요하다면 Character Reference를 우선 사용한다.

[NovelAI Control Tools 문서](https://docs.novelai.net/en/image/controltools/)

## 5. Vibe Transfer

참조 이미지의 화풍, 색감, 분위기, 시각적 요소를 새 이미지에 옮기는 기능이다. 정확한 동일인 유지보다 여러 이미지의 전체적인 스타일을 통일하는 데 적합하다.

### 적합한 작업

- 모든 이벤트 CG의 채색 스타일 통일
- 동일한 색조와 조명 분위기 유지
- 특정 작화 느낌을 여러 장면에 적용

### 한계

캐릭터 보존용으로 사용하면 배경, 포즈, 화풍까지 불필요하게 따라올 수 있다. 또한 Precise Reference와 동시에 사용할 수 없다.

[NovelAI Vibe Transfer 문서](https://docs.novelai.net/en/image/vibetransfer/)

## 6. Seed

이미지 생성에 사용하는 난수 시작점이다. 같은 Seed와 같은 설정을 사용하면 비슷한 생성 경로를 재현할 수 있어, 프롬프트 일부만 바꿨을 때의 차이를 비교하기 좋다.

### 적합한 작업

- 표정이나 소품 등 작은 프롬프트 변경 비교
- 생성 설정 실험
- 비슷한 방향의 결과 재현

### 한계

Seed는 캐릭터 ID를 저장하지 않는다. 배경, 카메라 구도, 포즈, 의상, 표정을 크게 바꾸면 같은 Seed를 사용해도 얼굴이 달라질 수 있다. 서로 다른 이벤트 CG에서 동일인을 유지하려면 Character Reference가 더 적합하다.

[NovelAI Seed 문서](https://docs.novelai.net/en/image/seed/)

## 7. Enhance, Upscale, Canvas

### Enhance

완성 이미지를 다시 처리해 디테일을 높이는 기능이다. Strength가 높으면 구도나 캐릭터 특징까지 바뀔 수 있으므로 낮은 강도부터 적용한다.

### Upscale

이미지 크기와 선명도를 높이는 기능이다. 캐릭터와 장면 수정이 모두 끝난 뒤 마지막 단계에서 사용하는 것이 좋다.

### Canvas

이미지 위에 직접 그림을 추가하거나 지우고, 구도를 확장하거나 수정하는 편집 공간이다. 손이나 소품을 러프하게 그려 넣은 뒤 Image2Image 또는 Inpaint로 자연스럽게 다듬는 작업에 유용하다.

- [NovelAI 이미지 생성 기본 문서](https://docs.novelai.net/en/image/basics/)
- [NovelAI Canvas 문서](https://docs.novelai.net/en/image/editimagecanvas/)

## 추천 제작 워크플로

### A. 미연시 표정 차분

1. V4.5로 중립 표정의 기본 스탠딩 이미지를 만든다.
2. 마음에 드는 이미지를 수정하지 않은 원본으로 보관한다.
3. Emotion으로 웃음, 슬픔, 분노 등 표정 차분을 만든다.
4. 몸이나 옷이 변했거나 완전한 고정이 필요하면 얼굴만 Inpaint한다.
5. 모든 수정이 끝난 차분을 마지막에 Upscale한다.

### B. 같은 캐릭터의 다른 상황·이벤트 CG

1. 정면, 측면, 후면, 얼굴 확대가 포함된 캐릭터 설정화를 만든다.
2. 설정화를 Precise Reference의 Character Reference로 등록한다.
3. 장면마다 포즈, 장소, 표정만 프롬프트에서 변경한다.
4. 머리색, 눈색, 헤어스타일, 핵심 액세서리 등 고정 특징은 매번 반복한다.
5. 얼굴이 달라지면 Fidelity를 올리고, 포즈가 원본에 묶이면 Strength를 내린다.
6. 마지막에 남은 눈, 손, 표정 오류만 Inpaint로 수정한다.

## 추천 프롬프트 구조

캐릭터의 고정 요소와 장면별 가변 요소를 분리해 관리한다.

```text
[고정 캐릭터]
1girl, solo,
short black hair, blunt bangs,
grey eyes, mole under left eye,
slender, pale skin,
black office suit, white blouse,
silver rectangular earrings

[변경할 장면]
sitting at an office desk,
holding a coffee cup,
tired expression,
night, computer monitor light,
upper body, three-quarter view
```

표정만 바꿀 때는 고정 캐릭터 부분을 그대로 유지하고 표정 태그만 교체한다.

```text
gentle smile, closed mouth
```

```text
annoyed, furrowed brows, looking away
```

```text
embarrassed, slight blush, nervous smile
```

## 핵심 조합

- **다른 포즈·장면에서 동일 캐릭터 유지:** V4.5 + Character Reference + 고정 캐릭터 태그
- **같은 구도의 표정 차분:** Emotion 또는 얼굴 Inpaint
- **최종 부분 오류 수정:** Inpaint
- **마지막 해상도 개선:** Upscale

> 기능 제공 범위, 모델 제한, Anlas 비용은 NovelAI 업데이트에 따라 달라질 수 있으므로 실제 작업 전 공식 문서를 확인한다.
