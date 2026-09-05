import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listCards } from '../src/cards.js'
import { readNote } from '../src/notes.js'
import {
  addRoutine,
  listRoutines,
  removeRoutine,
  renameRoutine,
  fillSlots,
  routineSlots,
  routineStepLabel,
  runRoutine,
  validateRoutineSteps,
  type RoutineDriver,
  type RoutineStep,
  type RoutineTarget,
} from '../src/routine.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const OPEN: RoutineStep = { kind: 'open', url: 'https://example.com/notices' }
const READ: RoutineStep = { kind: 'read' }
const TYPE: RoutineStep = { kind: 'type', target: { text: 'Entry' }, text: 'shipped the replayer' }
// Posting needs a person's yes; these tests are about other things, so they
// grant it. The gate itself is tested in its own block below.
const APPROVE = async (): Promise<'approve'> => 'approve'
const CLICK: RoutineStep = { kind: 'click', target: { text: 'Submit' } }

// A scripted driver: each call shifts the next canned answer and records what
// the engine asked of it — the replay's whole contract in one fake.
function fakeDriver(script: {
  open?: Array<{ ok: boolean; wall?: 'login' | 'captcha'; error?: string }>
  click?: Array<{ ok: boolean; wall?: 'login' | 'captcha'; error?: string }>
  read?: Array<{ url: string; title: string; text: string; wall?: 'login' | 'captcha' }>
}): RoutineDriver & { calls: string[] } {
  const open = [...(script.open ?? [])]
  const click = [...(script.click ?? [])]
  const read = [...(script.read ?? [])]
  const calls: string[] = []
  return {
    calls,
    async open(url) {
      calls.push(`open ${url}`)
      return open.shift() ?? { ok: true }
    },
    async click(target: RoutineTarget) {
      calls.push(`click ${target.text ?? target.css?.[0] ?? '?'}`)
      return click.shift() ?? { ok: true }
    },
    async type(target: RoutineTarget, text: string) {
      calls.push(`type ${target.text ?? '?'} ${text}`)
      return { ok: true }
    },
    async read() {
      calls.push('read')
      return read.shift() ?? { url: 'https://example.com/x', title: 'Page', text: 'body text' }
    },
  }
}

describe('routine CRUD', () => {
  it('adds, lists and removes a routine, persisted across loads', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-crud'), { git: false })
    const saved = await addRoutine(paths, { name: 'Portal notices', steps: [OPEN, READ] })
    expect(saved.id).toMatch(/^rt-/)
    expect((await listRoutines(paths)).map((r) => r.name)).toEqual(['Portal notices'])
    await removeRoutine(paths, saved.id)
    expect(await listRoutines(paths)).toEqual([])
  })

  it('renames a routine without changing its steps', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-rename'), { git: false })
    const saved = await addRoutine(paths, { name: 'Portal notices', steps: [OPEN, READ] })
    await renameRoutine(paths, saved.id, 'Morning portal')
    const [renamed] = await listRoutines(paths)
    expect(renamed?.name).toBe('Morning portal')
    expect(renamed?.steps).toEqual([OPEN, READ])
    await expect(renameRoutine(paths, saved.id, '  ')).rejects.toThrow('needs a name')
  })

  it('rejects a nameless routine and invalid steps with human words', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-invalid'), { git: false })
    await expect(addRoutine(paths, { name: '  ', steps: [OPEN] })).rejects.toThrow('needs a name')
    await expect(addRoutine(paths, { name: 'x', steps: [] })).rejects.toThrow('at least one step')
    await expect(
      addRoutine(paths, { name: 'x', steps: [{ kind: 'open', url: 'file:///etc/passwd' }] }),
    ).rejects.toThrow('http(s)')
    await expect(
      addRoutine(paths, { name: 'x', steps: [{ kind: 'click', target: {} }] }),
    ).rejects.toThrow('element text or a selector')
  })

  it('a corrupt legacy cache file reads as empty, not a crash', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-corrupt'), { git: false })
    await writeFile(join(paths.cache, 'routines.json'), '{ not json')
    expect(await listRoutines(paths)).toEqual([])
  })
})

