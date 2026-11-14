import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createBot, initVault, type VaultPaths } from 'core'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication | undefined
let page: Page
let paths: VaultPaths

test.afterEach(async () => { await closeTestApp(app); app = undefined })

// The mock brain makes one real tool call, then answers; the host adds the file card.
async function ask(message: string, step: { tool: string; args: Record<string, unknown> }): Promise<Buffer> {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-general-'))
  const mock = await mkdtemp(join(TMP, 'e2e-general-mock-'))
  await writeFile(join(mock, 'COMET-STEP.json'), JSON.stringify(step))
  await writeFile(join(mock, 'COMET-ANSWER.md'), '만들었어요.')
  await writeFile(join(mock, 'default.md'), '네.')
  paths = await initVault(root, { git: false })
  await createBot(paths, { name: 'Maker' })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-general-userdata-')), ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: mock, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_HIDDEN: '1' },
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ shell }) => {
    const seen = globalThis as unknown as { opened: string[]; revealed: string[] }
    seen.opened = []; seen.revealed = []
    shell.openPath = async (path: string) => { seen.opened.push(path); return '' }
    shell.showItemInFolder = (path: string) => { seen.revealed.push(path) }
  })
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: 'Maker' }).click()
  const composer = page.getByTestId('bots-view').getByTestId('bots-input')
  await composer.fill(message)
  await composer.press('Enter')
  const name = String(step.args['name'])
  const card = page.getByTestId('answer-file').filter({ hasText: name })
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card.getByTestId('answer-file-size')).toContainText(/\d+(\.\d)? (KB|MB)/)
  const tasks = join(paths.workspace, 'tasks')
  const folders = (await readdir(tasks)).filter(folder => !folder.startsWith('.'))
  for (const folder of folders) {
    const data = await readFile(join(tasks, folder, name)).catch(() => null)
    if (data) return data
  }
  throw new Error(`${name} is not in any task folder: ${folders.join(', ')}`)
}
const seen = (key: 'opened' | 'revealed') => app!.evaluate((_electron, name) => (globalThis as unknown as Record<string, string[]>)[name]!, key)

test('a Korean ask for a PDF yields a real PDF as a file card', async () => {
  const data = await ask('서울 날씨 정리해서 PDF로 만들어줘', { tool: 'render_file', args: { name: '서울 날씨.pdf', html: '<h1>서울 날씨</h1><p>맑음, 최고 12도 최저 3도</p>' } })
  expect(data.subarray(0, 4).toString()).toBe('%PDF')
  await page.getByTestId('answer-file').filter({ hasText: '서울 날씨.pdf' }).click()
  await expect.poll(() => seen('opened')).toHaveLength(1)
})

test('a Korean ask for a spreadsheet yields an xlsx workbook', async () => {
  const data = await ask('지난달 지출 표를 엑셀로 만들어줘', { tool: 'file_create_workbook', args: { name: '지난달 지출.xlsx', sheet: '지출', rows: [['항목', '금액'], ['식비', 420000], ['교통', 88000]] } })
  expect(data.subarray(0, 4).toString('hex')).toBe('504b0304')
  expect(data.includes('xl/workbook.xml')).toBe(true)
})

test('the same ask as CSV yields the table as text', async () => {
  const content = '항목,금액\n식비,420000\n교통,88000\n'
  const data = await ask('지난달 지출 표를 엑셀로 만들어줘 csv로도', { tool: 'file_create_copy', args: { name: '지난달 지출.csv', content } })
  expect(data.toString('utf8')).toBe(content)
})

test('a Korean ask for a bar chart yields a painted PNG with a thumbnail', async () => {
  const bars = [30, 55, 80, 45].map((value, index) => `<rect x="${60 + index * 150}" y="${400 - value * 4}" width="100" height="${value * 4}" fill="#2a78d6"/>`).join('')
  const html = `<body style="margin:0;background:#fff"><svg width="800" height="420" xmlns="http://www.w3.org/2000/svg">${bars}</svg><canvas id="c" width="800" height="60"></canvas><script>const g=document.getElementById('c').getContext('2d');g.fillStyle='#d6402a';g.fillRect(0,0,400,60)</script></body>`
  const data = await ask('월별 매출 막대그래프 PNG로 그려줘', { tool: 'render_file', args: { name: '월별 매출.png', html, width: 800, height: 500 } })
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const image = await app!.evaluate(({ nativeImage }, base64) => {
    const picture = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    const bitmap = picture.toBitmap(), colours = new Set<number>()
    for (let at = 0; at < bitmap.length; at += 4 * 97) colours.add(bitmap.readUInt32LE(at))
    return { ...picture.getSize(), colours: colours.size }
  }, data.toString('base64'))
  expect(image).toMatchObject({ width: 800, height: 500 })
  expect(image.colours).toBeGreaterThan(1)
  await expect(page.getByTestId('answer-file-thumb')).toBeVisible()
})

test('a Korean ask for a script yields a file that opens as text and is never run', async () => {
  const content = 'import os\nfor name in os.listdir("."):\n    os.rename(name, name.lower())\n'
  const data = await ask('폴더 안 파일 이름 바꾸는 파이썬 스크립트 만들어줘', { tool: 'file_create_copy', args: { name: 'rename_files.py', content } })
  expect(data.toString('utf8')).toBe(content)
  await page.getByTestId('answer-file').filter({ hasText: 'rename_files.py' }).click()
  await expect(page.getByTestId('artifact-sheet')).toContainText('os.rename')
  expect(await seen('opened')).toEqual([])
  await page.keyboard.press('Escape')
  await page.getByTestId('answer-file-reveal').click()
  await expect.poll(async () => (await seen('revealed')).at(-1) ?? '').toContain('rename_files.py')
})
