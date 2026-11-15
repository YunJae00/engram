import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RESUME_FIELDS, renameWithRetry, textsIn, withoutSecrets, withoutSecretsIn, type VaultPaths } from 'core'
import { flog } from './flog.js'

interface Checkpoint { context?: string; pending: string[] }
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
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pending: [] }
    throw error
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') throw new Error('Invalid checkpoint')
    const data = value as Checkpoint & { returned?: unknown }
    const pending = Array.isArray(data.pending) ? data.pending.filter(text => typeof text === 'string') : []
    const returned = Array.isArray(data.returned) ? data.returned.filter((text): text is string => typeof text === 'string') : []
    return { ...(typeof data.context === 'string' ? { context: data.context } : {}), pending: [...new Set([...pending, ...returned])] }
  } catch (error) {
    // A damaged checkpoint (an older build redacted the serialized text and
    // could break its JSON) must not stop the chat for good: it is only a
    // resume hint, so start over from the saved history and rewrite it on the next change.
    flog('checkpoint', `unreadable checkpoint ignored: ${(error as Error).name}`)
    return { pending: [] }
  }
}
// The resume context is itself a serialized record (resumeCheckpoint): it is
// cleaned as data and serialized again, so it stays valid JSON too.
function recordIn(context: string | undefined): object | undefined {
  if (context === undefined) return undefined
  try { const parsed: unknown = JSON.parse(context); return parsed !== null && typeof parsed === 'object' ? parsed : undefined } catch { return undefined }
}
function cleanContext(context: string, source: string): string {
  const record = recordIn(context)
  return record ? JSON.stringify(withoutSecretsIn(record, source, RESUME_FIELDS)) : withoutSecretsIn(context, source)
}

export function changeCheckpoint(paths: VaultPaths, id: string, change: (state: Checkpoint) => Checkpoint): Promise<void> {
  const file = fileOf(paths, id)
  const work = (writes.get(file) ?? Promise.resolve()).then(async () => {
    const next = change(await read(file))
    await mkdir(join(paths.cache, 'checkpoints'), { recursive: true })
    const scratch = `${file}.${process.pid}.tmp`
    // Only the stored texts are cleaned; the checkpoint's own field names stay as they are.
    // The context's decoded texts join the source: a value labelled inside it is spelled with
    // escapes in the serialized text, and the pending messages are cleaned of it too.
    const record = recordIn(next.context)
    const source = [next.context ?? '', ...(record ? textsIn(record) : []), ...next.pending].join('\n')
    const clean: Checkpoint = { ...(next.context !== undefined ? { context: cleanContext(next.context, source) } : {}), pending: withoutSecretsIn(next.pending, source) }
    await writeFile(scratch, JSON.stringify(clean))
    await renameWithRetry(scratch, file)
  })
  const settled = work.catch(() => undefined)
  writes.set(file, settled)
  void settled.finally(() => { if (writes.get(file) === settled) writes.delete(file) })
  return work
}

export function acknowledgeHanded(paths: VaultPaths, id: string, handed: string[], context?: string): Promise<void> {
  return changeCheckpoint(paths, id, state => ({ ...state, context, pending: state.pending.filter(text => !handed.includes(text)) }))
}

export function checkpointResume(stored: Checkpoint, history: { role: string; text: string }[]): string {
  const saved = new Set(history.filter(turn => turn.role === 'user').map(turn => turn.text))
  const pending = stored.pending.filter(text => !saved.has(withoutSecrets(text, text)))
  return [stored.context, pending.length ? `User messages saved for this model call: ${JSON.stringify(pending)}` : ''].filter(Boolean).join('\n')
}
