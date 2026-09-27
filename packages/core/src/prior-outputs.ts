import { resolveArtifact } from './file-work.js'

export interface PriorOutput { name: string; path: string }

const LINK = /\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)/g
const MAX_OUTPUTS = 40

// Files this conversation already saved, found from the links in earlier
// answers: a later day's session can reopen its own work instead of guessing
// where it went. The latest revision of each name wins; missing files drop out.
export async function priorOutputs(directory: string, history: { role: string; text: string }[] | undefined): Promise<PriorOutput[]> {
  const latest = new Map<string, string>()
  for (const turn of history ?? []) {
    if (turn.role !== 'assistant') continue
    for (const match of turn.text.matchAll(LINK)) {
      let id: string
      try { id = decodeURIComponent(match[1]!) } catch { continue }
      const name = id.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, '')
      latest.delete(name)
      latest.set(name, id)
    }
  }
  const found: PriorOutput[] = []
  for (const [name, id] of [...latest].slice(-MAX_OUTPUTS)) {
    try { found.push({ name, path: await resolveArtifact(directory, id) }) } catch { /* A removed or foreign file is not offered. */ }
  }
  return found
}

export function priorOutputLines(outputs: PriorOutput[]): string {
  if (!outputs.length) return ''
  return ['Files you saved earlier in this conversation (your own outputs; reopen them with file_read when the work continues):', ...outputs.map((o) => `- ${o.name}: ${o.path}`)].join('\n')
}
