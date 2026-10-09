import { expect, it, vi } from 'vitest'
import { cometTools } from '../src/comet-tools.js'
import { evidenceFault, evidenceTools } from '../src/work-evidence.js'
import { runComet } from '../src/agent-session.js'
import { MockEngine } from '../src/engine/mock.js'
import { engineCwd } from '../src/engine/types.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

it('opens a homepage with search configured and dispatches every evidence tool through the chat loop', async () => {
  const paths = await initVault(await tmpVaultRoot('evidence-loop'), { git: false })
  const url = 'https://example.test/'
  const page = { url, title: 'Example Domain', text: 'Example Domain', links: [] }
  const fetchPage = vi.fn(async () => page)
  const capture = { name: 'before', url }
  const receipt = { artifact: 'evidence.png', sha256: 'a'.repeat(64), ...capture }
  const host = { read: vi.fn(async () => page), capture: vi.fn(async () => receipt), upload: vi.fn(async () => ({ upload: { status: 'confirmed' } })) }
  const check = { id: 'heading', url, ready: 'Example Domain' }
  const calls = [
    { tool: 'open_page', args: { url } },
    { tool: 'wait_for', args: check }, { tool: 'verify', args: check },
    { tool: 'capture_evidence', args: capture },
    { tool: 'upload_file', args: { artifact: receipt.artifact, url, target: 'File', confirmation: 'Saved' } },
    { tool: 'answer', args: { text: 'Evidence saved and uploaded.' } },
  ]
  let next = 0
  const engine = new MockEngine({ 'COMET-STEP': prompt => {
    expect(prompt).toContain('"required":["name","url"]')
    expect(prompt).toContain('"required":["id","url","ready"]')
    expect(prompt).not.toMatch(/record_start|record_stop|Start recording/)
    return JSON.stringify({ step: calls[next++] })
  } })
  const tools = [...cometTools({ paths, retrieve: async () => [], courier: { fetchPage }, searchTemplate: async () => 'https://search.test/?q={q}', guided: false }), ...evidenceTools(host)]
  const result = await runComet({ engine, tools, workdir: engineCwd(paths) }, 'Open the homepage, verify, capture and upload evidence.', { guided: false })
  expect(fetchPage).toHaveBeenCalledOnce()
  expect(result.steps.map(step => step.tool)).toEqual(calls.slice(0, -1).map(call => call.tool))
  expect(result.incomplete).toBeUndefined()
  for (const method of [host.capture, host.upload]) expect(method).toHaveBeenCalledOnce()
})

it('does not mark a failed screenshot as complete', () => {
  expect(evidenceFault([{ tool: 'capture_evidence', args: { name: 'before', url: 'https://example.test/' }, observation: 'that did not work: declined' }])).toBeDefined()
})
