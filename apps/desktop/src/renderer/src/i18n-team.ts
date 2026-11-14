import { teamKo } from './i18n-ko-team.js'

export type TeamLang = 'en' | 'ko'

export const teamEn = {
  summaryWorking: 'Team of {n} · {m} working',
  summaryIdle: 'Team of {n} · all finished',
  failed: '{f} failed',
  working: 'Working',
  reviewing: 'Reviewing',
  done: 'Done',
  failedChip: 'Failed',
  released: 'Released',
  treeLabel: 'Team members',
}

export type TeamKey = keyof typeof teamEn

export const teamT = (lang: TeamLang, key: TeamKey, vars: Record<string, number> = {}): string =>
  (lang === 'ko' ? teamKo : teamEn)[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
