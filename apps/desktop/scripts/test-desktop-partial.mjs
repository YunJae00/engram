import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { guardedSequence } from '../src/main/desktop-guarded-sequence.ts'
import { testDesktopUia } from './test-desktop-uia.mjs'
import { testDesktopLegacy } from './test-desktop-legacy.mjs'

export async function testDesktopPartial(helper, fixture, target, result, until, desktop, output) {
  result.stage = 'partial-capture'
  await fixture.request('dense')
  const partialView = await helper.request('observe', target)
  assert.equal(partialView.truncated, true)
  assert.equal(partialView.captureSafe, true)
  await helper.request('capture', { ...target, snapshot: partialView.snapshot })
  result.stage = 'accessibility-backends'
  result.uiaNormal = testDesktopUia(desktop, output, target, false)
  await fixture.request('password')
  result.uiaPassword = testDesktopUia(desktop, output, target, true)
  await fixture.request('hidePassword')
  result.stage = 'legacy-accessibility-probe'
  await testDesktopLegacy(fixture, target, output, result)
  result.stage = 'partial-focused-editing'
  await fixture.request('deepFocus')
  const deepLease = await helper.request('bind', { ...target, grant: randomUUID() })
  const deepBound = { ...target, lease: deepLease.lease }
  let deepView = await helper.request('observe', deepBound)
  assert.equal(deepView.truncated, true)
  const deepEditor = deepView.nodes.find(node => node.name === 'Deep editor')
  assert.ok(deepEditor?.runtimeId)
  result.partialEditorType = deepEditor.controlType
  assert.equal(deepEditor.actions.type, true, 'The multiline editor was not recognized as editable')
  assert.equal(deepView.focusedControl, deepEditor.runtimeId, 'The partial observation lost editor focus')
  assert.equal(deepView.focusedEditable, true, 'The focused multiline surface was not recognized as editable')
  await helper.request('click', { ...deepBound, snapshot: deepView.snapshot, element: deepEditor.id })
  for (const action of [{ method: 'type', text: 'Draft' }, { method: 'key', key: 'Control+A' }, { method: 'type', text: 'Verified draft' }]) {
    deepView = await helper.request('observe', deepBound)
    assert.equal(deepView.focusedControl, deepEditor.runtimeId)
    const { method, ...input } = action
    await helper.request(method, { ...deepBound, snapshot: deepView.snapshot, ...input })
  }
  await until(() => helper.request('observe', deepBound),
    view => view.focusedControl === deepEditor.runtimeId && view.nodes.some(node => node.runtimeId === deepEditor.runtimeId && node.value === 'Verified draft'),
    'The focused partial observation did not confirm the complete edited value')
  assert.equal((await fixture.request('state')).deepText, 'Verified draft')
  result.stage = 'anchored-partial-workflow'
  const focusCapture = await helper.request('observe', { ...deepBound, focusedOnly: true })
  assert.equal(focusCapture.captureSafe, false)
  await assert.rejects(helper.request('capture', { ...deepBound, snapshot: focusCapture.snapshot }), /full window/)
  const fullCapture = await helper.request('observe', deepBound)
  await helper.request('capture', { ...deepBound, snapshot: fullCapture.snapshot })
  result.focusCaptureRejectionPassed = true
  result.partialTimings = []
  const partialRead = async (focusedOnly = false) => {
    const started = performance.now()
    const view = await helper.request('observe', { ...deepBound, focusedOnly })
    result.partialTimings.push({ kind: 'observe', focusedOnly, elapsedMs: Math.round(performance.now() - started) })
    return view
  }
  const partialAct = async ({ kind, snapshot, ...args }) => {
    const started = performance.now()
    const value = await helper.request(kind, { ...deepBound, snapshot, ...args })
    result.partialTimings.push({ kind, elapsedMs: Math.round(performance.now() - started) })
    return value
  }
  const partialStart = await partialRead()
  const anchor = partialStart.nodes.find(node => node.runtimeId === deepEditor.runtimeId)
  assert.ok(anchor)
  const anchoredTarget = { name: anchor.name, controlType: anchor.controlType, element: anchor.id }
  const initialText = 'Quarterly planning\nReview 12 open items\nPrepare follow-up'
  const finalText = initialText.replace('Quarterly planning', 'Updated quarterly planning')
  const anchoredSteps = [
    { kind: 'key', key: 'Control+A' },
    { kind: 'type', text: 'Quarterly planning' },
    { kind: 'key', key: 'Enter' },
    { kind: 'type', text: 'Review 12 open items' },
    { kind: 'key', key: 'Enter' },
    { kind: 'type', text: 'Prepare follow-up' },
    { kind: 'verify', value: initialText },
    { kind: 'key', key: 'Control+Home' },
    { kind: 'key', key: 'Shift+End' },
    { kind: 'type', text: 'Updated quarterly planning' },
    { kind: 'verify', value: finalText },
  ].map(step => ({ ...step, target: anchoredTarget, snapshot: partialStart.snapshot }))
  const anchoredResult = JSON.parse(await guardedSequence(partialStart, anchoredSteps, partialRead, partialAct))
  result.anchoredPartialResult = anchoredResult
  assert.equal(anchoredResult.error, undefined, anchoredResult.error)
  assert.equal(anchoredResult.completed, 11)
  assert.equal(anchoredResult.dispatched, 9)
  assert.equal(anchoredResult.verified, 2)
  assert.equal(anchoredResult.observation.truncated, true)
  assert.equal(anchoredResult.observation.scope, 'focus')
  assert.ok(anchoredResult.observation.nodes.length <= 2)
  assert.equal((await fixture.request('state')).deepText.replace(/\r\n?/g, '\n'), finalText)
  result.anchoredPartialWorkflowMs = anchoredResult.elapsedMs
  result.anchoredPartialWorkflowPassed = true
  await helper.request('stop')
  result.stage = 'readonly-document'
  await fixture.request('deepReadonly')
  const readonlyLease = await helper.request('bind', { ...target, grant: randomUUID() })
  const readonlyBound = { ...target, lease: readonlyLease.lease }
  const readonlyDocument = await helper.request('observe', readonlyBound)
  assert.equal(readonlyDocument.focusedEditable, false)
  assert.equal(readonlyDocument.nodes.find(node => node.runtimeId === deepEditor.runtimeId)?.actions.type, false)
  await assert.rejects(helper.request('type', { ...readonlyBound, snapshot: readonlyDocument.snapshot, text: 'Do not type' }), /editable field/)
  assert.equal((await fixture.request('state')).deepText.replace(/\r\n?/g, '\n'), finalText)
  result.readonlyDocumentRejectionPassed = true
  await helper.request('stop')
  result.partialFocusedEditingPassed = true
  const beforePassword = await helper.request('observe', target)
  await fixture.request('password')
  await assert.rejects(helper.request('capture', { ...target, snapshot: beforePassword.snapshot }), /cleared for capture/)
  assert.equal((await helper.request('observe', target)).captureSafe, false)
  await fixture.request('sparse')
  result.partialCapturePassed = true
}
