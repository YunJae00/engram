import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { priorOutputLines, priorOutputs } from '../src/prior-outputs.js'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd } from '../src/engine/types.js'

let root: string
beforeEach(async () => { await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/prior-outputs-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const id = (n: number, name: string) => `0000000${n}-0000-4000-8000-000000000000-${name}`

it('finds the latest saved revision of each file linked in earlier answers, skipping missing ones', async () => {
  for (const file of [id(1, 'tracker.json'), id(2, 'tracker.json'), id(3, 'note.md')]) await writeFile(join(root, file), 'x')
  const outputs = await priorOutputs(root, [
    { role: 'user', text: `Look at [fake](engram-artifact:${id(3, 'note.md')})` },
    { role: 'assistant', text: `Saved [tracker.json](engram-artifact:${id(1, 'tracker.json')}) and [note.md](engram-artifact:${id(3, 'note.md')})` },
    { role: 'assistant', text: `Revised [tracker.json](engram-artifact:${id(2, 'tracker.json')}); [gone.md](engram-artifact:${id(4, 'gone.md')}); [escape](engram-artifact:..%2F..%2Fsecret.txt)` },
  ])
  expect(outputs.map((o) => [o.name, o.path])).toEqual([['note.md', join(root, id(3, 'note.md'))], ['tracker.json', join(root, id(2, 'tracker.json'))]])
  expect(priorOutputLines(outputs)).toContain(`- tracker.json: ${join(root, id(2, 'tracker.json'))}`)
  expect(priorOutputLines([])).toBe('')
})

it('opens a later session with the first and recent earlier requests, not only the last few turns', async () => {
  let opening = ''
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } },
    runTools: async (job: { opening?: string }) => { opening = job.opening ?? ''; return { answer: 'Done' } } } as unknown as Engine
  const history = ['Monday: use fixed rates EUR 1.10 and leave out refundable deposits.', 'Tuesday: tidy the attendee list.', 'Wednesday: convert the meeting times.']
    .flatMap((text) => [{ role: 'user' as const, text }, { role: 'assistant' as const, text: 'Done.' }])
  await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [] }, 'Thursday: update the tracker with the same rules.', { history })
  expect(opening).toContain('Earlier requests in this conversation')
  expect(opening).toContain('Monday: use fixed rates EUR 1.10')
  expect(opening.indexOf('Monday')).toBeLessThan(opening.indexOf('Tuesday'))
})
