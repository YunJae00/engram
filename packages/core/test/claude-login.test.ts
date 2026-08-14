import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeLoggedIn } from '../src/engine/claude.js'

describe('claudeLoggedIn — logged in, not merely "has run once"', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'engram-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const writeConfig = (body: object) => writeFile(join(home, '.claude.json'), JSON.stringify(body))
  const writeCreds = async (body: object) => {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify(body))
  }

  it('says no on a machine that never ran claude', async () => {
    expect(await claudeLoggedIn(home)).toBe(false)
  })

  // The bug: ~/.claude.json is written the first time the CLI runs and
  // survives logout, so its mere existence had the app claiming "connected"
  // while every call failed on auth.
  it('says no when only the config exists (ran once, never logged in)', async () => {
    await writeConfig({ numStartups: 3, tipsHistory: {}, projects: {} })
    expect(await claudeLoggedIn(home)).toBe(false)
  })

  it('says no when the credential file exists but holds no account', async () => {
    await writeCreds({ mcpOAuth: {} })
    expect(await claudeLoggedIn(home)).toBe(false)
  })

  it('says yes on a real OAuth token', async () => {
    await writeCreds({ mcpOAuth: {}, claudeAiOauth: { accessToken: 'x', expiresAt: 1 } })
    expect(await claudeLoggedIn(home)).toBe(true)
  })

  // The second bug: `claude logout` removes the token but LEAVES oauthAccount
  // (stale account metadata) in ~/.claude.json, so treating that as "logged
  // in" reported connected right after a logout. This is the exact on-disk
  // state observed after a real logout.
  it('says no after logout even though account metadata lingers', async () => {
    await writeCreds({ mcpOAuth: {} }) // token removed, file remains
    await writeConfig({ numStartups: 3, oauthAccount: { emailAddress: 'a@b.c', organizationName: 'x' } })
    expect(await claudeLoggedIn(home)).toBe(false)
  })

  it('ignores account metadata entirely — only the token counts', async () => {
    await writeConfig({ numStartups: 3, oauthAccount: { emailAddress: 'a@b.c' } })
    expect(await claudeLoggedIn(home)).toBe(false)
  })

  it('survives a half-written or corrupt credential file instead of throwing', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth": {"acce')
    expect(await claudeLoggedIn(home)).toBe(false)
  })
})
