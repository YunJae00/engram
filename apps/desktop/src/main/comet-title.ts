import type { Engine, EngineCwd } from 'core'

// A comet made with one press is first named by the person's opening words,
// which is a sentence, not a name. Once the answer is out, the brain is
// asked for a short one about the subject — and only that: it never becomes
// the name while the person's opening words hold anything secret.

const TITLE_CHARS = 40
const TITLE_BUDGET_MS = 60_000

export function tidyTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((one) => one.trim())
    .find((one) => one.length > 0)
  if (!line) return null
  const clean = line
    .replace(/^(title|name|제목|이름)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`#*\-\s]+/, '')
    .replace(/["'“”‘’`.。*\s]+$/, '')
    .trim()
  if (!clean || Array.from(clean).length > TITLE_CHARS) return null
  return clean
}

export async function titleFor(engine: Engine, workdir: EngineCwd, message: string, answer: string): Promise<string | null> {
  const prompt = [
    'Name this conversation: at most four words, in the language the message is written in, saying what it is about. Reply with the name only - no quotes, no full stop.',
    '',
    `Message: ${message.slice(0, 600)}`,
    `Answer: ${answer.slice(0, 600)}`,
  ].join('\n')
  let streamed = ''
  let final: string | null = null
  try {
    for await (const event of engine.run({ prompt, workdir, disallowTools: true, modelHint: 'fast', timeoutMs: TITLE_BUDGET_MS })) {
      if (event.type === 'token') streamed += event.text
      else if (event.type === 'result') final = event.text
      else if (event.type === 'error') return null
    }
  } catch {
    return null
  }
  return tidyTitle(final ?? streamed)
}
