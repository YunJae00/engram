import { describe, expect, it } from 'vitest'
import { sessionRules } from '../src/agent-session-shape.js'

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

  it.each(flagSets)('scopes the emoji limit to the page address line (%#)', flags => {
    const lines = sessionRules(flags).split('\n').filter(l => /emoji/i.test(l))
    const address = lines.find(l => l.includes('fenced block whose language is replies'))!
    expect(address).toContain('its address alone on its own line with no emoji, icon or label beside that address')
    expect(address).toContain('this limit is about the address line only, not the rest of the answer')
    expect(address).not.toContain('no emoji, no icon, no label around it')
    expect(address).toContain('the polite -요 form')
    expect(address).toContain('separated by lines of only ---')
  })
})
