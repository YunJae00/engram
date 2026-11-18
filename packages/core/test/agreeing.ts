// c18a r3: a fake quick model written before the blind meaning read (item-check `stated`) answers every prompt with its own verdict. This
// wrapper answers that read alone, agreeing that every entry's words state what they are offered as, and passes every other prompt on, so
// those tests keep their call counts and clocks. Tests of the read itself answer it directly.
export const STATED_PROMPT = 'what they are offered as. Read the words alone'
export const agreeing = <A extends unknown[], R>(write: (prompt: string, ...rest: A) => Promise<R>) => async (prompt: string, ...rest: A): Promise<R | string> => {
  if (!prompt.includes(STATED_PROMPT)) return write(prompt, ...rest)
  const entries = JSON.parse(prompt.split('\nEntries: ')[1]!) as { n: number }[]
  return JSON.stringify({ states: entries.map(entry => entry.n) })
}
