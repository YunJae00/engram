import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ENGINE_BUDGETS, engineBackoff, engineCwd, extractJson, type Standup } from 'core'
import { app } from 'electron'
import type { VaultContext } from './vault.js'

interface SpeechCache {
  day: string
  lines: string[]
}

function cacheFile(): string {
  return join(app.getPath('userData'), 'brief-speech.json')
}

const PROMPT_RULES = [
  'You are the user\'s librarian delivering a MORNING STANDUP about their own work. Write in the language the folder summaries below are written in.',
  'Altitude rule: summarize the STATE of each active folder in your own words — never quote note titles verbatim, never list. What moved, what is still open, what presses today.',
  '2 to 4 lines, each under 90 characters, plain text. First line greets with the single most important thing. If something is due or overdue, it IS the most important thing. If nothing presses, say so in passing — never invent urgency.',
  'Reply with ONLY this JSON (no fence): {"lines": ["...", "..."]}',
].join('\n')

function digest(standup: Standup, dueCount: number): string {
  return `${new Date().toISOString().slice(0, 10)}|${standup.entries.map((e) => `${e.folder}:${e.open}`).join(',')}|${dueCount}`
}

export async function speakBrief(ctx: VaultContext, standup: Standup): Promise<string[] | null> {
  if (standup.entries.length === 0) return null
  const engine = ctx.engines[0]
  if (!engine || engineBackoff.blockedMs() > 0) return null
  const key = digest(standup, standup.due.length)
  try {
    const cached = JSON.parse(await readFile(cacheFile(), 'utf8')) as SpeechCache
    if (cached.day === key && Array.isArray(cached.lines) && cached.lines.length > 0) return cached.lines
  } catch {
    /* no cache yet */
  }
  const facts = [
    ...standup.entries.map(
      (e) => `- folder "${e.folder}": last conclusion "${e.last}" (${e.daysAgo}d ago), ${e.open} open loops`,
    ),
    ...standup.due.map((d) => `- ${d.overdue ? 'OVERDUE' : 'due today'}: ${d.title}`),
  ].join('\n')
  const prompt = `${PROMPT_RULES}\n\n--- Folder summaries ---\n${facts}`
  try {
    let streamed = ''
    let finalText: string | null = null
    for await (const event of engine.run({
      prompt,
      workdir: engineCwd(ctx.paths),
      disallowTools: true,
      timeoutMs: ENGINE_BUDGETS.speech,
      modelHint: 'smart',
    })) {
      if (event.type === 'token') streamed += event.text
      else if (event.type === 'result') finalText = event.text
      else if (event.type === 'error') return null
    }
    const value = extractJson(finalText ?? streamed) as { lines?: unknown } | null
    if (!value || !Array.isArray(value.lines)) return null
    const lines = value.lines
      .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      .map((line) => line.trim().slice(0, 120))
      .slice(0, 4)
    if (lines.length === 0) return null
    await writeFile(cacheFile(), JSON.stringify({ day: key, lines })).catch(() => undefined)
    return lines
  } catch {
    return null
  }
}
