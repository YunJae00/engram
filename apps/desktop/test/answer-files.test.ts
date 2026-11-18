import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { followSettings } from '../src/renderer/src/i18n.js'
import { linkedFiles } from '../src/renderer/src/markdown.js'
import { AnswerFiles, previousOf } from '../src/renderer/src/components/AnswerFiles.js'

const link = (id: string) => `[file](engram-artifact:${encodeURIComponent(id)})`
const V1 = '11111111-1111-1111-1111-111111111111-지출.xlsx', V2 = '22222222-2222-2222-2222-222222222222-지출.xlsx'
const OTHER = '44444444-4444-4444-4444-444444444444-덱.pptx'
const language = (uiLanguage: string) => followSettings({ onEvent: () => () => undefined, settingsGet: async () => ({ uiLanguage }) } as never)
const cards = () => renderToStaticMarkup(createElement(AnswerFiles, { files: [{ id: V2, name: '지출.xlsx' }] }))

afterEach(() => { vi.unstubAllGlobals() })

it('links a remade file only to a version on record that this chat linked (qa146 2a)', () => {
  const A = '11111111-1111-1111-1111-111111111111-plan.md', B = '22222222-2222-2222-2222-222222222222-plan.md'
  const chat = linkedFiles([{ role: 'user', text: 'Task A' }, { role: 'assistant', text: link(A) }, { role: 'user', text: 'Separate Task B, use same filename' }, { role: 'assistant', text: link(B) }, { role: 'user', text: link(OTHER) }])
  expect(chat).toBe(`${A}\n${B}`)
  expect(previousOf([], chat)).toBeUndefined()
  expect(previousOf([V1, A], chat)).toBe(A)
  expect(previousOf([V1], chat)).toBeUndefined()
})

it.each([['ko', 'MacIntel', 'Finder에서 보기'], ['ko', 'Win32', '탐색기에서 보기'], ['en', 'MacIntel', 'Show in Finder'], ['en', 'Win32', 'Show in Explorer']])('names the reveal button in the app language (%s, %s)', async (lang, platform, words) => {
  vi.stubGlobal('navigator', { platform, language: 'en-US' })
  await language(lang)
  expect(cards()).toContain(`aria-label="${words}: 지출.xlsx" title="${words}"`)
})
