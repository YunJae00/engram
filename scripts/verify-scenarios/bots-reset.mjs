// v1 bot data (bots.json without version, two scheduled tasks) is backed up byte-for-byte and reset to one Engram bot, once.
// Checks: one byte-identical .engram/backups/bots-v1-<stamp>/ folder, bot-memory/_person.json left in place,
// exactly one notice in notices.json whose text names the backup path and the 2 stopped schedules, the sidebar
// listing only "Engram", and a further relaunch adding no notice and no second backup folder.
// Until rd-bots-reset-v2 lands, the reset does not exist and this scenario returns ok:false with evidence
// naming the missing backups/bots-v1-* folder; that is the expected result on current code.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const DESKTOP = join(REPO, 'apps/desktop')
const STEP_MS = 15_000
const IDS = ['b-v1-aaaa0001', 'b-v1-bbbb0002']

function fixture() {
  // Recent times: the sidebar hides conversations older than a day.
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
  // A future one-day date: never due and never over, so the scheduler leaves bots.json untouched.
  const schedule = { days: [], hour: 9, minute: 0, on: '2099-01-01' }
  const bots = IDS.map((id, i) => ({
    id, name: `V1 comet ${i + 1}`, purpose: `Old purpose ${i + 1}`, createdAt: at(30 + i),
    tasks: [{ id: `t-v1-${i + 1}`, name: `Daily ${i + 1}`, goal: `Old goal ${i + 1}`, schedule }],
  }))
  const files = { 'bots.json': `{\n    "bots": ${JSON.stringify(bots, null, 3)},\n\t"dismissed": []\n}\n\n` }
  for (const id of IDS) {
    files[`bot-chats/${id}.jsonl`] = `${JSON.stringify({ role: 'user', text: `hello ${id}`, at: at(10) })}\n`
    files[`bot-memory/${id}.json`] = JSON.stringify({ facts: [], turns: 0 })
  }
  return { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])), person: Buffer.from('{ "facts": ["likes tea"],  "turns": 3 }\n') }
}

