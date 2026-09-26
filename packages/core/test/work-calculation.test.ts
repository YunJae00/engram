import { expect, it, vi } from 'vitest'
import { fileWorkTools } from '../src/file-work.js'

const read = vi.fn(async () => false)
const tool = fileWorkTools({ directory: 'unused', approveRead: read }).find(tool => tool.name === 'work_calculate')!
const call = (calculations: unknown[], signal?: AbortSignal) => tool.run({ calculations }, { task: 'Verify arithmetic', signal })
const calc = (id: string, operation: string, values: unknown[]) => ({ id, operation, values })

it('calculates dependent capacity and integer-cent controls without file access', async () => {
  const result = JSON.parse(await call([
    calc('yield', 'multiply', [4620, 0.98]), calc('required', 'divide', [250000, { ref: 'yield' }]),
    calc('batches', 'ceil', [{ ref: 'required' }]), calc('net', 'multiply', [{ ref: 'batches' }, { ref: 'yield' }]),
    calc('cents', 'sum', [10, 20, 549327]), calc('difference', 'subtract', [600000, { ref: 'cents' }]),
  ]))
  const values = result.calculations.map((row: { result: number }) => row.result)
  expect(values.slice(0, 3)).toEqual([4527.6, 250000 / 4527.6, 56])
  expect(values[3]).toBeCloseTo(253545.6, 6)
  expect(values.slice(4)).toEqual([549357, 50643])
  expect(read).not.toHaveBeenCalled()
  expect(result.verification).toContain('not verified')
})

it('rejects code, invalid references, arity, overflow and excess work', async () => {
  for (const calculations of [
    [calc('x', 'eval', ['process.exit()'])], [calc('x', 'sum', ['1+2'])],
    [calc('x', 'sum', [{ ref: 'later' }])], [calc('x', 'sum', [1]), calc('x', 'sum', [2])],
    [calc('x', 'divide', [1, 0])], [calc('x', 'divide', [1])], [calc('x', 'ceil', [1, 2])],
    [calc('x', 'sum', [Infinity])], [calc('x', 'sum', [NaN])], [calc('x', 'multiply', [Number.MAX_SAFE_INTEGER, 2])],
    [calc('x', 'sum', [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])],
    [calc('x', 'sum', [{ ref: 'x', code: 'anything' }])], [calc('x', 'sum', Array(1001).fill(1))],
    Array.from({ length: 11 }, (_, i) => calc(`x${i}`, 'sum', Array(1000).fill(1))),
  ]) await expect(call(calculations)).rejects.toThrow()
  await expect(call([calc('x', 'sum', [1])], AbortSignal.abort())).rejects.toThrow()
})
