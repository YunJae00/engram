
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const version = pkg.version
const repo = 'YunJae00/engram-releases'
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
if (!token) {
  console.error('prepare-release: GH_TOKEN is not set — the publish step would fail anyway')
  process.exitCode = 1
} else {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tag_name: `v${version}`, name: version, draft: true, prerelease: false }),
  })
  const body = await res.text() // ALWAYS consumed — see termination discipline above
  if (res.ok) {
    console.log(`prepare-release: created v${version}`)
  } else if (res.status === 422 && /already_exists/.test(body)) {
    console.log(`prepare-release: v${version} already exists — builder will upload into it`)
  } else {
    console.error(`prepare-release: GitHub answered ${res.status}: ${body.slice(0, 300)}`)
    process.exitCode = 1
  }
}
