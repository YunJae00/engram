import { describe, expect, it } from 'vitest'
import { en } from '../src/renderer/src/i18n'
import { ko } from '../src/renderer/src/i18n-ko'
import { botExamples } from '../src/renderer/src/lib/botExamples'

const DEFAULT = ['botEmpty.default1', 'botEmpty.default2', 'botEmpty.default3']
const TEMPLATES = ['morning-briefing', 'research', 'mail-draft', 'schedule', 'study-helper']

describe('bot empty examples', () => {
  it('each built-in template has its own three examples and anything else gets the default three', () => {
    expect(botExamples(undefined)).toEqual(DEFAULT)
    const keys = [...DEFAULT]
    for (const id of TEMPLATES) {
      const examples = botExamples(id)
      expect(examples).toHaveLength(3)
      keys.push(...examples)
    }
    expect(new Set(keys).size).toBe(18)
    for (const id of ['custom', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 42, null, {}, ['research']]) {
      expect(botExamples(id)).toEqual(DEFAULT)
    }
  })

  it('every example has an English and a Korean text', () => {
    const keys = [undefined, ...TEMPLATES].flatMap((id) => botExamples(id))
    expect(keys).toHaveLength(18)
    for (const key of keys) {
      expect(en[key].trim()).not.toBe('')
      expect(ko[key]).toMatch(/[가-힣]/)
      expect(`${en[key]} ${ko[key]}`).not.toMatch(/comet|코멧/i)
    }
  })
})
