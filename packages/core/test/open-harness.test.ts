import { describe, expect, it } from 'vitest'
import { openStepSchema, stepSchema } from '../src/agent-prompt.js'
import { titleFromMessage } from '../src/bots.js'
import { looksLikeSearchFor } from '../src/comet-tools.js'
import type { AgentTool } from '../src/agent-loop.js'

const tools: AgentTool[] = [
  { name: 'search_web', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => '' },
  { name: 'open_page', description: 'open', argsSchema: { type: 'object', properties: { url: { type: 'string' } } }, run: async () => '' },
]

const links = (count: number) => Array.from({ length: count }, (_, i) => ({ text: `result ${i}`, url: `https://x.example/${i}` }))

describe('a search shape is learned only from a search the comet ran for its task', () => {
  it('a results page whose address carries the task words is the search', () => {
    expect(looksLikeSearchFor('https://find.example/results?q=electron+memory+leak', 'find the electron memory leak thread', { links: links(12) })).toBe(true)
  })

  it('a query string alone is not a search - videos, tickets and trackers carry them too', () => {
    expect(looksLikeSearchFor('https://video.example/watch?v=dQw4w9WgXcQ', 'find the electron memory leak thread', { links: links(12) })).toBe(false)
    expect(looksLikeSearchFor('https://tickets.example/issue?id=4821', 'find the electron memory leak thread', { links: links(12) })).toBe(false)
  })

  it('a page with the task words but no list of links is an article, not results', () => {
    expect(looksLikeSearchFor('https://blog.example/post?topic=electron+memory', 'find the electron memory leak thread', { links: links(2) })).toBe(false)
  })

  it('an unreadable address learns nothing', () => {
    expect(looksLikeSearchFor('not a url?q=electron', 'electron', { links: links(12) })).toBe(false)
  })
})

