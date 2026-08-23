import { describe, expect, it } from 'vitest'
import { classifyWall } from '../src/main/agent-browser.js'

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

// A person means Google when they say "search", and it answers a browser that
// is not advertising itself as a robot. These pin the shape the parser reads
// and the furniture it must never call a result.