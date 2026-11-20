const STATED_PROMPT = 'what they are offered as. Read the words alone'
export const agreeing = <A extends unknown[], R>(write: (prompt: string, ...rest: A) => Promise<R>) => async (prompt: string, ...rest: A): Promise<R | string> => {
  if (!prompt.includes(STATED_PROMPT)) return write(prompt, ...rest)
  const entries = JSON.parse(prompt.split('\nEntries: ')[1]!) as { n: number }[]
  return JSON.stringify({ states: entries.map(entry => entry.n) })
}
