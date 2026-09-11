import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  countRecentSkills,
  installSkill,
  passesPrivacyLint,
  readSkillsLedger,
  renderSkillMd,
  skillCandidates,
  skillContentHash,
} from '../src/skills.js'
import type { Note } from '../src/schema.js'
import type { VaultPaths } from '../src/vault.js'

// J14: the vault's recurring know-how becomes a real ~/.claude/skills file.
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
  home = await mkdtemp(join(tmpdir(), 'engram-skills-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'engram-skills-vault-'))
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

  it('writes SKILL.md under the injectable home and stamps the ledger', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    const result = await installSkill(home, paths, candidate!, draft, NOW)
    expect(result.installed).toBe(true)
    const file = await readFile(join(home, '.claude', 'skills', 'engram-sample', 'SKILL.md'), 'utf8')
    expect(file).toContain('name: engram-sample')
    expect(file).toContain('## Steps')
    const ledger = await readSkillsLedger(paths)
    expect(ledger['sample']?.hash).toBe(skillContentHash(file))
    expect(countRecentSkills(ledger, NOW.getTime() - 1000)).toBe(1)
  })

  it('A USER-EDITED FILE IS THEIRS FOREVER — hash mismatch flips ownership and refuses', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    await installSkill(home, paths, candidate!, draft, NOW)
    const file = join(home, '.claude', 'skills', 'engram-sample', 'SKILL.md')
    await writeFile(file, `${await readFile(file, 'utf8')}\n<!-- my own edit -->`)
    const again = await installSkill(home, paths, candidate!, { ...draft, body: 'new body' }, NOW)
    expect(again).toEqual({ installed: false, reason: 'user-owned' })
    expect((await readFile(file, 'utf8')).includes('my own edit')).toBe(true)
    expect((await readSkillsLedger(paths))['sample']?.userOwned).toBe(true)
  })

  it('secrets never leave the vault', async () => {
    const [candidate] = skillCandidates(procedureNotes('sample', 3), {})
    const leaky = { ...draft, body: 'set GH_TOKEN=ghp_abcdefghijklmnopqrst1234 first' }
    expect(await installSkill(home, paths, candidate!, leaky, NOW)).toEqual({ installed: false, reason: 'privacy' })
    expect(passesPrivacyLint('email me at a@b.co')).toBe(false)
  })
})

describe('renderSkillMd', () => {
  it('produces valid frontmatter with the engram marker', () => {
    const md = renderSkillMd('sample', 'sample', { title: 'T', description: 'multi\nline desc', body: 'B' })
    expect(md.startsWith('---\nname: engram-sample\ndescription: multi line desc\n---\n')).toBe(true)
    expect(md).toContain('<!-- engram:skill v1')
  })
})
