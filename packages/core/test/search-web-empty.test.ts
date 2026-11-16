import { expect, it } from 'vitest'
import { navigationTools } from '../src/comet-navigation-tools.js'
import type { CometToolDeps } from '../src/comet-tools.js'

const search = (fetchPage: () => Promise<unknown>) => navigationTools({ courier: { fetchPage }, guided: false, searchTemplate: async () => 'https://search.example/?q={q}' } as unknown as CometToolDeps)
  .find(tool => tool.name === 'search_web')!.run({ query: '부산 날씨' }, { task: '부산 날씨', steps: [], read: '' } as never)

// perf146: search_web came back in 18-25 ms because the browser refused a tab; the members read that as "no results" and guessed addresses.
it('says the search did not run when the results page could not be loaded', async () => {
  const said = await search(async () => { throw new Error('not enough free memory for another browser tab right now (0.9GB free).') })
  expect(said).toContain('did not run')
  expect(said).toContain('not enough free memory')
  expect(said).not.toMatch(/nothing that came back/)
})

it('says an empty results page is empty, not unrelated', async () => {
  const said = await search(async () => ({ url: 'https://search.example/?q=x', title: '', text: '', links: [] }))
  expect(said).toContain('returned an empty page')
  expect(said).not.toMatch(/nothing that came back/)
})

// grokbar: with no search address learned, search_web answered "open a results page yourself" in 1 ms and the page the model guessed met a robot check.
it('searches a default results page until the person\'s own search is learned, and hands back the page\'s own answer', async () => {
  const { defaultSearchTemplate } = await import('../src/search-template.js')
  expect(defaultSearchTemplate('부산 날씨')).toBe('https://search.naver.com/search.naver?query={q}')
  expect(defaultSearchTemplate('Seoul weather')).toBe('https://www.bing.com/search?q={q}')
  const asked: string[] = []
  const prose = `${'부산 날씨 메뉴 '.repeat(60)}현재 온도 14.5° 습도 92% 약한 비`
  const run = (searchTemplate?: () => Promise<string | null>) => navigationTools({ courier: { fetchPage: async (url: string) => { asked.push(url); return { url, title: '부산 날씨', text: prose, links: [{ text: '부산 날씨 예보', url: 'https://weather.example/busan' }] } } }, guided: false, ...(searchTemplate ? { searchTemplate } : {}) } as unknown as CometToolDeps)
    .find(tool => tool.name === 'search_web')!.run({ query: '부산 날씨' }, { task: '부산 날씨', steps: [], read: '' } as never)
  const said = await run(async () => null)
  await run()
  await run(async () => 'https://search.example/?q={q}')
  expect(asked).toEqual([`https://search.naver.com/search.naver?query=${encodeURIComponent('부산 날씨')}`, `https://search.naver.com/search.naver?query=${encodeURIComponent('부산 날씨')}`, `https://search.example/?q=${encodeURIComponent('부산 날씨')}`])
  expect(said).toContain('results for "부산 날씨"')
  expect(said).toContain('현재 온도 14.5°')
  expect(said).not.toMatch(/no search address|Where should I search/)
})
