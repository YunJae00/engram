// The golden retrieval set: a realistic mixed Korean/English personal vault
// with stable note ids, plus queries whose correct answers are known. The
// eval runner (eval-retrieval.mts) builds this vault and scores every layer
// of the retrieval stack against EXPECTED ids, so a constant change shows up
// as a number, not a feeling.
//
// Design rules, so additions keep the set honest:
// - Query wording must NOT quote the note verbatim unless category is
//   'exact' — paraphrase/crosslingual queries are the point of the set.
// - Every cluster ships distractors: notes near in topic but wrong as an
//   answer. A retriever that "just returns the cluster" must lose points.
// - '2hop' queries name note A; the expected note B is only reachable via
//   the derived_from link fabric (spreading activation), not by wording.

export interface GoldenNote {
  id: string
  date: string
  type?: string
  decay?: 'evergreen' | 'slow' | 'fast' | 'ephemeral'
  derived_from?: string[]
  body: string
}

export type QueryCategory = 'exact' | 'paraphrase' | 'crosslingual' | 'distractor' | '2hop' | 'synthesis'

export interface GoldenQuery {
  q: string
  category: QueryCategory
  // Any of these counts as a hit for hit@k / MRR.
  expected: string[]
  // For 'synthesis': how many of `expected` must appear in top-8 to pass.
  needInTop8?: number
}

