// The local model runs in a 4096-token window and cannot shift a prompt that
// is one long user turn — node-llama-cpp throws a library error that would
// reach the user as the "answer". So the prompt is fitted before it is sent:
// rules and the question always ride, background and evidence are dropped from
// the far end until it fits. CJK tokenizes near 1.6 chars/token on Gemma, so
// the estimate is deliberately pessimistic.
const LOCAL_CTX_TOKENS = 4_096
const LOCAL_OUTPUT_RESERVE = 700
const CHARS_PER_TOKEN = 1.6

export function fitPrompt(
  rules: string[],
  background: string[],
  evidence: string[],
  ask: string,
  engineId: string,
): string {
  const join = (parts: string[]) => parts.filter(Boolean).join('\n\n')
  const all = [...rules, ...background, ...evidence, ask]
  if (engineId !== 'local') return join(all)
  const budget = Math.floor((LOCAL_CTX_TOKENS - LOCAL_OUTPUT_RESERVE) * CHARS_PER_TOKEN)
  const fixed = [...rules, ask]
  let room = budget - fixed.reduce((n, part) => n + part.length + 2, 0)
  // Evidence is ordered weakest-first and sits closest to the question, so it
  // is trimmed from the front; background is trimmed from the back.
  const keptEvidence: string[] = []
  for (let i = evidence.length - 1; i >= 0; i--) {
    const part = evidence[i]!
    if (part.length + 2 > room) continue
    room -= part.length + 2
    keptEvidence.unshift(part)
  }
  const keptBackground: string[] = []
  for (const part of background) {
    if (part.length + 2 > room) continue
    room -= part.length + 2
    keptBackground.push(part)
  }
  return join([...rules, ...keptBackground, ...keptEvidence, ask])
}
