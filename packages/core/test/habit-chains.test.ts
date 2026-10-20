import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appLabels, changeHabits, habitCandidate, habitChains, habitPrompt, habitsToDraft, readHabits, usedApps, writeHabits, type ActivityStep } from '../src/habit-chains.js'
import { initVault } from '../src/vault.js'

const at = (day: number, minute: number) => new Date(Date.UTC(2026, 9, day, 1, minute)).toISOString()
const span = (app: string, title: string, day: number, from: number, to: number): ActivityStep => ({ app, title, start: at(day, from), end: at(day, to) })

// One job, three days: a message, the sheet, an assistant, the deploy page, the reply.
const job = (day: number, offset = 0): ActivityStep[] => [
  span('chat', `Issue ${day} | Team chat`, day, offset, offset + 3),
  span('sheet', `issues.xlsx - Sheets`, day, offset + 3, offset + 10),
  span('assistant', 'Assistant', day, offset + 10, offset + 25),
  span('browser', `Deploy #${day} - Browser`, day, offset + 25, offset + 35),
  span('chat', `Issue ${day} | Team chat`, day, offset + 35, offset + 37),
]
const noise = (day: number): ActivityStep[] => [
  span('mail', 'Inbox - Mail', day, 200, 210),
  span('browser', 'News - Browser', day, 210, 220),
  span('notes', 'Notes', day, 220, 230),
]

describe('habit chains', () => {
  it('serializes scanning and decisions without losing either change', async () => {
    const paths = await initVault(await mkdtemp(join(tmpdir(), 'habits-')), { git: false })
    await Promise.all([
      changeHabits(paths, async ledger => { await Promise.resolve(); ledger.first = { state: 'kept', at: at(1, 0), times: 3, labels: [] } }),
      changeHabits(paths, ledger => { ledger.second = { state: 'draft', at: at(1, 0), times: 3, labels: [] } }),
    ])
    expect(Object.keys(await readHabits(paths))).toEqual(['first', 'second'])
    await expect(changeHabits(paths, () => { throw new Error('offline') })).rejects.toThrow('offline')
    await changeHabits(paths, ledger => { ledger.second!.state = 'dismissed' })
    expect((await readHabits(paths)).second?.state).toBe('dismissed')
  })
  it('names apps by the title tail most of their windows share', () => {
    const labels = appLabels([...job(1), span('assistant', 'Assistant - Chat about x', 1, 50, 51)])
    expect(labels.get('sheet')).toBe('Sheets')
    expect(labels.get('chat')).toBe('Team chat')
    expect(labels.get('assistant')).toBe('assistant')
  })

  it('ranks used apps by time and counts the days they were used', () => {
    const apps = usedApps([...job(1), ...job(2)])
    expect(apps[0]).toMatchObject({ app: 'assistant', days: 2 })
    expect(apps.find(app => app.app === 'sheet')?.label).toBe('Sheets')
  })

  it('finds the run repeated in separate sittings, longest first, and not the one-off', () => {
    const spans = [...job(1), ...noise(1), ...job(2), ...job(3), ...noise(3)]
    const chains = habitChains(spans)
    expect(chains[0]!.key).toBe('chat>sheet>assistant>browser>chat')
    expect(chains[0]!.times).toHaveLength(3)
    expect(chains.some(chain => chain.key.includes('mail'))).toBe(false)
    // A shorter run held inside the longer one as often is not repeated.
    expect(chains.some(chain => chain.key === 'chat>sheet>assistant')).toBe(false)
    expect(chains[0]!.steps[1]).toMatchObject({ label: 'Sheets', titles: ['issues.xlsx'] })
  })

  it('needs the run in three sittings and leaves out apps the person kept off', () => {
    expect(habitChains([...job(1), ...job(2)])).toEqual([])
    const without = habitChains([...job(1), ...job(2), ...job(3)], new Set(['sheet']))
    expect(without.every(chain => !chain.key.includes('sheet'))).toBe(true)
  })

  it('counts one run once per sitting', () => {
    expect(habitChains([...job(1), ...job(1, 40), ...job(2)])).toEqual([])
  })

  it('asks for the draft in the person language and keeps names out', () => {
    const [chain] = habitChains([...job(1), ...job(2), ...job(3)])
    const prompt = habitPrompt(chain!, 'Korean')
    expect(prompt).toContain('Write everything in Korean, the section headings included.')
    expect(prompt).toContain('open questions')
    expect(prompt).toContain('1. Team chat: "Issue 1"')
    expect(habitCandidate(chain!.key).slug).toMatch(/^habit--[0-9a-f]{24}$/)
  })

  it('drafts a run once, and a declined one again only after it came back twice more', async () => {
    const paths = await initVault(await mkdtemp(join(tmpdir(), 'habits-')), { git: false })
    const [chain] = habitChains([...job(1), ...job(2), ...job(3)])
    expect(habitsToDraft([chain!], await readHabits(paths))).toHaveLength(1)
    await writeHabits(paths, { [chain!.key]: { state: 'declined', at: at(3, 0), times: 3, labels: [] } })
    expect(habitsToDraft([chain!], await readHabits(paths))).toHaveLength(0)
    expect(habitsToDraft([{ ...chain!, times: ['a', 'b', 'c', 'd', 'e'] }], await readHabits(paths))).toHaveLength(1)
    await writeHabits(paths, { [chain!.key]: { state: 'dismissed', at: at(3, 0), times: 3, labels: [] } })
    expect(habitsToDraft([{ ...chain!, times: ['a', 'b', 'c', 'd', 'e', 'f'] }], await readHabits(paths))).toHaveLength(0)
  })
})

describe('what is not an app', () => {
  it('leaves out windows with no title and names a bare-titled app by its title', () => {
    const spans = [span('locked', '', 1, 0, 30), span('mailapp', 'Mail', 1, 30, 40), span('mailapp', 'Mail', 1, 40, 50)]
    expect(usedApps(spans).map(app => app.label)).toEqual(['Mail'])
  })
})
