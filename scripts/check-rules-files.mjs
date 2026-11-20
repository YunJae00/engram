import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RULES = ['AGENTS.md', 'CLAUDE.md']

export function rulesFileProblems(tracked, read) {
  const missing = RULES.filter(name => !tracked.includes(name)).map(name => `${name} is not committed`)
  if (missing.length) return missing
  return read(RULES[0]).equals(read(RULES[1])) ? [] : [`${RULES.join(' and ')} differ`]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const tracked = execFileSync('git', ['ls-files', '--', ...RULES], { cwd: root, encoding: 'utf8' }).split('\n')
  const problems = rulesFileProblems(tracked, name => readFileSync(join(root, name)))
  if (problems.length) {
    console.error(`Agent rules files:\n${problems.join('\n')}`)
    process.exit(1)
  }
}
