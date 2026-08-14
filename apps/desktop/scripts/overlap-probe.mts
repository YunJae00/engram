import { _electron as electron } from '@playwright/test'
import { createNote, initVault, readNote, writeNote } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/overlap-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/overlap-shots/', import.meta.url))

async function seed(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true })
  const paths = await initVault(ROOT, { git: false })
  const at = new Date('2026-07-15T09:00:00Z')
  const note = async (body: string) => (await createNote(paths, { body, happened_at: '2026-07-15' }, at)).front.id
  const a = await note(
    '# SATURN-189: dev idle watchdog 오판 수정 — 툴콜 델타 heartbeat 포팅\n\n문제 dev는 watchdog(200초)를 보유하거나 heartbeat가 없어, 느린 모델의 대형 PPT 요청 시 코드 생성(실측 220~230초, 약 1만 토큰)이 200초를 초과하면 정상 작업을 중단 처리한다.',
  )
  const b = await note(
    '# 로딩 문구 갱신 문제 (SATURN-192)\n\n상태: 할일 | 버그 #bug #ux 문제 LLM 생성 구간(추론, 툴콜 코드 작성)이 길어지면 로딩 문구가 수 분간 "응답을 준비 중입니다..."에 머물다가 툴 실행 시점에야 바뀜.',
  )
  const c = await note('# SATURN 스프린트 회고\n\ndev 안정화 스프린트에서 나온 후속 이슈 정리.')
  const d = await note('# heartbeat 설계 초안\n\n툴콜 델타를 heartbeat 채널로 흘려 실시간 표시.')
  const link = async (from: string, to: string, reason: string) => {
    const n = await readNote(paths, from)
    n.front.derived_from = [...(n.front.derived_from ?? []), to]
    n.front.link_reasons = { ...(n.front.link_reasons ?? {}), [to]: reason }
    await writeNote(paths, n)
  }
  await link(a, b, '문구 갱신(SATURN-192) 부재가 근본 원인인 후속 작업')
  await link(b, c, 'SATURN 스프린트 후속 이슈')
  await link(d, a, 'heartbeat로 toolcall 코드 실시간 표시 기능 활성화에 필요')
  console.log('seeded:', ROOT)
}

async function main(): Promise<void> {
  await seed()
  await mkdir(OUT, { recursive: true })
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: ROOT,
      ENGRAM_USERDATA: join(ROOT, '.userdata'),
      ENGRAM_NO_GIT: '1',
      ENGRAM_ENGINE: 'none',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1500)

  await page.getByTestId('activity-brain').click()
  await page.waitForTimeout(800)
  const item = page.getByTestId('brain-item').first()
  if (await item.count()) await item.click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, 'brain-topic.png') })

  const report = await page.evaluate(() => {
    const out: string[] = []
    document.querySelectorAll('.brain-memories').forEach((grid, gi) => {
      const rows = [...grid.querySelectorAll('.memory-row')]
      rows.forEach((row, i) => {
        const r = row.getBoundingClientRect()
        const title = row.querySelector('.memory-title')?.getBoundingClientRect()
        const date = row.querySelector('.memory-date')?.getBoundingClientRect()
        out.push(
          `grid${gi} row${i}: box ${r.left.toFixed(0)}..${r.right.toFixed(0)}, title ..${title?.right.toFixed(0)}, date ${date?.left.toFixed(0)}..${date?.right.toFixed(0)}`,
        )
        rows.forEach((other, j) => {
          if (j <= i) return
          const o = other.getBoundingClientRect()
          const x = Math.min(r.right, o.right) - Math.max(r.left, o.left)
          const y = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)
          if (x > 0 && y > 0) out.push(`  !! row${i} overlaps row${j} by ${x.toFixed(1)}x${y.toFixed(1)}`)
          const dt = date && (() => {
            const ot = other.querySelector('.memory-title')?.getBoundingClientRect()
            if (!ot) return 0
            const xx = Math.min(date.right, ot.right) - Math.max(date.left, ot.left)
            const yy = Math.min(date.bottom, ot.bottom) - Math.max(date.top, ot.top)
            return xx > 0 && yy > 0 ? xx : 0
          })()
          if (dt) out.push(`  !! row${i} date overlaps row${j} title by ${dt.toFixed(1)}px`)
        })
      })
    })
    return out
  })
  console.log(report.join('\n'))
  await app.close()
  console.log('shots →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