describe('validateRoutineSteps', () => {
  it('caps the step count', () => {
    const steps = Array.from({ length: 31 }, () => READ)
    expect(validateRoutineSteps(steps)).toMatch(/capped at 30/)
  })

  it('accepts the shapes the builder produces', () => {
    const steps: RoutineStep[] = [
      OPEN,
      { kind: 'click', target: { text: 'Notices' } },
      { kind: 'type', target: { text: 'Title', css: ['#title'] }, text: 'Weekly summary' },
      READ,
    ]
    expect(validateRoutineSteps(steps)).toBeNull()
  })
})

describe('routineStepLabel', () => {
  it('describes each step in a short human line', () => {
    expect(routineStepLabel(OPEN)).toBe('Open example.com')
    expect(routineStepLabel({ kind: 'click', target: { text: 'Submit' } })).toBe('Click "Submit"')
    expect(routineStepLabel({ kind: 'type', target: { text: 'Title' }, text: 'x' })).toBe('Type into "Title"')
    expect(routineStepLabel(READ)).toBe('Read the page')
  })
})

describe('runRoutine — replay', () => {
  it('walks the steps in order and lands the readings as one review card', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-run'), { git: false })
    const routine = await addRoutine(paths, {
      name: 'Portal notices',
      steps: [OPEN, { kind: 'click', target: { text: 'Notices' } }, READ],
    })
    const driver = fakeDriver({
      read: [{ url: 'https://example.com/notices', title: 'Notices', text: 'Holiday on Friday.' }],
    })
    const seen: string[] = []
    const result = await runRoutine(paths, driver, routine, {
      onStep: (i, total, label) => seen.push(`${i + 1}/${total} ${label}`),
      now: () => new Date('2026-08-20T09:00:00Z'),
    })
    expect(result.ok).toBe(true)
    expect(driver.calls).toEqual(['open https://example.com/notices', 'click Notices', 'read'])
    expect(seen).toEqual(['1/3 Open example.com', '2/3 Click "Notices"', '3/3 Read the page'])
    const cards = await listCards(paths)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.id).toBe(result.cardId)
    expect(cards[0]!.proposed).toContain('# Portal notices — 2026-08-20')
    expect(cards[0]!.proposed).toContain('Holiday on Friday.')
    expect(cards[0]!.proposed).toContain('Source: https://example.com/notices')
    const stored = (await listRoutines(paths))[0]!
    expect(stored.lastOutcome).toBe('done')
    expect(stored.lastRunAt).toBeTruthy()
  })

  it('a routine with no read step finishes without a card', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-noread'), { git: false })
    const routine = await addRoutine(paths, {
      name: 'Just click',
      steps: [OPEN, { kind: 'click', target: { text: 'Refresh' } }],
    })
    const result = await runRoutine(paths, fakeDriver({}), routine)
    expect(result.ok).toBe(true)
    expect(result.cardId).toBeUndefined()
    expect(await listCards(paths)).toHaveLength(0)
  })

  it('a wall pauses the run, and a resolved wall retries the same step once', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-wall'), { git: false })
    const routine = await addRoutine(paths, { name: 'Behind login', steps: [OPEN, READ] })
    const driver = fakeDriver({
      open: [{ ok: true, wall: 'login' }, { ok: true }],
      read: [{ url: 'https://example.com/in', title: 'Inside', text: 'secret notices' }],
    })
    const walls: string[] = []
    const result = await runRoutine(paths, driver, routine, {
      onWall: async (w) => {
        walls.push(w.wall)
        return 'resolved'
      },
    })
    expect(result.ok).toBe(true)
    expect(walls).toEqual(['login'])
    expect(driver.calls.filter((c) => c.startsWith('open'))).toHaveLength(2)
  })

  it('a wall the user does not resolve stops the run — a sequence has no skipping', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-wall-stop'), { git: false })
    const routine = await addRoutine(paths, { name: 'Behind login', steps: [OPEN, READ] })
    const driver = fakeDriver({ open: [{ ok: true, wall: 'login' }] })
    const result = await runRoutine(paths, driver, routine, { onWall: async () => 'skip' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/needs a person/)
    expect((await listRoutines(paths))[0]!.lastOutcome).toBe('failed')
  })

  it('a wall still standing after the human answered fails with a clear message', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-wall-twice'), { git: false })
    const routine = await addRoutine(paths, { name: 'Stubborn login', steps: [OPEN] })
    const driver = fakeDriver({ open: [{ ok: true, wall: 'login' }, { ok: true, wall: 'login' }] })
    const result = await runRoutine(paths, driver, routine, { onWall: async () => 'resolved' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/still wants a login/)
  })

  it('a failed step fails the run with the driver message', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-fail'), { git: false })
    const routine = await addRoutine(paths, {
      name: 'Missing button',
      steps: [OPEN, { kind: 'click', target: { text: 'Ghost' } }],
    })
    const driver = fakeDriver({ click: [{ ok: false, error: 'could not find "Ghost" on the page' }] })
    const result = await runRoutine(paths, driver, routine)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Ghost')
  })

  it('an abort mid-run records the aborted outcome', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-abort'), { git: false })
    const routine = await addRoutine(paths, { name: 'Stopped', steps: [OPEN, READ] })
    const controller = new AbortController()
    const driver: RoutineDriver = {
      ...fakeDriver({}),
      async open() {
        controller.abort()
        return { ok: true }
      },
    }
    const result = await runRoutine(paths, driver, routine, { signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('canceled')
    expect((await listRoutines(paths))[0]!.lastOutcome).toBe('aborted')
  })

  it('partial readings survive into the failure result for the person to salvage', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-partial'), { git: false })
    const routine = await addRoutine(paths, {
      name: 'Two pages',
      steps: [OPEN, READ, { kind: 'open', url: 'https://example.com/two' }, READ],
    })
    const driver = fakeDriver({
      open: [{ ok: true }, { ok: false, error: 'the page took too long to answer' }],
      read: [{ url: 'https://example.com/one', title: 'One', text: 'first page' }],
    })
    const result = await runRoutine(paths, driver, routine)
    expect(result.ok).toBe(false)
    expect(result.readings).toHaveLength(1)
  })

  it('rerunning the same routine the same day does not duplicate the card', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-idem'), { git: false })
    const routine = await addRoutine(paths, { name: 'Portal notices', steps: [OPEN, READ] })
    const reading = { url: 'https://example.com/n', title: 'N', text: 'same text' }
    const at = () => new Date('2026-08-20T09:00:00Z')
    const first = await runRoutine(paths, fakeDriver({ read: [reading] }), routine, { now: at })
    const second = await runRoutine(paths, fakeDriver({ read: [reading] }), routine, { now: at })
    expect(first.cardId).toBe(second.cardId)
    expect(await listCards(paths)).toHaveLength(1)
  })

  it('a run stamps only the routine it touched', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-siblings'), { git: false })
    const a = await addRoutine(paths, { name: 'A', steps: [OPEN] })
    await addRoutine(paths, { name: 'B', steps: [OPEN] })
    await runRoutine(paths, fakeDriver({}), a)
    const all = await listRoutines(paths)
    expect(all.find((r) => r.name === 'A')?.lastOutcome).toBe('done')
    expect(all.find((r) => r.name === 'B')?.lastOutcome).toBeUndefined()
  })
})

