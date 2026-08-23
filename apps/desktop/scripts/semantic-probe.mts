// Can the embedder get here at all? On a network that inspects TLS the model
// download is the thing most likely to be refused, and the comet's ability to
// tell one subject from another rests on it.
import { launchApp } from './launch-app.mts'
import { initVault } from 'core'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUN = Date.now().toString(36)
const VAULT = fileURLToPath(new URL(`../../../tmp/sem-${RUN}-vault/`, import.meta.url))
const USERDATA = fileURLToPath(new URL(`../../../tmp/sem-${RUN}-userdata/`, import.meta.url))
await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(USERDATA, 'models'), join(process.env['APPDATA']!, 'desktop', 'models')], {
  windowsHide: true,
})

const app = await launchApp({
  ENGRAM_VAULT: VAULT,
  ENGRAM_USERDATA: USERDATA,
  ENGRAM_NO_GIT: '1',
  ENGRAM_NO_AUTOTIDY: '1',
  ENGRAM_INDEX_NOW: '1',
  // Packaged builds search by meaning; a probe has to be the same app.
  ENGRAM_SEMANTIC: '1',
})
await app.page.getByTestId('shell').waitFor({ state: 'visible', timeout: 120_000 })
for (let i = 0; i < 60; i++) {
  const seen = (await app.page.evaluate(() => window.engram.semanticStatus())) as {
    status: string
    detail: string
    model: string
  }
  console.log(`${i * 10}s  ${seen.status} — ${seen.detail} (${seen.model})`)
  if (seen.status === 'ready' || seen.status === 'error') break
  await new Promise((r) => setTimeout(r, 10_000))
}
await app.close()
process.exit(0)
