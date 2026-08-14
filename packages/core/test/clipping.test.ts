import { describe, expect, it } from 'vitest'
import { clipUrl, parseHtmlClip } from '../src/clipping.js'

const HTML = `<!doctype html>
<html><head>
<title>Engram &amp; Friends — Release Notes</title>
<meta name="description" content="What changed in v2">
</head><body>
<nav>Home | Docs</nav>
<article>
<h1>Release v2</h1>
<p>Faster sweeps &amp; better cards.</p>
<script>alert('x')</script>
<p>Second paragraph.</p>
</article>
</body></html>`

describe('url clipping', () => {
  it('extracts title, description and readable text', () => {
    const clip = parseHtmlClip('https://example.com/notes', HTML)
    expect(clip.title).toBe('Engram & Friends — Release Notes')
    expect(clip.description).toBe('What changed in v2')
    expect(clip.text).toContain('Faster sweeps & better cards.')
    expect(clip.text).toContain('Second paragraph.')
    expect(clip.text).not.toContain('alert')
    expect(clip.text).not.toContain('Home | Docs') // article beats nav
  })

  it('clipUrl renders markdown via injected fetch', async () => {
    const md = await clipUrl('https://example.com/notes', async () => ({ text: async () => HTML }))
    expect(md).toContain('# Engram & Friends — Release Notes')
    expect(md).toContain('> https://example.com/notes')
  })

  it('refuses non-http(s) schemes (SSRF guard) — never even calls fetch', async () => {
    let called = false
    const spyFetch = async () => {
      called = true
      return { text: async () => '' }
    }
    for (const bad of ['file:///etc/passwd', 'http://169.254.169.254/'.replace('http', 'ftp'), 'data:text/html,x']) {
      await expect(clipUrl(bad, spyFetch)).rejects.toThrow()
    }
    await expect(clipUrl('not a url', spyFetch)).rejects.toThrow()
    expect(called).toBe(false)
  })
})
