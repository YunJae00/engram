import assert from 'node:assert/strict'

export async function measurePreviewCost(helper, target) {
  async function capture() {
    const before = await helper.request('observe', target)
    assert.ok(before.captureSafe || before.truncated === false)
    await helper.request('capture', { ...target, snapshot: before.snapshot })
    await helper.request('observe', target)
  }
  async function batch(eager) {
    const start = performance.now(), requests = helper.sequence
    for (let i = 0; i < 3; i++) {
      await helper.request('quietScan', target)
      if (eager) await capture()
    }
    if (!eager) await capture()
    return { requests: helper.sequence - requests, elapsedMs: Math.round(performance.now() - start) }
  }
  const eager = await batch(true), coalesced = await batch(false)
  assert.equal(eager.requests, 12)
  assert.equal(coalesced.requests, 6)
  return { scope: 'Controlled native operation cost for three reads; eager versus one coalesced preview on the same fixture/helper. Not full-app latency or production scheduling proof.', eager, coalesced }
}
