// Approval waits have no deadline; document and reply tools get longer budgets.
const DEFAULT_MS = 45_000
const BUDGETS: Record<string, number | null> = {
  app_text: 200_000,
  app_do: 320_000,
  page_do: 120_000,
  ppt_build: 120_000, word_write: 120_000, excel_write: 120_000, compose_live_document: 120_000, edit_live_document: 120_000,
  press: null, press_point: null, page_steps: null, desktop_action: null, desktop_sequence: null, upload_file: null, run_procedure: null, ask_person: null,
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
export async function withinBudget<T>(name: string, parent: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const budget = toolBudgetMs(name)
  if (budget === null) return run(parent)
  const own = new AbortController()
  const stop = () => own.abort(parent.reason)
  parent.addEventListener('abort', stop, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const over = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const error = new ToolOverBudget(name, budget); own.abort(error); reject(error) }, budget)
  })
  try { return await Promise.race([run(own.signal), over]) }
  finally { clearTimeout(timer); parent.removeEventListener('abort', stop) }
}
