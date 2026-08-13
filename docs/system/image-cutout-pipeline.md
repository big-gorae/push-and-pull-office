# 캐릭터 원화 비파괴 누끼 파이프라인

## 목적

기본 원화와 SD 오리지널의 회색·백색·베이지색 배경만 제거한다. 캐릭터를 다시 생성하거나 원본 파일을 덮어쓰지 않는다. 출력은 원본과 같은 832×1216 PNG 캔버스를 유지하므로 기존 무대 배치 좌표가 변하지 않는다.

## 원본 보존 계약

- `art-source/archive/characters/*/office-default/base-with-background.png`와 `art-source/references/characters/*/sd.png`는 읽기 전용 원본이다.
- `art-source/cutout-config.json`의 SHA-256과 원본의 현재 해시가 다르면 생성 작업을 즉시 중단한다.
- 원본은 삭제·이동·덮어쓰지 않는다.
- `preserve-rgb` 결과는 원본의 모든 RGB 픽셀을 그대로 유지하고 알파 채널만 바꾼다.
- 게임용 결과도 완전 불투명한 전경 픽셀의 RGB를 원본과 동일하게 유지한다. 반투명 경계에서만 배경색 번짐을 제거한다.

## 명령

```bash
npm run art:cutout
npm run art:cutout:verify
```

`art:cutout`은 설정에 등록된 6장을 재생성한다. `art:cutout:verify`는 다음을 검사한다.

- 원본 SHA-256 불변
- 원본·결과·마스크의 크기 일치
- 런타임 PNG의 알파 채널
- `preserve-rgb`와 원본의 RGB 전수 비교
- 런타임의 불투명 전경과 원본 RGB 전수 비교
- SD 흰 종이 테두리의 지정 좌표 보존
- 머리카락 내부 배경 지정 좌표의 완전 투명 여부
- 투명 배경과 전경 경계 존재

전체 `npm run verify`에도 누끼 검증이 포함된다.

## 출력 구조

```text
art-source/derived/characters/<character>/.../*-cutout-preserve-rgb.png
art-source/masks/characters/<character>/.../*-alpha.png
art-source/archive/characters/<character>/office-default/base-with-background.png
assets/characters/<character>/office-default/base-cutout.png
assets/characters/<character>/sd/original-cutout.png
output/cutout-qa/<asset-id>.png
```

`art-source/archive/characters`는 배경이 포함된 원본, `art-source/derived`와 `art-source/masks`는 복구·재생성용이다. `assets/characters`의 `*-cutout.png`만 에디터와 게임에서 사용한다. `output/cutout-qa`에는 원본, 체크무늬, 흰색, 검은색, 자홍색, 초록색 배경 합성판이 생성된다.

## 분리 방식

전체 이미지에서 특정 회색이나 흰색을 지우지 않는다. 좌우 캔버스 가장자리에서 배경색 모델을 만들고, 가장자리와 연결된 영역만 배경으로 분류한다. 이 방식은 흰 셔츠, 회색 바지, 피부, 눈의 흰자와 SD의 흰 종이 테두리를 보호한다.

캐릭터가 캔버스 하단까지 이어지므로 하단 픽셀은 배경색 학습에 사용하지 않는다. 느린 그라데이션은 인접 픽셀 변화량으로 추적하고, 선화나 종이 테두리처럼 색 변화가 큰 경계에서는 추적을 멈춘다.

머리카락에 완전히 둘러싸여 가장자리 flood-fill이 닿지 않는 배경은 캐릭터별 `backgroundSeeds`로 분리한다. 배경 그라데이션이 기본 허용치를 벗어난 곳만 `force: true`를 사용하며, 지정점과 비슷한 색이 연결된 영역에서만 확장한다. 기본 원화에는 넓은 페더 탐색과 확정 배경 알파 잠금을 적용해 회색 매트 프린지를 제거하고, SD의 흰 종이 테두리에는 이 설정을 적용하지 않는다.

## 수동 검수

자동 검증 후 `output/cutout-qa`의 모든 합성판을 확인한다.

- 머리카락 끝과 잔머리가 잘리지 않았는가
- 손가락, 수첩, 태블릿 주변에 배경 조각이 남지 않았는가
- 검은 배경에서 회색 후광이 보이지 않는가
- 흰 배경에서 흰 셔츠나 피부 경계가 사라지지 않는가
- SD 흰 종이 테두리가 전 방향에서 유지되는가

검수에 실패하면 원본을 편집하지 않고 `cutout-config.json`의 해당 이미지 허용치만 조정한 뒤 다시 생성한다.
