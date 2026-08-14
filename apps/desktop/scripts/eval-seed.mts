// Dogfood evaluation seed: a Korean dev-notes corpus with planted ground
// truth (hub cluster, duplicate pair, contradiction pair, supersede pair,
// distractors). Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/eval-seed.mts
import { createNote, initVault } from 'core'
import { rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/eval-vault/', import.meta.url))

interface Seed {
  body: string
  date: string
  type?: string
  decay?: 'fast' | 'slow' | 'none'
}

const SEEDS: Seed[] = [
  {
    date: '2026-06-20T10:00:00Z',
    type: 'note',
    body: `# 청킹 전략 실험 결과\n\n문단 기반 512토큰 청크 + 오버랩 15%가 우리 기술문서 코퍼스에서 가장 안정적이었다. 고정 256토큰은 표/코드블록이 잘려서 리콜이 떨어지고, 1024는 관련 없는 문단이 섞여 정밀도가 나빠짐. 실험은 골든 질문 30개 기준.`,
  },
  {
    date: '2026-06-22T09:00:00Z',
    type: 'note',
    body: `# 임베딩 모델: bge-m3 채택\n\n한국어 기술문서 검색에서 bge-m3가 text-embedding-3-small보다 recall@5 기준 12%p 높았다. 다국어 문서 혼재 환경에서 특히 격차가 큼. 로컬 서빙이라 비용도 없음. 단점: 인덱싱이 느리다.`,
  },
  {
    date: '2026-06-25T14:00:00Z',
    type: 'decision',
    body: `# 검색 topN 하드코딩 버그 수정\n\n다수 문서 업로드 시 일부 문서만 반복 인식되던 문제의 근본 원인: rag-search.tool.ts의 search()가 topN=4 하드코딩 — 문서가 18개여도 청크 4개만 반환됐다. 문서 수에 비례하는 동적 topN으로 수정 완료. 동일 양식 문서끼리 임베딩이 몰리는 것도 한몫했음.`,
  },
  {
    date: '2026-06-28T11:00:00Z',
    type: 'note',
    body: `# 리랭커 도입 검토\n\ncross-encoder 리랭킹(bge-reranker)을 상위 20 후보에 걸면 최종 상위 5의 정확도가 눈에 띄게 좋아진다. 대신 질의당 지연 +80ms. 대화형 검색에는 허용 범위라고 판단. 배치 인덱싱 쪽에는 불필요.`,
  },
  {
    date: '2026-07-01T16:00:00Z',
    type: 'note',
    body: `# RAG 평가 하네스\n\n골든 질문 30개로 recall@5를 상시 측정하는 하네스를 만들었다. 청킹/임베딩/리랭커 변경마다 회귀 확인용. 현재 기준선 recall@5 = 0.74. 질문 세트는 실제 사용자 질의 로그에서 추출.`,
  },
  // ── Duplicate pair (expected: J7 dedupe card) ──
  {
    date: '2026-06-15T09:00:00Z',
    type: 'note',
    body: `# 회의록 정리 원칙\n\n회의록은 회의 직후 24시간 안에 정리해야 정보 손실이 없다. 하루가 지나면 맥락과 뉘앙스를 절반은 잊는다. 정리 전에는 다른 작업을 시작하지 않는 걸 원칙으로.`,
  },
  {
    date: '2026-07-03T18:00:00Z',
    type: 'note',
    body: `# 미팅 노트는 당일에\n\n미팅 노트는 다음날이 되기 전에 정리하자. 하루 지나면 맥락을 다 까먹어서 노트가 반쪽짜리가 된다. 미팅 끝나고 바로 15분 확보하는 게 제일 확실하다.`,
  },
  // ── Contradiction pair (expected: conflict/supersede card) ──
  {
    date: '2026-06-10T10:00:00Z',
    type: 'decision',
    body: `# 배포 정책: 금요일 배포 금지\n\n금요일에는 프로덕션 배포를 하지 않는다. 주말에 장애 대응 인력이 없어서 금요일 오후 배포는 리스크가 크다. 예외는 보안 핫픽스뿐.`,
  },
  {
    date: '2026-07-05T09:30:00Z',
    type: 'decision',
    body: `# 배포 정책 갱신: 금요일 오전 배포 허용\n\n카나리 배포 + 자동 롤백이 도입돼서 금요일 오전(11시 이전) 배포는 허용하기로 했다. 금요일 오후는 여전히 금지. 자동 롤백이 15분 안에 완료되는 걸 두 번 확인했음.`,
  },
  // ── Supersede/stale pair (expected: stale or supersede card) ──
  {
    date: '2026-06-05T10:00:00Z',
    type: 'note',
    decay: 'fast',
    body: `# 외부 API rate limit\n\n파트너 API rate limit은 분당 60 요청. 초과하면 429 + 60초 백오프. 배치 작업은 분당 50으로 스로틀링해서 돌릴 것.`,
  },
  {
    date: '2026-07-08T13:00:00Z',
    type: 'note',
    body: `# 파트너 API rate limit 상향\n\n파트너사가 우리 플랜의 rate limit을 분당 600으로 상향해줬다 (7월 계약 갱신). 배치 스로틀 상수 업데이트 필요. 429 백오프 로직은 그대로 두는 게 안전.`,
  },
  // ── Standalone but linkable to A cluster ──
  {
    date: '2026-06-30T15:00:00Z',
    type: 'log',
    body: `# 검색 장애 회고\n\n사용자가 18개 문서를 올렸는데 검색이 같은 4개 문서만 계속 참조한다고 리포트. 원인 추적 결과 topN 고정이 문제였고, 임베딩 유사도가 동일 양식 문서에 몰리는 현상도 확인. 수정 후 전 문서가 고르게 검색됨.`,
  },
  {
    date: '2026-06-29T10:00:00Z',
    type: 'decision',
    body: `# 워크스페이스 임베딩 100MB 제한 해제\n\n단일 파일 100MB 제한을 600MB로 상향. 스트리밍 파싱/청킹으로 대용량 파일도 RAG 임베딩 가능하게 함. 기존 제한은 파일 전체를 메모리에 적재해 OOM이 나기 때문에 둔 안전장치였음.`,
  },
  // ── Triple-note same issue (card-dedupe limit probe: J7 may pair A-B,
  // A-C, B-C — distinct target sets defeat issuance dedup; sibling
  // dismissal on approval is what must collapse them) ──
  {
    date: '2026-06-12T09:30:00Z',
    type: 'note',
    body: `# 스탠드업 15분 원칙\n\n데일리 스탠드업은 15분 타임박스를 지킨다. 논의가 길어지면 당사자만 남아서 별도 콜로 뺀다. 전원 참석 시간은 15분이 상한.`,
  },
  {
    date: '2026-06-24T09:00:00Z',
    type: 'note',
    body: `# 아침 스탠드업은 짧게\n\n스탠드업이 자꾸 늘어진다. 15분 넘기지 않기로 다시 정리. 깊은 논의는 스탠드업 끝나고 관련자끼리 따로 잡는다.`,
  },
  {
    date: '2026-07-06T09:15:00Z',
    type: 'note',
    body: `# 스탠드업 또 길어짐\n\n이번 주 스탠드업이 두 번이나 30분을 넘었다. 15분 컷 원칙 재합의 — 타이머를 켜고, 초과 주제는 주차장 목록으로 미룬다.`,
  },
  // ── Distractors (should NOT link into cluster A) ──
  {
    date: '2026-06-18T08:00:00Z',
    type: 'note',
    body: `# 어깨 재활 루틴\n\n밴드 외회전 15회 3세트, 페이스풀 12회 3세트, 벽 슬라이드 10회. 통증 없는 범위에서만. 주 4회, 아침에.`,
  },
  {
    date: '2026-06-26T19:00:00Z',
    type: 'note',
    body: `# 김치찌개\n\n신김치 반 포기, 돼지목살 300g, 쌀뜨물 500ml. 목살 먼저 볶다가 김치 넣고 5분, 쌀뜨물 붓고 20분. 두부는 마지막 5분.`,
  },
  {
    date: '2026-07-02T21:00:00Z',
    type: 'note',
    body: `# 독서: 프로그래머의 뇌\n\n작업 기억은 한 번에 4~6개 항목만 다룬다. 코드 읽기가 힘든 건 지능이 아니라 청크 부족 문제 — 패턴을 외우면 청크가 커진다. 리팩토링은 읽는 사람의 작업 기억 부담을 줄이는 행위.`,
  },
]

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })
  const paths = await initVault(ROOT, { git: false })
  for (const seed of SEEDS) {
    const note = await createNote(
      paths,
      { body: seed.body, type: seed.type, decay: seed.decay },
      new Date(seed.date),
    )
    console.log(note.front.id, '\t', seed.body.split('\n')[0])
  }
  console.log('\nvault ready:', ROOT, `(${SEEDS.length} notes)`)
}

void main()
