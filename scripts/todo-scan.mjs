import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = new RegExp('\\b(' + ['TODO', 'FIXME', 'XXX', 'NotImplemented'].join('|') + ')\\b')
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/

function collectSourceDirs() {
  const dirs = []
  for (const group of ['packages', 'apps']) {
    let entries = []
    try {
      entries = readdirSync(group, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(group, entry.name, 'src'))
    }
  }
  return dirs
}

function scanDir(dir, hits) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDir(path, hits)
    } else if (EXTENSIONS.test(entry.name)) {
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (MARKER.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`)
      })
    }
  }
}

const hits = []
for (const dir of collectSourceDirs()) scanDir(dir, hits)

if (hits.length > 0) {
  console.error(`todo-scan: found ${hits.length} stub marker(s):`)
  for (const hit of hits) console.error('  ' + hit)
  process.exit(1)
}
console.log('todo-scan: clean')
