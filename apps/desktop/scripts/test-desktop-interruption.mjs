import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function testDesktopInterruption(helper, fixture, target) {
  if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Owned desktop interruption requires isolated Windows CI')
  }
  await helper.request('stop')
  const before = await fixture.request('passwordDuringTyping')
  const lease = await helper.request('bind', { ...target, grant: randomUUID() })
  const bound = { ...target, lease: lease.lease }
  try {
    const view = await helper.request('observe', bound)
    assert.equal(view.focusedEditable, true)
    assert.equal(before.passwordVisible, false)
    const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(4)
    await assert.rejects(helper.request('type', { ...bound, snapshot: view.snapshot, text }), /Password and authentication/)
    const after = await fixture.request('state')
    assert.equal(after.passwordVisible, true, 'The fixture must expose the protected field during input')
    assert.equal(after.focused, true, 'The intended editor must retain focus; this tests a sibling protected field')
    assert.ok(after.text.length > 0 && after.text.length <= 4, 'Only the already-dispatched four-character packet may reach the editor')
    assert.equal(after.text, text.slice(0, after.text.length))
    assert.equal(after.protectedCharacters, 0, 'No input may reach the protected field')
    assert.equal(after.clicks, before.clicks)
    assert.equal(after.deepText, before.deepText)
    assert.equal(after.draft, before.draft)
    assert.equal(after.reviewed, before.reviewed)
    await assert.rejects(helper.request('observe', bound))
    assert.equal((await helper.request('inputState')).working, false)
    return { passed: true, acceptedCharacters: after.text.length, protectedCharacters: after.protectedCharacters }
  } finally {
    await helper.request('stop')
    await fixture.request('hidePassword')
  }
}
