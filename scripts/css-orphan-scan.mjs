// Fails the build when the renderer asks for a class the stylesheet does not
// define AND the element has nothing else to fall back on.
//
// Why this exists. Commit 414aa35 removed CaptureBar and swept .connect-banner,
// .connect-banner-btn and .update-banner out of styles.css while App.tsx kept
// rendering all three. An unstyled element does not throw — it just becomes a
// plain div in normal flow — so the connect nudge spent four days running off
// the right edge of the window and shoving the star field sideways, with the
// button text welded to the sentence, until a user sent a screenshot. Nothing
// in typecheck, lint, the unit suite or the e2e suite can see this: every one
// of them passed the whole time.
//
// THE RULE IS DELIBERATELY NARROW. An element carrying `className="a b"` where
// `.a` is styled and `.b` is not renders fine; `.b` is a dead modifier, worth
// knowing about but not worth failing a build over, and this repo has eight of
// them that never had a rule in the first place. What is fatal is an element
// whose ONLY class has no rule — that one has no layout at all, which is
// exactly what happened to the banner. So: sole unstyled class → error;
// unstyled modifier alongside a styled base → reported, exit 0.
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const RENDERER = join('apps', 'desktop', 'src', 'renderer', 'src')
const STYLESHEET = join(RENDERER, 'styles.css')

// Sole classes that legitimately have no rule because the PARENT styles the
// element — ordinary CSS, and the one thing this scan cannot see, since it
// reads class attributes and not the JSX tree. Each entry needs the parent that
// does the work, so a future reader can check the claim instead of trusting it.
const PARENT_STYLED = new Map([
  ['lineage-node-wrap', '.lineage-chain is display:flex — the wrapper is a flex item and needs nothing'],
  ['view-section-key', '.view-section-head sets the small-caps; .view-section-count exists only to opt OUT of it'],
  ['onboard-note', 'inherits the onboarding body text; nothing about it differs'],
])

// Every `.foo` a selector mentions. Over-broad on purpose: a class named in any
// selector, however deeply nested, is one the author accounted for.
//
// COMMENTS ARE STRIPPED FIRST, and that is not a detail. Self-testing this scan
// by deleting the banner rules the way 414aa35 did, it failed to flag the
// banner itself — because the comment left behind still said ".connect-banner",
// and prose about a rule was being read as the rule. A scan that a comment can
// silence is worse than none: it reports clean over the exact bug it exists to
// catch, and the comment describing a deleted rule is the likeliest thing to
// survive that deletion.
function definedClasses(css) {
  const names = new Set()
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const match of withoutComments.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1])
  return names
}

// className="a b" and className={`a ${expr} b`}. Interpolations are blanked
// rather than parsed — `fresh-${level}` leaves a `fresh-` fragment, which is a
// prefix of real rules and cannot be checked from source.
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

const defined = definedClasses(readFileSync(STYLESHEET, 'utf8'))
const fatal = []
const modifiers = new Map()

for (const file of walk(RENDERER, [])) {
  for (const { names, interpolated } of classAttributes(readFileSync(file, 'utf8'))) {
    const missing = names.filter((name) => !defined.has(name))
    if (missing.length === 0) continue
    const where = relative(RENDERER, file)
    // A group with an interpolated class may be styled by the part we blanked
    // out, so it can never be proven bare from source.
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
