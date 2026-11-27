import { expect, it } from 'vitest'
import { leadPrompt, openRuleLines } from './rules.js'
import { sessionRules } from './rules.js'
import { COLLEAGUE_RULE, TEAM_LEAD_RULE, VOICE_RULE } from '../src/prompt.js'
import { documentTools } from '../src/document-tools.js'
import { DOCUMENT_CHECK_RULE } from '../src/office-verification.js'

const rules = sessionRules({ engineId: 'claude', desktop: false, workflow: true, browser: false, planned: true, pageSteps: false, native: { cwd: '/vault/workspace/tasks/bot-1', mode: 'auto', workspace: '/vault/workspace' } as never })

it('asks for nothing before the first tool call once the host has shown a first line', () => {
  expect(rules).not.toContain('Before the first tool call, say')
  expect(rules).toContain(VOICE_RULE)
  expect(rules.split('When the turn says a first line from you is already on screen')).toHaveLength(2)
  expect(VOICE_RULE.startsWith('When the turn says a first line from you is already on screen, that line is your first line: write nothing before your first tool call')).toBe(true)
  expect(openRuleLines().join('\n')).toContain(VOICE_RULE)
})

it('says the first line once in the work rules, and never on a turn that does no work', () => {
  const first = 'Otherwise one line before the first call restates the job and its outcome'
  const count = (text: string, part: string) => text.split(part).length - 1
  for (const text of [rules, openRuleLines().join('\n'), `${sessionRules({ engineId: 'claude', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false })}\n${leadPrompt({ context: { firstLine: { pending: true } } })}`]) {
    expect(count(text, first)).toBe(1)
    expect(count(text, 'that line is your first line')).toBe(1)
    expect(count(text, 'restates the job')).toBe(1)
  }
  expect(count(openRuleLines({ kind: 'lookup' }).join('\n'), 'restates the job')).toBe(0)
})

it('asks for no caveat about a check nobody asked for', () => {
  expect(DOCUMENT_CHECK_RULE).not.toContain('say in one line what was not checked')
  expect(DOCUMENT_CHECK_RULE).toContain('never mention a check nobody asked for')
  expect(rules).toContain(DOCUMENT_CHECK_RULE)
  expect(rules).toContain('never mention that Word, Excel or PowerPoint was not opened, that a file link is new or changed, or a check nobody asked for')
  expect(rules).not.toContain('only if part of the ask was not done or could not be confirmed')
  expect(rules).toContain('A part truly missing gets one calm clause')
  expect(rules).toContain('nor of what was not opened or checked')
  expect(COLLEAGUE_RULE).toContain('Never say what you did not do or check unless asked')
  expect(COLLEAGUE_RULE).not.toContain('파일 링크')
  const tools = documentTools(async () => { throw new Error('unused') }, async () => { throw new Error('unused') })
  const said = JSON.stringify(tools.map(tool => tool.description)) + readSource()
  expect(said).not.toContain('not proof of visual layout')
  expect(said).not.toContain('or prove layout')
})
const readSource = (): string => documentTools.toString()

it('gives one fact as one sentence, adds nothing the source lacks, answers a short note in the chat and closes a file job with one offer', () => {
  expect(COLLEAGUE_RULE).toContain('A one-fact ask, also from a file, gets the fact in one sentence naming any convention it rests on, nothing more unless asked.')
  expect(COLLEAGUE_RULE).toContain('holds only what is in it: no added item, number, owner, date or question')
  expect(COLLEAGUE_RULE).toContain('A summary or tidy-up of a short note is answered in the chat; a file only when asked for or long.')
  expect(COLLEAGUE_RULE).toContain('After a file job, say in a few words what you chose.')
  expect(COLLEAGUE_RULE).toContain('ends with exactly one short offer line')
  expect(COLLEAGUE_RULE).toContain('never a note, aside or menu')
  expect(COLLEAGUE_RULE).toContain('No offer after a correction, a simple fact, small talk or a short ask')
  expect(COLLEAGUE_RULE).toContain('a summary or document turn may end with one only when no earlier reply ended with an offer')
  expect(TEAM_LEAD_RULE).toContain('call report_result_check on it when that tool is offered')
  expect(rules).toContain('to change a text file they named and already keep there use your own Edit on its full path, also without asking')
})
