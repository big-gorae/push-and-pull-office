# 구현된 스토리 기준선

> 박제 기준일: 2026-08-01

이 문서는 현재 게임 데이터와 웹 플레이어에서 실제로 실행되는 스토리 범위만 기록한다. 이 기준선 이후 `docs/`에만 적힌 아이디어는 `story/` YAML과 런타임에 연결되기 전까지 구현된 스토리로 취급하지 않는다.

## 기준

- 구조화 원본: `story/`
- 게임 입력물: `build/story-runtime.json`
- 현재 규모: 캠페인 1개, 이벤트 24개, 루트 2개, 플레이 장면 10개
- `scene`이 연결된 이벤트만 대사·선택지·상태 변화가 있는 완전한 플레이 장면이다.
- `scene`이 없는 시간 이벤트는 해당 시간대에 제목과 요약만 표시된다.
- 문서에만 존재하고 이벤트·장면 YAML이 없는 사건은 이 기준선에 포함하지 않는다.

## 대사와 선택지까지 구현된 일반 장면

### 공용 1일차

1. `common.day_01_company_meeting` — 1일차 오전, 프로젝트 킥오프와 네 사람의 첫인상
2. `common.day_01_parent_pressure` — 1일차 퇴근 후, 부모의 결혼 재촉과 한도윤의 후보 재분류

두 장면은 선택지와 수치 변화 없이 자동 진행된다. 아직 공략 상대를 정하지 않은 1일차에 기존 밀당 선택지를 억지로 노출하지 않기 위한 의도다.

### 윤서아

1. `seo_a.email_request` — 7~8일차 점심, 메일로 보내 주세요
2. `seo_a.relief_smile` — 9~10일차 오전, 다시 웃었다

### 차민경

1. `min_kyung.explicit_boundary` — 7~8일차 퇴근 후, 업무 외 연락 금지
2. `min_kyung.witness_meeting` — 9~10일차 오후, 둘만 남지 않는 회의

## 대사와 선택지까지 구현된 엔딩 장면

### 윤서아

1. `ending.seo_a.report` — 신고와 정식 처리
2. `ending.seo_a.ambiguous` — 증거가 부족한 파국 분기

### 차민경

1. `ending.min_kyung.report` — 신고와 정식 처리
2. `ending.min_kyung.coverup` — 증거가 부족한 파국 분기

## 시간표에 구현된 요약 사건

다음 사건은 날짜 진행과 주인공 인식·실제 요약은 구현되어 있지만, 연결된 대사 장면은 없다.

1. `anchor.day_02_practical_meeting` — 첫 실무 회의와 서아의 실제 감사
2. `anchor.day_02_project_dinner` — 프로젝트 회식
3. `anchor.day_03_business_trip_or_cafe` — 출장 또는 단둘의 점심
4. `anchor.day_04_weekend_encounter` — 토요일 첫 번째 주말 조우
5. `anchor.day_05_weekend_reflection` — 일요일 두 번째 주말 조우
6. `anchor.day_10_hr_notice` — 인사팀 상담 절차 안내
7. `anchor.day_13_secret_romance` — 비밀 사내연애라는 오해
8. `anchor.day_14_triangle` — 삼각관계라는 오해
9. `anchor.day_15_closing_meeting` — 마지막으로 따뜻한 날
10. `anchor.day_16_office_rumor` — 회사에 퍼진 이야기
11. `anchor.day_17_home_surprise` — 주거지 방문 결심

## 구현된 숨은 실제 사건

다음 사건은 조건을 만족하거나 선행 사건을 놓치면 시간선에서 자동 처리된다. 스토리 모드에서는 숨겨지고 원문 모드에서 확인할 수 있다.

1. `offscreen.seo_a_consults_min_kyung` — 9일차, 서아가 민경에게 상황을 설명
2. `offscreen.witnesses_compare_notes` — 10일차, 서아와 민경이 기록을 대조
3. `offscreen.past_case_date_mismatch` — 12일차, 유진이 과거 사건 날짜 불일치를 확인

## 구현된 엔딩 시간 이벤트

1. `seo_a.ending_report`
2. `seo_a.ending_ambiguous`
3. `min_kyung.ending_report`
4. `min_kyung.ending_coverup`

각 이벤트는 위의 엔딩 장면 하나에 연결된다.

## 현재 박제된 1주차 해석

- 1일차 저녁에 부모의 결혼 재촉이 발생한다.
- 1일차 오전 회의와 퇴근길 가족 전화는 대사 장면으로 직접 플레이된다.
- 오전 회의 종료 시점에는 한도윤도 누구를 공략할지 정하지 않는다.
- 가족 전화 뒤 서아와 민경을 결혼 후보로 재분류하지만, 두 사람이 자신에게 관심 있다고 단정하지 않는다.
- `과장님이 계셔서 다행이었어요`는 서아의 실제 감사와 인간적 호감이다.
- 토요일과 일요일에는 서아와 민경을 한 명씩 교차해 만난다.
- 두 사람은 1주차 주말 조우를 의도적 접근으로 의심하지 않는다.
- 한도윤도 주말에 마주쳤다는 이유만으로 두 사람이 자신에게 관심 있다고 확신하지 않는다.
- 6일차의 출발 감정은 두 사람의 회사 밖 모습을 조금 더 알아보고 싶다는 가벼운 기대다.

## 기준선 밖

- 날짜별 상세 대사나 선택지가 없는 2주차 신규 사건
- 두 번째 주말의 구체적인 장소·대화·선택지
- 생존 모드의 실제 캠페인·장면·플레이어 캐릭터
- B/C 고유 베일 효과의 최종 선택과 실제 렌더링
- 문서에만 적힌 추가 사건과 미확정 설정

이 항목들은 기존 구현을 설명하는 자료가 아니라 후속 제작 범위다.
