import { describe, expect, it } from 'vitest'
import { createModelActivity } from '../src/renderer/src/lib/modelActivity.js'

describe('modelActivity', () => {
  it('holds the latest progress and clears it on done', () => {
    const store = createModelActivity()
    store.handleEvent({ type: 'localllm:warm', state: 'loading' })
    expect(store.getSnapshot().warm).toBe('loading')
    store.handleEvent({ type: 'localllm:progress', phase: 'reading', kind: 'choice', done: 0, total: 900 })
    expect(store.getSnapshot().progress).toEqual({ phase: 'reading', kind: 'choice', done: 0, total: 900 })
    store.handleEvent({ type: 'localllm:progress', phase: 'done', kind: 'choice', done: 0 })
    expect(store.getSnapshot().progress).toBeNull()
  })
})
