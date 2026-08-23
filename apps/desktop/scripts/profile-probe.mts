// Can the agent browser be the person's OWN browser — already signed in to
// the accounts they use — instead of an empty profile they must log into
// again? Chrome blocks remote-debugging on the default profile, so the only
// routes are (a) launch a COPY of the profile, or (b) a fresh profile that
// inherits the OS sign-in. This measures both, and reports only whether a
// session was recognised — never what it contains.
//
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/profile-probe.mts"
import { chromium, type BrowserContext } from 'playwright-core'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const LOCAL = process.env['LOCALAPPDATA'] ?? ''
const CHROME_USER_DATA = join(LOCAL, 'Google', 'Chrome', 'User Data')
const EDGE_USER_DATA = join(LOCAL, 'Microsoft', 'Edge', 'User Data')

function findExe(...candidates: string[]): string | null {
  return candidates.find((p) => existsSync(p)) ?? null
}

const CHROME = findExe(
  join(process.env['PROGRAMFILES'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
)
const EDGE = findExe(
  join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['PROGRAMFILES'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
)

// Copy only what carries a session: the key store and the cookie jar. The rest
// of a profile is gigabytes of cache nobody needs.
async function copySession(from: string, into: string): Promise<boolean> {
  try {
    await mkdir(join(into, 'Default', 'Network'), { recursive: true })
    await copyFile(join(from, 'Local State'), join(into, 'Local State'))
    await copyFile(join(from, 'Default', 'Network', 'Cookies'), join(into, 'Default', 'Network', 'Cookies'))
    return true
  } catch {
    return false
  }
}

// Where a redirect lands is the whole answer: a live session stays put, a dead
// one is bounced to a sign-in host.
const PROBES = [
  { name: 'google', url: 'https://myaccount.google.com/', signedOut: /accounts\.google\.com|ServiceLogin|signin/i },
  { name: 'microsoft', url: 'https://outlook.office.com/mail/', signedOut: /login\.microsoftonline\.com|login\.live\.com/i },
]

async function check(label: string, exe: string, dir: string): Promise<void> {
  let ctx: BrowserContext | null = null
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      executablePath: exe,
      headless: false,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    const marks: string[] = []
    for (const probe of PROBES) {
      try {
        await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(2_500)
        const landed = page.url()
        const title = await page.title().catch(() => '')
        marks.push(
          `${probe.name}=${probe.signedOut.test(landed) ? 'signed-out' : 'SIGNED IN'} [${landed.slice(0, 58)} | ${title.slice(0, 40)}]`,
        )
      } catch (err) {
        marks.push(`${probe.name}=error(${String(err).slice(0, 40)})`)
      }
    }
    console.log(`${label}\n    ${marks.join('\n    ')}`)
  } catch (err) {
    console.log(`${label.padEnd(34)} launch failed: ${String(err).slice(0, 120)}`)
  } finally {
    await ctx?.close().catch(() => undefined)
  }
}

if (!CHROME) {
  console.error('no Chrome found')
  process.exit(1)
}

// 1) What ships today: an empty profile of our own.
const fresh = await mkdtemp(join(TMP, 'profile-fresh-'))
await check('chrome, empty profile (today)', CHROME, fresh)
await rm(fresh, { recursive: true, force: true }).catch(() => undefined)

// 2) The person's own session, copied into a profile we may drive.
const copied = await mkdtemp(join(TMP, 'profile-copied-'))
const ok = await copySession(CHROME_USER_DATA, copied)
if (ok) await check('chrome, copied session', CHROME, copied)
else console.log('chrome, copied session          could not read the profile (Chrome holds it open)')
await rm(copied, { recursive: true, force: true }).catch(() => undefined)

// 3) Edge with a fresh profile: on a work machine the OS sign-in often
//    carries into it without any copying at all.
if (EDGE) {
  const edgeFresh = await mkdtemp(join(TMP, 'profile-edge-'))
  await check('edge, empty profile', EDGE, edgeFresh)
  await rm(edgeFresh, { recursive: true, force: true }).catch(() => undefined)

  const edgeCopied = await mkdtemp(join(TMP, 'profile-edge-copied-'))
  const edgeOk = await copySession(EDGE_USER_DATA, edgeCopied)
  if (edgeOk) await check('edge, copied session', EDGE, edgeCopied)
  else console.log('edge, copied session            could not read the profile')
  await rm(edgeCopied, { recursive: true, force: true }).catch(() => undefined)
}
console.log('profile-probe: DONE')
