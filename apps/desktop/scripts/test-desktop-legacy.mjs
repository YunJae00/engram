import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export async function testDesktopLegacy(fixture, target, output, result) {
  if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Legacy accessibility probes require an isolated Windows CI runner')
  }
  const executable = path.join(output, 'AutomationProbe.exe')
  const run = mode => {
    try {
      return JSON.parse(execFileSync(executable, [String(target.window), String(target.pid), mode],
        { windowsHide: true, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (error) {
      result.legacyProbe.failure = { mode, status: error.status, stderr: String(error.stderr || '').slice(-2000) }
      throw error
    }
  }
  const initial = await fixture.request('state')
  result.legacyProbe = {}
  try {
    await fixture.request('deepFocus')
    result.legacyProbe.writable = run('--legacy')
    assert.equal(result.legacyProbe.writable.restored, true, 'The owned legacy probe did not restore its original document')
    assert.ok(result.legacyProbe.writable.unsupported || result.legacyProbe.writable.writeVerified)
    const restored = await fixture.request('state')
    for (const key of ['text', 'deepText', 'draft', 'reviewed', 'clicks', 'protectedCharacters']) assert.equal(restored[key], initial[key])
    await fixture.request('deepReadonly')
    result.legacyProbe.readonly = run('--legacy-readonly')
    assert.ok(result.legacyProbe.readonly.unsupported || result.legacyProbe.readonly.readonlyBlocked)
    assert.equal(result.legacyProbe.readonly.setterAttempted, false)
    const readonly = await fixture.request('state')
    for (const key of ['text', 'deepText', 'draft', 'reviewed', 'clicks', 'protectedCharacters']) assert.equal(readonly[key], initial[key])
    await fixture.request('deepWritable')
    await fixture.request('password')
    await fixture.request('deepFocus')
    assert.throws(() => run('--legacy'), /A protected field is visible in the owned fixture/)
    const protectedState = await fixture.request('state')
    for (const key of ['text', 'deepText', 'draft', 'reviewed', 'clicks', 'protectedCharacters']) assert.equal(protectedState[key], initial[key])
    result.legacyProbe.protectedBlocked = true
    delete result.legacyProbe.failure
  } finally {
    await fixture.request('hidePassword')
    await fixture.request('deepWritable')
  }
}
