import { describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadBots, loadArchivedBots } from '../src/bots.js'
import { readSidebarLayout } from '../src/sidebar-layout.js'
import { initVault, vaultPaths, type VaultPaths } from '../src/vault.js'
import { mergeWorkspace } from '../src/workspace-merge.js'
import { tmpVaultRoot } from './helpers.js'

const bot = (id: string, name: string, more: Record<string, unknown> = {}) => ({ id, name, purpose: '', createdAt: '2026-11-01T00:00:00.000Z', ...more })

async function vault(name: string, files: Record<string, unknown>): Promise<VaultPaths> {
  const paths = await initVault(await tmpVaultRoot(`merge-${name}`), { git: false })
  for (const [rel, data] of Object.entries(files)) {
    const file = join(paths.root, rel)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data))
  }
  return paths
}

// Every file under a folder with its bytes: the proof that a source was not written.
async function snapshot(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(out, await snapshot(path, base))
    else if (entry.isFile()) out[path.slice(base.length)] = (await readFile(path)).toString('base64')
  }
  return out
}

const C = 'workspace/.engram'
const mainVault = () => vault('main', {
  [`${C}/bots.json`]: { version: 2, bots: [bot('bot-a-1', '비서실장', { primary: true }), bot('bot-a-2', '김대리', { label: '리서치' })], dismissed: ['x'] },
  [`${C}/bot-chats/bot-a-1.jsonl`]: '{"role":"user","text":"main chief"}\n',
  [`${C}/bot-chats/bot-a-2.jsonl`]: '{"role":"user","text":"main kim"}\n',
  [`${C}/bot-memory/_person.json`]: { facts: [{ id: 'f1', text: '민호와 일한다', at: 't', touchedAt: 't' }], turns: 3 },
  [`${C}/sidebar-layout.json`]: { chat: { folders: [{ id: 'fold-1', name: '마케팅팀' }], items: [{ id: 'bot-a-2', folder: 'fold-1' }] }, routine: { folders: [], items: [] } },
  'workspace/notes/n-person-profile.md': '---\nid: n-person-profile\n---\nmain profile\n',
  'workspace/notes/n-1.md': '---\nid: n-1\n---\nsame in both\n',
  'workspace/aliases.md': '# Aliases\n\n- 민호 = Minho\n',
})
const workVault = () => vault('work', {
  [`${C}/bots.json`]: { version: 2, bots: [
    bot('bot-a-1', '비서실장', { primary: true, tasks: [{ id: 'task-1', goal: '주간보고', schedule: { kind: 'weekly' } }] }),
    bot('bot-a-2f', '김대리', { label: '영업' }),
    bot('bot-b-9', '박사원', { label: '디자인', avatar: { image: 'bot-avatars/bot-b-9.png' } }),
  ], archived: [bot('bot-b-7', '이과장', { label: '퇴사' })], dismissed: ['x', 'y'] },
  [`${C}/bot-chats/bot-a-1.jsonl`]: '{"role":"user","text":"work chief"}\n',
  [`${C}/bot-chats/bot-a-1.2026-11-01T10-00-00.jsonl`]: '{"role":"user","text":"work chief earlier"}\n',
  [`${C}/bot-chats/bot-a-2f.jsonl`]: '{"role":"user","text":"work kim"}\n',
  [`${C}/bot-chats/bot-b-9.jsonl`]: '{"role":"user","text":"work park"}\n',
  [`${C}/bot-avatars/bot-b-9.png`]: 'png',
  [`${C}/bot-memory/bot-a-1.json`]: { facts: [{ id: 'm1', text: 'work chief fact', at: 't', touchedAt: 't' }], turns: 1 },
  [`${C}/bot-memory/_person.json`]: { facts: [{ id: 'f1', text: '서울에 산다', at: 't', touchedAt: 't' }, { id: 'f2', text: '민호와 일한다', at: 't', touchedAt: 't' }], turns: 9 },
  [`${C}/bot-memory/_team-fold-9.json`]: { facts: [{ id: 't1', text: 'team fact', at: 't', touchedAt: 't' }], turns: 0 },
  [`${C}/sidebar-layout.json`]: { chat: { folders: [{ id: 'fold-9', name: '마케팅팀' }, { id: 'fold-8', name: '영업팀' }], items: [{ id: 'bot-a-1', folder: null, pinned: true }, { id: 'bot-b-9', folder: 'fold-9' }, { id: 'bot-a-2f', folder: 'fold-8' }] }, routine: { folders: [], items: [] } },
  [`${C}/artifacts/abc-report.docx`]: 'docx',
  [`${C}/habits.json`]: { chain: { state: 'draft', botId: 'bot-a-1' } },
  'workspace/tasks/bot-bot-a-1/out.txt': 'made by work chief',
  'workspace/notes/n-person-profile.md': '---\nid: n-person-profile\n---\nwork profile\n',
  'workspace/notes/n-1.md': '---\nid: n-1\n---\nsame in both\n',
  'workspace/notes/n-2.md': '---\nid: n-2\n---\nonly at work\n',
  'workspace/sources/paper.pdf': 'pdf',
  'workspace/aliases.md': '# Aliases\n\n- 민호 = Minho\n- 엔비디아 = NVDA\n',
  'private/secret-capture.md': 'private',
})

