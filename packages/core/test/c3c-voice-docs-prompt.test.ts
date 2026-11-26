import { expect, it } from 'vitest'
import { openRuleLines } from '../src/agent-prompt.js'
import { sessionRules } from '../src/agent-session-shape.js'
import { COLLEAGUE_RULE, TEAM_LEAD_RULE, VOICE_RULE } from '../src/agent-voice.js'
import { documentTools } from '../src/document-tools.js'
import { DOCUMENT_CHECK_RULE } from '../src/office-verification.js'

const rules = sessionRules({ engineId: 'claude', desktop: false, workflow: true, browser: false, planned: true, pageSteps: false, native: { cwd: '/vault/workspace/tasks/bot-1', mode: 'auto', workspace: '/vault/workspace' } as never })

it('asks for nothing before the first tool call once the host has shown a first line', () => {
  expect(rules).not.toContain('Before the first tool call, say')
  expect(rules).toContain('When the turn says a first line from you is already on screen, write nothing before your first tool call and nothing between tool calls')
  expect(rules).toContain('never what you are about to read or check')
  expect(VOICE_RULE.startsWith('When the turn says a first line from you is already on screen, that line is your first line: write nothing before your first tool call')).toBe(true)
  expect(openRuleLines().join('\n')).toContain(VOICE_RULE)
})

it('asks for no caveat about a check nobody asked for', () => {
  expect(DOCUMENT_CHECK_RULE).not.toContain('say in one line what was not checked')
  expect(DOCUMENT_CHECK_RULE).toContain('never mention a check nobody asked for')
  expect(rules).toContain(DOCUMENT_CHECK_RULE)
  expect(rules).toContain('never mention that Word, Excel or PowerPoint was not opened, that a file link is new or changed, or a check nobody asked for')
  expect(rules).not.toContain('only if part of the ask was not done or could not be confirmed')
  expect(rules).toContain('only if part of what the person asked for is truly missing - one calm clause saying which, in their language')
  expect(COLLEAGUE_RULE).toContain('Never tell them what you did not do or check when nobody asked for it')
  expect(COLLEAGUE_RULE).toContain('파일 링크가 새로 바뀌었으니')
  const tools = documentTools(async () => { throw new Error('unused') }, async () => { throw new Error('unused') })
  const said = JSON.stringify(tools.map(tool => tool.description)) + readSource()
  expect(said).not.toContain('not proof of visual layout')
  expect(said).not.toContain('or prove layout')
})
const readSource = (): string => documentTools.toString()

it('gives one fact as one sentence, adds nothing the source lacks, answers a short note in the chat and closes a file job with one offer', () => {
  expect(COLLEAGUE_RULE).toContain('A one-fact ask gets that fact in one sentence, also when it comes from a file, naming in it any convention it rests on (a common year, a 30-day month): no breakdown, table, working, other variant or "if" unless they ask.')
  expect(COLLEAGUE_RULE).toContain('holds only what is in it: add no item, number, owner, date or open question that is not there')
  expect(COLLEAGUE_RULE).toContain('A summary or tidy-up of a short note is answered in the chat itself; make a file only when they asked for a file or the result is long.')
  expect(COLLEAGUE_RULE).toContain('After a file job say in a few words what you chose.')
  expect(COLLEAGUE_RULE).toContain('ends with exactly ONE short offer line')
  expect(COLLEAGUE_RULE).toContain('never a menu or a list of offers')
  expect(COLLEAGUE_RULE).toContain('Give no offer after a correction, a simple fact, small talk or a short ask.')
  expect(COLLEAGUE_RULE).toContain('document turns in a row carry at most one offer between them')
  expect(TEAM_LEAD_RULE).toContain('call report_result_check on it when that tool is offered')
  expect(rules).toContain('to change a text file they named and already keep there use your own Edit on its full path, also without asking')
})
