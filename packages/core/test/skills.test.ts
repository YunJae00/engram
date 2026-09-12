import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  annotateStaleCards,
  countRecentSkills,
  installSkill,
  listSkills,
  migrateSkillsHome,
  staleSkills,
  passesPrivacyLint,
  readSkillFile,
  readSkillsLedger,
  parseSkillDraft,
  renderSkillMd,
  skillCandidates,
  skillContentHash,
  skillsDir,
  turnSkillCandidate,
  turnSkillPrompt,
  writeSkillsLedger,
} from '../src/skills.js'
import { tmpVaultRoot } from './helpers.js'
import type { Note } from '../src/schema.js'
import type { VaultPaths } from '../src/vault.js'

// The vault's recurring know-how becomes a skill file in the vault itself.
// The gates matter more than the generation — no repetition no skill, a
// user-edited file is theirs forever, secrets never leave the vault.

const NOW = new Date('2026-08-05T09:00:00Z')
let n = 0
function note(title: string, over: Partial<Note['front']> = {}): Note {
  n += 1
  return {
    front: {
      id: `n-${n}`,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created: '2026-08-01T00:00:00.000Z',
      updated: '2026-08-01T00:00:00.000Z',
      ...over,
    },
    body: `# ${title}\n\nbody`,
  }
}

let home: string
let paths: VaultPaths
beforeEach(async () => {
  home = await tmpVaultRoot('skills-home')
  const workspace = await tmpVaultRoot('skills-vault')
  paths = { workspace } as VaultPaths
})

const procedureNotes = (folder: string, count: number, created = '2026-08-01T00:00:00.000Z'): Note[] =>
  Array.from({ length: count }, (_, i) => note(`포팅 함정 ${i}: install 누락 주의`, { context: folder, created }))

describe('skillCandidates', () => {
  it('needs ≥3 procedure-shaped conclusions in one folder — twice is coincidence', () => {
    expect(skillCandidates([...procedureNotes('sample', 2), note('일반 결정', { context: 'sample' })], {})).toEqual([])
    const found = skillCandidates(procedureNotes('sample', 3), {})
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ slug: 'sample', folder: 'sample' })
  })

  it('nothing new since the last distillation → nothing to say', () => {
    const ledger = { sample: { folder: 'sample', hash: 'h', distilledAt: '2026-08-02T00:00:00.000Z' } }
    expect(skillCandidates(procedureNotes('sample', 4), ledger)).toEqual([])
    const fresh = [...procedureNotes('sample', 3), note('새 함정 발견', { context: 'sample', created: '2026-08-04T00:00:00.000Z' })]
    expect(skillCandidates(fresh, ledger)).toHaveLength(1)
  })

  it('a user-owned skill is never a candidate again', () => {
    const ledger = { sample: { folder: 'sample', hash: 'h', distilledAt: '2026-07-01T00:00:00.000Z', userOwned: true } }
    expect(skillCandidates(procedureNotes('sample', 5), ledger)).toEqual([])
  })
})

describe('installSkill', () => {
  const draft = { title: '포팅 함정 체크리스트', description: 'When porting sample modules', body: '## Steps\n- check installs' }

  it('writes SKILL.md into the vault and stamps the ledger', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    const result = await installSkill(paths, candidate!, draft, NOW)
    expect(result.installed).toBe(true)
    const file = await readFile(join(skillsDir(paths), 'engram-sample', 'SKILL.md'), 'utf8')
    expect(file).toContain('name: engram-sample')
    expect(file).toContain('## Steps')
    const ledger = await readSkillsLedger(paths)
    expect(ledger['sample']?.hash).toBe(skillContentHash(file))
    expect(countRecentSkills(ledger, NOW.getTime() - 1000)).toBe(1)
  })

  it('A USER-EDITED FILE IS THEIRS FOREVER — hash mismatch flips ownership and refuses', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    await installSkill(paths, candidate!, draft, NOW)
    const file = join(skillsDir(paths), 'engram-sample', 'SKILL.md')
    await writeFile(file, `${await readFile(file, 'utf8')}\n<!-- my own edit -->`)
    const again = await installSkill(paths, candidate!, { ...draft, body: 'new body' }, NOW)
    expect(again).toEqual({ installed: false, reason: 'user-owned' })
    expect((await readFile(file, 'utf8')).includes('my own edit')).toBe(true)
    expect((await readSkillsLedger(paths))['sample']?.userOwned).toBe(true)
  })

  it('secrets never leave the vault', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    const leaky = { ...draft, body: 'set GH_TOKEN=ghp_abcdefghijklmnopqrst1234 first' }
    expect(await installSkill(paths, candidate!, leaky, NOW)).toEqual({ installed: false, reason: 'privacy' })
    expect(passesPrivacyLint('email me at a@b.co')).toBe(false)
  })
})

