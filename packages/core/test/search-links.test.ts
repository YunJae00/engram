import { describe, expect, it, vi } from 'vitest'
import { namedTarget, resolveResultLinks } from '../src/search-links.js'

const PAGE = 'https://www.google.com/search?q=ai+jobs'

describe('search result links', () => {
  it('reads a target the wrapper names in the clear', () => {
    expect(namedTarget('https://www.google.com/url?q=https://www.catch.co.kr/Recruit/1&sa=U')).toBe('https://www.catch.co.kr/Recruit/1')
    expect(namedTarget('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa')).toBe('https://example.com/a')
    expect(namedTarget('https://www.google.com/goto?url=CAESmQEB6zswFXBs')).toBeNull()
    expect(namedTarget('https://www.google.com/url?q=https://www.google.com/maps')).toBeNull()
  })

  it('follows the engine redirect for opaque links, leaving other links alone', async () => {
    const follow = vi.fn(async (url: string) => url.includes('CAES1') ? 'https://www.jobkorea.co.kr/Search/?stext=ai' : null)
    const links = await resolveResultLinks([
      { text: 'JobKorea', url: 'https://www.google.com/goto?url=CAES1' },
      { text: 'Broken', url: 'https://www.google.com/goto?url=CAES2' },
      { text: 'Direct', url: 'https://www.saramin.co.kr/jobs' },
      { text: 'Named', url: 'https://www.google.com/url?q=https://www.catch.co.kr/x' },
    ], PAGE, follow)
    expect(links.map(link => link.url)).toEqual(['https://www.jobkorea.co.kr/Search/?stext=ai', 'https://www.google.com/goto?url=CAES2', 'https://www.saramin.co.kr/jobs', 'https://www.catch.co.kr/x'])
    expect(follow).toHaveBeenCalledTimes(2)
  })

  it('never lets a slow or failing redirect hold the results back', async () => {
    vi.useFakeTimers()
    try {
      const follow = vi.fn((_url: string, signal?: AbortSignal) => new Promise<string | null>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))))
      const pending = resolveResultLinks([{ text: 'Slow', url: 'https://www.google.com/goto?url=CAES9' }], PAGE, follow)
      await vi.advanceTimersByTimeAsync(10_100)
      expect((await pending)[0]!.url).toBe('https://www.google.com/goto?url=CAES9')
    } finally { vi.useRealTimers() }
  })
})

describe('one site across its hosts', () => {
  it('treats an engine and its www host, and country second-level domains, as one site', async () => {
    const { siteOf } = await import('../src/search-links.js')
    expect(siteOf('www.google.com')).toBe(siteOf('google.com'))
    expect(siteOf('search.naver.co.kr')).toBe('naver.co.kr')
    expect(siteOf('m.place.naver.com')).toBe('naver.com')
    const follow = vi.fn(async () => 'https://www.catch.co.kr/Recruit/1')
    const [link] = await resolveResultLinks([{ text: 'Posting', url: 'https://google.com/goto?url=CAES1' }], PAGE, follow)
    expect(link!.url).toBe('https://www.catch.co.kr/Recruit/1')
  })
})
