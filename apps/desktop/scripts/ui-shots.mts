import { _electron as electron } from '@playwright/test'
import { createCard, createNote, initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/ui-vault/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/ui-shots/', import.meta.url))

async function seed(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true })
  const paths = await initVault(ROOT, { git: false })
  const at = new Date('2026-07-16T09:00:00Z')
  const note = async (body: string) => (await createNote(paths, { body }, at)).front.id
  const old60 = await note('# 외부 API rate limit\n\n파트너 API rate limit은 분당 60 요청. 초과하면 429 + 60초 백오프.')
  const new600 = await note('# 파트너 API rate limit 상향\n\n파트너사가 분당 600으로 상향해줬다 (7월 계약 갱신).')
  const friA = await note('# 배포 정책: 금요일 배포 금지\n\n금요일에는 프로덕션 배포를 하지 않는다.')
  const friB = await note('# 배포 정책 갱신: 금요일 오전 배포 허용\n\n카나리+자동 롤백 도입으로 금요일 오전 배포 허용.')
  const st1 = await note('# 스탠드업 15분 원칙\n\n데일리 스탠드업은 15분 타임박스를 지킨다.')
  const st2 = await note('# 아침 스탠드업은 짧게\n\n스탠드업이 자꾸 늘어진다. 15분 넘기지 않기로.')
  const st3 = await note('# 스탠드업 또 길어짐\n\n이번 주 두 번이나 30분 초과. 15분 컷 재합의.')
  const meet1 = await note('# 회의록 정리 원칙\n\n회의록은 회의 직후 24시간 안에 정리해야 정보 손실이 없다.')
  const meet2 = await note('# 미팅 노트는 당일에\n\n미팅 노트는 다음날이 되기 전에 정리하자.')
  // filler for the list view scroll check
  for (let i = 1; i <= 14; i++) await note(`# 참고 자료 ${i}\n\nRAG 검색 개선 관련 참고 메모 ${i}번. 청킹과 임베딩 실험 기록.`)

  const card = (input: Parameters<typeof createCard>[1]) => createCard(paths, input, at)
  // rate limit issue: 4 sibling cards (the real dogfood shape)
  await card({ cardType: 'conflict', targets: [old60, new600], rationale: '분당 60 vs 600 상충함', job: 'J3' })
  await card({ cardType: 'supersede', targets: [old60], rationale: '계약 갱신으로 더 이상 참이 아님', proposed: '# 파트너 API rate limit 상향\n\n분당 600으로 상향됨 (7월 계약 갱신).', job: 'J4' })
  await card({ cardType: 'merge', targets: [old60, new600], rationale: '동일 주제의 갱신 내용 통합 가능', proposed: '# 파트너 API rate limit\n\n분당 600 (구 60에서 상향).', job: 'J7' })
  await card({ cardType: 'stale', targets: [old60], rationale: 'verified_until 경과함', proposed: '재확인 필요', job: 'J5' })
  await card({ cardType: 'conflict', targets: [friA, friB], rationale: '전면 금지 vs 오전 허용 상충함', job: 'J3' })
  await card({ cardType: 'supersede', targets: [friA], rationale: '카나리 도입으로 명시적 갱신됨', proposed: '# 배포 정책 갱신: 금요일 오전 배포 허용\n\n카나리+자동 롤백 도입으로 오전 허용.', job: 'J4' })
  await card({ cardType: 'merge', targets: [st1, st2, st3], rationale: '같은 원칙의 반복 재합의 3건, 병합 가능', proposed: '# 스탠드업 15분 원칙\n\n15분 타임박스. 초과 주제는 주차장 목록으로.', job: 'J7' })
  // singles
  await card({ cardType: 'merge', targets: [meet1, meet2], rationale: '동일 원칙 중복 기록, 병합 가능', proposed: '# 회의록 정리 원칙\n\n회의 직후 24시간 안 정리.', job: 'J7' })
  console.log('seeded:', ROOT)
}

async function main(): Promise<void> {
  await seed()
  await mkdir(OUT, { recursive: true })
  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: ROOT,
      ENGRAM_USERDATA: join(ROOT, '.userdata'),
      ENGRAM_NO_GIT: '1',
      ENGRAM_ENGINE: 'mock',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(2000)
  const shot = async (name: string) => {
    await page.screenshot({ path: join(OUT, `${name}.png`) })
    console.log('shot:', name)
  }

  await shot('01-board-topbar')

  // grouped review stack
  await page.getByTestId('review-count').click()
  await page.getByTestId('review-sheet').waitFor({ state: 'visible' })
  await page.waitForTimeout(600)
  const rows = await page.locator('.issue-row').count()
  const chips = await page.locator('.issue-chip').allTextContents()
  console.log('issue rows:', rows, '· sibling chips:', JSON.stringify(chips))
  await shot('02-review-grouped')

  // approve the first issue → feedback toast + stack collapses by the group
  await page.getByTestId('review-sheet').getByRole('button', { name: /^Keep B$|^Approve/ }).first().click()
  await page.waitForTimeout(700)
  const toast = await page.locator('.toast').textContent().catch(() => '(no toast)')
  console.log('toast:', toast?.trim())
  const rowsAfter = await page.locator('.issue-row').count()
  console.log('issue rows after one decision:', rowsAfter)
  await shot('03-review-after-approve')
  await page.keyboard.press('Escape')

  // list view scrolled to the very end — dock must not hide the last row
  await page.getByTestId('activity-list').click()
  await page.waitForTimeout(800)
  await page.locator('.list-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await page.waitForTimeout(400)
  await shot('04-list-end-of-scroll')

  // dark scheme: the new chips/rows/toast must hold up in both themes
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(600)
  await page.getByTestId('activity-board').click()
  await page.waitForTimeout(600)
  await shot('05-board-dark')
  await page.getByTestId('review-count').click()
  await page.getByTestId('review-sheet').waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  await shot('06-review-dark')

  await app.close()
  console.log('ui shots complete')
}

void main()