// Repetition is the point, and repetition is also the danger: a routine that
// types into a page can post the same thing twice. These are the guardrails
// that make a second press a question instead of a second submission.
describe('rerunning a routine that writes', () => {
  const NINE_AM = (): Date => new Date('2026-08-20T09:00:00')

  it('refuses a blind same-day rerun, and runs when the person insists', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-rerun'), { git: false })
    const routine = await addRoutine(paths, { name: 'Daily log', steps: [OPEN, TYPE, CLICK] })
    expect((await runRoutine(paths, fakeDriver({}), routine, { now: NINE_AM, onSubmit: APPROVE })).ok).toBe(true)

    const saved = (await listRoutines(paths))[0]!
    expect(saved.lastSuccessAt).toBe(NINE_AM().toISOString())
    const second = await runRoutine(paths, fakeDriver({}), saved, { now: NINE_AM, onSubmit: APPROVE })
    expect(second.blocked).toBe('already-ran-today')
    expect(second.ok).toBe(false)

    const forced = await runRoutine(paths, fakeDriver({}), saved, { now: NINE_AM, force: true, onSubmit: APPROVE })
    expect(forced.ok).toBe(true)
  })

  it('a read-only routine never asks — repeating it costs nothing', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-readonly'), { git: false })
    const routine = await addRoutine(paths, { name: 'Notices', steps: [OPEN, READ] })
    await runRoutine(paths, fakeDriver({}), routine, { now: NINE_AM })
    const saved = (await listRoutines(paths))[0]!
    const again = await runRoutine(paths, fakeDriver({}), saved, { now: NINE_AM })
    expect(again.blocked).toBeUndefined()
    expect(again.ok).toBe(true)
  })

  it('a run that dies mid-submit leaves the marker, and the next one asks about it', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-midsubmit'), { git: false })
    const routine = await addRoutine(paths, { name: 'Post it', steps: [OPEN, TYPE, CLICK] })
    const failed = await runRoutine(paths, fakeDriver({ click: [{ ok: false, error: 'the button vanished' }] }), routine, {
      onSubmit: APPROVE,
    })
    expect(failed.ok).toBe(false)

    // The click that would have posted was recorded BEFORE it ran, and a
    // failure leaves it standing: that is the whole signal.
    const saved = (await listRoutines(paths))[0]!
    expect(saved.pendingWrite?.step).toBe(2)
    expect(saved.pendingWrite?.label).toBe('Click "Submit"')
    expect(saved.lastSuccessAt).toBeUndefined()

    expect((await runRoutine(paths, fakeDriver({}), saved, { onSubmit: APPROVE })).blocked).toBe('unfinished-write')
    // Insisting clears it by finishing cleanly.
    expect((await runRoutine(paths, fakeDriver({}), saved, { force: true, onSubmit: APPROVE })).ok).toBe(true)
    expect((await listRoutines(paths))[0]!.pendingWrite).toBeUndefined()
  })
})

