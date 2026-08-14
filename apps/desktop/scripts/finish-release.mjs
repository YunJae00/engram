
process.on('uncaughtException', (err) => {
  console.error(`\nfinish-release: ${err}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error(`\nfinish-release: ${reason}`)
  process.exit(1)
})

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { request } from 'node:https'
import { fileURLToPath } from 'node:url'

function uploadViaHttps(path, body, type, token) {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: 'uploads.github.com',
        path,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': type,
          'content-length': Buffer.byteLength(body),
          'user-agent': 'engram-release-script',
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', (err) => resolve({ status: 0, body: String(err) }))
    req.end(body)
  })
}

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const version = pkg.version
const repo = 'YunJae00/engram-releases'
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN

const fail = (message) => {
  console.error(message)
  process.exitCode = 1
}

if (!token) {
  fail('finish-release: GH_TOKEN is not set')
} else {
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
    fail(`finish-release: release v${version} not found (${releaseRes.status})`)
  } else {
    const exePath = fileURLToPath(new URL(`../dist/Engram Setup ${version}.exe`, import.meta.url))
    const exe = readFileSync(exePath)
    const sha512 = createHash('sha512').update(exe).digest('base64')
    const size = statSync(exePath).size
    const latestYml = [
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

    const artifacts = [
      { name: `Engram-Setup-${version}.exe`, body: exe, type: 'application/octet-stream' },
      {
        name: `Engram-Setup-${version}.exe.blockmap`,
        body: readFileSync(fileURLToPath(new URL(`../dist/Engram Setup ${version}.exe.blockmap`, import.meta.url))),
        type: 'application/octet-stream',
      },
      { name: 'latest.yml', body: latestYml, type: 'text/yaml' },
    ]

    for (const artifact of artifacts) {
      // A previous attempt may have left a same-name asset, complete or torn
      // mid-upload — replace it either way.
      const stale = (release.assets ?? []).find((a) => a.name === artifact.name)
      if (stale) {
        const del = await gh(`/repos/${repo}/releases/assets/${stale.id}`, { method: 'DELETE' })
        await del.text()
      }
      const mb = Math.round(Buffer.byteLength(artifact.body) / 1024 / 1024)
      process.stdout.write(`finish-release: uploading ${artifact.name} (${mb}MB — a big one can take many minutes, it is not stuck)… `)
      const upload = await uploadViaHttps(
        `/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(artifact.name)}`,
        artifact.body,
        artifact.type,
        token,
      )
      let state = ''
      try {
        state = JSON.parse(upload.body).state ?? ''
      } catch {
        /* non-JSON error body */
      }
      if (upload.status !== 201 || state !== 'uploaded') {
        fail(`FAILED (${upload.status}: ${upload.body.slice(0, 200)})`)
        break
      }
      console.log('ok')
    }

    if (process.exitCode !== 1) {
      const served = await fetch(`https://github.com/${repo}/releases/latest/download/latest.yml`, { redirect: 'follow' })
      const yml = await served.text()
      if (served.ok && yml.includes(sha512) && yml.includes(`size: ${size}`)) {
        console.log(`finish-release: feed verified — v${version} is live and checksum-true`)
      } else {
        fail(`finish-release: uploaded but the served feed does not verify (${served.status}) — wait a minute and rerun`)
      }
    }
  }
}
