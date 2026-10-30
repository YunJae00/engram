// ask_person has no deadline; input tools allow the five-minute hands-off wait.
const DEFAULT_MS = 45_000
const INPUT_MS = 7 * 60_000
const BUDGETS: Record<string, number | null> = {
  app_text: 200_000,
  app_do: 320_000,
  page_do: 120_000,
  // Many values one by one, each moved and read.
  page_each: 600_000,
  look_in_parallel: 600_000,
  ppt_build: 120_000, word_write: 120_000, excel_write: 120_000, compose_live_document: 120_000, edit_live_document: 120_000,
  press: INPUT_MS, press_point: INPUT_MS, app_press: INPUT_MS, page_steps: INPUT_MS,
  desktop_action: INPUT_MS, desktop_sequence: INPUT_MS, upload_file: INPUT_MS, run_procedure: INPUT_MS,
  Bash: INPUT_MS,
  ask_person: null,
}

export function toolBudgetMs(name: string): number | null {
  return name in BUDGETS ? BUDGETS[name]! : DEFAULT_MS
}

export class ToolOverBudget extends Error {
  constructor(name: string, ms: number) {
    super(`${name} took longer than ${Math.round(ms / 1000)}s and was stopped. It may have partly happened: read the current state before doing it again. Then narrow it (fewer items, a more specific search, a smaller range) or use another way.`)
  }
}

// Runs one call within its budget. The call gets its own signal, so a tool
// that listens stops its work when the budget runs out.
export async function withinBudget<T>(name: string, parent: AbortSignal, run: (signal: AbortSignal) => Promise<T>, waitingForPerson?: () => boolean): Promise<T> {
  parent.throwIfAborted()
  const budget = toolBudgetMs(name)
  const own = new AbortController()
  let stop!: () => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const over = new Promise<never>((_, reject) => {
    stop = () => { own.abort(parent.reason); reject(parent.reason ?? new Error('canceled')) }
    parent.addEventListener('abort', stop, { once: true })
    if (budget !== null) {
      let remaining = budget, last = Date.now()
      const tick = () => {
        const now = Date.now()
        if (!waitingForPerson?.()) remaining -= now - last
        last = now
        if (remaining <= 0) { const error = new ToolOverBudget(name, budget); own.abort(error); reject(error) }
        else timer = setTimeout(tick, waitingForPerson ? Math.min(1000, remaining) : remaining)
      }
      timer = setTimeout(tick, waitingForPerson ? Math.min(1000, remaining) : remaining)
    }
  })
  try { return await Promise.race([run(own.signal), over]) }
  finally { clearTimeout(timer); parent.removeEventListener('abort', stop) }
}
