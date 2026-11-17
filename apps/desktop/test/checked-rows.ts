import { checkedSearch, type AgentTool } from 'core'

// c13b: a lone lookup's search rows are judged where they enter (core checkedSearch), before the model writes. Tests feed it search output
// (several outputs: the first search, then a widened one), a fake quick-model verdict, the dead addresses and a fake clock.
export async function checked(outs: string | string[], ask: string, verdict?: string | ((prompt: string) => string | undefined | Promise<string | undefined>), opts: { dead?: string[]; now?: number; since?: number; judgeMs?: number } = {}): Promise<{ out: string; prompts: string[]; queries: string[]; rows: string[] }> {
  const pages = Array.isArray(outs) ? [...outs] : [outs], prompts: string[] = [], queries: string[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return pages.shift() ?? '' } }
  const tool = checkedSearch(search, {
    ask: () => ask,
    ...(verdict !== undefined ? { write: async (prompt: string) => { prompts.push(prompt); return typeof verdict === 'string' ? verdict : verdict(prompt) } } : {}),
    alive: async url => !(opts.dead ?? []).includes(url),
    since: opts.since ?? 0,
    now: () => opts.now ?? 0,
    ...(opts.judgeMs ? { judgeMs: opts.judgeMs } : {}),
  })
  const out = await tool.run({ query: 'q' }, { task: ask })
  return { out, prompts, queries, rows: out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\/\/\S+)/.exec(line)?.[1] ?? line) }
}
