import type { StringKey } from '../i18n.js'

type Examples = readonly [StringKey, StringKey, StringKey]

const DEFAULT: Examples = ['botEmpty.default1', 'botEmpty.default2', 'botEmpty.default3']

const BY_TEMPLATE: Record<string, Examples> = {
  'morning-briefing': ['botEmpty.morning1', 'botEmpty.morning2', 'botEmpty.morning3'],
  research: ['botEmpty.research1', 'botEmpty.research2', 'botEmpty.research3'],
  'mail-draft': ['botEmpty.mail1', 'botEmpty.mail2', 'botEmpty.mail3'],
  schedule: ['botEmpty.schedule1', 'botEmpty.schedule2', 'botEmpty.schedule3'],
  'study-helper': ['botEmpty.study1', 'botEmpty.study2', 'botEmpty.study3'],
}

export function botExamples(templateId: unknown): Examples {
  return typeof templateId === 'string' && Object.hasOwn(BY_TEMPLATE, templateId) ? BY_TEMPLATE[templateId]! : DEFAULT
}
