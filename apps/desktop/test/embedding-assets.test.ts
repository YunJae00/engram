import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fetch = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch } }))
import { embeddingAssets } from '../src/main/embedding-assets.js'
afterEach(() => fetch.mockReset())
async function root() { const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true }); return mkdtemp(join(parent, 'embedding-assets-')) }
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']

it('uses complete bundled assets offline and preserves the existing cache layout', async () => {
  const base = await root()
  for (const file of files) { await mkdir(join(base, 'example/model', file === files[3] ? 'onnx' : ''), { recursive: true }); await writeFile(join(base, 'example/model', file), 'data') }
  expect(await embeddingAssets('example/model', [base], join(base, 'cache'), new AbortController().signal, () => {})).toBe(base)
  expect(fetch).not.toHaveBeenCalled()
})

it('downloads missing files through Chromium and reuses complete files on retry', async () => {
  const base = await root()
  fetch.mockImplementation(async () => new Response('model data'))
  expect(await embeddingAssets('example/model', [], base, new AbortController().signal, () => {})).toBe(base)
  expect(fetch).toHaveBeenCalledTimes(4)
  expect(fetch.mock.calls[0]![0]).toBe('https://huggingface.co/example/model/resolve/main/config.json')
  expect(await readFile(join(base, 'example/model/onnx/model_quantized.onnx'), 'utf8')).toBe('model data')
  await embeddingAssets('example/model', [], base, new AbortController().signal, () => {})
  expect(fetch).toHaveBeenCalledTimes(4)
})

it('does not retain partial downloads or allow model paths to escape the cache', async () => {
  const base = await root()
  fetch.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('interrupted')) } })))
  await expect(embeddingAssets('example/model', [], base, new AbortController().signal, () => {})).rejects.toThrow('interrupted')
  expect(await readdir(join(base, 'example/model'))).toEqual([])
  await expect(embeddingAssets('../escape', [], base, new AbortController().signal, () => {})).rejects.toThrow('Invalid')
})
