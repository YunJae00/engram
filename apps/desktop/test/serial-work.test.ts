import { expect, it } from 'vitest'
import { serialWork } from '../src/main/serial-work.js'

it('serializes concurrent embedding work and counts queued jobs until completion', async () => {
  const queue = serialWork()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const order: number[] = []
  const first = queue.run(async () => { order.push(1); await blocked; order.push(2); return 'first' })
  const second = queue.run(async () => { order.push(3); return 'second' })
  expect(queue.pending).toBe(2)
  await Promise.resolve()
  await Promise.resolve()
  expect(order).toEqual([1])
  release()
  expect(await Promise.all([first, second])).toEqual(['first', 'second'])
  expect(order).toEqual([1, 2, 3])
  expect(queue.pending).toBe(0)
})

it('does not leave the queue locked after a failed inference', async () => {
  const queue = serialWork()
  await expect(queue.run(async () => { throw new Error('Inference failed') })).rejects.toThrow('Inference failed')
  await expect(queue.run(async () => 'Recovered')).resolves.toBe('Recovered')
  expect(queue.pending).toBe(0)
})
