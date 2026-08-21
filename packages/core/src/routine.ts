import { createCard } from './cards.js'
import type { VaultPaths } from './vault.js'
import { markRoutinePendingWrite, markRoutineRun } from './routine-store.js'
import {
  routineBlock,
  routineStepLabel,
  validateRoutineSteps,
  writeStepIndexes,
  type Routine,
  type RoutineDriver,
  type RoutineReading,
  type RoutineRunOptions,
  type RoutineRunResult,
  type RoutineStep,
  type RoutineStepResult,
} from './routine-model.js'

// A routine is repetition with the thinking already done: the exact pages,
// clicks and readings a person walks every day, saved once and replayed
// verbatim. No model is involved — the replay is deterministic code — which
// is what makes it dependable on a machine too tight for inference, and what
// keeps a 99-in-100 success rate reachable at all.

export * from './routine-model.js'
export { addRoutine, listRoutines, markRoutineRun, removeRoutine } from './routine-store.js'

// One card body: generous enough for a few portal pages, small enough that
// review stays readable.
const CARD_BODY_CAP = 24_000

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('canceled')
}

async function runStep(
  driver: RoutineDriver,
  step: RoutineStep,
  readings: RoutineReading[],
  signal?: AbortSignal,
): Promise<RoutineStepResult> {
  switch (step.kind) {
    case 'open':
      return driver.open(step.url, signal)
    case 'click':
      return driver.click(step.target, signal)
    case 'type':
      return driver.type(step.target, step.text, signal)
    case 'read': {
      const reading = await driver.read(signal)
      if (reading.wall) return { ok: false, wall: reading.wall }
      readings.push({ url: reading.url, title: reading.title, text: reading.text })
      return { ok: true }
    }
  }
}

// Every line of a page arrives quoted. A page is untrusted text: spliced in
// raw it could write its own "## Heading" and "Source:" lines and forge a
// reading the routine never took. Inside a blockquote it can only look like
// what it is — words the routine brought back from somewhere.
function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function readingsBody(name: string, readings: RoutineReading[], now: Date): string {
  const date = now.toISOString().slice(0, 10)
  const sections = readings.map((r) => `## ${r.title || r.url}\n\nSource: ${r.url}\n\n${quote(r.text)}`)
  return `# ${name} — ${date}\n\n${sections.join('\n\n')}`.slice(0, CARD_BODY_CAP)
}

// Replays a routine step by step. A wall pauses the run on the host's
// onWall answer and retries the same step once — the human logged in, the
// page should pass now. Readings land as one review card, never a direct
// vault write: the routine collects, the person decides what is kept.
export async function runRoutine(
  paths: VaultPaths,
  driver: RoutineDriver,
  routine: Routine,
  options: RoutineRunOptions = {},
): Promise<RoutineRunResult> {
  const now = options.now ?? (() => new Date())
  const invalid = validateRoutineSteps(routine.steps)
  const readings: RoutineReading[] = []
  const finish = async (result: RoutineRunResult): Promise<RoutineRunResult> => {
    const outcome = result.ok ? 'done' : result.error === 'canceled' ? 'aborted' : 'failed'
    await markRoutineRun(paths, routine.id, outcome, now()).catch(() => undefined)
    return result
  }
  if (invalid) return finish({ ok: false, readings, error: invalid })
  // Refused before anything moves, and without stamping the journal: a run
  // that never started is not a run.
  const blocked = options.force ? null : routineBlock(routine, now())
  if (blocked) return { ok: false, readings, blocked }
  const writeSteps = writeStepIndexes(routine.steps)
  try {
    const total = routine.steps.length
    for (let i = 0; i < total; i++) {
      const step = routine.steps[i]!
      checkAbort(options.signal)
      const label = routineStepLabel(step)
      options.onStep?.(i, total, label)
      // The intent to post is on disk before the click that posts. If the
      // machine dies right here, the next run knows to ask.
      if (writeSteps.has(i))
        await markRoutinePendingWrite(paths, routine.id, { at: now().toISOString(), step: i, label })
      let result = await runStep(driver, step, readings, options.signal)
      if (result.wall) {
        const verdict = (await options.onWall?.({ wall: result.wall })) ?? 'skip'
        checkAbort(options.signal)
        if (verdict !== 'resolved')
          return finish({ ok: false, readings, error: 'stopped at a page that needs a person' })
        result = await runStep(driver, step, readings, options.signal)
        if (result.wall)
          return finish({ ok: false, readings, error: 'the page still wants a login — the routine stopped there' })
      }
      if (!result.ok) return finish({ ok: false, readings, error: result.error ?? 'a step failed' })
    }
    if (readings.length === 0) return finish({ ok: true, readings })
    const card = await createCard(
      paths,
      {
        cardType: 'new-note',
        targets: [],
        rationale: `routine: ${routine.name}`.slice(0, 160),
        proposed: readingsBody(routine.name, readings, now()),
        job: 'J1',
      },
      now(),
    )
    return finish({ ok: true, readings, cardId: card.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return finish({ ok: false, readings, error: message })
  }
}
