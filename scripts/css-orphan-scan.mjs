import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

const RENDERER = join('apps', 'desktop', 'src', 'renderer', 'src')
const STYLESHEET = join(RENDERER, 'styles.css')

const PARENT_STYLED = new Map([
  ['lineage-node-wrap', '.lineage-chain is display:flex — the wrapper is a flex item and needs nothing'],
  ['view-section-key', '.view-section-head sets the small-caps; .view-section-count exists only to opt OUT of it'],
  ['onboard-note', 'inherits the onboarding body text; nothing about it differs'],
])

function definedClasses(css) {
  const names = new Set()
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const match of withoutComments.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1])
  return names
}

function classAttributes(source) {
  const groups = []
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = match[1] ?? match[2] ?? ''
    const interpolated = /\$\{/.test(raw)
    const names = raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean)
    if (names.length > 0) groups.push({ names, interpolated })
  }
  return groups
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (extname(entry.name) === '.tsx' || extname(entry.name) === '.ts') files.push(full)
  }
  return files
}

function stylesheetText(file, seen = new Set()) {
  const absolute = resolve(file)
  if (seen.has(absolute)) return ''
  seen.add(absolute)
  const text = readFileSync(absolute, 'utf8')
  return text + [...text.matchAll(/@import\s+['"](\.[^'"]+\.css)['"];?/g)]
    .map((match) => stylesheetText(resolve(dirname(absolute), match[1]), seen)).join('\n')
}

const defined = definedClasses(stylesheetText(STYLESHEET))
const fatal = []
const modifiers = new Map()

for (const file of walk(RENDERER, [])) {
  for (const { names, interpolated } of classAttributes(readFileSync(file, 'utf8'))) {
    const missing = names.filter((name) => !defined.has(name))
    if (missing.length === 0) continue
    const where = relative(RENDERER, file)
    if (missing.length === names.length && !interpolated) {
      if (!(names.length === 1 && PARENT_STYLED.has(names[0]))) fatal.push({ where, names })
      continue
    }
    for (const name of missing) {
      if (!modifiers.has(name)) modifiers.set(name, new Set())
      modifiers.get(name).add(where)
    }
  }
}

if (modifiers.size > 0) {
  console.log(`css-orphan-scan: ${modifiers.size} dead modifier(s) — styled base, so cosmetic:`)
  for (const [name, where] of [...modifiers].sort()) {
    console.log(`  .${name.padEnd(24)} ${[...where].join(', ')}`)
  }
}

if (fatal.length > 0) {
  console.error(`\ncss-orphan-scan: ${fatal.length} element(s) with NO styled class at all:`)
  for (const { where, names } of fatal) {
    console.error(`  ${where}  className="${names.join(' ')}"`)
  }
  console.error('\nThese render with no layout of their own. Add a rule to styles.css or drop the class.')
  process.exit(1)
}

console.log('css-orphan-scan: clean')
