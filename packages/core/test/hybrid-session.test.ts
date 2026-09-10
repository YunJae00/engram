import { expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileWorkTools } from '../src/file-work.js'
import { runToolSession } from '../src/agent-session.js'
import { MockEngine } from '../src/engine/mock.js'
import type { EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

class Planner extends MockEngine {
  constructor(private script: (job: ToolSessionJob) => Promise<ToolSessionResult>) { super() }
  runTools(job: ToolSessionJob) { return this.script(job) }
}

it('completes a file workflow through the real session and storage tools without desktop access', async () => {
  await mkdir('tmp', { recursive: true })
  const root = await mkdtemp(resolve('tmp/hybrid-session-'))
  try {
    const path = join(root, 'source.json')
    await writeFile(path, '{"count":2,"untouched":"keep"}')
    const engine = new Planner(async (job) => {
      const invoke = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await job.tools.find((tool) => tool.name === name)!.run(args)
        return typeof result === 'string' ? result : result.text
      }
      const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await invoke(name, args)).split('\n(')[0]!)
      expect(job.system).toContain('Respect GUI-only, no-script, no-save')
      expect(job.tools.some((tool) => tool.name === 'desktop_action')).toBe(false)
      const methods = await json('work_capabilities')
      expect(methods.liveDocumentApi.available).toBe(false)
      expect(methods.desktop).toEqual([])
      await invoke('task_plan', { phases: ['Read source', 'Create and verify a separate revised copy'] })
      const source = await json('file_read', { path })
      await invoke('task_plan', { evidenceStep: 3, finding: 'Original count and unrelated content observed.' })
      const output = await json('file_create_copy', { name: 'revised.json', sourcePath: path, expectedSha256: source.sha256, content: '{"count":3,"untouched":"keep"}' })
      expect(JSON.parse(output.content)).toEqual({ count: 3, untouched: 'keep' })
      await invoke('task_plan', { evidenceStep: 5, finding: 'Separate saved copy read back with count 3 and unrelated content preserved; no live application update claimed.' })
      return { answer: `Created and verified a separate copy: ${output.link}. Original unchanged.` }
    })
    const result = await runToolSession({ engine, workdir: root as EngineCwd, tools: fileWorkTools({ directory: join(root, 'outputs'), approveRead: async () => true }) }, 'Revise the count in a separate file copy.')
    expect(result.incomplete).toBeUndefined()
    expect(result.answer).toMatch(/\[revised.json\]\(engram-artifact:/)
    expect(result.steps.find((step) => step.tool === 'file_create_copy')!.args).not.toHaveProperty('content')
    expect(JSON.parse(await readFile(path, 'utf8')).count).toBe(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not label a failed file write complete when the model says done', async () => {
  const engine = new Planner(async (job) => {
    await job.tools.find((tool) => tool.name === 'file_create_copy')!.run({ name: 'x.json', content: 'invalid' })
    return { answer: 'Done.' }
  })
  const result = await runToolSession({ engine, workdir: resolve('tmp') as EngineCwd, tools: fileWorkTools({ directory: resolve('tmp/not-written'), approveRead: async () => false }) }, 'Create JSON.')
  expect(result.incomplete).toBeDefined()
  expect(result.answer).toMatch(/^Not verified as complete/)
})
