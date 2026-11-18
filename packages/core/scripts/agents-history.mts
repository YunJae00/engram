import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const revisions = execFileSync(
  'git',
  ['log', '--format=%h', '--follow', '--', 'packages/core/src/agents-template.ts'],
  { cwd: process.cwd(), encoding: 'utf8' },
)
  .trim()
  .split('\n')

const seen = new Map<string, string>()
for (const rev of revisions) {
  let source: string
  try {
    source = execFileSync('git', ['show', `${rev}:packages/core/src/agents-template.ts`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch {
    continue
  }
  const start = source.indexOf('`', source.indexOf('AGENTS_MD_V1'))
  const end = source.lastIndexOf('`')
  if (start < 0 || end <= start) continue
  const body = source
    .slice(start + 1, end)
    .replace(/\\`/g, '`')
    .replace(/\\\$/g, '$')
    .replace(/\r\n/g, '\n')
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16)
  if (!seen.has(hash)) seen.set(hash, `${rev} (${body.split('\n').length} lines)`)
}

console.log(`${seen.size} distinct AGENTS.md versions across ${revisions.length} revisions:\n`)
for (const [hash, where] of seen) console.log(`  '${hash}', // ${where}`)
