import { expect, it, vi } from 'vitest'
import { toolBudgetMs, withinBudget } from '../src/tool-budget.js'
import { resumeCheckpoint } from '../src/agent-resume.js'
import { resumeLines } from '../src/agent-prompt.js'
import { pressCommits } from '../src/press-guard.js'

it.each(['PowerShell', 'Shell'])('allows a 60-second %s call to finish', async name => {
  vi.useFakeTimers()
  try {
    expect(toolBudgetMs(name)).toBe(toolBudgetMs('Bash'))
    const result = withinBudget(name, new AbortController().signal, async signal => {
      await new Promise(resolve => setTimeout(resolve, 60_000))
      signal.throwIfAborted()
      return 'completed once'
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toBe('completed once')
  } finally { vi.useRealTimers() }
})

it('requires approval for the Korean send button', () => {
  expect(pressCommits({ words: '보내기', submits: false })).toBe(true)
})

it('retains every dispatched commit outside the recent observation window', () => {
  const commits = Array.from({ length: 12 }, (_, i) => ({ tool: 'PowerShell', args: { command: `send-${i}` }, observation: 'Unconfirmed', committed: true }))
  const reads = Array.from({ length: 12 }, () => ({ tool: 'read_open_page', args: {}, observation: 'Read' }))
  const checkpoint = resumeCheckpoint('Send once', { answer: 'Limit reached', steps: [...commits, ...reads], fellBack: false, incomplete: 'Check result' })!
  expect(JSON.parse(checkpoint).committedActions).toEqual(commits.map(({ tool, args }) => ({ tool, args })))
  expect(JSON.parse(checkpoint).recentResults).toHaveLength(8)
  const prompt = resumeLines(checkpoint).join('\n')
  expect(prompt).toContain('never repeat it')
  expect(prompt).toContain('send-0')
})

it('retains a dispatched browser commit when the readback fails', async () => {
  const { runToolSession } = await import('../src/agent-session.js')
  const { pageTools } = await import('../src/comet-page-tools.js')
  const tools = pageTools({}, { fetchPage: async () => { throw new Error('unused') }, press: async () => ({ ok: true, committed: true }), readOpen: async () => { throw new Error('readback unavailable') } })
  const engine = { id: 'mock', runTools: async (job: import('../src/engine/types.js').ToolSessionJob) => {
    await job.tools.find(tool => tool.name === 'press')!.run({ target: 'Send' })
    return { answer: 'Could not confirm delivery' }
  } } as import('../src/engine/types.js').Engine
  const result = await runToolSession({ engine, tools, workdir: 'tmp/harness-commit' as import('../src/engine/types.js').EngineCwd }, 'Send once', { maxCalls: 1 })
  expect(result.steps.filter(step => step.committed)).toMatchObject([{ tool: 'press', args: { target: 'Send' } }])
  expect(JSON.parse(resumeCheckpoint('Send once', result)!).committedActions).toHaveLength(1)
})
