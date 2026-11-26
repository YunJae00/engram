import { describe, expect, it } from 'vitest'
import { type SessionFlags } from '../src/prompt.js'
import { openRuleLines } from './rules.js'
import { sessionRules } from './rules.js'
import { ONE_BUBBLE_RULE } from '../src/prompt.js'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

const KINDS: NonNullable<SessionFlags['kind']>[] = ['short', 'lookup', 'work']
const FLAGS = { engineId: 'mock', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false }

describe('the model is told that a blank line is a bubble break, in every kind of turn', () => {
  it.each(KINDS)('a %s turn asks for one bubble with the body right under the lead', kind => {
    const rules = openRuleLines({ kind }).join('\n')
    expect(rules).toContain(ONE_BUBBLE_RULE)
    expect(ONE_BUBBLE_RULE).toBe('A table comes last in the reply, with nothing under it. Write the reply with no empty line in it, not between paragraphs and not before a list or a table (both draw fine right under a line of text): an empty line cuts the reply into a separate chat bubble.')
  })

  it('no rule asks for several messages or for a blank line as a separator', () => {
    const told = [...KINDS.map(kind => openRuleLines({ kind }).join('\n')), ...KINDS.map(kind => sessionRules({ ...FLAGS, kind }))].join('\n')
    expect(told).not.toMatch(/two to four short messages|use one between the result line and its details|at most three bubbles/)
    expect(sessionRules({ ...FLAGS, kind: 'work' })).toContain('reply as one message with no blank line in it')
  })
})

describe('the one-bubble rule is the last thing the model reads before it answers', () => {
  it.each(['장마철 빨래 잘 마르는 법 알려줘', 'compare oat milk and soy milk in a table'])('the turn prompt for "%s" ends with the rule', async ask => {
    const prompts: string[] = []
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { prompts.push(job.prompt); return { answer: 'ok' } } } as unknown as Engine
    await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [] }, ask, { guided: false })
    expect(prompts[0]!.split('\n').at(-1)).toBe(ONE_BUBBLE_RULE)
    expect(prompts[0]).toContain(`Task: ${ask}`)
  })
})
