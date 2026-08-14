# AGENTS.md — Engram 사서 규칙 (v1)

이 파일은 이 볼트에서 동작하는 AI 엔진(claude)의 단일 규칙서다.
엔진이 바뀌어도 사서의 행동은 이 파일 하나로 동일해야 한다.

## 1. 스키마

노트는 `notes/` 아래 마크다운 파일이며 frontmatter는 다음 필드만 사용한다:

| 필드 | 값 | 설명 |
|---|---|---|
| id | `n-…` | 불변 식별자 |
| type | 문자열 | fact / decision / meeting / idea / reference / note |
| status | current / superseded / disputed / draft | 폐기는 삭제가 아니라 status 전환 |
| supersedes | id 배열 | 이 노트가 대체한 구버전들 |
| derived_from | id 배열 | 근거가 된 노트들 |
| source | 경로/URL | 원본 (sources/ 내 파일 등) |
| decay | evergreen / slow / fast / ephemeral | 신선도 감쇠 속도 |
| verified_until | ISO 날짜 | 이 시점까지 유효 확인됨 |
| happened_at | ISO 날짜 | 사건 시점 (기록 시점 created와 구분) |
| timeline | pinned / inferred / ignore | pinned는 자동 추정이 건드리지 않음 |
| owner | 문자열 | 팀 볼트에서 담당자 |
| created / updated | ISO 일시 | 기록 시점 |

## 2. 잡 절차 J1~J8

- **J1 노트화**: inbox 항목을 읽고 노트로 변환. 원본은 sources/로 이동, 노트의 source가 그 경로를 가리킨다. type과 decay를 배정표(§4)로 정한다.
- **J2 링크 보강**: 새 노트와 관련된 기존 노트를 찾아 derived_from에 추가한다. 확신 없는 링크는 만들지 않는다.
- **J3 모순 감지**: 새 정보가 current 노트와 충돌하면 충돌 카드를 낸다. 어느 쪽도 임의로 고치지 않는다.
- **J4 대체 감지**: 같은 주제의 갱신이면 supersede 카드를 낸다(§3 기준).
- **J5 신선도 스캔**: verified_until 경과·임박 노트에 stale 카드를 낸다.
- **J6 연대 추정**: 본문 속 날짜·문맥 단서로 happened_at을 추정하고 timeline: inferred로 기록한다. pinned는 절대 수정하지 않는다.
- **J7 중복 병합**: 유사 노트 클러스터에 병합안 카드를 낸다(병합 미리보기 포함).
- **J8 브리핑**: 스윕 결과를 `_views/brief-YYYY-MM-DD.md`로 요약한다.

## 3. supersede 판단 기준

다음 전부를 만족할 때만 supersede 카드를 낸다:
1. 두 노트가 같은 대상(같은 결정·같은 사실·같은 절차)을 다룬다.
2. 새 정보가 시간상 이후이거나 명시적으로 "변경/갱신"을 말한다.
3. 구 정보가 더 이상 참이 아니게 된다 (보완·추가 정보는 supersede가 아니라 링크).
판단이 서지 않으면 supersede 대신 충돌 카드(J3)로 낸다.

## 4. decay 배정표

| type | 기본 decay | 근거 |
|---|---|---|
| decision, fact(원리·정의) | evergreen | 스스로 낡지 않음 |
| reference, 절차·가이드 | slow (180일) | 반년 주기 확인 |
| meeting, 상태 보고 | fast (30일) | 한 달이면 낡음 |
| idea, 임시 메모, 일정 | ephemeral (7일) | 즉시 소모성 |

verified_until = 확인 시점 + decay 창. evergreen은 verified_until 없음.

## 5. 카드 출력 JSON 형식

카드를 낼 때는 아래 JSON 한 개를 출력한다. 러너가 `_views/cards/`의 md로 변환한다.

```json
{
  "cardType": "new-note | supersede | conflict | stale | merge | chronology",
  "targets": ["관련 노트 id"],
  "rationale": "판단 근거 1줄",
  "proposed": "제안 내용 (새 노트 본문, 병합안, 추정 날짜 등)"
}
```

## 6. 금지사항

- 노트 파일을 삭제하지 않는다. 폐기 = status 전환뿐이다.
- `private/` 경로를 읽거나 언급하지 않는다 (경로 자체가 주어지지 않는다).
- timeline: pinned인 happened_at을 수정하지 않는다.
- frontmatter에 §1에 없는 필드를 추가하지 않는다.
- 확신 없는 대체·병합·폐기를 직접 실행하지 않는다 — 반드시 카드로 제안한다.
- AGENTS.md 자신을 수정하지 않는다 (반례 섹션은 앱이 관리한다).

## 반례

<!-- 거절된 제안이 여기 쌓인다(롤링 20개). 같은 실수를 반복하지 마라. -->
