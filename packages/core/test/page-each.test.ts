import { expect, it } from 'vitest'
import { pageEachTool } from '../src/page-each.js'
import type { WebCourier } from '../src/errand.js'

// A record site where each project is chosen from a menu and searched.
function site(log: string[]): WebCourier {
  let shown = 'pick a project'
  const hours: Record<string, string> = { 'P-01': 'Kim 6.0h, Lee 2.0h', 'P-02': 'Park 3.0h' }
  return {
    fetchPage: async (url) => ({ url, title: 'Hours', text: shown }),
    readOpen: async () => ({ url: 'https://x.example/hours', title: 'Hours', text: shown }),
    choose: async (target, option) => {
      log.push(`choose ${target}:${option}`)
      if (!(option in hours) && option !== 'P-03') return { ok: false, error: `no option "${option}"` }
      shown = `${option}: (press Search)`
      return { ok: true }
    },
    press: async (target) => {
      log.push(`press ${target}`)
      if (target === 'Approve all') return { ok: false, refused: 'Approve all' }
      shown = shown.replace(/^(\S+): \(press Search\)$/, (_, project: string) => `${project}: ${hours[project] ?? 'no entries'}`)
      return { ok: true }
    },
    typeText: async () => ({ ok: true }),
    pressKey: async () => ({ ok: true }),
  }
}

const context = { task: 'team hours by project', steps: [], read: '' }

it('goes through every value with the same moves and reads each one', async () => {
  const log: string[] = []
  const tool = pageEachTool(site(log))!
  const report = await tool.run({ values: ['P-01', 'P-02', 'P-09', 'P-03'], steps: [{ do: 'choose', target: 'Project', option: '{value}' }, { do: 'press', target: 'Search' }] }, context)
  expect(report).toContain('Went through 3 of 4 values. Not read: P-09 (no option "P-09").')
  expect(report).toContain('## P-01\nP-01: Kim 6.0h, Lee 2.0h')
  expect(report).toContain('## P-02\nP-02: Park 3.0h')
  expect(report).toContain('## P-03\nP-03: no entries')
  expect(log).toEqual(['choose Project:P-01', 'press Search', 'choose Project:P-02', 'press Search', 'choose Project:P-09', 'choose Project:P-03', 'press Search'])
})

it('stops the whole run at anything that would commit', async () => {
  const log: string[] = []
  const report = await pageEachTool(site(log))!.run({ values: ['P-01', 'P-02'], steps: [{ do: 'choose', target: 'Project', option: '{value}' }, { do: 'press', target: 'Approve all' }] }, context)
  expect(report).toContain('Went through 0 of 2 values.')
  expect(report).toContain('"Approve all" would commit something')
  expect(log).toEqual(['choose Project:P-01', 'press Approve all'])
})

it('asks for a list and moves before doing anything', async () => {
  const tool = pageEachTool(site([]))!
  expect(await tool.run({ values: [], steps: [{ do: 'press', target: 'Search' }] }, context)).toContain('needs 1 to 60 values')
  expect(await tool.run({ values: ['P-01'], steps: [] }, context)).toContain('needs 1 to 8 moves')
})

it('preserves an approved commit for verification and stops the remaining moves', async () => {
  const log: string[] = []
  const courier = site(log)
  courier.press = async target => { log.push(`press ${target}`); return { ok: true, committed: true } }
  const report = await pageEachTool(courier)!.run({ values: ['P-01', 'P-02'], steps: [{ do: 'press', target: 'Save' }, { do: 'press', target: 'Next' }] }, context)
  expect(report).toMatchObject({ committed: true, text: expect.stringContaining('verify the changed state') })
  expect(log).toEqual(['press Save'])
})
