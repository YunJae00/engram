import { resolve } from 'node:path'
import type { DevExternalSession, DevItem, DevProvider, DevUsage } from '../shared/developers.js'
import { loadClaudeSdk } from './claude-runtime.js'
import { codexBinary, withHelpersOnPath } from './engine-cloud.js'
import { DevRpc } from './dev-rpc.js'
import { codexUsage } from './dev-usage.js'

export async function devProbe(cwd: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const binary = codexBinary()
  if (!binary) throw new Error('The coding runtime is not available.')
  const rpc = new DevRpc(binary, { cwd, env: withHelpersOnPath(binary) }, () => {}, async () => { throw new Error('Read-only account request.') }, () => {})
  try { await rpc.initialize(); return await rpc.send(method, params, 30_000) }
  finally { await rpc.shutdown() }
}

export async function devExternal(cwd: string, provider: DevProvider): Promise<DevExternalSession[]> {
  if (provider === 'claude') {
    const sdk = await loadClaudeSdk() as { listSessions(options: { dir: string; limit: number }): Promise<{ sessionId: string; summary: string; lastModified: number; cwd?: string }[]> }
    const rows = await sdk.listSessions({ dir: cwd, limit: 100 })
    return rows.filter(row => row.cwd && resolve(row.cwd) === resolve(cwd)).map(row => ({ id: row.sessionId, title: row.summary || 'Untitled session', cwd: row.cwd!, provider, updatedAt: row.lastModified }))
  }
  const result = await devProbe(cwd, 'thread/list', { cwd, limit: 100, archived: false })
  if (!Array.isArray(result['data'])) throw new Error('The runtime did not return a session list.')
  return result['data'].filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').filter(row => typeof row['id'] === 'string' && typeof row['cwd'] === 'string' && resolve(row['cwd']) === resolve(cwd)).map(row => ({
    id: String(row['id']), provider, title: typeof row['name'] === 'string' && row['name'] ? row['name'] : typeof row['preview'] === 'string' ? row['preview'].slice(0, 120) : 'Untitled session', cwd: String(row['cwd']),
    updatedAt: typeof row['updatedAt'] === 'number' ? row['updatedAt'] * 1000 : 0,
    ...((row['status'] as { type?: string } | undefined)?.type === 'active' ? { active: true } : {}),
  }))
}

export async function devAccountUsage(cwd: string): Promise<DevUsage> {
  try { return codexUsage(await devProbe(cwd, 'account/rateLimits/read', {})) }
  catch { return { unavailable: 'Account limits could not be refreshed. Check your AI connection and try again.' } }
}

export async function devExternalRead(cwd: string, provider: DevProvider, id: string): Promise<DevItem[]> {
  if (!(await devExternal(cwd, provider)).some(session => session.id === id)) throw new Error('This session does not belong to the selected repository.')
  const items: DevItem[] = []
  if (provider === 'claude') {
    const sdk = await loadClaudeSdk() as { getSessionMessages(id: string, options: { dir: string; limit: number }): Promise<{ uuid: string; type: string; message: { content?: unknown } }[]> }
    for (const message of await sdk.getSessionMessages(id, { dir: cwd, limit: 200 })) {
      if (!['user', 'assistant'].includes(message.type)) continue
      const content = message.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n') : ''
      if (text) items.push({ id: message.uuid, kind: message.type as 'user' | 'assistant', text: text.slice(0, 50_000) })
    }
  } else {
    const result = await devProbe(cwd, 'thread/read', { threadId: id, includeTurns: true })
    const thread = result['thread'] as { turns?: { items?: Record<string, unknown>[] }[] } | undefined
    for (const turn of thread?.turns ?? []) for (const item of turn.items ?? []) {
      if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') items.push({ id: String(item['id']), kind: 'assistant', text: item['text'].slice(0, 50_000) })
      if (item['type'] === 'userMessage' && Array.isArray(item['content'])) items.push({ id: String(item['id']), kind: 'user', text: item['content'].filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n').slice(0, 50_000) })
    }
  }
  return items.slice(-200)
}