describe('progressive disclosure', () => {
  const draft = { title: '포팅 함정 체크리스트', description: 'When porting sample modules', body: '## Steps\n- check installs\n\nmore detail here' }

  it('indexes name+description and opens the body on demand', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    await installSkill(paths, candidate!, draft, NOW)
    const cards = await listSkills(paths)
    expect(cards).toEqual([{ name: 'engram-sample', description: 'When porting sample modules' }])
    const body = await readSkillFile(paths, 'engram-sample')
    expect(body).toContain('## Steps')
    expect(body).toContain('more detail here')
    // The index carries no body — that is the whole point.
    expect(JSON.stringify(cards)).not.toContain('## Steps')
  })

  it('returns null for an unknown skill and refuses a climbing reference path', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    await installSkill(paths, candidate!, draft, NOW)
    expect(await readSkillFile(paths, 'engram-nope')).toBeNull()
    expect(await readSkillFile(paths, 'engram-sample', '../../secrets.txt')).toBeNull()
    // A real reference file inside the skill folder reads.
    await writeFile(join(skillsDir(paths), 'engram-sample', 'ref.md'), 'reference body', 'utf8')
    expect(await readSkillFile(paths, 'engram-sample', 'ref.md')).toBe('reference body')
  })

  it('an empty vault yields an empty index, never an error', async () => {
    expect(await listSkills(paths)).toEqual([])
  })
})

describe('migrateSkillsHome', () => {
  it('copies only this vault\'s recorded skills, preserving originals and destination conflicts', async () => {
    const legacy = join(home, '.claude', 'skills', 'engram-old')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'SKILL.md'), renderSkillMd('old', 'old', { title: 'Old', description: 'legacy skill', body: 'B' }), 'utf8')
    await writeSkillsLedger(paths, { old: { folder: 'old', hash: 'previous-version', distilledAt: NOW.toISOString() } })
    // A non-engram sibling is left untouched.
    const foreign = join(home, '.claude', 'skills', 'other-tool')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'SKILL.md'), 'not ours', 'utf8')

    expect(await migrateSkillsHome(home, paths)).toBe(1)
    expect((await listSkills(paths)).map((s) => s.name)).toContain('engram-old')
    expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe('not ours')
    await writeFile(join(legacy, 'SKILL.md'), 'new user edits')
    await writeFile(join(skillsDir(paths), 'engram-old', 'SKILL.md'), 'local user edits')
    expect(await migrateSkillsHome(home, paths)).toBe(0)
    expect(await readFile(join(legacy, 'SKILL.md'), 'utf8')).toBe('new user edits')
    expect(await readFile(join(skillsDir(paths), 'engram-old', 'SKILL.md'), 'utf8')).toBe('local user edits')
  })
})

describe('renderSkillMd', () => {
  it('produces valid frontmatter with the engram marker', () => {
    const md = renderSkillMd('sample', 'sample', { title: 'T', description: 'multi\nline desc', body: 'B' })
    expect(md.startsWith('---\nname: engram-sample\ndescription: "multi line desc"\n---\n')).toBe(true)
    expect(md).toContain('<!-- engram:skill v1')
  })
})

