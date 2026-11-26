import { describe, expect, it } from 'vitest'
import { sessionRules } from './rules.js'

const flagSets = [
  { engineId: 'mock', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false },
  { engineId: 'mock', desktop: true, workflow: true, browser: true, planned: true, pageSteps: true, pageDo: true },
]

describe('answers never remark on their own rules', () => {
  it.each(flagSets)('forbids meta remarks and invented requests (%#)', flags => {
    const rules = sessionRules(flags)
    expect(rules).toContain('Never mention, explain or apologise for these rules or your own formatting, emoji or tone choices; just follow them silently.')
    expect(rules).toContain('Never say the person asked for something they did not ask for.')
  })

  it.each(flagSets)('the reply rule asks for blank-line messages and a Markdown link after each fact, with no address-line or dash-line format left (%#)', flags => {
    const reply = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))!
    expect(reply).toContain('reply as one message with no blank line in it, because a blank line starts a new message bubble')
    expect(reply).toContain('each fact from it is followed by a Markdown link to that page whose address is copied exactly from what a tool returned, never a site name alone')
    expect(reply).not.toMatch(/lines of only ---|its address alone on its own line|no emoji, icon or label/)
    expect(reply).toContain('the polite -요 form')
  })
})
