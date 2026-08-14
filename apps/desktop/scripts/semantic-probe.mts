// Semantic layer probe: boots the app on a tiny seeded vault with
// ENGRAM_SEMANTIC=1 and polls semantic:status through the preload bridge —
// surfaces the real load/download error that production swallows by design.
import { _electron as electron } from '@playwright/test'
import { createNote, initVault } from 'core'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/semantic-probe-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/semantic-probe-userdata/', import.meta.url))

await rm(VAULT, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await createNote(paths, { body: '# 청킹 전략\n\n512 토큰 문단 분할이 가장 안정적.' })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_SEMANTIC: '1' },
})
app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[main] ${d}`))
app.process().stderr?.on('data', (d: Buffer) => process.stdout.write(`[main:err] ${d}`))
const page = await app.firstWindow()
for (let i = 0; i < 180; i++) {
  await page.waitForTimeout(5000)
  const status = await page.evaluate(() => (window as unknown as { engram: { semanticStatus(): Promise<unknown> } }).engram.semanticStatus())
  if (i % 6 === 0 || (status as { status: string }).status !== 'loading')
    console.log(`t+${(i + 1) * 5}s`, JSON.stringify(status))
  const s = status as { status: string }
  if (s.status === 'ready' || s.status === 'error') break
}
await app.close()