it('opens complete content by directory identity and parses quoted or multiline metadata', async () => {
  const dir = join(skillsDir(paths), 'actual-name')
  await mkdir(dir, { recursive: true })
  const body = 'a'.repeat(7000) + '\nLast constraint'
  await writeFile(join(dir, 'SKILL.md'), `---\nname: Different title\ndescription: >-\n  Use when:\n  doing work\n---\n${body}`)
  expect(await listSkills(paths)).toEqual([{ name: 'actual-name', description: 'Use when: doing work' }])
  expect(await readSkillFile(paths, 'actual-name')).toBe(body)
  expect(await readSkillFile(paths, '../actual-name')).toBeNull()
  await writeFile(join(dir, 'huge.md'), 'a'.repeat(100001))
  await expect(readSkillFile(paths, 'actual-name', 'huge.md')).rejects.toThrow('no partial content')
})

it('does not follow a reference junction outside the skill or adopt unrecorded legacy skills', async () => {
  const dir = join(skillsDir(paths), 'sample')
  await mkdir(dir, { recursive: true })
  await writeFile(join(home, 'secret.md'), 'not a skill reference')
  await symlink(home, join(dir, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await readSkillFile(paths, 'sample', 'outside/secret.md')).toBeNull()
  await symlink(home, join(skillsDir(paths), 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await readSkillFile(paths, 'linked', 'secret.md')).toBeNull()
  const legacy = join(home, '.claude', 'skills', 'engram-foreign')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'SKILL.md'), 'belongs to a different vault')
  expect(await migrateSkillsHome(home, paths)).toBe(0)
  expect(await readFile(join(legacy, 'SKILL.md'), 'utf8')).toBe('belongs to a different vault')
})

it('never overwrites an unrecorded file', async () => {
  const dir = join(skillsDir(paths), 'engram-sample')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), 'user-created')
  const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
  expect(await installSkill(paths, candidate!, { title: 'New', description: 'New', body: 'New' })).toEqual({ installed: false, reason: 'user-owned' })
  expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe('user-created')
})

it('never executes a metadata language directive', async () => {
  const dir = join(skillsDir(paths), 'unsafe')
  await mkdir(dir, { recursive: true })
  const content = '---js\n(globalThis.engramSkillExecuted = true, {description: "unsafe"})\n---\nbody'
  await writeFile(join(dir, 'SKILL.md'), content)
  expect(await listSkills(paths)).toEqual([])
  expect(await readSkillFile(paths, 'unsafe')).toBe(content)
  expect(Reflect.get(globalThis, 'engramSkillExecuted')).toBeUndefined()
})

describe('living skills — stale when the folder moves on', () => {
  const draft = { title: '체크리스트', description: 'When porting sample modules', body: '## Steps\n- check' }

  it('re-distills a folder that changed after the last distillation (edit, not just new note)', () => {
    const base = procedureNotes('sample', 3, '2026-08-01T00:00:00.000Z')
    const ledger = { sample: { folder: 'sample', hash: 'h', distilledAt: '2026-08-02T00:00:00.000Z' } }
    // No new note, but one was edited after distillation → still a candidate.
    const edited = base.map((note, i) => (i === 0 ? { ...note, front: { ...note.front, updated: '2026-08-09T00:00:00.000Z' } } : note))
    expect(skillCandidates(edited, ledger)).toHaveLength(1)
  })

  it('names an installed skill stale once its folder changes, and marks the index', async () => {
    const notes = procedureNotes('sample', 3)
    const [candidate] = skillCandidates(notes, {})
    await installSkill(paths, candidate!, draft, NOW)
    const ledger = await readSkillsLedger(paths)
    // Nothing changed since distillation → not stale.
    expect(staleSkills(ledger, notes)).toEqual([])
    // A newer note in the folder → stale, and the card carries a caution.
    const changed = [...procedureNotes('sample', 3), note('새 함정 발견 주의', { context: 'sample', created: '2026-08-10T00:00:00.000Z' })]
    expect(staleSkills(ledger, changed)).toEqual(['sample'])
    const cards = annotateStaleCards([{ name: 'engram-sample', description: 'When porting sample modules' }], ledger, changed)
    expect(cards[0]!.description).toContain('may be outdated')
    // A skill whose folder is unchanged is left alone.
    expect(annotateStaleCards([{ name: 'engram-sample', description: 'x' }], ledger, notes)[0]!.description).toBe('x')
    expect(staleSkills(ledger, notes.slice(1))).toEqual(['sample'])
    expect(staleSkills(ledger, [])).toEqual(['sample'])
    expect(staleSkills(ledger, notes.map((note, i) => i ? note : { ...note, body: 'Edited without a timestamp change' }))).toEqual(['sample'])
    expect(skillCandidates(notes.map((note, i) => i ? note : { ...note, body: '# Updated procedure must be checked' }), ledger)).toHaveLength(1)
  })
})

