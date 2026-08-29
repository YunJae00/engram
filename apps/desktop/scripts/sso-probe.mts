// Does a driven window sign in the way a double-clicked one does? The
// driver's defaults switch extensions off; a company's device sign-in often
// lives in one. This opens a fresh profile, optionally with extensions
// allowed, waits for the machine's policy to place them, opens the account
// page and reports only which stage came up - never what it shows. With
// SSO_PROBE_PICK=1 it makes the one click a person would on the account
// picker and reports whether the page behind it opened signed in.
import { chromium } from 'playwright-core'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEVICE_SIGN_IN = 'ppnbnpeolgkicgegkbkbjmhlideopiji'
const executablePath = process.env['AGENT_PROBE_CHROME'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const target = process.env['SSO_PROBE_URL'] ?? 'https://myapps.microsoft.com/'
const keepDefaults = process.env['SSO_PROBE_DEFAULTS'] === '1'
// SSO_PROBE_PROFILE points at an existing profile to try instead of a fresh one.
const ownProfile = process.env['SSO_PROBE_PROFILE']
const profileDir = ownProfile ?? mkdtempSync(join(tmpdir(), 'sso-probe-'))
const ctx = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: false,
  chromiumSandbox: true,
  args: ['--window-size=1200,700', '--window-position=-4000,-4000', '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--test-type'],
  ignoreDefaultArgs: keepDefaults
    ? ['--enable-automation']
    : ['--enable-automation', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-background-networking', '--disable-component-update', '--disable-default-apps'],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())

const stageOf = async (): Promise<{ host: string; asks: boolean; stage: string; text: string }> => {
  const host = new URL(page.url()).host
  const asks = (await page.locator('input[type="email"], input[name="loginfmt"], input[type="password"]').count()) > 0
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ')
  const stage = /Pick an account|계정 선택/i.test(text)
    ? 'account picker'
    : /Stay signed in|로그인 상태를 유지/i.test(text)
      ? 'stay-signed-in prompt'
      : asks
        ? 'sign-in form'
        : /login\.microsoftonline|login\.live/.test(host)
          ? 'sign-in page (no form)'
          : 'past sign-in'
  return { host, asks, stage, text }
}

// The policy's extensions arrive over the network; give them a moment.
const extDir = join(profileDir, 'Default', 'Extensions')
if (!keepDefaults) for (let i = 0; i < 75 && !(existsSync(extDir) && readdirSync(extDir).includes(DEVICE_SIGN_IN)); i++) await page.waitForTimeout(1_000)
const installed = existsSync(extDir) ? readdirSync(extDir) : []
console.log(`extensions placed: ${installed.length} (device sign-in extension ${installed.includes(DEVICE_SIGN_IN) ? 'present' : 'absent'})`)

await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch((err) => console.log('goto:', String(err).slice(0, 80)))
let seen = await stageOf()
for (let i = 0; i < 20 && seen.stage === 'sign-in page (no form)'; i++) {
  await page.waitForTimeout(1_500)
  seen = await stageOf()
}
const signInLinks = await page.locator('a, button').filter({ hasText: /로그인|Sign in|Log in|Login/i }).count()
console.log(`landed on ${seen.host}; stage: ${seen.stage}; sign-in links on page: ${signInLinks}`)

if (seen.stage === 'account picker' && process.env['SSO_PROBE_PICK'] === '1') {
  // The picker lists the machine's own account: one click, as a person would.
  const tile = page.locator('[data-test-id], .table-row, .tile, [role="listitem"], [role="button"]').filter({ hasText: /@/ }).first()
  await tile.click({ timeout: 10_000 }).catch((err) => console.log('pick:', String(err).slice(0, 80)))
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1_500)
    seen = await stageOf()
    if (seen.stage === 'stay-signed-in prompt') {
      await page.locator('input[type="submit"], button:has-text("Yes"), button:has-text("예")').first().click({ timeout: 5_000 }).catch(() => undefined)
      continue
    }
    if (seen.stage === 'past sign-in' || seen.stage === 'sign-in form') break
  }
  const mfa = /Approve sign in|verification code|Authenticator|인증 앱|승인/i.test(seen.text)
  console.log(`after one pick: ${seen.host}; stage: ${seen.stage}; mfa prompt: ${mfa ? 'yes' : 'no'}`)
}
await ctx.close()
if (!ownProfile) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