export const GOLDEN_NOTES: GoldenNote[] = [
  // ── RAG / 검색 클러스터 (개발) ──
  {
    id: 'g-rag-chunk',
    date: '2026-06-20T10:00:00Z',
    body: `# 청킹 전략 실험 결과\n\n문단 기반 512토큰 청크 + 오버랩 15%가 우리 기술문서 코퍼스에서 가장 안정적이었다. 고정 256토큰은 표/코드블록이 잘려서 리콜이 떨어지고, 1024는 관련 없는 문단이 섞여 정밀도가 나빠짐. 실험은 골든 질문 30개 기준.`,
  },
  {
    id: 'g-rag-bge',
    date: '2026-06-22T09:00:00Z',
    type: 'decision',
    body: `# 임베딩 모델: bge-m3 채택\n\n한국어 기술문서 검색에서 bge-m3가 text-embedding-3-small보다 recall@5 기준 12%p 높았다. 다국어 문서 혼재 환경에서 특히 격차가 큼. 로컬 서빙이라 비용도 없음. 단점: 인덱싱이 느리다.`,
  },
  {
    id: 'g-rag-topn',
    date: '2026-06-25T14:00:00Z',
    type: 'decision',
    body: `# 검색 topN 하드코딩 버그 수정\n\n다수 문서 업로드 시 일부 문서만 반복 인식되던 문제의 근본 원인: rag-search.tool.ts의 search()가 topN=4 하드코딩 — 문서가 18개여도 청크 4개만 반환됐다. 문서 수에 비례하는 동적 topN으로 수정 완료.`,
  },
  {
    id: 'g-rag-rerank',
    date: '2026-06-28T11:00:00Z',
    derived_from: ['g-rag-bge'],
    body: `# 리랭커 도입 검토\n\ncross-encoder 리랭킹(bge-reranker)을 상위 20 후보에 걸면 최종 상위 5의 정확도가 눈에 띄게 좋아진다. 대신 질의당 지연 +80ms. 대화형 검색에는 허용 범위라고 판단. 배치 인덱싱 쪽에는 불필요.`,
  },
  {
    id: 'g-rag-harness',
    date: '2026-07-01T16:00:00Z',
    derived_from: ['g-rag-chunk'],
    body: `# RAG 평가 하네스\n\n골든 질문 30개로 recall@5를 상시 측정하는 하네스를 만들었다. 청킹/임베딩/리랭커 변경마다 회귀 확인용. 현재 기준선 recall@5 = 0.74. 질문 세트는 실제 사용자 질의 로그에서 추출.`,
  },
  {
    id: 'g-rag-incident',
    date: '2026-06-30T15:00:00Z',
    type: 'log',
    derived_from: ['g-rag-topn'],
    body: `# 검색 장애 회고\n\n사용자가 18개 문서를 올렸는데 검색이 같은 4개 문서만 계속 참조한다고 리포트. 원인 추적 결과 topN 고정이 문제였고, 임베딩 유사도가 동일 양식 문서에 몰리는 현상도 확인. 수정 후 전 문서가 고르게 검색됨.`,
  },
  {
    id: 'g-rag-embed-limit',
    date: '2026-06-29T10:00:00Z',
    type: 'decision',
    body: `# 워크스페이스 임베딩 100MB 제한 해제\n\n단일 파일 100MB 제한을 600MB로 상향. 스트리밍 파싱/청킹으로 대용량 파일도 RAG 임베딩 가능하게 함. 기존 제한은 파일 전체를 메모리에 적재해 OOM이 나기 때문에 둔 안전장치였음.`,
  },

  // ── 배포 정책 (supersede 체인) ──
  {
    id: 'g-deploy-fri',
    date: '2026-06-10T10:00:00Z',
    type: 'decision',
    body: `# 배포 정책: 금요일 배포 금지\n\n금요일에는 프로덕션 배포를 하지 않는다. 주말에 장애 대응 인력이 없어서 금요일 오후 배포는 리스크가 크다. 예외는 보안 핫픽스뿐.`,
  },
  {
    id: 'g-deploy-fri-am',
    date: '2026-07-05T09:30:00Z',
    type: 'decision',
    derived_from: ['g-deploy-fri'],
    body: `# 배포 정책 갱신: 금요일 오전 배포 허용\n\n카나리 배포 + 자동 롤백이 도입돼서 금요일 오전(11시 이전) 배포는 허용하기로 했다. 금요일 오후는 여전히 금지. 자동 롤백이 15분 안에 완료되는 걸 두 번 확인했음.`,
  },
  {
    id: 'g-deploy-canary',
    date: '2026-07-03T14:00:00Z',
    derived_from: ['g-deploy-fri-am'],
    body: `# 카나리 배포 세팅\n\n신규 버전을 트래픽 5%에 10분 → 25%에 10분 → 100% 순서로 올린다. 에러율이 기준선 대비 2배를 넘으면 자동 롤백. 롤백 소요는 평균 12분, 최대 15분 관측.`,
  },

  // ── API rate limit (supersede 체인) ──
  {
    id: 'g-api-60',
    date: '2026-06-05T10:00:00Z',
    decay: 'fast',
    body: `# 외부 API rate limit\n\n파트너 API rate limit은 분당 60 요청. 초과하면 429 + 60초 백오프. 배치 작업은 분당 50으로 스로틀링해서 돌릴 것.`,
  },
  {
    id: 'g-api-600',
    date: '2026-07-08T13:00:00Z',
    derived_from: ['g-api-60'],
    body: `# 파트너 API rate limit 상향\n\n파트너사가 우리 플랜의 rate limit을 분당 600으로 상향해줬다 (7월 계약 갱신). 배치 스로틀 상수 업데이트 필요. 429 백오프 로직은 그대로 두는 게 안전.`,
  },

  // ── 스탠드업 (중복 3형제) ──
  {
    id: 'g-standup-1',
    date: '2026-06-12T09:30:00Z',
    body: `# 스탠드업 15분 원칙\n\n데일리 스탠드업은 15분 타임박스를 지킨다. 논의가 길어지면 당사자만 남아서 별도 콜로 뺀다. 전원 참석 시간은 15분이 상한.`,
  },
  {
    id: 'g-standup-2',
    date: '2026-06-24T09:00:00Z',
    body: `# 아침 스탠드업은 짧게\n\n스탠드업이 자꾸 늘어진다. 15분 넘기지 않기로 다시 정리. 깊은 논의는 스탠드업 끝나고 관련자끼리 따로 잡는다.`,
  },
  {
    id: 'g-standup-3',
    date: '2026-07-06T09:15:00Z',
    body: `# 스탠드업 또 길어짐\n\n이번 주 스탠드업이 두 번이나 30분을 넘었다. 15분 컷 원칙 재합의 — 타이머를 켜고, 초과 주제는 주차장 목록으로 미룬다.`,
  },

  // ── 회의록 (중복 쌍) ──
  {
    id: 'g-meeting-1',
    date: '2026-06-15T09:00:00Z',
    body: `# 회의록 정리 원칙\n\n회의록은 회의 직후 24시간 안에 정리해야 정보 손실이 없다. 하루가 지나면 맥락과 뉘앙스를 절반은 잊는다. 정리 전에는 다른 작업을 시작하지 않는 걸 원칙으로.`,
  },
  {
    id: 'g-meeting-2',
    date: '2026-07-03T18:00:00Z',
    body: `# 미팅 노트는 당일에\n\n미팅 노트는 다음날이 되기 전에 정리하자. 하루 지나면 맥락을 다 까먹어서 노트가 반쪽짜리가 된다. 미팅 끝나고 바로 15분 확보하는 게 제일 확실하다.`,
  },

  // ── 영어 업무 노트 (crosslingual 표적) ──
  {
    id: 'g-en-pg-index',
    date: '2026-06-17T11:00:00Z',
    body: `# Postgres index tuning on orders table\n\nThe slow dashboard query was a seq scan on orders(created_at, status). Added a partial index on status='pending' plus BRIN on created_at — p95 went from 2.1s to 90ms. Lesson: check pg_stat_user_tables before guessing.`,
  },
  {
    id: 'g-en-react-perf',
    date: '2026-06-19T15:00:00Z',
    body: `# React list re-render fix\n\nThe activity feed re-rendered every row on each websocket tick. Wrapped rows in memo with a stable key and moved the timestamp formatter out of render. Frame time dropped from 40ms to 6ms on a 500-row feed.`,
  },
  {
    id: 'g-en-docker-cache',
    date: '2026-06-21T10:00:00Z',
    body: `# Docker build cache ordering\n\nCI builds took 9 minutes because COPY . . sat above npm install, busting the layer cache on every commit. Reordered so package.json is copied and installed first — builds are now 90 seconds warm.`,
  },
  {
    id: 'g-en-incident',
    date: '2026-06-27T20:00:00Z',
    type: 'log',
    body: `# Incident retro: queue backlog on June 27\n\nPayment webhooks queued for 40 minutes after a consumer deploy with a bad env var. Alert fired on queue depth but paged the wrong rotation. Actions: fix the paging route, add a canary consumer, alert on consumer lag not just depth.`,
  },
  {
    id: 'g-en-api-review',
    date: '2026-07-02T13:00:00Z',
    type: 'decision',
    body: `# API design review: cursor pagination\n\nWe standardized list endpoints on cursor pagination (opaque base64 cursor, no offset). Offset pagination on the orders table skipped rows under concurrent writes. Deadline: migrate the three legacy endpoints by end of July.`,
  },
  {
    id: 'g-en-onboarding',
    date: '2026-06-14T09:00:00Z',
    body: `# Engineering onboarding checklist\n\nNew hires: repo access day 1, first PR by day 3 (docs fix counts), production shadow on week 2, first on-call shadow week 4. Each new hire gets a buddy who owns unblocking them for the first month.`,
  },

  // ── 인프라 ──
  {
    id: 'g-infra-k8s',
    date: '2026-06-23T14:00:00Z',
    body: `# k8s 1.31 업그레이드 계획\n\n스테이징부터 순차 업그레이드. PodDisruptionBudget 재점검, deprecated API(flowcontrol v1beta3) 사용처 두 곳 수정 필요. 프로덕션은 트래픽 낮은 화요일 새벽으로.`,
  },
  {
    id: 'g-infra-monitor',
    date: '2026-06-26T11:00:00Z',
    body: `# 모니터링 알람 정리\n\n알람 42개 중 실제 액션으로 이어진 건 9개뿐. 나머지는 노이즈라 침묵 처리하거나 대시보드로 강등. 원칙: 알람은 "지금 사람이 일어나야 하는가"에만 발사.`,
  },
  {
    id: 'g-infra-backup',
    date: '2026-06-11T10:00:00Z',
    body: `# 백업 정책\n\nDB는 일 1회 풀백업 + 5분 간격 WAL 아카이브, 보존 30일. 복구 리허설을 분기 1회 실제로 돌린다 — 백업은 복구가 검증된 만큼만 존재한다.`,
  },
  {
    id: 'g-infra-secrets',
    date: '2026-06-13T15:00:00Z',
    body: `# 시크릿 로테이션 정책\n\nAPI 키와 DB 크리덴셜은 90일 주기로 로테이션. 로테이션은 Vault 동적 시크릿으로 자동화, 사람 손으로 도는 키는 목록화해서 분기 점검. 유출 시 즉시 폐기 절차 문서화 완료.`,
  },

  // ── 팀/HR ──
  {
    id: 'g-team-rubric',
    date: '2026-06-16T14:00:00Z',
    body: `# 채용 면접 루브릭\n\n코딩 인터뷰는 정답 여부보다 문제 분해·소통·트레이드오프 설명을 본다. 4개 축(문제해결/코드품질/소통/협업) 각 1-4점, 종합 3.0 미만은 불합. 면접관 2인 독립 채점 후 조율.`,
  },
  {
    id: 'g-team-buddy',
    date: '2026-06-18T10:00:00Z',
    derived_from: ['g-en-onboarding'],
    body: `# 온보딩 버디 제도 시작\n\n신규 입사자마다 버디 1명을 붙인다. 버디는 첫 달 동안 질문 창구이자 블로커 제거 담당. 버디 업무는 스프린트 캐파의 20%로 인정해준다.`,
  },
  {
    id: 'g-team-1on1',
    date: '2026-07-04T16:00:00Z',
    body: `# 1on1 진행 방식\n\n격주 30분, 아젠다는 팀원이 먼저 채운다. 상태 보고 금지 — 성장/막힌 것/피드백만. 액션 아이템은 다음 1on1 시작 때 확인.`,
  },

  // ── 건강 ──
  {
    id: 'g-health-shoulder',
    date: '2026-06-18T08:00:00Z',
    body: `# 어깨 재활 루틴\n\n밴드 외회전 15회 3세트, 페이스풀 12회 3세트, 벽 슬라이드 10회. 통증 없는 범위에서만. 주 4회, 아침에.`,
  },
  {
    id: 'g-health-run',
    date: '2026-06-29T07:00:00Z',
    body: `# 10km 대회 준비 계획\n\n9월 대회까지 주 3회: 인터벌 1회(400m x 8), 템포런 1회(5km), 롱런 1회(주말, 매주 1km씩 증량). 목표 기록 55분. 무릎 통증 있으면 그 주는 롱런 스킵.`,
  },
  {
    id: 'g-health-sleep',
    date: '2026-06-24T22:00:00Z',
    body: `# 수면 루틴 재정비\n\n자정 전 취침, 기상 7시 고정. 침대에서 폰 금지, 22시 이후 카페인 금지. 2주 해보니 낮 졸림이 확실히 줄었다. 주말 늦잠은 1시간까지만.`,
  },
  {
    id: 'g-health-derm',
    date: '2026-07-07T18:00:00Z',
    decay: 'fast',
    body: `# 피부과 처방 메모\n\n트레티노인 0.025% 격일 밤, 보습 먼저 바르고 그 위에. 낮에는 선크림 필수. 4주차부터 각질 줄어드는 게 보인다고 함. 다음 진료 8월 20일.`,
  },

  // ── 요리 ──
  {
    id: 'g-cook-kimchi',
    date: '2026-06-26T19:00:00Z',
    body: `# 김치찌개\n\n신김치 반 포기, 돼지목살 300g, 쌀뜨물 500ml. 목살 먼저 볶다가 김치 넣고 5분, 쌀뜨물 붓고 20분. 두부는 마지막 5분.`,
  },
  {
    id: 'g-cook-pasta',
    date: '2026-07-01T20:00:00Z',
    body: `# 알리오 올리오 비율\n\n1인분: 면 100g, 마늘 6쪽, 올리브유 3큰술, 페페론치노 2개. 면수 반 국자로 유화가 핵심 — 불 끄고 섞으면 안 갈라진다. 소금은 면수에만.`,
  },
  {
    id: 'g-cook-curry',
    date: '2026-06-22T19:30:00Z',
    body: `# 일본식 카레 개선\n\n양파 2개를 30분 캐러멜라이즈하는 게 맛의 8할. 고형 루 반 + 카레가루 반으로 하면 텁텁함이 줄어든다. 마지막에 우스터소스 1큰술.`,
  },

  // ── 독서 ──
  {
    id: 'g-read-brain',
    date: '2026-07-02T21:00:00Z',
    body: `# 독서: 프로그래머의 뇌\n\n작업 기억은 한 번에 4~6개 항목만 다룬다. 코드 읽기가 힘든 건 지능이 아니라 청크 부족 문제 — 패턴을 외우면 청크가 커진다. 리팩토링은 읽는 사람의 작업 기억 부담을 줄이는 행위.`,
  },
  {
    id: 'g-read-habits',
    date: '2026-06-20T21:00:00Z',
    body: `# 독서: 아주 작은 습관의 힘\n\n습관은 정체성에서 나온다 — "달리는 사람"이 되면 달리기가 유지된다. 2분 규칙: 새 습관은 2분 버전으로 시작. 환경 설계가 의지력보다 세다.`,
  },
  {
    id: 'g-read-scifi',
    date: '2026-06-28T22:00:00Z',
    body: `# 독서: 프로젝트 헤일메리\n\n과학적 문제 해결의 연속이 플롯 그 자체인 소설. 로키 챕터부터 급가속. 아마추어 과학자 주인공이 실험-가설-검증 루프를 도는 구조가 일하는 방식이랑 닮았다.`,
  },

  // ── 재정 ──
  {
    id: 'g-fin-tax',
    date: '2026-06-30T12:00:00Z',
    body: `# 연말정산 대비 정리\n\n연금저축 세액공제 한도 600만원 중 400 납입 — 연말까지 200 추가 납입 예정. 월세 세액공제 서류(계약서, 이체내역) 미리 스캔. 의료비는 총급여 3% 초과분부터라 올해는 해당 없음.`,
  },
  {
    id: 'g-fin-isa',
    date: '2026-06-19T12:00:00Z',
    type: 'decision',
    body: `# ISA 계좌 개설\n\n중개형 ISA로 개설, 연 2000만원 한도. 3년 유지 시 수익 200만원까지 비과세라 배당 ETF는 전부 ISA로 이전. 만기 후 연금저축 전환도 고려.`,
  },
  {
    id: 'g-fin-loan',
    date: '2026-07-06T11:00:00Z',
    decay: 'fast',
    body: `# 주담대 금리 비교\n\nA은행 4.1% 변동 vs B은행 4.5% 5년 고정. 금리 인하기라 변동 쪽으로 기울지만, 월 상환액 차이가 9만원이라 고정의 심리적 안정도 무시 못 함. 8월 중 결정.`,
  },

  // ── 여행 ──
  {
    id: 'g-trip-osaka',
    date: '2026-07-05T19:00:00Z',
    body: `# 오사카 여행 계획 (10월)\n\n10/9-12 3박. 항공권은 8월 초 특가 노리기. 숙소는 난바 근처, 1일차 도톤보리, 2일차 교토 당일치기, 3일차 유니버설. 교통은 이코카 + 하루카 왕복권.`,
  },
  {
    id: 'g-trip-jeju',
    date: '2026-06-16T20:00:00Z',
    type: 'log',
    body: `# 제주 회고\n\n렌터카 대신 버스+택시가 오히려 편했다. 동쪽(세화-종달) 이틀이 제일 좋았고 서쪽은 하루면 충분. 다음엔 우도에서 1박 하기. 흑돼지는 시내보다 중문 쪽이 나았다.`,
  },
  {
    id: 'g-trip-flight',
    date: '2026-06-21T13:00:00Z',
    body: `# 항공권 구매 원칙\n\n국제선은 출발 8~10주 전이 대체로 저점. 화·수 출발이 금·일보다 15% 싸다. 가격 알림 걸어두고 두 번 떨어지면 산다 — 바닥 잡으려다 세 번 놓쳤다.`,
  },

  // ── 기타 distractors ──
  {
    id: 'g-misc-move',
    date: '2026-06-25T18:00:00Z',
    body: `# 이사 체크리스트\n\n전입신고+확정일자 당일, 인터넷 이전 일주일 전 예약, 도시가스 전출·전입 각각 전화. 관리비 정산서 꼭 받기. 짐 싸기는 안 쓰는 방부터.`,
  },
  {
    id: 'g-misc-car',
    date: '2026-06-27T10:00:00Z',
    decay: 'fast',
    body: `# 자동차 정기점검\n\n엔진오일 다음 교체 68,000km(현재 63,200). 타이어 앞쪽 마모 경고 — 다음 점검 때 위치 교환. 와이퍼 소음은 교체로 해결.`,
  },
  {
    id: 'g-misc-dog',
    date: '2026-07-03T11:00:00Z',
    decay: 'fast',
    body: `# 강아지 병원 기록\n\n심장사상충 약 7/3 투여 (매월 3일 고정). 슬개골 2기 진단 — 계단 오르내리기 줄이고 체중 4.2→3.8kg 감량 목표. 다음 검진 10월.`,
  },
  {
    id: 'g-misc-concert',
    date: '2026-06-23T21:00:00Z',
    decay: 'ephemeral',
    body: `# 콘서트 예매 메모\n\n9/14 공연 티켓팅 8/1 20:00. 인터파크 선예매는 카드 필요. 작년엔 30초 만에 매진 — 대기열 두 기기로 잡는다.`,
  },
  {
    id: 'g-misc-keyboard',
    date: '2026-06-14T16:00:00Z',
    body: `# 키보드 구매 결정\n\n저소음 적축으로 결정. 사무실용이라 소음이 1순위, 갈축은 탈락. 풀배열 대신 텐키리스 — 마우스 동선이 짧아진다.`,
  },
]

