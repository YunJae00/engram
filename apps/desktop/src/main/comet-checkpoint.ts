import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renameWithRetry, withoutSecrets, type VaultPaths } from 'core'

interface Checkpoint { context?: string; pending: string[]; returned?: string[]; replayed?: string[] }
const writes = new Map<string, Promise<unknown>>()
function fileOf(paths: VaultPaths, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid conversation ID')
  return join(paths.cache, 'checkpoints', `${id}.json`)
}
export async function readCheckpoint(paths: VaultPaths, id: string): Promise<Checkpoint> {
  const file = fileOf(paths, id)
  await writes.get(file)
  return read(file)
}
async function read(file: string): Promise<Checkpoint> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object') throw new Error('Invalid checkpoint')
    const data = value as Checkpoint
    return { ...(typeof data.context === 'string' ? { context: data.context } : {}), ...(Array.isArray(data.returned) ? { returned: data.returned.filter(text => typeof text === 'string') } : {}), ...(Array.isArray(data.replayed) ? { replayed: data.replayed.filter(text => typeof text === 'string') } : {}), pending: Array.isArray(data.pending) ? data.pending.filter(text => typeof text === 'string') : [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pending: [] }
    throw error
  }
}
export function changeCheckpoint(paths: VaultPaths, id: string, change: (state: Checkpoint) => Checkpoint): Promise<void> {
  const file = fileOf(paths, id)
  const work = (writes.get(file) ?? Promise.resolve()).then(async () => {
    const next = change(await read(file))
    await mkdir(join(paths.cache, 'checkpoints'), { recursive: true })
    const scratch = `${file}.${process.pid}.tmp`
    await writeFile(scratch, withoutSecrets(JSON.stringify(next), [next.context ?? '', ...next.pending].join('\n')))
    await renameWithRetry(scratch, file)
  })
  const settled = work.catch(() => undefined)
  writes.set(file, settled)
  void settled.finally(() => { if (writes.get(file) === settled) writes.delete(file) })
  return work
}

export async function settleHanded(paths: VaultPaths, id: string, handed: string[], left: string[], retry = true): Promise<{ queued: string[]; unapplied: string[] }> {
  const result = { queued: [] as string[], unapplied: [] as string[] }
  await changeCheckpoint(paths, id, state => {
    const issued = new Set([...(state.returned ?? []), ...(state.replayed ?? [])])
    for (const text of new Set(left.filter(text => handed.includes(text)))) {
      if (retry && !issued.has(text)) result.queued.push(text)
      else result.unapplied.push(text)
    }
    return { ...state, pending: state.pending.filter(text => !handed.includes(text)), returned: [...new Set([...(state.returned ?? []), ...result.queued])] }
  })
  return result
}
