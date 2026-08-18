// The web errand, end to end, for real: the packaged main process, the REAL
// Gemma model (symlinked in), the REAL Chrome driven by the agent browser,
// real DuckDuckGo searches. Three errands a person would actually give:
// research, a mail draft grounded on a vault note, and a comparison. Each
// must end as a new-note proposal card in review.
//
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/errand-probe.mts"
import { _electron as electron } from '@playwright/test'
import { createNote, initVault, vaultPaths } from 'core'
import { execSync } from 'node:child_process'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/errand-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/errand-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
await initVault(VAULT, { git: false })
await mkdir(join(USERDATA, 'models'), { recursive: true })

const home = process.env['HOME']!
const realGguf =
  process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'desktop', 'models', 'gguf')
    : join(process.env['APPDATA'] ?? '', 'desktop', 'models', 'gguf')
await symlink(realGguf, join(USERDATA, 'models', 'gguf'), 'junction')
await writeFile(join(USERDATA, 'local-llm.json'), JSON.stringify({ activeModelId: 'gemma4-e2b' }))

const paths = vaultPaths(VAULT)
await createNote(paths, {
  body: '# 배포 정책\n\n- 금요일 배포 금지, 화-목만 배포한다\n- 쿠버네티스 배포는 helm 차트로 통일\n- 스테이징 values는 신규 리포에 둔다',
  type: 'decision',
})
await createNote(paths, {
  body: '# 팀 온보딩 메모\n\n- 신규 입사자는 첫 주에 스테이징 접근 권한을 받는다\n- 배포 채널은 #deploy-alerts',
})

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: VAULT,
    ENGRAM_USERDATA: USERDATA,
    ENGRAM_NO_GIT: '1',
    ENGRAM_NO_AUTOTIDY: '1',
    ENGRAM_ENGINE: 'local',
  },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
console.log('errand-probe: shell up')

interface Outcome {
  ok: boolean
  error?: string
  phases: string[]
  seconds: number
}

async function runErrandInApp(goal: string, timeoutMs: number): Promise<Outcome> {
  const t0 = Date.now()
  const outcome = (await page.evaluate(
    ({ goal, timeoutMs }) =>
      new Promise((resolve) => {
        const phases: string[] = []
        const off = window.engram.onEvent((event: { type: string } & Record<string, unknown>) => {
          if (event.type === 'errand:phase') {
            phases.push(String(event['phase']))
            if (event['phase'] === 'done') {
              off()
              resolve({ ok: true, phases })
            }
            if (event['phase'] === 'failed') {
              off()
              resolve({ ok: false, error: String(event['error'] ?? ''), phases })
            }
          }
          if (event.type === 'errand:wall') {
            phases.push(`WALL:${event['wall']}:${event['url']}`)
            void window.engram.errandWallDone('skip')
          }
        })
        void window.engram.errandStart(goal).then((r: { ok: boolean; error?: string }) => {
          if (!r.ok) {
            off()
            resolve({ ok: false, error: r.error ?? 'refused', phases })
          }
        })
        setTimeout(() => {
          off()
          resolve({ ok: false, error: `probe timeout after ${timeoutMs}ms`, phases })
        }, timeoutMs)
      }),
    { goal, timeoutMs },
  )) as Omit<Outcome, 'seconds'>
  return { ...outcome, seconds: Math.round((Date.now() - t0) / 1000) }
}

const scenarios: { name: string; goal: string }[] = [
  { name: 'research', goal: 'Electron 앱에서 메모리 사용량을 줄이는 방법을 조사해줘' },
  { name: 'mail-draft', goal: '우리 배포 정책을 바탕으로 팀에게 보낼 공지 메일 초안을 한국어로 써줘' },
  { name: 'compare', goal: 'DuckDuckGo Search API와 Brave Search API의 가격과 무료 한도를 비교해줘' },
]

let failed = 0
let cardsSeen = 0
for (const scenario of scenarios) {
  console.log(`\n=== ${scenario.name}: ${scenario.goal}`)
  const result = await runErrandInApp(scenario.goal, 12 * 60_000)
  console.log(`phases (${result.seconds}s):`, result.phases.join(' → ') || '(none)')
  if (!result.ok) {
    failed++
    console.error(`errand-probe: ${scenario.name} FAILED — ${result.error}`)
    continue
  }
  const cards = (await page.evaluate(() => window.engram.listCards())) as {
    id: string
    cardType: string
    rationale: string
    proposed: string
    status: string
  }[]
  const card = cards.find((c) => c.status === 'proposed' && c.rationale.includes(scenario.goal.slice(0, 30)))
  if (!card) {
    failed++
    console.error(`errand-probe: ${scenario.name} FAILED — no proposal card landed`)
    continue
  }
  cardsSeen++
  console.log('--- proposed note ---')
  console.log(card.proposed.slice(0, 1200))
  if (card.proposed.trim().length < 80) {
    failed++
    console.error(`errand-probe: ${scenario.name} FAILED — proposed note too thin`)
  }
}

await app.close()

// Zombie check: the agent's Chrome must be gone with the app.
await new Promise((r) => setTimeout(r, 2_000))
const left = execSync('pgrep -f agent-browser-profile || true', { encoding: 'utf8' }).trim()
if (left) {
  failed++
  console.error(`errand-probe: ZOMBIE Chrome processes left behind: ${left}`)
} else console.log('errand-probe: no leftover Chrome processes')

if (failed > 0) {
  console.error(`errand-probe: ${failed} failure(s) (${cardsSeen} cards landed)`)
  process.exit(1)
}
console.log(`errand-probe: DONE — ${cardsSeen} proposal cards landed`)
