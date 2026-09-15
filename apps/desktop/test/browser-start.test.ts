import { expect, it } from 'vitest'
import { browserAddress, recentSite } from '../src/renderer/src/lib/browser-start.js'

it('opens addresses directly and encodes search terms', () => {
  expect(browserAddress('example.com/path?q=one')).toBe('https://example.com/path?q=one')
  expect(browserAddress('localhost:3000')).toBe('http://localhost:3000/')
  expect(browserAddress('example.com:8443/page')).toBe('https://example.com:8443/page')
  expect(browserAddress('weather tomorrow')).toBe('https://www.google.com/search?q=weather%20tomorrow')
  expect(browserAddress('안녕')).toBe('https://www.google.com/search?q=%EC%95%88%EB%85%95')
  expect(() => browserAddress('file:///secret')).toThrow('http')
  expect(() => browserAddress('https://user:pass@example.com')).toThrow('credentials')
  expect(() => browserAddress('https://user:pass@example.com/a path')).toThrow('credentials')
  expect(browserAddress('https://example.com/a path')).toBe('https://example.com/a%20path')
})
it('stores only safe origins, not authentication codes or private paths', () => {
  expect(recentSite('https://example.com/private?code=secret#token')).toBe('https://example.com')
  for (const value of ['about:blank', 'javascript:alert(1)', 'https://user:pass@example.com', null, {}]) expect(recentSite(value)).toBeNull()
})
