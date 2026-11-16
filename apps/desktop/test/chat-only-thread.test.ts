import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Thinking } from '../src/renderer/src/components/Thinking.js'
import { threadWords } from '../src/renderer/src/lib/threadLang.js'

const SRC = resolve(import.meta.dirname, '../src/renderer/src')
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(one => one.isDirectory() ? files(join(dir, one.name)) : /\.(tsx?|css)$/.test(one.name) ? [join(dir, one.name)] : [])

// GROKBOT rule 9: a question is answered by typing. Nothing in the thread turns its options into buttons.
describe('a question the teammate asked', () => {
  it('draws no choice card or choice button anywhere in the renderer', () => {
    for (const gone of ['components/ThreadOffers.tsx', 'components/Choices.tsx']) expect(existsSync(join(SRC, gone)), gone).toBe(false)
    const left = files(SRC).filter(file => /bots-choice|ThreadOffers|<Choices\b|sendCometReply/.test(readFileSync(file, 'utf8')))
    expect(left).toEqual([])
  })
})

// GROKBOT rule 12: the waiting line has no English anywhere a Korean reader can reach, tooltip included.
describe('the waiting line in a Korean thread', () => {
  it('has no tooltip and no English words', () => {
    const html = renderToStaticMarkup(createElement(Thinking, { label: '생각하는 중', since: Date.now() - 3_000, total: threadWords('ko').total }))
    expect(html).not.toMatch(/title=/)
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/[A-Za-z]{2,}/)
    expect(html).toContain('aria-label="생각하는 중"')
  })
})
