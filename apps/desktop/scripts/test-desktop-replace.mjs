import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { guardedSequence } from '../src/main/desktop-guarded-sequence.ts'

export async function testDesktopReplace(helper, fixture, target, result, until) {
  if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Owned field replacement requires isolated Windows CI')
  }
  const original = await fixture.request('state')
  const evidence = result.fieldReplacement = { passed: false }
  const begin = async () => {
    await helper.request('stop')
    await fixture.request('hidePassword')
    await fixture.request('focus')
    const lease = await helper.request('bind', { ...target, grant: randomUUID() })
    const bound = { ...target, lease: lease.lease }
    const view = await helper.request('observe', bound)
    const entry = view.nodes.find(node => node.name === 'Worker input')
    assert.equal(view.focusedControl, entry?.runtimeId)
    assert.equal(entry.actions.replace, true)
    assert.equal(entry.valueTruncated, false)
    return { bound, view, entry }
  }
  const replace = ({ bound, view, entry }, expected, text) => helper.request('replace', {
    ...bound, snapshot: view.snapshot, element: entry.id, expected, text,
  })
  try {
    result.stage = 'field-replacement'
    const first = await begin()
    const text = 'Working draft 42. '.repeat(60)
    const anchor = { name: first.entry.name, controlType: first.entry.controlType, element: first.entry.id }
    const start = performance.now()
    const output = JSON.parse(await guardedSequence(first.view, [
      { kind: 'replace', snapshot: first.view.snapshot, target: anchor, expected: first.entry.value, text },
    ], focusedOnly => helper.request('observe', { ...first.bound, focusedOnly }),
    ({ kind, snapshot, ...args }) => helper.request(kind, { ...first.bound, snapshot, ...args })))
    evidence.result = output
    assert.equal(output.error, undefined, output.error)
    assert.equal(output.completed, 1)
    assert.equal(output.dispatched, 1)
    assert.equal(output.verified, 1)
    assert.equal((await fixture.request('state')).text, text)
    evidence.elapsedMs = Math.round(performance.now() - start)
    evidence.characters = text.length
    assert.ok(evidence.elapsedMs < 8000, 'Replacement exceeded the production request watchdog')
    const unchanged = await fixture.request('state')
    assert.equal(unchanged.clicks, original.clicks)
    assert.equal(unchanged.deepText, original.deepText)

    result.stage = 'replacement-wrong-expected'
    const wrong = await begin()
    await assert.rejects(replace(wrong, 'Not the observed value', 'Do not replace'), /complete observed value/)
    assert.equal((await fixture.request('state')).text, text)
    evidence.wrongExpectedRejected = true

    result.stage = 'replacement-concurrent-change'
    const stale = await begin()
    await fixture.request('changeEntry')
    await assert.rejects(replace(stale, stale.entry.value, 'Do not overwrite'), /field value changed/)
    assert.equal((await fixture.request('state')).text, 'Changed by application')
    evidence.concurrentChangeRejected = true

    result.stage = 'replacement-stop'
    const stopped = await begin()
    await helper.request('stop')
    await assert.rejects(replace(stopped, stopped.entry.value, 'Do not replace'))
    assert.equal((await fixture.request('state')).text, stopped.entry.value)
    evidence.stopRejected = true

    result.stage = 'replacement-password'
    const protectedField = await begin()
    await fixture.request('password')
    const protectedBefore = await fixture.request('state')
    await assert.rejects(replace(protectedField, protectedField.entry.value, 'Do not replace'), /Password and authentication/)
    const protectedAfter = await fixture.request('state')
    assert.equal(protectedAfter.text, protectedField.entry.value)
    assert.equal(protectedAfter.protectedCharacters, protectedBefore.protectedCharacters)
    evidence.passwordRejected = true

    result.stage = 'replacement-unsupported'
    const unsupported = await begin()
    await helper.request('key', { ...unsupported.bound, snapshot: unsupported.view.snapshot, key: 'Tab' })
    const unsupportedView = await helper.request('observe', unsupported.bound)
    const unsupportedNode = unsupportedView.nodes.find(node => node.runtimeId === unsupportedView.focusedControl)
    assert.ok(unsupportedNode)
    assert.equal(unsupportedNode.actions.replace, false)
    const unsupportedBefore = await fixture.request('state')
    await assert.rejects(helper.request('replace', { ...unsupported.bound, snapshot: unsupportedView.snapshot,
      element: unsupportedNode.id, expected: unsupportedNode.value ?? '', text: 'Do not replace' }), /editable field|complete observed value|writable value replacement/)
    assert.deepEqual(await fixture.request('state'), unsupportedBefore)
    evidence.unsupportedRejected = true

    result.stage = 'replacement-readonly'
    const readonly = await begin()
    await fixture.request('workflow')
    let view = await helper.request('observe', readonly.bound)
    const click = async name => {
      const node = view.nodes.find(node => node.name === name)
      assert.ok(node)
      await helper.request('click', { ...readonly.bound, snapshot: view.snapshot, element: node.id })
      view = await helper.request('observe', readonly.bound)
    }
    await click('Open draft')
    await click('Review draft')
    view = await until(() => helper.request('observe', readonly.bound),
      value => value.nodes.some(node => node.name === 'Reviewed value' && !node.offscreen), 'Readonly review field did not appear')
    await click('Reviewed value')
    const readOnlyNode = view.nodes.find(node => node.name === 'Reviewed value')
    assert.equal(readOnlyNode.actions.replace, false)
    const beforeRefusal = await fixture.request('state')
    await assert.rejects(helper.request('replace', { ...readonly.bound, snapshot: view.snapshot,
      element: readOnlyNode.id, expected: readOnlyNode.value, text: 'Do not replace' }), /editable field|writable value replacement/)
    assert.deepEqual(await fixture.request('state'), beforeRefusal)
    evidence.readonlyRejected = true
    evidence.passed = true
  } finally {
    await helper.request('stop')
    await fixture.request('endWorkflow')
    const restore = await begin()
    if (original.text) await replace(restore, restore.entry.value, original.text)
    else {
      await helper.request('key', { ...restore.bound, snapshot: restore.view.snapshot, key: 'Control+A' })
      const view = await helper.request('observe', restore.bound)
      await helper.request('key', { ...restore.bound, snapshot: view.snapshot, key: 'Backspace' })
    }
    assert.equal((await fixture.request('state')).text, original.text)
    await helper.request('stop')
  }
}