const text = (paths: VaultPaths, rel: string) => readFile(join(paths.root, rel), 'utf8')
const names = (bots: { name: string }[]) => bots.map(one => one.name)

describe('mergeWorkspace', () => {
  it('brings a second workspace into the open one without touching either original', async () => {
    const main = await mainVault(), work = await workVault()
    const before = await snapshot(work.root), mine = await snapshot(main.root)
    const report = await mergeWorkspace(main, { root: work.root, name: '회사' })

    // The source is byte for byte what it was.
    expect(await snapshot(work.root)).toEqual(before)
    // Nothing that was here is gone or changed, apart from the lists that grew.
    const after = await snapshot(main.root)
    for (const [file, bytes] of Object.entries(mine)) {
      if (/bots\.json|sidebar-layout\.json|_person\.json|aliases\.md/.test(file)) continue
      expect(after[file], file).toBe(bytes)
    }

    const bots = await loadBots(main)
    expect(names(bots)).toEqual(['비서실장', '김대리', '비서실장 (회사)', '김대리 (회사)', '박사원'])
    // One chief of staff, the one that was already here.
    expect(bots.filter(one => one.primary).map(one => one.id)).toEqual(['bot-a-1'])
    const tag = /^bot-a-1-[0-9a-f]{6}$/
    const chief = bots[2]!
    expect(chief.id).toMatch(tag)
    // A schedule that was not running in its own workspace does not start by itself.
    expect(chief.tasks).toEqual([{ id: 'task-1', goal: '주간보고', schedule: { kind: 'weekly' }, paused: true }])
    expect(bots[3]!.id).toBe('bot-a-2f')
    expect(bots[4]!.avatar).toEqual({ image: 'bot-avatars/bot-b-9.png' })
    expect(names(await loadArchivedBots(main))).toEqual(['이과장'])

    // Each conversation under the id its bot now has; the ones here are whole.
    expect(await text(main, `${C}/bot-chats/bot-a-1.jsonl`)).toContain('main chief')
    expect(await text(main, `${C}/bot-chats/${chief.id}.jsonl`)).toContain('work chief')
    expect(await text(main, `${C}/bot-chats/${chief.id}.2026-11-01T10-00-00.jsonl`)).toContain('work chief earlier')
    expect(await text(main, `${C}/bot-chats/bot-a-2.jsonl`)).toContain('main kim')
    expect(await text(main, `${C}/bot-chats/bot-a-2f.jsonl`)).toContain('work kim')
    expect(await text(main, `${C}/bot-memory/${chief.id}.json`)).toContain('work chief fact')
    expect(await text(main, `${C}/bot-memory/_team-fold-9.json`)).toContain('team fact')
    expect(await text(main, `workspace/tasks/bot-${chief.id}/out.txt`)).toBe('made by work chief')
    expect(await text(main, `${C}/artifacts/abc-report.docx`)).toBe('docx')
    expect(await text(main, 'workspace/sources/paper.pdf')).toBe('pdf')
    expect(await text(main, 'private/secret-capture.md')).toBe('private')
    expect(JSON.parse(await text(main, `${C}/habits.json`))).toEqual({ chain: { state: 'draft', botId: chief.id } })

    // What the person told every bot: both sets, the shared line once.
    const person = JSON.parse(await text(main, `${C}/bot-memory/_person.json`)) as { facts: { id: string; text: string }[]; turns: number }
    expect(person.facts.map(fact => fact.text)).toEqual(['민호와 일한다', '서울에 산다'])
    expect(new Set(person.facts.map(fact => fact.id)).size).toBe(2)
    expect(person.turns).toBe(3)

    // Notes: a new one arrives, an identical one is one file, a different one with the same id keeps both.
    expect(await text(main, 'workspace/notes/n-2.md')).toContain('only at work')
    expect(await text(main, 'workspace/notes/n-person-profile.md')).toContain('main profile')
    const aside = (await readdir(main.notes)).filter(name => /^n-person-profile-[0-9a-f]{6}\.md$/.test(name))
    expect(aside).toHaveLength(1)
    const kept = await text(main, `workspace/notes/${aside[0]}`)
    expect(kept).toContain('work profile')
    expect(kept).toContain(`id: ${aside[0]!.slice(0, -3)}`)
    expect((await readdir(main.notes)).filter(name => name.startsWith('n-1'))).toEqual(['n-1.md'])
    expect(await text(main, 'workspace/aliases.md')).toBe('# Aliases\n\n- 민호 = Minho\n- 엔비디아 = NVDA\n')

    // Folders are teams: the second 마케팅팀 says where it came from, and every bot stays in its own.
    const layout = await readSidebarLayout(main, { chat: bots.map(one => one.id) })
    expect(layout.chat.folders.map(folder => folder.name)).toEqual(['마케팅팀', '마케팅팀 (회사)', '영업팀'])
    expect(layout.chat.items).toEqual([
      { id: 'bot-a-2', folder: 'fold-1' }, { id: chief.id, folder: null, pinned: true }, { id: 'bot-b-9', folder: 'fold-9' }, { id: 'bot-a-2f', folder: 'fold-8' }, { id: 'bot-a-1', folder: null },
    ])

    expect(report).toMatchObject({ name: '회사', bots: 4 })
    expect(report!.renamed).toEqual(expect.arrayContaining(['비서실장 → 비서실장 (회사)', '김대리 → 김대리 (회사)', '마케팅팀 → 마케팅팀 (회사)']))
  })

  it('changes nothing the second time', async () => {
    const main = await mainVault(), work = await workVault()
    await mergeWorkspace(main, { root: work.root, name: '회사' })
    const once = await snapshot(main.root)
    expect(await mergeWorkspace(main, { root: work.root, name: '회사' })).toBeNull()
    expect(await snapshot(main.root)).toEqual(once)
  })

  it('finishes a run that was cut short without adding anyone twice', async () => {
    const main = await mainVault(), work = await workVault()
    await mergeWorkspace(main, { root: work.root, name: '회사' })
    const whole = await snapshot(main.root)
    // As if the app had quit after the bots were written and before the run was marked done.
    const ledgerPath = join(main.cache, 'merged-workspaces.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, { done: boolean; report?: unknown; at: string }>
    for (const entry of Object.values(ledger)) { entry.done = false; delete entry.report }
    await writeFile(ledgerPath, JSON.stringify(ledger))
    const again = await mergeWorkspace(main, { root: work.root, name: '회사' })
    expect(again).toMatchObject({ bots: 0, files: 0 })
    const after = await snapshot(main.root)
    delete after[`/${C}/merged-workspaces.json`]; delete whole[`/${C}/merged-workspaces.json`]
    expect(after).toEqual(whole)
  })

  it('takes three workspaces in turn, each name still its own', async () => {
    const main = await mainVault(), work = await workVault()
    const third = await vault('third', { [`${C}/bots.json`]: { version: 2, bots: [bot('bot-a-1', '비서실장', { primary: true }), bot('bot-c-1', '김대리', { label: '재무' })], dismissed: [] } })
    await mergeWorkspace(main, { root: work.root, name: '회사' })
    await mergeWorkspace(main, { root: third.root, name: '회사' })
    const bots = await loadBots(main)
    expect(names(bots)).toEqual(['비서실장', '김대리', '비서실장 (회사)', '김대리 (회사)', '박사원', '비서실장 (회사 2)', '김대리 (회사 2)'])
    expect(new Set(bots.map(one => one.id)).size).toBe(7)
    expect(bots.filter(one => one.primary)).toHaveLength(1)
  })

  it('keeps a person\'s notes out of a workspace shared with a team', async () => {
    const main = await mainVault(), work = await workVault()
    const report = await mergeWorkspace(main, { root: work.root, name: '회사' }, { tracked: false })
    expect((await readdir(main.notes)).sort()).toEqual(['n-1.md', 'n-person-profile.md'])
    expect(await readdir(main.sources)).toEqual([])
    expect(await text(main, 'workspace/aliases.md')).toBe('# Aliases\n\n- 민호 = Minho\n')
    // What git does not carry still arrives.
    expect(names(await loadBots(main))).toContain('박사원')
    expect(report!.skipped.join(' ')).toContain('shared with a team')
  })

  it('leaves an older bot list, a missing folder and a link alone', async () => {
    const main = await mainVault()
    const old = await vault('old', { [`${C}/bots.json`]: { bots: [bot('bot-o-1', '옛 봇')] }, [`${C}/bot-chats/bot-o-1.jsonl`]: 'old\n', 'workspace/notes/n-9.md': '---\nid: n-9\n---\nold note\n' })
    await symlink(join(main.root, 'private'), join(old.notes, 'link'))
    const report = await mergeWorkspace(main, { root: old.root, name: '옛날' })
    expect(names(await loadBots(main))).toEqual(['비서실장', '김대리'])
    expect(await readdir(join(main.cache, 'bot-chats'))).toEqual(['bot-a-1.jsonl', 'bot-a-2.jsonl'])
    expect(await text(main, 'workspace/notes/n-9.md')).toContain('old note')
    expect(await readdir(main.notes)).not.toContain('link')
    expect(report!.skipped.join(' ')).toContain('older format')

    expect(await mergeWorkspace(main, { root: join(main.root, 'nowhere'), name: '없음' })).toBeNull()
    expect(await mergeWorkspace(main, { root: main.root, name: '자기' })).toBeNull()
  })

  it('writes nothing when the bot list here cannot be read', async () => {
    const main = await mainVault(), work = await workVault()
    await writeFile(join(main.cache, 'bots.json'), '{ not json')
    const before = await snapshot(main.root)
    await expect(mergeWorkspace(main, { root: work.root, name: '회사' })).rejects.toThrow()
    expect(await snapshot(main.root)).toEqual(before)
    expect(vaultPaths(main.root).cache).toBe(main.cache)
  })
})
