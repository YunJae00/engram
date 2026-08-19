// Every model Engram downloads lives on someone else's server, addressed by a
// hardcoded filename. A repo that renames a file — one publishes only the
// dynamic K_M build, another lowercases the size — turns into a 404 that only
// the first user with the matching hardware ever sees. So the URLs are checked
// against the real server rather than trusted.
//
// Networks that inspect TLS break Node's fetch (which is why the app downloads
// through Chromium), so an unreachable server is reported as unchecked, not as
// a broken entry.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const targets = []

// The local brains, whose file name must also match the URL they are fetched from.
const llm = read('../src/main/local-llm.ts')
const catalogue = llm.slice(llm.indexOf('const MODELS'), llm.indexOf('const IDLE_UNLOAD_MS'))
for (const [, id, file, url] of catalogue.matchAll(/id: '([^']+)',[\s\S]*?file: '([^']+)',[\s\S]*?url: '([^']+)'/g)) {
  targets.push({ id, url, mustEndWith: file })
}
if (targets.length === 0) {
  console.error('verify-models: found no local-llm entries — the catalogue shape changed')
  process.exit(1)
}

// Transcription.
const audio = read('../../../packages/core/src/audio.ts')
const whisper = /MODEL_URL = '([^']+)'/.exec(audio)
if (whisper) targets.push({ id: 'whisper', url: whisper[1] })
else console.warn('verify-models: could not find MODEL_URL in audio.ts')

// Embeddings: the library resolves the repo at runtime, so check the repo exists.
const semantic = read('../src/main/semantic.ts')
const embed = /DEFAULT_MODEL = '([^']+)'/.exec(semantic)
if (embed) targets.push({ id: `embeddings (${embed[1]})`, url: `https://huggingface.co/${embed[1]}/resolve/main/config.json` })
else console.warn('verify-models: could not find DEFAULT_MODEL in semantic.ts')

let broken = 0
let unchecked = 0

for (const { id, url, mustEndWith } of targets) {
  if (mustEndWith && !url.endsWith(mustEndWith)) {
    console.error(`verify-models: ${id} — url does not end with its file name (${mustEndWith})`)
    broken++
    continue
  }
  let res
  try {
    res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  } catch (err) {
    console.warn(`verify-models: ${id} — could not reach the server (${String(err).slice(0, 80)})`)
    unchecked++
    continue
  }
  if (!res.ok) {
    console.error(`verify-models: ${id} — HTTP ${res.status} for ${url}`)
    broken++
    continue
  }
  const bytes = Number(res.headers.get('content-length') ?? 0)
  console.log(`verify-models: ${id} — ok${bytes > 1e6 ? ` (${(bytes / 1e9).toFixed(1)} GB)` : ''}`)
}

if (broken > 0) {
  console.error(`verify-models: ${broken} download${broken === 1 ? '' : 's'} would fail for a user`)
  process.exit(1)
}
console.log(`verify-models: clean${unchecked > 0 ? ` (${unchecked} unchecked — no connection)` : ''}`)