export const GOLDEN_QUERIES: GoldenQuery[] = [
  // ── exact: 키워드가 노트에 그대로 있음 (어휘 검색 sanity) ──
  { q: 'bge-m3 recall 얼마나 좋았지', category: 'exact', expected: ['g-rag-bge'] },
  { q: '금요일 배포 정책', category: 'exact', expected: ['g-deploy-fri-am', 'g-deploy-fri'] },
  { q: '파트너 API rate limit 지금 분당 몇이지', category: 'exact', expected: ['g-api-600'] },
  { q: 'Docker build cache 왜 느렸지', category: 'exact', expected: ['g-en-docker-cache'] },
  { q: '청킹 전략 실험 결과', category: 'exact', expected: ['g-rag-chunk'] },
  { q: '연금저축 세액공제 얼마 남았지', category: 'exact', expected: ['g-fin-tax'] },

  // ── paraphrase: 같은 뜻, 다른 단어 (시맨틱이 살려야 함) ──
  { q: '문서를 몇 글자 단위로 자르는 게 좋았더라', category: 'paraphrase', expected: ['g-rag-chunk'] },
  { q: '회의 끝나고 기록은 언제까지 남기기로 했지', category: 'paraphrase', expected: ['g-meeting-1', 'g-meeting-2'] },
  { q: '아침 회의가 자꾸 길어질 때 정한 규칙', category: 'paraphrase', expected: ['g-standup-1', 'g-standup-2', 'g-standup-3'] },
  { q: '어깨 아플 때 하는 운동 뭐였지', category: 'paraphrase', expected: ['g-health-shoulder'] },
  { q: '잠 잘 자려고 정한 규칙들', category: 'paraphrase', expected: ['g-health-sleep'] },
  { q: '지원자 평가할 때 보는 기준', category: 'paraphrase', expected: ['g-team-rubric'] },
  { q: '비밀키 주기적으로 바꾸는 정책 있었나', category: 'paraphrase', expected: ['g-infra-secrets'] },
  { q: '면 삶아서 마늘이랑 기름으로 만드는 요리 비율', category: 'paraphrase', expected: ['g-cook-pasta'] },

  // ── crosslingual: 질문 언어 ≠ 노트 언어 (bge-m3 다국어 검증) ──
  { q: '대시보드 쿼리 느렸던 거 인덱스 어떻게 고쳤지', category: 'crosslingual', expected: ['g-en-pg-index'] },
  { q: '리액트 리스트 렌더링 느린 문제 해결한 방법', category: 'crosslingual', expected: ['g-en-react-perf'] },
  { q: '결제 웹훅 밀렸던 장애 회고 내용', category: 'crosslingual', expected: ['g-en-incident'] },
  { q: 'What did we decide about Friday deploys?', category: 'crosslingual', expected: ['g-deploy-fri-am', 'g-deploy-fri'] },
  { q: 'how to make Korean kimchi stew', category: 'crosslingual', expected: ['g-cook-kimchi'] },
  { q: '신규 입사자 온보딩 절차 정리한 것', category: 'crosslingual', expected: ['g-en-onboarding', 'g-team-buddy'] },

  // ── distractor: 비슷한 노트가 여럿, 정답은 하나 ──
  { q: '임베딩 모델 뭐 쓰기로 했지', category: 'distractor', expected: ['g-rag-bge'] },
  { q: '자동 롤백 조건이 뭐였지', category: 'distractor', expected: ['g-deploy-canary'] },
  { q: '작업 기억에 대해 책에서 읽은 것', category: 'distractor', expected: ['g-read-brain'] },
  { q: '달리기 훈련 계획', category: 'distractor', expected: ['g-health-run'] },
  { q: '알람 너무 많아서 정리한 기준', category: 'distractor', expected: ['g-infra-monitor'] },
  { q: '오사카 갈 때 항공권 언제 사기로 했지', category: 'distractor', expected: ['g-trip-osaka', 'g-trip-flight'] },

  // ── 2hop: 질문은 A를 가리키고 정답 B는 링크로만 연결 ──
  { q: '검색이 같은 문서만 반복해서 나오던 문제', category: '2hop', expected: ['g-rag-incident', 'g-rag-topn'], needInTop8: 2 },
  { q: '429 백오프 어떻게 하기로 했지', category: '2hop', expected: ['g-api-60', 'g-api-600'], needInTop8: 2 },
  { q: '카나리 배포 도입하고 뭐가 바뀌었지', category: '2hop', expected: ['g-deploy-canary', 'g-deploy-fri-am'], needInTop8: 2 },
  { q: '버디 제도 왜 만들었지', category: '2hop', expected: ['g-team-buddy', 'g-en-onboarding'], needInTop8: 2 },

  // ── synthesis: 여러 노트가 함께 나와야 답이 되는 질문 ──
  { q: 'RAG 검색 품질 높이려고 결정하고 확인한 것들 정리해줘', category: 'synthesis', expected: ['g-rag-bge', 'g-rag-chunk', 'g-rag-rerank', 'g-rag-topn', 'g-rag-harness'], needInTop8: 3 },
  { q: '배포 정책이 어떻게 바뀌어왔지', category: 'synthesis', expected: ['g-deploy-fri', 'g-deploy-fri-am'], needInTop8: 2 },
  { q: '스탠드업 관련해서 적어둔 것 전부', category: 'synthesis', expected: ['g-standup-1', 'g-standup-2', 'g-standup-3'], needInTop8: 2 },
  { q: '요즘 건강 관리 뭐뭐 하고 있지', category: 'synthesis', expected: ['g-health-shoulder', 'g-health-run', 'g-health-sleep'], needInTop8: 2 },
]
