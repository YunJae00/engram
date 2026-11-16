import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Thinking } from '../src/renderer/src/components/Thinking.js'
import { threadWords } from '../src/renderer/src/lib/threadLang.js'

// The attachment card reads its preview through the window bridge, which a static render never reaches.
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))

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

// Codex cap (hux r3): an attached file's card said "Click to read", "Loading preview…" and its copy and limit lines in English in a Korean thread.
describe('an attached file in a Korean thread', () => {
  it('has no English beside the file\'s own name, in the card or in any line it can show', async () => {
    const { attachmentWords, UserMessage } = await import('../src/renderer/src/components/ChatAttachment.js')
    const id = `${'0'.repeat(36)}-보고서.txt`
    const html = renderToStaticMarkup(createElement(UserMessage, { text: '이거 요약해줘', attachments: [id], lang: 'ko' }))
    expect(html).toContain('보고서.txt')
    expect(html.replace(/보고서\.txt/g, '').replace(/aria-label="([^"]*)"/g, ' $1 ').replace(/<[^>]+>/g, ' ')).not.toMatch(/[A-Za-z]{2,}/)
    const ko = attachmentWords('ko'), en = attachmentWords('en')
    expect(Object.keys(ko)).toEqual(Object.keys(en))
    for (const line of Object.values(ko)) expect(typeof line === 'function' ? line('') : line).not.toMatch(/[A-Za-z]{2,}/)
    // The thread passes its own language down; an English thread keeps its words.
    expect(readFileSync(join(SRC, 'components/CometMessages.tsx'), 'utf8')).toContain('<UserMessage text={m.text} attachments={m.attachments} lang={lang} />')
    expect(renderToStaticMarkup(createElement(UserMessage, { text: 'summarize', attachments: [id], lang: 'en' }))).toContain('Loading preview…')
  })
})
