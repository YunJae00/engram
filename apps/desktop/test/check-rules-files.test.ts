import { describe, expect, it } from 'vitest'
import { rulesFileProblems } from '../../../scripts/check-rules-files.mjs'

const files = (agents: string, claude: string) => (name: string) => Buffer.from(name === 'AGENTS.md' ? agents : claude)

describe('check-rules-files', () => {
  it('passes when both rules files are committed and the same bytes', () => {
    expect(rulesFileProblems(['AGENTS.md', 'CLAUDE.md'], files('- keep the orchard tidy\n', '- keep the orchard tidy\n'))).toEqual([])
  })

  it('fails when either file is not committed', () => {
    expect(rulesFileProblems(['AGENTS.md'], files('a', 'a'))).toEqual(['CLAUDE.md is not committed'])
    expect(rulesFileProblems(['CLAUDE.md'], files('a', 'a'))).toEqual(['AGENTS.md is not committed'])
  })

  it('fails when the files differ, even by a trailing newline', () => {
    expect(rulesFileProblems(['AGENTS.md', 'CLAUDE.md'], files('- water the plums\n', '- water the plums'))).toEqual(['AGENTS.md and CLAUDE.md differ'])
  })
})
