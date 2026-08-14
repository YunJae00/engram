
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const version = pkg.version
const repo = 'YunJae00/engram-releases'
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const exePath = fileURLToPath(new URL(`../dist/Engram Setup ${version}.exe`, import.meta.url))

const fail = (message) => {
  console.error(message)
  process.exitCode = 1
}

const exe = readFileSync(exePath)
const sha512 = createHash('sha512').update(exe).digest('base64')
const size = statSync(exePath).size

const served = await fetch(`https://github.com/${repo}/releases/latest/download/latest.yml`, { redirect: 'follow' })
const yml = await served.text()
if (!served.ok) {
  fail(`verify-feed: could not fetch served latest.yml (${served.status})`)
} else {
  const okVersion = yml.includes(`version: ${version}`)
  const okSha = yml.includes(sha512)
  const okSize = yml.includes(`size: ${size}`)
  if (okVersion && okSha && okSize) {
    console.log(`verify-feed: OK — served latest.yml matches the ${version} installer exactly`)
  } else if (!token) {
    fail(`verify-feed: MISMATCH (version:${okVersion} sha:${okSha} size:${okSize}) and GH_TOKEN not set — cannot repair`)
  } else {
    console.warn(`verify-feed: MISMATCH (version:${okVersion} sha:${okSha} size:${okSize}) — repairing`)
    const gh = (path, init = {}) =>
      fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          ...(init.headers ?? {}),
        },
      })

    const releaseRes = await gh(`/repos/${repo}/releases/tags/v${version}`)
    const release = await releaseRes.json()
    if (!releaseRes.ok || !release.id) {
      fail('verify-feed: release not found for repair')
    } else {
      const stale = (release.assets ?? []).find((a) => a.name === 'latest.yml')
      if (stale) {
        const del = await gh(`/repos/${repo}/releases/assets/${stale.id}`, { method: 'DELETE' })
        await del.text()
      }
      const corrected = [
        `version: ${version}`,
        'files:',
        `  - url: Engram-Setup-${version}.exe`,
        `    sha512: ${sha512}`,
        `    size: ${size}`,
        `path: Engram-Setup-${version}.exe`,
        `sha512: ${sha512}`,
        `releaseDate: '${new Date().toISOString()}'`,
        '',
      ].join('\n')
      const upload = await fetch(
        `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=latest.yml`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'text/yaml' },
          body: corrected,
        },
      )
      await upload.text()
      if (!upload.ok) fail(`verify-feed: repair upload failed (${upload.status})`)
      else console.log('verify-feed: repaired — corrected latest.yml uploaded')
    }
  }
}
