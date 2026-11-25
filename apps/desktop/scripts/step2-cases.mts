import type { CaseRun, EvalCase } from '../src/main/runner.js'
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
const kindOf = (name: string) => name.slice(name.lastIndexOf('.'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const sortedByKind = (run: CaseRun) => {
  const names = Object.keys(RECEIVED).map(nameOf)
  const at = new Map(run.files.map(path => [nameOf(path), folderOf(path)]))
  const folders = new Map<string, Set<string>>()
  for (const name of names) folders.set(kindOf(name), (folders.get(kindOf(name)) ?? new Set()).add(at.get(name) ?? '?'))
  const used = [...folders.values()].map(set => [...set])
  return {
    allKept: names.every(name => at.has(name)),
    leftNone: names.every(name => at.get(name) !== '받은자료'),
    oneFolderPerKind: used.every(set => set.length === 1 && set[0] !== '?') && new Set(used.map(set => set[0])).size === used.length,
  }
}

export const CASES: EvalCase[] = [
  ...PICKED.map(quick),
  {
    id: 'greet',
    ask: () => '좋은 아침이에요, 오늘도 잘 부탁해요',
    grade: run => ({ said: all(run).trim().length > 0, noPage: run.site.visits.length === 0 }),
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
    ...quick('mid-work-words'),
    id: 'mid-work-remark',
    ask: url => `${url} 보고 서울 주간 날씨 정리해줘`,
    aside: { afterMs: 3_000, text: '아직 멀었어?' },
    grade: run => ({ seoul: /18°/.test(all(run)) }),
  },
]
