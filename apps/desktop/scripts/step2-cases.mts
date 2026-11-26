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
]
