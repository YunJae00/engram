import type { CaseRun, EvalCase } from '../src/main/runner.js'
import { SAFETY_LINE } from '../src/main/first-line.js'
import { CASES as QUICK } from './eval-quick-cases.mts'

const all = (run: CaseRun) => run.answers.join('\n')
const quick = (id: string): EvalCase => QUICK.find(one => one.id === id)!
const PICKED = ['schedule-in-app', 'filter-list', 'mid-work-words', 'ask-when-no-records', 'sign-in-wall', 'broken-page-offers', 'reply-in-their-format', 'sum-across-projects']

const RECEIVED: Record<string, string> = {
  '받은자료/견적서_1차.pdf': '%PDF-1.4 견적서 1차',
  '받은자료/견적서_2차.pdf': '%PDF-1.4 견적서 2차',
  '받은자료/현장사진_입구.jpg': 'jpg 현장 입구',
  '받은자료/현장사진_창고.jpg': 'jpg 현장 창고',
  '받은자료/계약서_초안.docx': 'docx 계약서 초안',
  '받은자료/계약서_수정.docx': 'docx 계약서 수정',
}
const BAND_MS = 1500
const realFirst = (run: CaseRun) => !!run.trace.first && run.trace.first.text !== SAFETY_LINE.ko && run.trace.first.ms <= BAND_MS
const DELIVERIES = '# 11월 납품 일정\n\n| 날짜 | 거래처 | 품목 | 수량 |\n|---|---|---|---|\n| 11월 3일 | 대성기계 | 볼트 | 400 |\n| 11월 9일 | 한결물산 | 너트 | 250 |\n| 11월 17일 | 대성기계 | 와셔 | 900 |\n| 11월 24일 | 우진상사 | 볼트 | 120 |\n| 12월 2일 | 한결물산 | 너트 | 300 |\n'
const BRANCHES: Record<string, string> = {
  '지점자료/강남.csv': '월,방문객,매출(만원),직원수,평균대기(분)\n7,4200,6100,6,14\n8,4500,6500,6,17\n9,4700,6900,6,21\n10,5100,7400,6,26\n',
  '지점자료/수원.csv': '월,방문객,매출(만원),직원수,평균대기(분)\n7,3100,4000,5,8\n8,3000,3900,5,7\n9,2900,3800,5,7\n10,2800,3700,5,6\n',
  '지점자료/대전.csv': '월,방문객,매출(만원),직원수,평균대기(분)\n7,2500,3300,3,15\n8,2700,3600,3,18\n9,2900,3900,3,22\n10,3200,4300,3,27\n',
}
const page = (title: string, body: string) => ({ html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>` })
const REPLIES = /```replies\n([\s\S]*?)\n```\s*$/
const repliesOf = (run: CaseRun) => (all(run).trim().match(REPLIES)?.[1] ?? '').split('\n').map(line => line.trim()).filter(Boolean)
const koreanReplies = (run: CaseRun) => { const lines = repliesOf(run); return lines.length >= 2 && lines.length <= 3 && lines.every(line => /[가-힣]/.test(line) && !/(?:[A-Za-z]+\s+){3}[A-Za-z]+/.test(line)) }
const bodyOf = (run: CaseRun) => all(run).trim().replace(REPLIES, '').trim()
const linksTo = (run: CaseRun, path: string) => new RegExp(`http://127\\.0\\.0\\.1:\\d+${path}`).test(all(run))
const BOOK_CLUB = '# 독서모임 운영 메모\n\n- 12월 모임은 12월 13일 토요일 오후 3시, 망원동 카페 두잔\n- 회비는 한 달 만 원, 총무는 은지\n- 다음 책 후보: 「작별하지 않는다」, 「불편한 편의점」\n- 1월 모임은 1월 10일로 잠정, 장소 미정\n- 연말 송년회 날짜는 12월 27일로 확정\n- 새 회원 두 명 소개 예정\n'
const SUPPLIES = '품목,수량,단위,보관 위치\nA4 용지,14,박스,3층 창고\n볼펜(검정),62,자루,사무실 서랍\n토너,3,개,3층 창고\n포스트잇,25,묶음,사무실 서랍\n'
const PACKING = '# 부산 출장 챙길 것\n\n- 노트북과 충전기\n- 사원증\n- 명함 50장\n- 견본 카탈로그 3부\n- 우산\n'
const PACKED = ['노트북', '사원증', '명함', '카탈로그', '우산']
const UNCOUNTED = ['노트북', '사원증', '우산']
const FLOWERS = '# 꽃꽂이 수업 재료\n\n- 꽃가위\n- 오아시스 2개\n- 리본\n- 포장지 3장\n- 유리 화병\n'
const FLOWER_ITEMS = ['꽃가위', '오아시스', '리본', '포장지', '화병']
const FLOWER_UNCOUNTED = ['꽃가위', '리본', '화병']
const tableRows = (run: CaseRun) => all(run).split('\n').filter(line => line.trim().startsWith('|'))
const blanksKept = (rows: string[], uncounted: string[]) => uncounted.every(item => rows.filter(line => line.includes(item)).every(line => !/\d/.test(line)))

const kindOf = (name: string) => name.slice(name.lastIndexOf('.'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const sortedByKind = (run: CaseRun) => {
  const names = Object.keys(RECEIVED).map(nameOf)
  const at = (name: string) => run.files.filter(path => nameOf(path) === name).map(folderOf)
  const used = [...new Set(names.map(kindOf))].map(kind => [...new Set(names.filter(name => kindOf(name) === kind).flatMap(at))])
  return {
    eachOnce: names.every(name => at(name).length === 1),
    leftNone: run.files.every(path => folderOf(path) !== '받은자료'),
    oneFolderPerKind: used.every(set => set.length === 1) && new Set(used.map(set => set[0])).size === used.length,
  }
}

export const CASES: EvalCase[] = [
  ...PICKED.map(quick),
  {
    id: 'greet',
    ask: () => '좋은 아침이에요, 오늘도 잘 부탁해요',
    grade: run => ({ said: all(run).trim().length > 0, noStep: run.steps.length === 0 }),
  },
  {
    id: 'quick-fact',
    ask: () => '삼각형 내각의 합은 몇 도야?',
    grade: run => ({ answer: /180/.test(all(run)) }),
  },
  {
    id: 'told',
    ask: () => '나 다음 달부터 화요일마다 재택이야',
    grade: run => ({ said: all(run).trim().length > 0, noQuestion: !/[?？]\s*$/.test(all(run).trim()) }),
  },
  {
    id: 'fix-recall',
    before: ['내 담당 거래처는 한빛상사야', '아 한빛상사 아니고 한솔상사야'],
    ask: () => '내 담당 거래처 어디였지?',
    grade: run => ({ corrected: all(run).includes('한솔상사'), oldGone: !all(run).includes('한빛상사') }),
  },
  {
    id: 'file-sort',
    files: RECEIVED,
    ask: () => '받은자료 폴더 안 파일들 종류별로 폴더 나눠 넣어줘',
    grade: sortedByKind,
  },
  {
    id: 'file-summary',
    files: { '회의메모.md': '# 11월 넷째 주 회의\n\n참석: 민호, 수아, 태준\n\n- 지난주 문의 건수 공유 (42건)\n- 사무실 프린터 교체 이야기, 다음 회의에서 다시\n- 결정: 신제품 출시일은 3월 14일로 확정\n- 결정: 베타 신청은 온라인 신청서로만 받기\n- 할 일: 수아가 신청서 문항 초안 금요일까지\n- 할 일: 태준이 출시 안내 메일 문구 준비\n' },
    ask: () => '회의메모.md 팀에 돌릴 수 있게 추려줘',
    grade: run => ({ launchDate: /3월\s*14일/.test(all(run)), betaForm: /신청서/.test(all(run)) }),
  },
  {
    id: 'lookup-live',
    ask: () => '지금 도쿄 날씨 어때?',
    grade: run => ({ linked: /\]\(https?:\/\//.test(all(run)), degrees: /\d+(?:\.\d+)?\s*(?:°|도)/.test(all(run)) }),
  },
  {
    id: 'tier-chat',
    ask: () => '점심 맛있게 드셨어요? 저는 방금 국수 먹고 왔어요',
    grade: run => ({ said: all(run).trim().length > 0, noStep: run.steps.length === 0, wholeInBand: run.trace.final.ms <= BAND_MS }),
  },
  {
    id: 'tier-work',
    files: { '납품일정.md': DELIVERIES },
    ask: () => '납품일정.md 보고 11월 납품이 몇 건인지 알려줘',
    grade: run => ({ count: /4\s*건/.test(all(run)), realFirstInBand: realFirst(run), lineBeforeFinal: !!run.trace.first && run.trace.first.ms < run.trace.final.ms && !run.trace.final.text.trim().startsWith(run.trace.first.text) }),
  },
  {
    id: 'named-file-direct',
    files: { '재고장.md': '# 입고 확인\n- 파란 컵: 검수 완료\n- 흰 접시: 검수 완료\n- 나무 쟁반: 확인 중\n- 유리잔: 검수 완료\n' },
    ask: () => '재고장.md에서 검수 완료된 품목 수만 알려줘',
    grade: run => ({ count: /3\s*(?:개|품목)/.test(all(run)), readFile: run.steps.some(step => step.startsWith('file_read:')), namedSourceFirst: !run.steps.some(step => /^(?:search_chats|search_memory):/.test(step)) }),
  },
  {
    id: 'tier-hard',
    files: BRANCHES,
    ask: () => '지점자료/강남.csv, 지점자료/수원.csv, 지점자료/대전.csv 세 지점 넉 달 치를 서로 맞춰 보고, 내년 1분기에 어느 지점에 직원을 몇 명 더 둘지 근거를 대서 단계별 배치 계획 세워줘',
    grade: run => {
      const up = run.trace.escalated
      const deep = up && run.trace.steps.find(step => step.ms > up.ms)
      return { escalated: !!up, saidWhy: !!up?.said.trim(), whyBeforeDeep: !!up && up.said.trim().length > 0 && up.ms < (deep ?? run.trace.final).ms, planned: /강남|대전/.test(all(run)) }
    },
  },
  {
    ...quick('mid-work-words'),
    id: 'mid-work-remark',
    ask: url => `${url} 보고 서울 주간 날씨 정리해줘`,
    aside: { afterMs: 3_000, text: '아직 멀었어?' },
    grade: run => ({ seoul: /18°/.test(all(run)) }),
  },
  {
    id: 'replies-close',
    files: { '독서모임.md': BOOK_CLUB },
    ask: () => '독서모임.md에서 날짜 정해진 일정만 골라줘',
    grade: run => ({ dates: /12월\s*13일/.test(all(run)) && /12월\s*27일/.test(all(run)), closesWithReplies: koreanReplies(run) }),
  },
  {
    id: 'hold-replies',
    before: ['우리 동네 탁구 모임 사람들한테 돌릴 다음 달 정기 모임 안내 문자 하나 써줘'],
    ask: () => '좋아요. 근데 돌리는 건 내가 하자고 할 때까지 그냥 둬요',
    grade: run => ({ hasReplies: repliesOf(run).length > 0, noSendNow: repliesOf(run).every(line => !/(?:지금|바로|이제|이대로)[^\n]{0,8}(?:보내|돌려|발송|전송)|(?:보내|돌려|발송|전송)(?:줘|주세요|요\b)/.test(line)) }),
  },
  {
    id: 'one-fact-file',
    files: { '비품재고.csv': SUPPLIES },
    ask: () => '비품재고.csv 보면 A4 용지 몇 박스 남았어?',
    grade: run => ({ value: /14\s*박스/.test(all(run)), noTable: !/\|\s*-{3,}/.test(all(run)), short: bodyOf(run).split('\n').filter(line => line.trim()).length <= 2 }),
  },
  {
    id: 'reshape-last',
    files: { '출장준비물.md': PACKING },
    before: ['출장준비물.md에 뭐 적혀 있는지 알려줄래요?'],
    ask: () => '그 목록 표 모양으로 한 번 더 줄래요?',
    grade: run => {
      const rows = tableRows(run)
      return { table: rows.some(line => /\|\s*-{3,}/.test(line)), everyItem: PACKED.every(item => rows.some(line => line.includes(item))), blanksKept: blanksKept(rows, UNCOUNTED) }
    },
  },
  {
    id: 'reshape-blanks',
    files: { '수업재료.md': FLOWERS },
    before: ['수업재료.md 내용 좀 읽어줘요'],
    ask: () => '방금 거 칸 나눠서 정리해 줄 수 있어요?',
    grade: run => {
      const rows = tableRows(run)
      return { table: rows.some(line => /\|\s*-{3,}/.test(line)), everyItem: FLOWER_ITEMS.every(item => rows.some(line => line.includes(item))), blanksKept: blanksKept(rows, FLOWER_UNCOUNTED) }
    },
  },
  {
    id: 'teammate-lookup',
    as: 'teammate',
    ask: url => `${url}book-room 에 있는 구립 작은도서관이 주말엔 몇 시에 문 닫는지 찾아줘`,
    page: path => path.startsWith('/book-room') ? page('구립 작은도서관 이용 안내', '<p>평일 오전 9시 ~ 오후 10시</p><p>주말 오전 9시 ~ 오후 6시</p><p>매주 월요일 휴관</p>') : null,
    grade: run => ({ closes: /(?:오후\s*)?6시|18시|18:00/.test(all(run)), address: linksTo(run, '/book-room') }),
  },
  {
    id: 'helper-look',
    as: 'helper',
    ask: url => `${url}parking 에 나온 시민공원 공영주차장 최초 30분 요금 알아봐줘`,
    page: path => path.startsWith('/parking') ? page('시민공원 공영주차장 요금 안내', '<table><tr><th>구분</th><th>요금</th></tr><tr><td>최초 30분</td><td>1,500원</td></tr><tr><td>이후 10분마다</td><td>500원</td></tr><tr><td>1일 최대</td><td>15,000원</td></tr></table>') : null,
    grade: run => ({ fee: /1,?500\s*원/.test(all(run)), address: linksTo(run, '/parking') }),
  },
  {
    id: 'helper-one-page',
    as: 'helper',
    ask: url => `${url}bakery 안내에서 평일에 몇 시에 닫는지만 알려줘`,
    page: path => path.startsWith('/bakery') ? page('동네 빵집 이용 안내', '<p>평일 오전 8시 ~ 오후 8시</p><p>토요일 오전 9시 ~ 오후 5시</p>') : null,
    grade: run => ({ closes: /(?:오후\s*)?8시|20시|20:00/.test(all(run)), address: linksTo(run, '/bakery'), oneReceipt: run.steps.filter(step => step.startsWith('collect_results:')).length <= 1 }),
  },
  {
    id: 'single-page-lead',
    ask: url => `${url}market 안내에서 중앙시장 수요일 문 닫는 시간만 알려줘`,
    page: path => path.startsWith('/market') ? page('중앙시장 이용 안내', '<p>월~금 오전 9시 ~ 오후 7시</p><p>토요일 오전 10시 ~ 오후 5시</p>') : null,
    grade: run => ({ closes: /(?:오후\s*)?7시|19시|19:00/.test(all(run)), address: linksTo(run, '/market'), oneReceipt: run.steps.filter(step => step.startsWith('collect_results:')).length <= 1 }),
  },
]
