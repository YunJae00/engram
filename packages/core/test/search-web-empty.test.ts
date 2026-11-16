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
