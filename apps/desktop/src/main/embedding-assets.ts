import { net } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']

export async function embeddingAssets(model: string, roots: string[], cache: string, signal: AbortSignal, progress: (detail: string) => void): Promise<string> {
  signal.throwIfAborted()
  if (!/^[\w.-]+\/[\w.-]+$/.test(model) || model.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid embedding model')
  const complete = async (root: string) => (await Promise.all(FILES.map(file => stat(join(root, model, file)).then(info => info.isFile() && info.size > 0).catch(() => false)))).every(Boolean)
  for (const root of [...roots, cache]) if (await complete(root)) return root
  for (const [index, file] of FILES.entries()) {
    signal.throwIfAborted()
    const target = join(cache, model, file)
    if (await stat(target).then(info => info.isFile() && info.size > 0).catch(() => false)) continue
    progress(`downloading model file ${index + 1}/${FILES.length}`)
    await mkdir(dirname(target), { recursive: true })
    const response = await net.fetch(`https://huggingface.co/${model}/resolve/main/${file}`, { signal, credentials: 'omit' })
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Model download failed (${response.status})`) }
    const temporary = `${target}.${randomUUID()}.tmp`
    const reader = response.body.getReader()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx')
      let size = 0
      const limit = file.endsWith('.onnx') ? 1_000_000_000 : 100_000_000
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        signal.throwIfAborted()
        size += value.length
        if (size > limit) throw new Error('Model download exceeds its size limit')
        await handle.writeFile(value)
      }
      if (!size) throw new Error('Model download was empty')
      await handle.close(); handle = undefined
      await rename(temporary, target)
    } finally {
      await reader.cancel().catch(() => undefined)
      await handle?.close()
      await unlink(temporary).catch(() => undefined)
    }
  }
  return cache
}
