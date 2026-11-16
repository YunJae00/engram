import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { followSettings } from '../src/renderer/src/i18n.js'
import { previousFiles } from '../src/renderer/src/markdown.js'
import { AnswerFiles, PreviousFiles } from '../src/renderer/src/components/AnswerFiles.js'

const link = (id: string) => `[file](engram-artifact:${encodeURIComponent(id)})`
const V1 = '11111111-1111-1111-1111-111111111111-지출.xlsx', V2 = '22222222-2222-2222-2222-222222222222-지출.xlsx', V3 = '33333333-3333-3333-3333-333333333333-지출.xlsx'
const OTHER = '44444444-4444-4444-4444-444444444444-덱.pptx'
const language = (uiLanguage: string) => followSettings({ onEvent: () => () => undefined, settingsGet: async () => ({ uiLanguage }) } as never)
const cards = (previous = '') => renderToStaticMarkup(createElement(PreviousFiles.Provider, { value: previous }, createElement(AnswerFiles, { files: [{ id: V2, name: '지출.xlsx' }] })))

afterEach(() => { vi.unstubAllGlobals() })

it('links a remade file to the version an earlier turn carded, and nothing else (qa146 S03/S04/S33)', () => {
  const messages = [
    { role: 'user', text: 'make it' },
    { role: 'assistant', text: `Made.\n\n${link(V1)}\n${link(OTHER)}` },
    { role: 'assistant', text: `Checked.\n\n${link(V1)}` },
    { role: 'user', text: 'fix the sheet name' },
    { role: 'assistant', text: `Fixed.\n\n${link(V2)}` },
    { role: 'assistant', text: `Checked.\n\n${link(V2)}` },
    { role: 'user', text: 'again' },
    { role: 'assistant', text: `Again.\n\n${link(V3)}\n${link(OTHER)}` },
  ]
  expect(previousFiles(messages)).toBe(`${V2}\t${V1}\n${V3}\t${V2}`)
  // Two files of one name made in the same turn are two files, not versions.
  expect(previousFiles([{ role: 'user', text: 'two' }, { role: 'assistant', text: `${link(V1)}\n${link(V2)}` }])).toBe('')
})

it.each([['ko', 'MacIntel', 'Finder에서 보기'], ['ko', 'Win32', '탐색기에서 보기'], ['en', 'MacIntel', 'Show in Finder'], ['en', 'Win32', 'Show in Explorer']])('names the reveal button in the app language (%s, %s)', async (lang, platform, words) => {
  vi.stubGlobal('navigator', { platform, language: 'en-US' })
  await language(lang)
  expect(cards()).toContain(`aria-label="${words}: 지출.xlsx" title="${words}"`)
})

it.each([['ko', '(이전)'], ['en', '(previous)']])('shows the previous-version link only on a remade file\'s card (%s)', async (lang, words) => {
  vi.stubGlobal('navigator', { platform: 'MacIntel', language: 'en-US' })
  await language(lang)
  expect(cards()).not.toContain('answer-file-previous')
  expect(cards(`${V3}\t${V2}`)).not.toContain('answer-file-previous')
  expect(cards(`${V2}\t${V1}`)).toMatch(new RegExp(`data-testid="answer-file-previous"[^>]*>${words.replace(/[()]/g, '\\$&')}<`))
})
