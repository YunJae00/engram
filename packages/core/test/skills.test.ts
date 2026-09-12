import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  countRecentSkills,
  installSkill,
  listSkills,
  migrateSkillsHome,
  passesPrivacyLint,
  readSkillFile,
  readSkillsLedger,
  renderSkillMd,
  skillCandidates,
  skillContentHash,
  skillsDir,
  writeSkillsLedger,
} from '../src/skills.js'
import { tmpVaultRoot } from './helpers.js'
import type { Note } from '../src/schema.js'
import type { VaultPaths } from '../src/vault.js'

// J14: the vault's recurring know-how becomes a skill file in the vault itself.
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
