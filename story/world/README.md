# 회사 월드 바이블

`story/world/`는 회사·조직·직무·팀원·프로젝트·회의 구성의 기계 판독용 소스 오브 트루스다. `docs/`의 설명과 장면 대사보다 이 디렉터리의 ID·소속·보고 관계·권한을 우선한다.

## 엔티티 모델

- `company.*`: 사업 영역, 규모, 운영 사실과 작성 제약
- `role.*`: 직급별 랭크, 인원 관리·승인·프로젝트 리드 권한
- `team.*`: 팀 기능, 팀장과 멤버 목록
- `member.*`: 소속 팀, 직급, 직속 상사, 고용 형태, 표현 방식과 업무 책임
- `project.*`: 참여 팀, 스폰서, 실무 리드, 산출물, 프로젝트 책임 배정
- `meeting.*`: 참석자 수, 필수 팀·책임과 비일러스트 참석자 최소치

모든 파일은 하나의 엔티티만 정의한다. 스키마는 `story/schema/world.schema.json`, 장면이 쓰는 제한된 참조 형식은 `story/schema/world-context.schema.json`이다.

## 비주얼 캐릭터와 비일러스트 팀원

`presentation: illustrated`인 멤버는 `story_character`를 통해 `story/characters/`의 인물 하나와 연결된다. `presentation: text_only`인 멤버는 대사와 업무 행동은 가질 수 있지만 일러스트 캐스트에 넣지 않는다.

- 장면 `cast`: 일러스트를 표시할 `story_character` ID만 적는다.
- `world_context.participants`: 실제로 그 자리에 있는 모든 `member.*` ID를 적는다.
- 비일러스트 팀원을 대사 화자로 쓸 때는 런타임이 텍스트 전용 화자를 지원하는지 확인한다. 지원하지 않는 단계에서는 그의 발언을 서술로 바꾸되 참석 사실은 지우지 않는다.

`route_eligible: true`는 `illustrated` 멤버이며 연결된 스토리 캐릭터가 `main_heroine`일 때만 허용한다. 라우트의 `heroine`은 반드시 그 조건을 만족하는 멤버와 연결돼야 한다.

## 장면 연결

다부서 킥오프처럼 직무·권한을 검증해야 하는 회의는 장면에 다음을 선언한다.

```yaml
world_context:
  company: company.dawon_living
  project: project.harudam_spring_campaign
  interaction: meeting.cross_function_kickoff
  participants:
    - member.han_do_yoon
    - member.yoon_seo_a
    - member.cha_min_kyung
    - member.kang_yoo_jin
    - member.oh_se_jin
    - member.jeong_da_eun
    - member.moon_ji_hye
```

하네스는 다음을 오류로 처리한다.

- 알 수 없는 회사·팀·직급·멤버·프로젝트·회의 ID
- 팀 목록과 멤버의 소속 팀이 어긋남
- 팀장이 해당 팀에 소속하지 않거나 관리 권한이 없음
- 직속 상사가 낮은 직급이거나 보고 관계가 순환함
- 프로젝트 참여 팀과 책임 배정이 어긋남
- 비일러스트 멤버를 장면 `cast`나 공략 라우트에 사용함
- 회의 최소·최대 인원, 필수 팀, 필수 책임, 비일러스트 참석자 최소치를 만족하지 못함
- 회의 참석자가 해당 프로젝트에 배정되지 않음

## 제1일 킥오프 권장 구성

| 참석자 | 프로젝트 책임 | 표현 |
|---|---|---|
| 차민경 | 실무 리드·마스터 일정 | 일러스트 |
| 한도윤 | 거래처 승인·상업 조건 | 일러스트 |
| 오세진 | 상품 요건 승인 | 텍스트 전용 |
| 윤서아 | 상품 자료·회의록 | 일러스트 |
| 정다은 | 캠페인 일정 표 | 텍스트 전용 |
| 문지혜 | 최종 시안 승인 | 텍스트 전용 |
| 강유진 | 디자인 생산·버전 관리 | 일러스트 |

이 구성은 영업·상품·마케팅·디자인 영역과 승인자를 모두 포함하며, 공략 인물만 있는 어색한 회의를 방지한다.
