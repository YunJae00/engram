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

it('highlights supported code without interpreting markup and leaves large blocks plain', () => {
  const render = (text: string, language: string) => renderToStaticMarkup(createElement(DeveloperCode, { text, language }))
  expect(render('const x = "<script>"', 'ts')).toContain('tok-keyword')
  expect(render('<script>alert(1)</script>', 'html')).not.toContain('<script>')
  expect(render('const x = 1;'.repeat(2000), 'ts')).not.toContain('tok-keyword')
})
