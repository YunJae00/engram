import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  addAliasGroup,
  aliasesPath,
  coveredByAliases,
  expandQueryWithAliases,
  loadAliasGroups,
  parseAliasGroups,
} from '../src/aliases.js'
import { buildIndex, searchIndex } from '../src/search.js'
import { createNote } from '../src/notes.js'
import { loadNotes } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// The tacit-knowledge glossary: names only the user knows are the same thing
// (myclient = myclientology) must bridge search, and teaching is transitive.

describe('alias glossary (workspace/aliases.md)', () => {
  it('parses only list lines, dropping 1-char and duplicate terms', () => {
    const groups = parseAliasGroups(
      ['# Aliases', '', 'prose = not a group', '- myclient = myclientology = MyClient', '- a = 우리회사', '- 단독'].join('\n'),
    )
    // 'prose = not a group' is not a `- ` line; 'MyClient' dupes 'myclient';
    // 'a' is too short so its line has one usable term and is dropped.
    expect(groups).toEqual([['myclient', 'myclientology']])
  })

  it('addAliasGroup merges transitively: a=b then b=c yields one a=b=c group', async () => {
    const paths = await initVault(await tmpVaultRoot('alias-add'), { git: false })
    expect(await addAliasGroup(paths, ['myclient', 'myclientology'])).toEqual(['myclient', 'myclientology'])
    expect(await addAliasGroup(paths, ['MYCLIENTOLOGY', '우리회사'])).toEqual(['myclient', 'myclientology', '우리회사'])
    const groups = await loadAliasGroups(paths)
    expect(groups).toEqual([['myclient', 'myclientology', '우리회사']])
    // Human-editable: the file itself carries the group as a plain list line.
    expect(await readFile(aliasesPath(paths), 'utf8')).toContain('- myclient = myclientology = 우리회사')
    // Under 2 usable terms teaches nothing.
    expect(await addAliasGroup(paths, ['solo'])).toBeNull()
  })

  it('coveredByAliases spots already-known combinations', () => {
    const groups = [['myclient', 'myclientology', '우리회사']]
    expect(coveredByAliases(['myclientology', 'MyClient'], groups)).toBe(true)
    expect(coveredByAliases(['myclient', 'othercorp'], groups)).toBe(false)
  })

  it('expands queries with the OTHER names of a mentioned term', () => {
    const groups = [['myclient', 'myclientology', '우리회사']]
    const expanded = expandQueryWithAliases('myclient 미팅 정리', groups)
    expect(expanded).toContain('myclientology')
    expect(expanded).toContain('우리회사')
    // Latin terms need word boundaries: "ai" must not fire inside "maintain".
    expect(expandQueryWithAliases('maintain the plan', [['ai', '인공지능']])).toBe('maintain the plan')
    // CJK terms match by substring (particles attach without spaces).
    expect(expandQueryWithAliases('우리회사의 결정', groups)).toContain('myclient')
    // No mention → query untouched.
    expect(expandQueryWithAliases('배포 정책', groups)).toBe('배포 정책')
  })

  it('bridges search: a note filed under the other name is found via the alias', async () => {
    const paths = await initVault(await tmpVaultRoot('alias-search'), { git: false })
    const now = new Date('2026-07-22T09:00:00Z')
    await createNote(paths, { body: '# myclientology 온보딩 일정\n\n킥오프는 8월 4일로 확정됨.' }, now)
    await createNote(paths, { body: '# 배포 정책\n\n금요일 배포 금지.' }, now)
    const notes = await loadNotes(paths)
    const index = buildIndex(notes)
    expect(searchIndex(index, '우리회사').some((h) => h.title.includes('온보딩'))).toBe(false)
    await addAliasGroup(paths, ['우리회사', 'myclientology'])
    const expanded = expandQueryWithAliases('우리회사', await loadAliasGroups(paths))
    expect(searchIndex(index, expanded).some((h) => h.title.includes('온보딩'))).toBe(true)
  })
})
