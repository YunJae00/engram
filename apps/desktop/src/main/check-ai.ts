import { createEngine, engineCwd } from 'core'
import { app } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { aiSelection, withModel } from './ai-selection.js'
import { activeAccountProfile } from './account-profiles.js'
import { loadSettings } from './settings.js'
import { verifySetupConnection } from './setup-connection.js'
import { resolveEngines } from './vault.js'

let pending: Promise<void> | undefined
export function checkAISelection(): Promise<void> {
  if (pending) return pending
  const request = (async () => {
    const selection = aiSelection(await loadSettings(), 'filing')
    const profile = activeAccountProfile(selection.engine)
    const engine = ['mock', 'none'].includes(process.env['ENGRAM_ENGINE'] ?? '')
      ? (await resolveEngines())[0]
      : withModel(createEngine(selection.engine), selection.model, selection.effort)
    if (!engine) throw new Error('Connect an AI before checking it.')
    const folder = join(app.getPath('userData'), 'tmp', 'connection-check')
    await mkdir(folder, { recursive: true })
    await verifySetupConnection(engine, engineCwd({ workspace: folder, privateDir: '' }), undefined, async () => {
      if (profile !== activeAccountProfile(selection.engine) || JSON.stringify(selection) !== JSON.stringify(aiSelection(await loadSettings(), 'filing'))) throw new Error('Your AI selection changed during the check. Try again.')
    })
  })().finally(() => { pending = undefined })
  pending = request
  return request
}
