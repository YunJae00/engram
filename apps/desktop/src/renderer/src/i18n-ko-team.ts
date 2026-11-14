import type { teamEn } from './i18n-team.js'

export const teamKo: Record<keyof typeof teamEn, string> = {
  summaryWorking: '팀 {n}명 · {m}명 작업 중',
  summaryIdle: '팀 {n}명 · 모두 끝',
  failed: '{f}명 실패',
  working: '작업 중',
  reviewing: '검토 중',
  done: '끝',
  failedChip: '실패',
  released: '해산',
  treeLabel: '팀 구성원',
}
