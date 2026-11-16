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

// qa145 S27: after declining a send card the banner read "작업이 멈췄어요 / You declined a command, so this turn stopped. …".
it('says every other stopped-turn line in the language of the conversation', async () => {
  const { displayTaskAnswer } = await import('../src/renderer/src/lib/threadLang.js')
  const lines = ['You declined a command, so this turn stopped. Waiting for your next instruction.', 'The verification turn ended without a result check.',
    'Stopped at the task budget or fallback turn limit.', 'The turn ended without an answer.', 'The turn ended with unfinished work; waiting for your next instruction.']
  for (const line of lines) {
    expect(displayTaskAnswer(line, 'ko'), line).not.toMatch(/[A-Za-z]{3}/)
    expect(displayTaskAnswer(line, 'en'), line).not.toBe(line)
  }
  expect(displayTaskAnswer(lines[0]!, 'ko')).toBe('진행하지 않기로 하셔서 여기서 멈췄어요. 어떻게 이어갈지 알려주세요.')
  // The lines the task runner writes are the ones mapped here.
  const runner = await readFile(resolve('apps/desktop/src/main/task-runner.ts'), 'utf8'), closing = await readFile(resolve('apps/desktop/src/main/task-closing.ts'), 'utf8')
  for (const line of lines) expect(runner + closing, line).toContain(`'${line}'`)
})

// qa145 S30: after a relaunch the thread is not loaded yet, and the sidebar read a Korean conversation's unconfirmed result in English.
it('previews a saved last message in its own language before the thread is opened', async () => {
  const { lastPreview } = await import('../src/renderer/src/lib/teamView.js')
  const text = 'Not verified as complete.\n\n내장 브라우저로 로컬 form.html을 열어 이름 QA145를 입력했어요.'
  const shown = lastPreview(text, [], { role: 'assistant', text })
  expect(shown).toMatch(/^확인하지 못한 항목이 있어요\./)
  expect(shown).not.toContain('Some results could not be confirmed')
})

it('shows the error card in the language of the conversation', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ErrorAnswer } = await import('../src/renderer/src/components/ErrorAnswer.js')
  const ko = renderToStaticMarkup(createElement(ErrorAnswer, { text: 'API Error: 400 does not support this model', lang: 'ko' }))
  // One human line that says what to do next: no raw error, no details to open, no buttons.
  expect(ko).toContain('문제가 생겨서 이번 건 끝내지 못했어요. 한 번 더 말씀해 주시면 다시 해볼게요.')
  for (const leaked of ['API Error', '400', 'model', '<button', '<details', 'Could not', 'Something went wrong']) expect(ko).not.toContain(leaked)
  const en = renderToStaticMarkup(createElement(ErrorAnswer, { text: '[claude] {"type":"error","error":{"message":"overloaded_error"}}', kind: 'outage', lang: 'en' }))
  expect(en).toContain('Send the same message again in a minute.')
  for (const leaked of ['overloaded_error', '{', '<button', '<details']) expect(en).not.toContain(leaked)
  // A sentence the app itself wrote for the person, in their language, is shown as written.
  expect(renderToStaticMarkup(createElement(ErrorAnswer, { text: '지금은 로그인이 풀려 있어요. 설정에서 다시 로그인해 주세요.', lang: 'ko' }))).toContain('다시 로그인해 주세요.')
})

it('does not show the verifier\'s model-facing reason to the person; a delivered answer is shown alone', async () => {
  const { displayTaskAnswer } = await import('../src/renderer/src/lib/threadLang.js')
  const { checkOfficeResult } = await import('../../../packages/core/src/office-verification.js')
  // An Office write that was never read back: the host still marks the turn incomplete.
  const result = checkOfficeResult({ answer: '슬라이드 4장을 만들었어요.', steps: [{ tool: 'ppt_build', args: {}, observation: '{}' }], fellBack: false })
  expect(result.incomplete).toContain('Report incomplete or unverified work')
  // grokbar D3 (stack2-d469cddf): "확인하지 못한 항목이 있어요. … 사용하기 전에 파일을 열어 확인해 주세요." stood over a finished deck. The host's
  // doubt is its own (the turn is still marked incomplete above); the person reads the answer.
  expect(displayTaskAnswer(result.answer, 'ko')).toBe('슬라이드 4장을 만들었어요.')
  expect(displayTaskAnswer(result.answer, 'en')).toBe('슬라이드 4장을 만들었어요.')
  // With no answer under it the note is said in the person's language. The write already happened: it is about reading back after it, never "before writing".
  const shown = displayTaskAnswer(`Not verified as complete.\n\n${result.incomplete}`, 'ko')
  expect(shown).toBe('확인하지 못한 항목이 있어요.\n\n파일을 쓴 뒤에 다시 읽어 확인하지 못했어요. 사용하기 전에 파일을 열어 확인해 주세요.')
  expect(shown).not.toContain('쓰기 전')
  expect(displayTaskAnswer(`Not verified as complete.\n\n${result.incomplete}`, 'en')).not.toMatch(/Report incomplete|read back of all changed targets/)
  const evidence = 'A requested evidence capture, page check or upload has not been confirmed. Report the failed or inconclusive result; do not claim completion.'
  expect(displayTaskAnswer(`Not verified as complete.\n\n${evidence}\n\nUnverified response:\n끝`, 'ko')).toBe('끝')
  expect(displayTaskAnswer(`Not verified as complete.\n\n${evidence}`, 'ko')).not.toMatch(/[A-Za-z]{4}/)
})
