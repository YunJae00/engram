import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { beforeAll, describe, expect, it } from 'vitest'
import { approveCard } from '../src/cards.js'
import { resolveConflicts } from '../src/conflict.js'
import { MockEngine } from '../src/engine/mock.js'
import { createNote, loadNotes, readNote } from '../src/notes.js'
import { joinTeam, TeamSync } from '../src/sync.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// M7 acceptance: 2-clone simulation over a LOCAL bare repo — no network.
let bare: string
let vaultA: VaultPaths
let vaultB: VaultPaths
let syncA: TeamSync
let syncB: TeamSync

beforeAll(async () => {
  bare = join(await tmpVaultRoot('team-bare'), 'team.git')
  await simpleGit().raw(['init', '--bare', '-b', 'main', bare])

  vaultA = await initVault(await tmpVaultRoot('team-a'), { git: true })
  syncA = new TeamSync(vaultA)
  await syncA.createTeam(bare)

  vaultB = await joinTeam(await tmpVaultRoot('team-b'), bare)
  syncB = new TeamSync(vaultB)
}, 240_000)

describe('team sync: 2-clone simulation', () => {
  it('A push → B pull lands the note', async () => {
    await createNote(vaultA, { id: 'n-team-0001', body: '# Team decision\n\nWe ship on Fridays.' })
    await syncA.commitAll('note: team decision')
    await syncA.push()

    const before = await syncB.status()
    expect(before.state).toBe('behind')
    expect(before.behind).toBeGreaterThanOrEqual(1)

    const pull = await syncB.pull()
    expect(pull.pulled).toBe(true)
    const note = await readNote(vaultB, 'n-team-0001')
    expect(note.body).toContain('Fridays')
    expect((await syncB.status()).state).toBe('clean')
  }, 240_000)

  it('both sides edit the same note → conflict → merge card → approval resolves', async () => {
    // A edits and pushes
    const noteA = await readNote(vaultA, 'n-team-0001')
    noteA.body = '# Team decision\n\nWe ship on Fridays.\nQA signs off on Thursdays.'
    noteA.front.updated = new Date().toISOString()
    await writeFile(join(vaultA.notes, 'n-team-0001.md'), (await import('../src/schema.js')).serializeNote(noteA))
    await syncA.commitAll('note: A adds QA line')
    await syncA.push()

    // B edits the same note differently
    const noteB = await readNote(vaultB, 'n-team-0001')
    noteB.body = '# Team decision\n\nWe ship on Fridays.\nRelease notes are mandatory.'
    noteB.front.updated = new Date().toISOString()
    await writeFile(join(vaultB.notes, 'n-team-0001.md'), (await import('../src/schema.js')).serializeNote(noteB))
    await syncB.commitAll('note: B adds release-notes line')

    const pull = await syncB.pull()
    expect(pull.pulled).toBe(false)
    expect(pull.conflicts).toContain('notes/n-team-0001.md')

    const engine = new MockEngine({
      default:
        '# Team decision\n\nWe ship on Fridays.\nQA signs off on Thursdays.\nRelease notes are mandatory.',
    })
    const resolution = await resolveConflicts(syncB, pull.conflicts, engine)
    expect(resolution.cards).toHaveLength(1)
    expect(resolution.cards[0]!.cardType).toBe('merge')

    await approveCard(vaultB, resolution.cards[0]!.id)
    const merged = (await loadNotes(vaultB)).find((n) => n.front.supersedes.includes('n-team-0001'))
    expect(merged).toBeDefined()
    expect(merged!.body).toContain('QA signs off')
    expect(merged!.body).toContain('Release notes are mandatory')

    // repo is out of the conflicted state and can push the resolution
    await syncB.commitAll('sync: merged decision')
    await syncB.push()
    expect((await syncB.status()).state).toBe('clean')
  }, 240_000)

  it('판단불가 (no engine) → both versions preserved as disputed', async () => {
    await syncA.pull() // catch up with B's merge commits first
    await createNote(vaultA, { id: 'n-team-0002', body: '# Venue\n\nOffsite in Busan.' })
    await syncA.commitAll('note: venue')
    await syncA.push()
    await syncB.pull()

    const editA = await readNote(vaultA, 'n-team-0002')
    editA.body = '# Venue\n\nOffsite in Busan, October.'
    await writeFile(join(vaultA.notes, 'n-team-0002.md'), (await import('../src/schema.js')).serializeNote(editA))
    await syncA.commitAll('note: A month')
    await syncA.push()

    const editB = await readNote(vaultB, 'n-team-0002')
    editB.body = '# Venue\n\nOffsite in Jeju.'
    await writeFile(join(vaultB.notes, 'n-team-0002.md'), (await import('../src/schema.js')).serializeNote(editB))
    await syncB.commitAll('note: B venue change')

    const pull = await syncB.pull()
    expect(pull.conflicts).toContain('notes/n-team-0002.md')
    const resolution = await resolveConflicts(syncB, pull.conflicts, null)
    expect(resolution.preservedBoth).toContain('n-team-0002')

    const notes = await loadNotes(vaultB)
    const disputed = notes.filter(
      (n) => n.front.status === 'disputed' && (n.body.includes('Busan') || n.body.includes('Jeju')),
    )
    expect(disputed.length).toBe(2)
  }, 240_000)

  it('incoming diff briefing text mentions the changed file', async () => {
    await syncA.pull()
    await createNote(vaultA, { id: 'n-team-0003', body: '# Budget\n\nQ3 budget approved.' })
    await syncA.commitAll('note: budget')
    await syncA.push()
    const diff = await syncB.incomingDiff()
    expect(diff).toContain('n-team-0003')
  }, 240_000)
})

describe('cards excluded from sync noise', () => {
  it('_views and .engram stay untracked in team repos', async () => {
    const gitignore = await readFile(join(vaultB.workspace, '.gitignore'), 'utf8')
    expect(gitignore).toContain('_views/')
    expect(gitignore).toContain('.engram/')
  })
})
