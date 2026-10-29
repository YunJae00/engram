import { expect, it, vi } from 'vitest'
import { closeTestApp } from '../e2e/navigation.js'

it('requests normal quit while Playwright is blocked flushing a trace', async () => {
  let finish!: () => void
  const quit = vi.fn(() => finish())
  const kill = vi.fn()
  const app = {
    close: vi.fn(() => new Promise<void>(resolve => { finish = resolve })),
    evaluate: vi.fn(async (run: (electron: { app: { quit(): void } }) => void) => run({ app: { quit } })),
    process: () => ({ kill }),
  }
  await closeTestApp(app as never)
  expect(quit).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalled()
})
