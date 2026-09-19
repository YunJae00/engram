import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { renderMarkdown } from '../src/renderer/src/lib/markdown.js'
import { DeveloperCode } from '../src/renderer/src/components/DeveloperCode.js'

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
