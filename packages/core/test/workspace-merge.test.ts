import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addAliasGroup, loadAliasGroups } from '../src/aliases.js'
import { loadBots, loadArchivedBots } from '../src/bots.js'
import { GitLayer } from '../src/git.js'
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

  // Review round 2: a copied workspace has the same folder ids; the arriving folder was dropped and its bots put in the folder here.
  it('keeps both folders when a copied workspace has the same folder id', async () => {
    const main = await mainVault()
    const copy = await vault('copy', {
      [`${C}/bots.json`]: { version: 2, bots: [bot('bot-c-1', '최주임', {}), bot('bot-c-2', '한사원', {})], dismissed: [] },
      [`${C}/bot-memory/_team-fold-1.json`]: { facts: [{ id: 't1', text: 'copy team fact', at: 't', touchedAt: 't' }], turns: 0 },
      [`${C}/sidebar-layout.json`]: { chat: { folders: [{ id: 'fold-1', name: '기획팀' }, { id: 'fold-2', name: '마케팅팀' }], items: [{ id: 'bot-c-1', folder: 'fold-1' }, { id: 'bot-c-2', folder: 'fold-2' }] }, routine: { folders: [{ id: 'fold-1', name: '아침' }], items: [{ id: 'r-1', folder: 'fold-1' }] } },
    })
    const before = await snapshot(copy.root)
    const merge = () => mergeWorkspace(main, { root: copy.root, name: '사본' })
    await merge()
    const check = async () => {
      const layout = JSON.parse(await text(main, `${C}/sidebar-layout.json`)) as Record<'chat' | 'routine', { folders: { id: string; name: string }[]; items: { id: string; folder: string | null }[] }>
      const arrived = layout.chat.folders[1]!.id
      expect(arrived).toMatch(/^fold-1-[0-9a-f]{6}$/)
      expect(layout.chat.folders).toEqual([{ id: 'fold-1', name: '마케팅팀' }, { id: arrived, name: '기획팀' }, { id: 'fold-2', name: '마케팅팀 (사본)' }])
      // Each bot stays in its own folder: the one here is not handed the arriving folder's bot.
      expect(layout.chat.items).toEqual([{ id: 'bot-a-2', folder: 'fold-1' }, { id: 'bot-c-1', folder: arrived }, { id: 'bot-c-2', folder: 'fold-2' }])
      // One id per source folder, whichever list it is in; the team's memory follows its folder.
      expect(layout.routine).toEqual({ folders: [{ id: arrived, name: '아침' }], items: [{ id: 'r-1', folder: arrived }] })
      expect(await text(main, `${C}/bot-memory/_team-${arrived}.json`)).toContain('copy team fact')
      expect((await readdir(join(main.cache, 'bot-memory'))).filter(name => name.startsWith('_team-'))).toEqual([`_team-${arrived}.json`])
      return layout
    }
    const first = await check()
    expect(await snapshot(copy.root)).toEqual(before)
    // Cut short after the layout was written: the same ids are chosen again and no folder arrives twice.
    const ledgerPath = join(main.cache, 'merged-workspaces.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, { done: boolean; report?: unknown }>
    for (const entry of Object.values(ledger)) { entry.done = false; delete entry.report }
    await writeFile(ledgerPath, JSON.stringify(ledger))
    await merge()
    expect(await check()).toEqual(first)
    expect(await merge()).toBeNull()
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

  // Review round 1: a team workspace as the open one was marked merged while its notes stayed in the closed folder.
  it('brings notes into a workspace shared with a team as files git never stages', async () => {
    const main = await mainVault(), work = await workVault()
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.quotepath=false', ...args], { cwd: main.workspace, encoding: 'utf8' })
    await writeFile(join(work.notes, '회의 [초안] 메모.md'), '---\nid: 회의 [초안] 메모\n---\nprivate\n')
    await writeFile(join(work.inbox, 'later.md'), 'inbox item\n')
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'team')
    const tracked = git('ls-files').trim().split('\n')
    const before = await snapshot(work.root)

    const report = await mergeWorkspace(main, { root: work.root, name: '회사' }, { tracked: false })
    // Everything the other workspace held is here now.
    const here = (await readdir(main.notes)).map(name => name.normalize('NFC')).sort()
    expect(here.filter(name => !/^n-person-profile-[0-9a-f]{6}\.md$/.test(name))).toEqual(['n-1.md', 'n-2.md', 'n-person-profile.md', '회의 [초안] 메모.md'])
    expect(here).toHaveLength(5)
    expect(await readdir(main.inbox)).toContain('later.md')
    expect(await readdir(main.sources)).toContain('paper.pdf')
    expect(report!.skipped.join(' ')).not.toContain('shared with a team')
    // The alias lines are read, and the file the team shares is as it was.
    expect(await text(main, 'workspace/aliases.md')).toBe('# Aliases\n\n- 민호 = Minho\n')
    expect(await loadAliasGroups(main)).toContainEqual(['엔비디아', 'NVDA'])
    // What the app's sync does: nothing of the person's other workspace is staged, and the team's own files still are.
    await writeFile(join(main.notes, 'team-new.md'), '---\nid: team-new\n---\nteam\n')
    git('add', '-A')
    expect(git('status', '--porcelain', '--untracked-files=all').trim()).toBe('A  notes/team-new.md')
    git('commit', '-q', '-m', 'sync')
    expect(git('ls-files').trim().split('\n').sort()).toEqual([...tracked, 'notes/team-new.md'].sort())
    // A teaching in chat rewrites the shared alias file with its own lines only.
    await addAliasGroup(main, ['서연', 'Seoyeon'])
    expect(await text(main, 'workspace/aliases.md')).toContain('서연 = Seoyeon')
    expect(await text(main, 'workspace/aliases.md')).not.toContain('엔비디아')
    expect(await loadAliasGroups(main)).toContainEqual(['엔비디아', 'NVDA'])
    expect(await snapshot(work.root)).toEqual(before)
    // A second run is a no-op.
    expect(await mergeWorkspace(main, { root: work.root, name: '회사' }, { tracked: false })).toBeNull()
  })

  // Codex cap (sm r3): with no .git folder the notes were left in the closed workspace and the source was still marked done.
  it('a shared workspace with no repository folder still receives the notes, and a repository made later never stages them', async () => {
    const main = await mainVault(), work = await workVault()
    await writeFile(join(work.inbox, 'later.md'), 'inbox item\n')
    const before = await snapshot(work.root)
    const report = await mergeWorkspace(main, { root: work.root, name: '회사' }, { tracked: false })
    // Everything the other workspace held is here now; the alias file a team would share is as it was.
    const here = (await readdir(main.notes)).sort()
    expect(here.filter(name => !/^n-person-profile-[0-9a-f]{6}\.md$/.test(name))).toEqual(['n-1.md', 'n-2.md', 'n-person-profile.md'])
    expect(here).toHaveLength(4)
    expect(await readdir(main.inbox)).toContain('later.md')
    expect(await readdir(main.sources)).toContain('paper.pdf')
    expect(report!.skipped.join(' ')).not.toContain('shared with a team')
    expect(await text(main, 'workspace/aliases.md')).toBe('# Aliases\n\n- 민호 = Minho\n')
    expect(await loadAliasGroups(main)).toContainEqual(['엔비디아', 'NVDA'])
    expect(await snapshot(work.root)).toEqual(before)
    // With names to keep local and no repository folder to hold them, nothing is staged at all.
    await expect(new GitLayer(main.workspace).autoCommit('sync')).rejects.toThrow(/local-only/)
    // A repository made (or cloned again) afterwards: the app's own commit names them first, so only the team's files go in.
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.quotepath=false', ...args], { cwd: main.workspace, encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t')
    await new GitLayer(main.workspace).autoCommit('sync')
    const staged = git('ls-files').trim().split('\n')
    expect(staged).toContain('notes/n-1.md')
    expect(staged.filter(name => /n-2\.md|n-person-profile-|later\.md|paper\.pdf|local-only|aliases\.local/.test(name))).toEqual([])
    // A second run is a no-op.
    expect(await mergeWorkspace(main, { root: work.root, name: '회사' }, { tracked: false })).toBeNull()
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
