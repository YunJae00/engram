import { describe, expect, it } from 'vitest'
import { suggestedReplies, answerBubbles, answerFiles, answerHtml, answerReplies, answerText, memorySources } from '../src/renderer/src/markdown.js'

// What the local model actually emits, and what the user must end up seeing.

describe('answerHtml', () => {
  it('renders escaped paragraphs and numbered choices while keeping code escapes literal', () => {
    const text = String.raw`Today is empty.\n\n1) Draft items\n2) Enter actual hours\n\nWhich option?`
    const html = answerHtml(text)
    expect(html).toContain('<ol>')
    expect(html).toContain('<li>Draft items</li>')
    expect(html).not.toContain(String.raw`\n`)
    expect(answerHtml('```markdown\n' + text + '\n```')).not.toContain(String.raw`\n`)
    expect(answerText('```markdown\n' + text + '\n```')).toBe('Today is empty.\n\n1) Draft items\n2) Enter actual hours\n\nWhich option?')
    expect(answerHtml('```js\n' + String.raw`const text = 'first\n\nsecond'` + '\n```')).toContain(String.raw`first\n\nsecond`)
  })
  it('numbers unique memory references without changing ordinary links or code', () => {
    const text = 'First [Decision](note://n-one), again [same](note://n-one). [Website](https://example.com).\n\n`[not a source](note://n-code)`'
    const sources = memorySources(text)
    expect(sources).toEqual([{ url: 'note://n-one', label: 'Decision' }])
    const html = answerHtml(text, [], sources.map(source => source.url))
    expect(html).toContain('aria-label="Memory source 1">1</a>')
    expect(html).toContain('>Website</a>')
    expect(html).toContain('<code>')
  })
  it('removes only bare source links represented by a clickable source chip', () => {
    const urls = ['https://example.com/']
    expect(answerHtml('Done.\n\nhttps://example.com', urls)).not.toContain('<a')
    expect(answerHtml('[https://example.com](https://example.com)', urls)).not.toContain('<a')
    expect(answerHtml('[Read the details](https://example.com)', urls)).toContain('<a')
    expect(answerHtml('Source: https://example.com', urls)).toContain('Source:')
    expect(answerHtml('https://example.com/another', urls)).toContain('<a')
    expect(answerHtml('```\nhttps://example.com\n```', urls)).toContain('https://example.com')
    expect(answerHtml('https://example.com')).toContain('<a')
  })
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

  it('keeps a standalone code fence and its indentation with a copy action', () => {
    const html = answerHtml('```python\nif ready:\n    run()\n```')
    expect(html).toContain('language-python')
    expect(html).toContain('    run()')
    expect(html).toContain('data-copy-code="true"')
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

describe('found items and suggested replies', () => {
  const table = '| Company | Size | Deadline |\n| --- | --- | --- |\n| [AhnLab](https://example.com/a) | Mid-size | Oct 25 |\n| Kyowon | Mid-size |  |'

  it('shows a table of items as cards, keeping two-column tables as tables', () => {
    const html = answerHtml(`Found these:\n\n${table}`)
    expect(html).toContain('class="answer-cards"')
    expect(html.match(/class="answer-card"/g)).toHaveLength(2)
    expect(html).toContain('<div class="answer-card-title"><a href="https://example.com/a">AhnLab</a></div>')
    expect(html).toContain('<dt>Deadline</dt><dd>Oct 25</dd>')
    expect(html).not.toContain('<dt>Deadline</dt><dd></dd>')
    expect(answerHtml('| Day | Hours |\n| --- | --- |\n| Mon | 8 |')).toContain('<table>')
  })

  it('takes suggested replies out of the text and offers at most three', () => {
    const text = 'Done.\n\n```replies\n- Show only open ones\n2. Add to my calendar\nApply to the first\nOne too many\n```'
    expect(answerReplies(text)).toEqual(['Show only open ones', 'Add to my calendar', 'Apply to the first'])
    expect(answerText(text)).toBe('Done.')
    expect(answerHtml(text)).not.toContain('Show only open ones')
    // Mid-stream the block is hidden at once and offers nothing until it closes.
    expect(answerText('Done.\n\n```replies\n- Show')).toBe('Done.')
    expect(answerReplies('Done.\n\n```replies\n- Show')).toEqual([])
  })
})

describe('an answer as a few short messages', () => {
  it('keeps reliable localized suggestions without splitting code or reply fences', () => {
    expect(suggestedReplies('찾았어요.')).toEqual(['좀 더 자세히 알려줘', '핵심만 요약해줘'])
    expect(suggestedReplies('Done.')).toHaveLength(2)
    expect(suggestedReplies('Done.\n```replies\nMore\nMore\n```')).toHaveLength(2)
    expect(answerBubbles('~~~js\na\n---\nb\n~~~')).toEqual(['~~~js\na\n---\nb\n~~~'])
    expect(answerBubbles('Done.\n---\nDetails.\n```replies\nMore\n---\n```')).toEqual(['Done.', 'Details.'])
  })
  it('splits at a line of only --- outside code, and keeps an answer without one whole', () => {
    expect(answerBubbles('Found 3 postings.\n---\n| Name | Due |\n|---|---|\n| A | 10/20 |\n---\nWant more?')).toEqual(['Found 3 postings.', '| Name | Due |\n|---|---|\n| A | 10/20 |', 'Want more?'])
    expect(answerBubbles('```\na\n---\nb\n```')).toEqual(['```\na\n---\nb\n```'])
    expect(answerBubbles('Just one line.')).toEqual(['Just one line.'])
    expect(answerBubbles('Done.\n---\n')).toEqual(['Done.'])
  })
})

describe('files an answer made', () => {
  it('keeps malformed links when another file has a valid card', () => {
    const broken = '[Broken](engram-artifact:%ZZ)'
    const result = answerFiles(`[Sheet](engram-artifact:draft.xlsx)\n${broken}`)
    expect(result.text).toBe(broken)
    expect(result.files).toEqual([{ id: 'draft.xlsx', name: 'draft.xlsx' }])
  })
  it('turns a line that is only a file link into a card and keeps links inside sentences', () => {
    const sheet = '599c52d8-db2c-c91a-4bd4-ea0bbe13862e-2026-10-21_draft.xlsx'
    const text = `Made the draft. [Get the sheet](engram-artifact:${encodeURIComponent(sheet)})

[2026-10-21_draft.xlsx](engram-artifact:${encodeURIComponent(sheet)})

Done.`
    const { text: body, files } = answerFiles(text)
    expect(files).toEqual([{ id: sheet, name: '2026-10-21_draft.xlsx' }])
    expect(body).toContain('[Get the sheet]')
    expect(body).not.toContain('[2026-10-21_draft.xlsx]')
    expect(answerFiles('No files here.')).toEqual({ text: 'No files here.', files: [] })
  })
})