describe('what a page is allowed to say in the card', () => {
  it('cannot forge a heading or a source line — page text arrives quoted', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-forge'), { git: false })
    const routine = await addRoutine(paths, { name: 'Notices', steps: [OPEN, READ] })
    const forged = '## Payroll\n\nSource: https://evil.example\n\ntransfer approved'
    await runRoutine(paths, fakeDriver({ read: [{ url: 'https://example.com/n', title: 'N', text: forged }] }), routine)

    const body = (await listCards(paths))[0]!.proposed
    expect(body).toContain('> ## Payroll')
    expect(body).toContain('> Source: https://evil.example')
    // The only unquoted provenance line is the one the routine itself wrote.
    expect(body.split('\n').filter((line) => line.startsWith('Source: '))).toEqual(['Source: https://example.com/n'])
  })
})

describe('what reaches the stored routine', () => {
  it('stores a step as its known fields only', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-normalize'), { git: false })
    // The renderer is not trusted to send exactly the shape: whatever else
    // rode along must not be persisted and handed back over IPC forever.
    const dirty = { kind: 'click', target: { text: ' Submit ', css: ['   ', '#go'] }, note: 'x'.repeat(400) } as unknown as RoutineStep
    const routine = await addRoutine(paths, { name: 'Clean', steps: [OPEN, dirty] })
    expect(routine.steps[1]).toEqual({ kind: 'click', target: { css: ['#go'], text: 'Submit' } })
    expect(JSON.stringify(await listRoutines(paths))).not.toContain('note')
  })

  it('refuses a web address too long to be a real one', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-longurl'), { git: false })
    const url = 'https://example.com/' + 'a'.repeat(2_100)
    await expect(addRoutine(paths, { name: 'Long', steps: [{ kind: 'open', url }] })).rejects.toThrow(/too long/)
  })
})

