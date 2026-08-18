import { describe, expect, it } from 'vitest'
import { classifyWall, parseDuckResults } from '../src/main/agent-browser.js'

// Pure heuristics only — the browser itself is exercised by the errand
// battery script, not by unit tests.

describe('classifyWall', () => {
  it('reads a human check from title or text', () => {
    expect(classifyWall('https://a.com/x', 'Are you a robot?', '', false)).toBe('captcha')
    expect(classifyWall('https://a.com/x', 'Site', 'complete the CAPTCHA to continue', false)).toBe('captcha')
    expect(classifyWall('https://a.com/x', 'Just a moment', 'Cloudflare is checking your browser', false)).toBe('captcha')
  })

  it('reads a login wall from a password field or an auth path', () => {
    expect(classifyWall('https://a.com/page', 'Welcome', 'enter your credentials', true)).toBe('login')
    expect(classifyWall('https://a.com/login', 'Site', 'plain text', false)).toBe('login')
    expect(classifyWall('https://sso.corp.com/sign-in?next=/wiki', 'SSO', '', false)).toBe('login')
  })

  it('lets an ordinary article through', () => {
    expect(classifyWall('https://a.com/blog/post', 'A post about signing paperwork', 'body text', false)).toBe(null)
  })

  it('captcha wins over a password field — the check comes first', () => {
    expect(classifyWall('https://a.com/login', 'Verify you are human', '', true)).toBe('captcha')
  })
})

describe('parseDuckResults', () => {
  const row = (href: string, label: string) => `<a rel="nofollow" class="result__a" href="${href}">${label}</a>`

  it('decodes the uddg tunnel and strips markup from titles', () => {
    const html = row('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc', 'Example <b>Docs</b>')
    expect(parseDuckResults(html)).toEqual([{ url: 'https://example.com/docs', title: 'Example Docs', snippet: '' }])
  })

  it('keeps direct http hrefs and drops everything else', () => {
    const html = row('https://direct.com/a', 'Direct') + row('/relative/only', 'Relative')
    expect(parseDuckResults(html).map((f) => f.url)).toEqual(['https://direct.com/a'])
  })

  it('drops ad rows', () => {
    const html =
      row('https://duckduckgo.com/y.js?ad_domain=ads.com&u3=x', 'Ad') + row('https://real.com/a', 'Real')
    expect(parseDuckResults(html).map((f) => f.url)).toEqual(['https://real.com/a'])
  })

  it('caps the result count', () => {
    const html = Array.from({ length: 20 }, (_, i) => row(`https://s${i}.com/a`, `S${i}`)).join('')
    expect(parseDuckResults(html).length).toBeLessThanOrEqual(8)
  })
})
