import { describe, expect, it } from 'vitest'
import { answerHtml } from '../src/renderer/src/markdown.js'

// What the local model actually emits, and what the user must end up seeing.

describe('answerHtml', () => {
  it('unwraps an answer the model fenced as ```markdown', () => {
    const html = answerHtml('```markdown\n* first point\n* second point\n```')
    expect(html).toContain('<li>')
    expect(html).not.toContain('<pre>')
  })

  it('unwraps mid-stream, before the closing fence has arrived', () => {
    expect(answerHtml('```markdown\n* first point')).toContain('<li>')
  })

  it('leaves a real code block alone', () => {
    const html = answerHtml('Here is how:\n\n```ts\nconst a = 1\n```')
    expect(html).toContain('<pre>')
  })

  it('dedents an indented answer so prose stays prose', () => {
    const html = answerHtml('    We decided to split the worker.\n    It works now.')
    expect(html).not.toContain('<pre>')
    expect(html).toContain('We decided')
  })

  it('hides the capture marker tail', () => {
    expect(answerHtml('Saved it.\n<engram:capture>buy milk</engram:capture>')).not.toContain('buy milk')
  })
})