// A procedure is knowledge: the routine lives as a vault note — searchable,
// synced, hand-editable — with the steps in frontmatter and prose in the body.
describe('routines are vault notes', () => {
  it('saving a routine writes a note of type routine, evergreen and off the timeline', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-note'), { git: false })
    const saved = await addRoutine(paths, { name: 'Portal notices', steps: [OPEN, READ] })
    const note = await readNote(paths, saved.id)
    expect(note.front.type).toBe('routine')
    expect(note.front.decay).toBe('evergreen')
    expect(note.front.timeline).toBe('ignore')
    expect(note.front.routine?.steps).toEqual([OPEN, READ])
    expect(note.body).toContain('# Portal notices')
    expect(note.body).toContain('1. Open example.com')
  })

  it('save → load → replay walks the exact same steps (full round trip)', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-roundtrip'), { git: false })
    // What a comet keeps after doing a job: the moves it made, in order.
    const steps: RoutineStep[] = [
      { kind: 'open', url: 'https://portal.example/home' },
      { kind: 'click', target: { css: ['a#notices'], text: 'Notices' } },
      { kind: 'read' },
    ]
    const saved = await addRoutine(paths, { name: 'Kept', steps })
    const loaded = (await listRoutines(paths)).find((r) => r.id === saved.id)!
    expect(loaded.steps).toEqual(steps)
    const driver = fakeDriver({})
    await runRoutine(paths, driver, loaded)
    expect(driver.calls).toEqual(['open https://portal.example/home', 'click Notices', 'read'])
  })

  it('a run stamps its outcome without touching updated — a replay is not an edit', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-noedit'), { git: false })
    const saved = await addRoutine(paths, { name: 'Quiet', steps: [OPEN] })
    const before = (await readNote(paths, saved.id)).front.updated
    await runRoutine(paths, fakeDriver({}), saved)
    const after = await readNote(paths, saved.id)
    expect(after.front.routine?.lastOutcome).toBe('done')
    expect(after.front.updated).toBe(before)
  })

  it('removing a routine archives the note instead of deleting knowledge', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-archive'), { git: false })
    const saved = await addRoutine(paths, { name: 'Old ways', steps: [OPEN] })
    await removeRoutine(paths, saved.id)
    expect(await listRoutines(paths)).toEqual([])
    expect((await readNote(paths, saved.id)).front.status).toBe('archived')
  })

  it('routines saved by an older version migrate from the cache file on first read', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-migrate'), { git: false })
    const legacy = {
      routines: [
        {
          id: 'rt-legacy-1',
          name: 'Portal notices',
          steps: [OPEN, READ],
          createdAt: '2026-08-01T09:00:00.000Z',
          lastRunAt: '2026-08-19T09:00:00.000Z',
          lastOutcome: 'done',
          lastSuccessAt: '2026-08-19T09:00:00.000Z',
        },
      ],
    }
    await writeFile(join(paths.cache, 'routines.json'), JSON.stringify(legacy))
    const listed = await listRoutines(paths)
    expect(listed.map((r) => r.id)).toEqual(['rt-legacy-1'])
    expect(listed[0]!.name).toBe('Portal notices')
    expect(listed[0]!.steps).toEqual([OPEN, READ])
    expect(listed[0]!.lastSuccessAt).toBe('2026-08-19T09:00:00.000Z')
    // migrated once: the cache file has stepped aside, the note is the truth
    await expect(readFile(join(paths.cache, 'routines.json'), 'utf8')).rejects.toThrow()
    expect((await readNote(paths, 'rt-legacy-1')).front.type).toBe('routine')
  })
})

