import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { done, setup } from './task-runner-fixture.js'

async function captured(goal: string, answer: string) {
  const t = await setup(async () => done(answer, 3))
  await t.chat(goal)
  await t.settle('done')
  await vi.waitFor(() => expect(t.remembered).toHaveLength(1))
  const names = await vi.waitFor(async () => { const found = await readdir(t.paths.inbox); expect(found).toHaveLength(1); return found })
  const inbox = await Promise.all(names.map((name) => readFile(join(t.paths.inbox, name), 'utf8')))
  return { text: t.remembered[0]!, inbox: inbox.join('\n') }
}

// One describe so each criterion filter selects its test without skipping the others.
describe('task-finished capture masks labelled secrets', () => {
  it('in the goal', async () => {
    const { text, inbox } = await captured('Make a file called shopping-list.md with three items: PINEAPPLE, eggs, flour. Also my pin is 4821, never repeat it.', 'Saved shopping-list.md')
    expect(text).toContain('Task finished')
    expect(text).toContain('••••••')
    expect(text).not.toContain('4821')
    expect(inbox).not.toContain('4821')
  })

  it('in a result echo of the labelled value', async () => {
    const { text } = await captured('Note that my pin is 4821', 'Saved notes.md with pin 4821 inside')
    expect(text).not.toContain('4821')
    expect(text.split('Result:')[1]).toContain('••••••')
  })

  it('and keeps a plain goal unchanged', async () => {
    const goal = 'Make a file called shopping-list.md with three items: PINEAPPLE, eggs, flour'
    const { text } = await captured(goal, 'Saved shopping-list.md')
    expect(text.split('\n')[0]!.endsWith(`: ${goal}`)).toBe(true)
    expect(text).not.toContain('•')
  })
})
