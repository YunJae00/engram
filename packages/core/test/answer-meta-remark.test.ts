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

  it.each(flagSets)('the reply rule asks for one message, and the kept one-bubble, link and register sentences say how, with no address-line or dash-line format left (%#)', flags => {
    const rules = sessionRules(flags)
    const reply = rules.split('\n').find(l => l.includes('fenced block whose language is replies'))!
    expect(reply).toContain('reply as one short message in markdown')
    expect(rules).toContain('an empty line cuts the reply into a separate chat bubble')
    expect(rules).toContain('with the address copied exactly from what a tool returned: never an address from memory or one you put together, never a site name without its link')
    expect(reply).not.toMatch(/lines of only ---|its address alone on its own line|no emoji, icon or label/)
    expect(rules).toContain('in Korean keep the polite-casual -요 form through the whole reply')
  })
})