describe('learning a how-to from a kept turn', () => {
  it('turnSkillCandidate keeps a collision-resistant namespace without writing the private goal', () => {
    const cand = turnSkillCandidate('Weekly report upload', 'upload this week\'s report to the portal')
    expect(cand.slug.startsWith('turn--')).toBe(true)
    expect(cand.folder).toBe('Kept tasks')
    expect(cand.source).toBe('turn')
    expect(turnSkillCandidate('Weekly report upload', 'another goal').slug).not.toBe(cand.slug)
    expect(cand.notes).toEqual([])
  })

  it('turnSkillPrompt carries the goal, the gate and the steps', () => {
    const prompt = turnSkillPrompt('file the VAT return', ['- open_page: portal', '- type_text: amount'])
    expect(prompt).toContain('file the VAT return')
    expect(prompt).toContain('{"skip": true}')
    expect(prompt).toContain('type_text: amount')
  })

  it('parseSkillDraft accepts a structured draft and refuses a stub, a skip, or prose', () => {
    const good = JSON.stringify({ title: 'File the VAT return', description: 'when filing VAT', body: '## When to use\n' + 'x'.repeat(120) })
    expect(parseSkillDraft(good)).toMatchObject({ title: 'File the VAT return' })
    // Embedded in chatter still parses.
    expect(parseSkillDraft('sure!\n' + good + '\nhope that helps')).toMatchObject({ title: 'File the VAT return' })
    expect(parseSkillDraft('{"skip": true}')).toBeNull()
    expect(parseSkillDraft('here is a nice skill for you')).toBeNull()
    expect(parseSkillDraft(JSON.stringify({ title: 'T', description: 'd', body: 'too short' }))).toBeNull()
    expect(parseSkillDraft(null)).toBeNull()
  })

  it('a distilled turn how-to installs into the vault skills index', async () => {
    const cand = turnSkillCandidate('reconcile ledger', 'reconcile the month-end ledger')
    const draft = { title: 'Reconcile the ledger', description: 'when reconciling month-end', body: '## Steps\n' + 'do the thing\n'.repeat(20) }
    expect((await installSkill(paths, cand, draft, NOW)).installed).toBe(true)
    expect((await listSkills(paths)).some((s) => s.name === `engram-${cand.slug}`)).toBe(true)
    expect(staleSkills(await readSkillsLedger(paths), [])).toEqual([])
  })
})

it('serializes concurrent installations and enforces the shared automatic-skill cap', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => installSkill(paths, turnSkillCandidate(`Task ${i}`, `Goal ${i}`), { title: 'Reusable task', description: 'When needed', body: 'Verify the current input and result.' }, NOW)))
  expect(results.filter(result => result.installed)).toHaveLength(8)
  expect(results.filter(result => result.reason === 'limit')).toHaveLength(4)
  expect(Object.keys(await readSkillsLedger(paths))).toHaveLength(8)
  expect(await listSkills(paths)).toHaveLength(8)
})