// Nothing a person cannot undo happens without them seeing it first. This is
// the last gate before a routine posts, and it is deliberately unskippable.
describe('the submit gate', () => {
  const WRITER: RoutineStep[] = [OPEN, TYPE, CLICK]

  it('shows what was typed and posts only after the person approves', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-submit-ok'), { git: false })
    const routine = await addRoutine(paths, { name: 'Daily log', steps: WRITER })
    const driver = fakeDriver({})
    const seen: { routine: string; filled: { label: string; text: string }[] }[] = []
    const result = await runRoutine(paths, driver, routine, {
      onSubmit: async (preview) => {
        seen.push(preview)
        return 'approve'
      },
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([
      expect.objectContaining({ routine: 'Daily log', url: null, filled: [{ label: 'Entry', text: 'shipped the replayer' }] }),
    ])
    expect(driver.calls).toContain('click Submit')
  })

  it('a refusal stops the run before the click — nothing is posted', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-submit-no'), { git: false })
    const routine = await addRoutine(paths, { name: 'Daily log', steps: WRITER })
    const driver = fakeDriver({})
    const result = await runRoutine(paths, driver, routine, { onSubmit: async () => 'cancel' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/nothing was posted/)
    expect(driver.calls).not.toContain('click Submit')
  })

  it('no way to ask means no posting — a silent host never submits', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-submit-none'), { git: false })
    const routine = await addRoutine(paths, { name: 'Daily log', steps: WRITER })
    const driver = fakeDriver({})
    const result = await runRoutine(paths, driver, routine)
    expect(result.ok).toBe(false)
    expect(driver.calls).not.toContain('click Submit')
  })

  it('is asked once per run, not once per click', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-submit-once'), { git: false })
    const routine = await addRoutine(paths, {
      name: 'Two clicks',
      steps: [OPEN, TYPE, CLICK, { kind: 'click', target: { text: 'Confirm' } }],
    })
    let asked = 0
    const result = await runRoutine(paths, fakeDriver({}), routine, {
      onSubmit: async () => {
        asked++
        return 'approve'
      },
    })
    expect(result.ok).toBe(true)
    expect(asked).toBe(1)
  })

  it('a refusal leaves no doubt behind — the next run is not warned about it', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-submit-clean'), { git: false })
    const routine = await addRoutine(paths, { name: 'Daily log', steps: WRITER })
    await runRoutine(paths, fakeDriver({}), routine, { onSubmit: async () => 'cancel' })
    // Nothing was posted and the app knows it, so no "stopped mid-submit"
    // warning is left standing to block or frighten the next run.
    const saved = (await listRoutines(paths))[0]!
    expect(saved.pendingWrite).toBeUndefined()
    expect(await runRoutine(paths, fakeDriver({}), saved, { onSubmit: APPROVE })).toMatchObject({ ok: true })
  })

  it('a read-only routine never asks — it has nothing to post', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-submit-read'), { git: false })
    const routine = await addRoutine(paths, { name: 'Notices', steps: [OPEN, READ] })
    let asked = 0
    const result = await runRoutine(paths, fakeDriver({}), routine, {
      onSubmit: async () => {
        asked++
        return 'approve'
      },
    })
    expect(result.ok).toBe(true)
    expect(asked).toBe(0)
  })
})

// A procedure that types the same sentence every day is a worse procedure
// than one that leaves the sentence blank for the day it runs.
describe('slots — the blanks a procedure fills fresh', () => {
  const TEMPLATE: RoutineStep[] = [
    OPEN,
    { kind: 'type', target: { text: 'Title' }, text: 'Weekly report {{week}}' },
    { kind: 'type', target: { text: 'Body' }, text: '{{summary}}' },
    CLICK,
  ]

  it('names the blanks a procedure needs', () => {
    expect(routineSlots(TEMPLATE)).toEqual(['week', 'summary'])
    expect(routineSlots([OPEN, READ])).toEqual([])
  })

  it('fills them, and leaves an unanswered blank visible rather than empty', () => {
    const filled = fillSlots(TEMPLATE, { week: '34' })
    expect(filled[1]).toEqual({ kind: 'type', target: { text: 'Title' }, text: 'Weekly report 34' })
    expect(filled[2]).toEqual({ kind: 'type', target: { text: 'Body' }, text: '{{summary}}' })
  })

  it('a filled procedure types the filled values, and the gate shows them', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-slots-run'), { git: false })
    const saved = await addRoutine(paths, { name: 'Weekly', steps: TEMPLATE })
    const filled = { ...saved, steps: fillSlots(saved.steps, { week: '34', summary: 'shipped the replayer' }) }
    const driver = fakeDriver({})
    let preview: { label: string; text: string }[] = []
    const result = await runRoutine(paths, driver, filled, {
      onSubmit: async (p) => {
        preview = p.filled
        return 'approve'
      },
    })
    expect(result.ok).toBe(true)
    expect(driver.calls).toContain('type Title Weekly report 34')
    expect(preview).toEqual([
      { label: 'Title', text: 'Weekly report 34' },
      { label: 'Body', text: 'shipped the replayer' },
    ])
  })
})
