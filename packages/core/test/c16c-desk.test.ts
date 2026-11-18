import { describe, expect, it } from 'vitest'
import { checkPrompt, readProblems } from '../src/written-check.js'

const input = { data: { source: '## 합의\n1. 문서 작성 — 이수진' }, ask: '킥오프 메모 합의된 것, 리스크, 다음 단계로 나눠줘' }
describe('kind "missing": a part the ask names is not its own part of the message', () => {
  it('is asked of a text with parts and of a text held to its ask, and of nothing else', () => {
    expect(checkPrompt({ ...input, parts: true }, 'm')).toContain('"missing"')
    expect(checkPrompt({ ...input, askConstraints: true }, 'm')).toContain('"missing"')
    expect(checkPrompt(input, 'm')).not.toContain('"missing"')
    expect(checkPrompt({ ...input, rewrite: true }, 'm')).not.toContain('"missing"')
    expect(checkPrompt({ ...input, parts: true }, 'm')).toContain('the source\'s own headings do not decide')
    expect(readProblems('{"problems":[{"kind":"missing","quote":"리스크","why":"없음"}]}')).toEqual([{ kind: 'missing', quote: '리스크', why: '없음' }])
  })
})
describe('"asks" leaves one closing offer alone (rule 15) and still catches a question before the work', () => {
  it('says both in its line', () => {
    const line = checkPrompt(input, '정리했어요.\n원하시면 표로도 만들어 드릴게요.').split('\n').find(l => l.startsWith('- "asks"'))!
    expect(line).toContain('One short closing offer of a further step after the work is done')
    expect(line).toContain('a question or a choice before the work, or a menu of options, is')
  })
})
describe('"dropped" on a rewrite covers the earlier ask\'s facts', () => {
  it('who, what, for what, when survive a shorter form', () => {
    expect(checkPrompt({ ...input, rewrite: true }, 'm')).toContain('a shorter or simpler form removes words, never one of those facts')
  })
})
