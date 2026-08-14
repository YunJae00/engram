import { _electron as electron } from '@playwright/test'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const USERDATA = fileURLToPath(new URL('../../../tmp/warm-probe-userdata/', import.meta.url))
await rm(USERDATA, { recursive: true, force: true })

// ENGRAM_PROBE_EXE points at a PACKAGED build (dist/win-unpacked/Engram.exe)
// to verify the real installer payload; unset, the dev build runs.
const exe = process.env.ENGRAM_PROBE_EXE
const app = await electron.launch({
  ...(exe
    ? { executablePath: exe, args: ['--no-sandbox'] }
    : { args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'] }),
  env: { ...process.env, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_SEMANTIC: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('onboarding').waitFor({ state: 'visible', timeout: 30_000 })
console.log('onboarding visible (no vault)')
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(5000)
  const status = await page.evaluate(() =>
    (window as unknown as { engram: { semanticStatus(): Promise<unknown> } }).engram.semanticStatus(),
  )
  console.log(`t+${(i + 1) * 5}s`, JSON.stringify(status))
  const s = status as { status: string; detail: string }
  if (s.detail.includes('model ready')) {
    console.log(`PASS: model ready in ~${(i + 1) * 5}s ${(i + 1) * 5 <= 30 ? '(bundled/local — no download)' : '(slow: likely remote)'}`)
    break
  }
  if (s.status === 'error') {
    console.log('FAIL: error state')
    break
  }
}
await app.close()