describe('the open step shape suits a hosted structured-output runtime', () => {
  it('is one closed object over the tool names, with the arguments left open', () => {
    const schema = openStepSchema(tools) as { properties: { tool: { enum: string[] } }; required: string[]; additionalProperties: boolean; oneOf?: unknown }
    expect(schema.properties.tool.enum).toEqual(['search_web', 'open_page', 'answer'])
    expect(schema.required).toEqual(['tool', 'args'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.oneOf).toBeUndefined()
  })

  it('the guided shape stays the exact one the local grammar compiles', () => {
    expect((stepSchema(tools) as { oneOf?: unknown[] }).oneOf?.length).toBe(3)
  })
})

describe('a comet named by its first words', () => {
  it('cuts by whole characters, never through one', () => {
    const emoji = '🙂'.repeat(60)
    const name = titleFromMessage(emoji)
    expect(name.endsWith('…')).toBe(true)
    expect([...name.slice(0, -1)].every((char) => char === '🙂')).toBe(true)
  })
})

describe('a results page is recognised by the shape of the person\'s search', () => {
  it('matches the host and the query parameter, whatever the words', async () => {
    const { isResultsPage } = await import('../src/comet-tools.js')
    expect(isResultsPage('https://find.example/search?q=vitest+latest&p=2', 'https://find.example/search?q={q}')).toBe(true)
    expect(isResultsPage('https://find.example/settings', 'https://find.example/search?q={q}')).toBe(false)
    expect(isResultsPage('https://www.npmjs.com/package/vitest', 'https://find.example/search?q={q}')).toBe(false)
    expect(isResultsPage('nonsense', 'https://find.example/search?q={q}')).toBe(false)
  })
})

describe('a long page is read in parts', () => {
  it('reports which part this is and how to get the next, and the last part is the last', async () => {
    const { cometTools } = await import('../src/comet-tools.js')
    const { initVault } = await import('../src/vault.js')
    const { tmpVaultRoot } = await import('./helpers.js')
    const paths = await initVault(await tmpVaultRoot('tools-parts'), { git: false })
    const text = 'A'.repeat(3_000) + 'B'.repeat(3_000) + 'C'.repeat(100)
    const read = cometTools({
      paths,
      retrieve: async () => [],
      courier: { fetchPage: async (url) => ({ url, title: 'Long', text }), readOpen: async () => ({ url: 'https://x.example/long', title: 'Long', text }) },
    }).find((t) => t.name === 'read_open_page')!
    const first = await read.run({}, { task: 'read it' })
    expect(first).toContain('part 1 of 3')
    expect(first).toContain('"part": 2')
    expect(first).toContain('AAAA')
    expect(first).not.toContain('BBBB')
    const last = await read.run({ part: 3 }, { task: 'read it' })
    expect(last).toContain('part 3 of 3')
    expect(last).not.toContain('"part": 4')
    expect(last).toContain('CCC')
  })

  it('a word to find jumps to the part that holds it, or says the page has not got it', async () => {
    const { cometTools } = await import('../src/comet-tools.js')
    const { initVault } = await import('../src/vault.js')
    const { tmpVaultRoot } = await import('./helpers.js')
    const paths = await initVault(await tmpVaultRoot('tools-find'), { git: false })
    const text = 'A'.repeat(3_000) + 'B'.repeat(3_000) + 'price 12 won'
    const read = cometTools({
      paths,
      retrieve: async () => [],
      courier: { fetchPage: async (url) => ({ url, title: 'Long', text }), readOpen: async () => ({ url: 'https://x.example/long', title: 'Long', text }) },
    }).find((t) => t.name === 'read_open_page')!
    const found = await read.run({ find: 'Price' }, { task: 'read it' })
    expect(found).toContain('part 3 of 3')
    expect(found).toContain('"Price" is in part 3')
    expect(found).toContain('price 12 won')
    const missing = await read.run({ find: 'shipping' }, { task: 'read it' })
    expect(missing).toContain('not in any of its 3 parts')
    expect(missing).not.toContain('AAAA')
  })
})

describe('press moves around a page and refuses to commit', () => {
  it('reads what a press brought up, turns a committing press into a question, and says when nothing matched', async () => {
    const { cometTools } = await import('../src/comet-tools.js')
    const { initVault } = await import('../src/vault.js')
    const { tmpVaultRoot } = await import('./helpers.js')
    const paths = await initVault(await tmpVaultRoot('tools-press'), { git: false })
    let shown = 'week of the 24th'
    const tools = cometTools({
      paths,
      retrieve: async () => [],
      courier: {
        fetchPage: async (url) => ({ url, title: 'Report', text: shown }),
        readOpen: async () => ({ url: 'https://x.example/report', title: 'Report', text: shown }),
        press: async (target) => {
          if (target === 'Submit') return { ok: false, refused: 'Submit' }
          if (target === 'Previous week') {
            shown = 'week of the 17th'
            return { ok: true }
          }
          return { ok: false, error: 'missing' }
        },
      },
    })
    const press = tools.find((t) => t.name === 'press')!
    expect(await press.run({ target: 'Previous week' }, { task: 'last week' })).toContain('week of the 17th')
    expect(await press.run({ target: 'Submit' }, { task: 'last week' })).toContain('would submit or commit')
    expect(await press.run({ target: 'Nowhere' }, { task: 'last week' })).toContain('read_open_page lists')
    expect(await press.run({}, { task: 'last week' })).toContain('needs the words')
  })

  it('is not on offer when the browser cannot press', async () => {
    const { cometTools } = await import('../src/comet-tools.js')
    const { initVault } = await import('../src/vault.js')
    const { tmpVaultRoot } = await import('./helpers.js')
    const paths = await initVault(await tmpVaultRoot('tools-nopress'), { git: false })
    const names = cometTools({ paths, retrieve: async () => [], courier: { fetchPage: async (url) => ({ url, title: 'x', text: 'y' }) } }).map((t) => t.name)
    expect(names).not.toContain('press')
  })
})
