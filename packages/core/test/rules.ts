import { promptFor, type PromptInput, type SessionFlags } from '../src/prompt.js'

const BASE: SessionFlags = { engineId: 'claude', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false }
export const sessionRules = (flags: SessionFlags): string => promptFor('work', { task: '', flags }).system
export const openRuleLines = (scope: Pick<SessionFlags, 'kind' | 'tools'> = {}): string[] => sessionRules({ ...BASE, ...scope }).split('\n')
export const leadPrompt = (more: Omit<PromptInput, 'task' | 'flags'> = {}): string => promptFor('work', { task: '', flags: BASE, ...more }).prompt
