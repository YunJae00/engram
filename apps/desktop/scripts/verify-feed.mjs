// The update feed names the file the app will download. If that name does not
// match the file actually published, every self-update 404s — silently, on
// every machine, forever. That is exactly what shipped: the default installer
// name carried spaces, electron-builder wrote them into latest.yml as hyphens,
// and GitHub served the asset with dots. Nobody noticed because a failed
// update looks identical to no update.
//
// So the build refuses to finish unless the feed, the file on disk, and the
// name GitHub will serve all agree.

import { readdirSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dist = fileURLToPath(new URL('../dist', import.meta.url))

let present
try {
  present = new Set(readdirSync(dist))
} catch {
  console.error('verify-feed: no dist directory — run the build first')
  process.exit(1)
}

const feeds = [...present].filter((name) => /^latest.*\.yml$/.test(name))
if (feeds.length === 0) {
  console.error('verify-feed: the build produced no latest*.yml — nothing could ever self-update')
  process.exit(1)
}

let bad = 0

for (const feed of feeds) {
  const text = readFileSync(join(dist, feed), 'utf8')
  const urls = [...text.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*(.+)$/gm)].map(([, v]) => v.trim())
  if (urls.length === 0) {
    console.error(`verify-feed: ${feed} names no file`)
    bad++
    continue
  }
  for (const url of new Set(urls)) {
    // GitHub rewrites spaces in an asset name; the feed spells them another
    // way, and the two never meet again.
    if (/\s/.test(url)) {
      console.error(`verify-feed: ${feed} → "${url}" contains a space, which GitHub will rewrite on upload`)
      bad++
      continue
    }
    if (!present.has(url)) {
      console.error(`verify-feed: ${feed} → "${url}" is not among the built files`)
      bad++
      continue
    }
    const size = statSync(join(dist, url)).size
    console.log(`verify-feed: ${feed} → ${url} (${(size / 1e9).toFixed(2)} GB) ok`)
  }
}

if (bad > 0) {
  console.error(`verify-feed: ${bad} problem${bad === 1 ? '' : 's'} — this build could not update anyone`)
  process.exit(1)
}
console.log('verify-feed: clean')
