import { resolve } from 'node:path'
import type { DevExternalSession, DevItem, DevProvider, DevUsage } from '../shared/developers.js'
import { claudeHistory } from './claude-history.js'
import { codexBinary, withHelpersOnPath } from './engine-cloud.js'
import { DevRpc } from './dev-rpc.js'
import { codexUsage } from './dev-usage.js'
import { accountEnvironment, activeAccountProfile } from './account-profiles.js'

export function sessionPath(path: string): string {
  const normalized = resolve(path.replace(/^\\\\\?\\/, ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function devProbe(cwd: string, method: string, params: Record<string, unknown>, profile = activeAccountProfile('codex')): Promise<Record<string, unknown>> {
  return withCodex(cwd, profile, rpc => rpc.send(method, params, 30_000))
}

async function withCodex<T>(cwd: string, profile: string, read: (rpc: DevRpc) => Promise<T>): Promise<T> {
  const binary = codexBinary()
  if (!binary) throw new Error('The coding runtime is not available.')
  const rpc = new DevRpc(binary, { cwd, env: withHelpersOnPath(binary, accountEnvironment('codex', profile)) }, () => {}, async () => { throw new Error('Read-only account request.') }, () => {})
  try { await rpc.initialize(); return await read(rpc) }
  finally { await rpc.shutdown() }
}

export async function devExternal(cwd: string, provider: DevProvider, allFolders = false, profile = activeAccountProfile(provider)): Promise<DevExternalSession[]> {
  if (provider === 'claude') {
    const rows = await claudeHistory<{ sessionId: string; summary: string; lastModified: number; cwd?: string }[]>(profile, 'list', { ...(!allFolders ? { dir: cwd } : {}), limit: 100 })
    return rows.filter(row => row.cwd && (allFolders || sessionPath(row.cwd) === sessionPath(cwd))).map(row => ({ id: row.sessionId, title: row.summary || 'Untitled session', cwd: row.cwd!, provider, updatedAt: row.lastModified }))
  }
  const data: unknown[] = [], cursors = new Set<string>()
  let cursor: string | undefined
  const paths = process.platform === 'win32' ? [...new Set([cwd, cwd.replace(/\\/g, '/'), resolve(cwd), `\\\\?\\${resolve(cwd)}`])] : [cwd]
  do {
    const result = await devProbe(cwd, 'thread/list', { ...(!allFolders ? { cwd: paths } : {}), limit: 100, archived: false, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], ...(cursor ? { cursor } : {}) }, profile)
    if (!Array.isArray(result['data'])) throw new Error('The runtime did not return a session list.')
    data.push(...result['data'])
    cursor = !allFolders && typeof result['nextCursor'] === 'string' ? result['nextCursor'] : undefined
    if (cursor && (cursors.has(cursor) || cursors.size >= 50)) throw new Error('The session list is too large or did not advance. Archive older sessions and try again.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').filter(row => typeof row['id'] === 'string' && typeof row['cwd'] === 'string' && (allFolders || sessionPath(row['cwd']) === sessionPath(cwd))).map(row => ({
    id: String(row['id']), provider, title: typeof row['name'] === 'string' && row['name'] ? row['name'] : typeof row['preview'] === 'string' ? row['preview'].slice(0, 120) : 'Untitled session', cwd: String(row['cwd']),
    updatedAt: typeof row['updatedAt'] === 'number' ? row['updatedAt'] * 1000 : 0,
    ...((row['status'] as { type?: string } | undefined)?.type === 'active' ? { active: true } : {}),
  }))
}

export async function devAccountUsage(cwd: string, profile = activeAccountProfile('codex')): Promise<DevUsage> {
  try { return codexUsage(await devProbe(cwd, 'account/rateLimits/read', {}, profile)) }
  catch { return { unavailable: 'Account limits could not be refreshed. Check your AI connection and try again.' } }
}

export async function devExternalRead(cwd: string, provider: DevProvider, id: string, allFolders = false, profile = activeAccountProfile(provider)): Promise<DevItem[]> {
  const source = (await devExternal(cwd, provider, allFolders, profile)).find(session => session.id === id)
  if (!source) throw new Error('This session does not belong to the selected repository.')
  const items: DevItem[] = []
  if (provider === 'claude') {
    const messages = await claudeHistory<{ uuid: string; type: string; message: { content?: unknown } }[]>(profile, 'read', { dir: source.cwd, limit: 200 }, id)
    for (const message of messages) {
      if (!['user', 'assistant'].includes(message.type)) continue
      const content = message.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n') : ''
      if (text) items.push({ id: message.uuid, kind: message.type as 'user' | 'assistant', text: text.slice(0, 50_000) })
    }
  } else {
    await withCodex(cwd, profile, async rpc => {
      const cursors = new Set<string>()
      let cursor: string | undefined, characters = 0
      // ponytail: preview recent text only; the runtime resumes the full original history.
      do {
        const result = await rpc.send('thread/turns/list', { threadId: id, limit: 5, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) }, 30_000)
        if (!Array.isArray(result['data'])) throw new Error('The runtime did not return session messages.')
        for (const turn of result['data']) for (const item of [...(turn.items ?? [])].reverse()) {
          const kind = item.type === 'agentMessage' ? 'assistant' : item.type === 'userMessage' ? 'user' : null
          const text = kind === 'assistant' ? item.text : kind === 'user' && Array.isArray(item.content) ? item.content.filter((block: { type?: string }) => block?.type === 'text').map((block: { text?: string }) => block.text ?? '').join('\n') : ''
          if (kind && typeof text === 'string' && text.trim() && items.length < 200 && characters < 500_000) {
            const excerpt = text.slice(0, Math.min(50_000, 500_000 - characters))
            items.push({ id: String(item.id), kind, text: excerpt }); characters += excerpt.length
          }
        }
        cursor = typeof result['nextCursor'] === 'string' ? result['nextCursor'] : undefined
        if (cursor && cursors.has(cursor)) throw new Error('The session history did not advance. Try again.')
        if (cursor) cursors.add(cursor)
      } while (cursor && cursors.size < 40 && items.length < 200 && characters < 500_000)
      items.reverse()
    })
  }
  return items.slice(-200)
}
