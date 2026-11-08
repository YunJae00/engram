import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { renderMarkdown } from '../src/renderer/src/lib/markdown.js'
import { DeveloperCode } from '../src/renderer/src/components/DeveloperCode.js'

it('renders tables, nested numbered lists, quotes and safe links without loading model HTML', () => {
  const html = (text: string) => renderToStaticMarkup(createElement('div', null, renderMarkdown(text)))
  const result = html('| PR | Status |\n| --- | --- |\n| 6321 | **Merged** |\n\n1. First\n   - Nested\n2. Second\n\n> Quote\n\n[Docs](https://example.com)')
  expect(result).toContain('<table>')
  expect(result).toContain('<th scope="col">PR</th>')
  expect(result).toContain('<td><strong>Merged</strong></td>')
  expect(result).toContain('<ol start="1"><li>First<ul><li>Nested</li></ul>')
  expect(result).toContain('<blockquote><p>Quote</p></blockquote>')
  expect(result).toContain('rel="noopener noreferrer"')
  const unsafe = html('[Run](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>\n\n![Remote](https://example.com/track)')
  expect(unsafe).not.toContain('href=')
  expect(unsafe).not.toContain('<img')
  expect(unsafe).toContain('&lt;img')
})

it('preserves fenced code indentation, streaming fences and escapes HTML', () => {
  const html = (text: string) => renderToStaticMarkup(createElement('div', null, renderMarkdown(text)))
  expect(html('Before\n\n```ts\n  const x = "<script>"\n```\nAfter')).toContain('<pre><code data-language="ts">  const x = &quot;&lt;script&gt;&quot;</code></pre><p>After</p>')
  expect(html('~~~~\n```\n  code\n~~~')).toContain('```\n  code\n~~~</code>')
  expect(html('```\n<script>alert(1)</script>')).not.toContain('<script>')
})

it('keeps artifact HTML, styles and non-web destinations inert', () => {
  const text = '<style>body { display: none }</style>\n\n<iframe src="file:///secret"></iframe>\n\n<a href="javascript:alert(1)">Run</a>\n\n'
    + '[Script](JaVaScRiPt:alert%281%29) [Encoded](javascript&#58;alert%281%29) [File](file:///secret) [Data](data:text/html,hello) [Relative](../secret) [Remote](//example.com)\n\n'
    + '![Tracking image](https://example.com/track)\n\n[Docs](https://example.com/docs)'
  const html = renderToStaticMarkup(createElement('div', null, renderMarkdown(text)))
  expect(html).not.toMatch(/<(?:style|iframe|img|script)\b/)
  expect(html).toContain('&lt;style&gt;')
  expect(html).toContain('&lt;a href=')
  expect([...html.matchAll(/ href="([^"]+)"/g)].map(match => match[1])).toEqual(['https://example.com/docs'])
  expect(html).toContain('Tracking image')
})

it('highlights supported code without interpreting markup and leaves large blocks plain', () => {
  const render = (text: string, language: string) => renderToStaticMarkup(createElement(DeveloperCode, { text, language }))
  expect(render('const x = "<script>"', 'ts')).toContain('tok-keyword')
  expect(render('<script>alert(1)</script>', 'html')).not.toContain('<script>')
  expect(render('const x = 1;'.repeat(2000), 'ts')).not.toContain('tok-keyword')
})

it('keeps single tildes in ranges literal and still strikes through double tildes', () => {
  const html = (text: string) => renderToStaticMarkup(createElement('div', null, renderMarkdown(text)))
  const range = html('4개 후보(11/17~11/20) 중 2~3개만')
  expect(range).not.toContain('<del>')
  expect(range).toContain('11/17~11/20')
  expect(range).toContain('2~3개만')
  expect(html('~~취소~~')).toContain('<del>취소</del>')
  expect(html('~~~\nconst a = 1\n~~~')).toContain('const a = 1')
  expect(html('~~~\nconst a = 1\n~~~')).not.toContain('<del>')
  const ranges = ['2~3개', '10~15만원', '오전~오후', '월~금', '9시~12시 / 14시~18시', '3~4명', '약 ~5분', '30%~40%']
  for (const text of ranges) {
    expect(html(text), text).not.toContain('<del>')
    expect(html(text), text).toContain(text)
  }
  const line = '회의는 11/17~11/20, 2~3개, 10~15만원, 월~금 9시~12시 / 14시~18시, 3~4명, 30%~40%'
  expect(html(line)).not.toContain('<del>')
  expect(html(line)).toContain(line)
  const bold = html('**11/17~11/20**')
  expect(bold).toContain('<strong>11/17~11/20</strong>')
  expect(bold).not.toContain('<del>')
  const code = html('`a~b~c`')
  expect(code).toContain('<code>a~b~c</code>')
  expect(code).not.toContain('<del>')
  const mixed = html('~~취소된 일정~~ 대신 11/17~11/20, 2~3개')
  expect(mixed).toContain('<del>취소된 일정</del>')
  expect(mixed.match(/<del>/g)).toHaveLength(1)
  expect(mixed).toContain('11/17~11/20, 2~3개')
  expect(html('~~취소된 일정~~')).toContain('<del>취소된 일정</del>')
})