async function readOr(path, fallback) {
  try { return await readFile(path) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

async function backupDirs(cache) {
  const entries = await readdir(join(cache, 'backups'), { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
  return entries.filter((e) => e.isDirectory() && /^bots-v1-.+/.test(e.name)).map((e) => e.name).sort()
}

async function check(page, cache, seed, expect, failures, label) {
  const backups = await backupDirs(cache)
  let backup
  if (backups.length === 0) failures.push(`${label}: expected one backups/bots-v1-* folder, found none (reset did not run)`)
  else if (backups.length > 1) failures.push(`${label}: expected one backups/bots-v1-* folder, found ${backups.length}: ${backups.join(', ')}`)
  else backup = join(cache, 'backups', backups[0])
  if (backup) {
    for (const [rel, bytes] of Object.entries(seed.files)) {
      const got = await readOr(join(backup, rel), null)
      if (!got) failures.push(`${label}: backup is missing ${rel}`)
      else if (!got.equals(bytes)) failures.push(`${label}: backup ${rel} is not byte-identical`)
    }
    if (await readOr(join(backup, 'bot-memory/_person.json'), null)) failures.push(`${label}: _person.json was copied into the backup`)
  }
  const person = await readOr(join(cache, 'bot-memory/_person.json'), null)
  if (!person?.equals(seed.person)) failures.push(`${label}: bot-memory/_person.json ${person ? 'changed' : 'is gone'}`)
  for (const rel of Object.keys(seed.files).filter((r) => r !== 'bots.json')) {
    if (await readOr(join(cache, rel), null)) failures.push(`${label}: v1 file ${rel} is still live`)
  }
  let live
  try { live = JSON.parse((await readOr(join(cache, 'bots.json'), Buffer.from('{}'))).toString('utf8')) } catch (error) { failures.push(`${label}: live bots.json unreadable (${error.message})`) }
  if (live) {
    const names = (live.bots ?? []).map((b) => b.name)
    if (live.version !== 2 || names.length !== 1 || names[0] !== 'Engram') failures.push(`${label}: live bots.json has version ${live.version} and bots ${JSON.stringify(names)}, expected version 2 with only "Engram"`)
  }

  const rows = page.locator('.sidebar-conversation-name')
  let names = []
  try {
    await expect.poll(async () => (names = (await rows.allTextContents()).map((t) => t.trim())), { timeout: 5_000 }).toEqual(['Engram'])
  } catch {
    failures.push(`${label}: sidebar lists ${JSON.stringify(names)}, expected only "Engram"`)
  }

  let notices = []
  try { notices = JSON.parse((await readOr(join(cache, 'notices.json'), Buffer.from('[]'))).toString('utf8')) } catch (error) { failures.push(`${label}: notices.json unreadable (${error.message})`) }
  // The absolute path and the vault-relative .engram/backups/<folder> path both contain this.
  const resetNotices = notices.filter((n) => backup && typeof n.text === 'string' && n.text.includes(`backups/${backups[0]}`))
  if (notices.length !== 1 || resetNotices.length !== 1) failures.push(`${label}: expected one notice naming the backup folder, found ${notices.length} notices (${resetNotices.length} naming it)`)
  const notice = resetNotices[0]
  if (notice && !/일정 2개가 멈췄어요|\b2\b.*(scheduled tasks?|schedules?).*(stopped|paused)/i.test(notice.text)) failures.push(`${label}: notice text does not say 2 schedules stopped`)
  return { backup: backups[0], noticeId: notice?.id }
}

export async function run(page, { app, paths, expect, log }) {
  const req = createRequire(join(DESKTOP, 'package.json'))
  const { _electron } = (await import(pathToFileURL(req.resolve('@playwright/test')).href)).default
  const { closeTestApp } = await import(pathToFileURL(join(DESKTOP, 'e2e/navigation.ts')).href)
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
  // verify-cli closes this app again after run; a closed Playwright app throws on close() and process().
  const closeOnce = app.close.bind(app)
  const child = app.process()
  let closing
  app.close = () => (closing ??= closeOnce())
  app.process = () => child
  try {
    await closeTestApp(app)
  } catch (error) {
    return { ok: false, evidence: `initial app close failed: ${String(error.message ?? error).split('\n')[0]}` }
  }

  const seed = fixture()
  await mkdir(join(paths.cache, 'bot-chats'), { recursive: true })
  await mkdir(join(paths.cache, 'bot-memory'), { recursive: true })
  for (const [rel, bytes] of Object.entries(seed.files)) await writeFile(join(paths.cache, rel), bytes)
  await writeFile(join(paths.cache, 'bot-memory/_person.json'), seed.person)

  const failures = []
  let stage = 'second launch'
  const relaunch = async (body) => {
    const next = await _electron.launch({
      args: [join(DESKTOP, 'out/main/index.js'), '--no-sandbox'],
      env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
      timeout: STEP_MS,
    })
    next.process().stdout?.pipe(log, { end: false })
    next.process().stderr?.pipe(log, { end: false })
    try {
      const win = await next.firstWindow({ timeout: STEP_MS })
      win.on('pageerror', (err) => log.write(`[renderer pageerror] ${err.stack ?? err}\n`))
      await expect(win.getByTestId('shell')).toBeVisible({ timeout: STEP_MS })
      return await body(win)
    } finally {
      await closeTestApp(next).catch((error) => failures.push(`${stage}: close failed (${error.message})`))
    }
  }

  try {
    const first = await relaunch((win) => check(win, paths.cache, seed, expect, failures, 'after reset'))
    stage = 'third launch'
    const again = await relaunch((win) => check(win, paths.cache, seed, expect, failures, 'after relaunch'))
    if (first.backup && again.backup !== first.backup) failures.push(`after relaunch: backup folder changed from ${first.backup} to ${again.backup}`)
    if (first.noticeId && again.noticeId !== first.noticeId) failures.push('after relaunch: the reset notice was replaced by a new one')
  } catch (error) {
    failures.push(`${stage} failed: ${String(error.message ?? error).split('\n')[0]}`)
  }
  return {
    ok: failures.length === 0,
    evidence: failures.length ? failures.join('; ') : 'one Engram bot at version 2; one byte-identical bots-v1 backup; _person.json kept; one notice with backup path and 2 stopped schedules; relaunch added no backup or notice',
  }
}
