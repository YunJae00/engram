import { expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const koreanAllowed = (file: string) => /^i18n-ko(?:-[\w-]+)?\.ts$/.test(file) || /threadLangKo\.ts$/.test(file)

it('Korean literals only in i18n-ko*.ts and threadLangKo.ts, and dates are formatted explicitly instead of inheriting the OS language', async () => {
  for (const file of ['i18n-ko.ts', 'i18n-ko-1.ts', 'lib/threadLangKo.ts']) expect(koreanAllowed(file), file).toBe(true)
  for (const file of ['components/i18n-ko-1.ts', 'i18n-ko.ts.bak.ts', 'i18n.ts', 'components/Foo.tsx']) expect(koreanAllowed(file), file).toBe(false)
  const root = resolve('apps/desktop/src/renderer/src')
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.tsx?$/.test(file)) continue
    // The words inside a conversation follow the person's language; this is their one table.
    if (/threadLangKo\.ts$/.test(file)) continue
    const text = await readFile(resolve(root, file), 'utf8')
    if (!koreanAllowed(file.split('\\').join('/'))) expect(text, file).not.toMatch(/[가-힣]/)
    expect(text, file).not.toMatch(/(?:toLocale(?:Date|Time)?String|Intl\.DateTimeFormat)\(\s*(?:\)|undefined|\[\])/)
  }
})

it('says a paused task with unconfirmed checks in the language of the conversation', async () => {
  const { displayTaskAnswer } = await import('../src/renderer/src/lib/threadLang.js')
  const line = 'The report is recorded, but unresolved checks remain. Waiting for your next instruction.'
  expect(displayTaskAnswer(line, 'ko')).toBe('결과는 나왔지만 일부를 확인하지 못했어요. 어떻게 이어갈지 알려주세요.')
  expect(displayTaskAnswer(line, 'en')).not.toContain('unresolved checks')
})

it('shows the error card in the language of the conversation', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ErrorAnswer } = await import('../src/renderer/src/components/ErrorAnswer.js')
  const ko = renderToStaticMarkup(createElement(ErrorAnswer, { text: 'API Error: 400 does not support this model', lang: 'ko' }))
  expect(ko).toContain('요청을 끝내지 못했어요')
  expect(ko).toContain('오류 내용')
  expect(ko).toContain('오류 복사')
  for (const english of ['Could not complete this request', 'Error details', 'Copy error']) expect(ko).not.toContain(english)
  expect(renderToStaticMarkup(createElement(ErrorAnswer, { text: 'Boom', lang: 'en' }))).toContain('Could not complete this request')
})

it('does not show the verifier\'s model-facing reason to the person; the unverified mark itself stays', async () => {
  const { displayTaskAnswer } = await import('../src/renderer/src/lib/threadLang.js')
  const { checkOfficeResult } = await import('../../../packages/core/src/office-verification.js')
  // An Office write that was never read back: the host still marks the turn incomplete.
  const result = checkOfficeResult({ answer: '슬라이드 4장을 만들었어요.', steps: [{ tool: 'ppt_build', args: {}, observation: '{}' }], fellBack: false })
  expect(result.incomplete).toContain('Report incomplete or unverified work')
  const shown = displayTaskAnswer(result.answer, 'ko')
  expect(shown).toBe('확인하지 못한 항목이 있어요.\n\n파일을 쓴 뒤에 다시 읽어 확인하지 못했어요. 사용하기 전에 파일을 열어 확인해 주세요.\n\n현재까지 확인한 내용:\n슬라이드 4장을 만들었어요.')
  // The write already happened: the note is about reading back after it, never "before writing".
  expect(shown).not.toContain('쓰기 전')
  expect(displayTaskAnswer(result.answer, 'en')).not.toMatch(/Report incomplete|read back of all changed targets/)
  const evidence = 'A requested evidence capture, page check or upload has not been confirmed. Report the failed or inconclusive result; do not claim completion.'
  expect(displayTaskAnswer(`Not verified as complete.\n\n${evidence}\n\nUnverified response:\n끝`, 'ko')).not.toMatch(/[A-Za-z]{4}/)
})
