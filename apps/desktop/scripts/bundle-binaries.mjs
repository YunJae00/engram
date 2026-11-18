import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const bundleDir = join(root, '..', 'bundle')

const MINGIT_URL =
  process.env.ENGRAM_MINGIT_URL ??
  'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip'

const MINGIT_SHA256 = '50b04b55425b5c465d076cdb184f63a0cd0f86f6ec8bb4d5860114a713d2c29a'
const MINGIT_SIGNER = 'Johannes Schindelin'

rmSync(bundleDir, { recursive: true, force: true })
mkdirSync(join(bundleDir, 'git', 'bin'), { recursive: true })

function which(cmd) {
  try {
    const probe = process.platform === 'win32' ? ['where', [cmd]] : ['which', [cmd]]
    return execFileSync(probe[0], probe[1], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null
  } catch {
    return null
  }
}

if (process.platform === 'win32') {
  const gitDir = join(bundleDir, 'git')
  const cacheDir = join(root, '..', 'bundle-cache')
  mkdirSync(cacheDir, { recursive: true })
  const zipPath = join(cacheDir, MINGIT_URL.split('/').pop() ?? 'mingit.zip')
  if (!existsSync(zipPath)) {
    console.log(`bundle: downloading MinGit from ${MINGIT_URL}`)
    let lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(MINGIT_URL)
        if (!res.ok) throw new Error(`MinGit download failed: ${res.status}`)
        writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        rmSync(zipPath, { force: true })
        console.warn(`bundle: MinGit download attempt ${attempt} failed — ${err}`)
      }
    }
    if (lastErr) throw lastErr
  } else {
    console.log(`bundle: MinGit zip from cache (${zipPath})`)
  }
  const actualSha = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  if (MINGIT_SHA256 && actualSha !== MINGIT_SHA256) {
    rmSync(zipPath, { force: true })
    throw new Error(
      `MinGit checksum mismatch — refusing to bundle.\n  expected ${MINGIT_SHA256}\n  actual   ${actualSha}\n` +
        `  url      ${MINGIT_URL}\n  (cached copy deleted; if the pin is intentionally out of date, verify the new ` +
        `artifact's Authenticode signature and update MINGIT_SHA256)`,
    )
  }
  console.log(`bundle: MinGit checksum ok (${actualSha.slice(0, 16)}…)`)
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const bsdtar = join(systemRoot, 'System32', 'tar.exe')
  execFileSync(existsSync(bsdtar) ? bsdtar : 'tar', ['-xf', zipPath, '-C', gitDir], { stdio: 'inherit' })
  const gitExe = join(gitDir, 'cmd', 'git.exe')
  if (!existsSync(gitExe)) throw new Error('MinGit extraction produced no cmd/git.exe')
  const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  const powershellExe = join(windowsPowerShell, 'powershell.exe')
  const securityModule = join(windowsPowerShell, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
  if (!existsSync(powershellExe) || !existsSync(securityModule)) {
    throw new Error('Windows PowerShell security module not found — refusing to bundle')
  }
  const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`
  const sig = execFileSync(
    powershellExe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; Import-Module -Name ${quotePowerShell(securityModule)} -Force; ` +
        `$s = Get-AuthenticodeSignature -LiteralPath ${quotePowerShell(gitExe)}; ` +
        `Write-Output "$($s.Status)|$($s.SignerCertificate.Subject)"`,
    ],
    { encoding: 'utf8' },
  ).trim()
  const [status, subject = ''] = sig.split('|')
  if (status !== 'Valid' || !subject.includes(MINGIT_SIGNER)) {
    throw new Error(`MinGit signature check failed — refusing to bundle.\n  status ${status}\n  signer ${subject}`)
  }
  console.log(`bundle: MinGit signature ok (${MINGIT_SIGNER})`)
  console.log(`bundle: MinGit ready (${gitExe})`)
} else if (process.platform === 'darwin') {
  console.log('bundle: macOS uses the system git (/usr/bin/git) — nothing bundled')
} else {
  const gitBin = which('git')
  if (!gitBin) {
    console.error('bundle: no git on the build machine — bundle will fall back to system git')
  } else {
    cpSync(gitBin, join(bundleDir, 'git', 'bin', 'git'), { dereference: true })
    const execPath = execFileSync(gitBin, ['--exec-path'], { encoding: 'utf8' }).trim()
    if (existsSync(execPath)) {
      cpSync(execPath, join(bundleDir, 'git', 'libexec', 'git-core'), { recursive: true, dereference: true })
    }
    const templates = '/usr/share/git-core/templates'
    if (existsSync(templates)) {
      cpSync(templates, join(bundleDir, 'git', 'share', 'templates'), { recursive: true, dereference: true })
    }
    console.log(`bundle: git snapshot from ${gitBin}`)
  }
}

const whisperUrl = process.env.ENGRAM_WHISPER_URL
if (whisperUrl) {
  const target = join(bundleDir, 'whisper')
  mkdirSync(target, { recursive: true })
  const res = await fetch(whisperUrl)
  if (!res.ok) throw new Error(`whisper download failed: ${res.status}`)
  writeFileSync(join(target, 'main'), Buffer.from(await res.arrayBuffer()), { mode: 0o755 })
  console.log('bundle: whisper downloaded')
} else {
  console.log('bundle: ENGRAM_WHISPER_URL not set — audio pipeline stays feature-flagged')
}

{
  const MODEL_ID = process.env.ENGRAM_SEMANTIC_MODEL ?? 'Xenova/bge-m3'
  const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
  const cacheDir = join(root, '..', 'bundle-cache', 'model', ...MODEL_ID.split('/'))
  const complete = () => MODEL_FILES.every((f) => existsSync(join(cacheDir, f)))
  if (!complete()) {
    const appData =
      process.platform === 'win32'
        ? process.env.APPDATA
        : process.platform === 'darwin'
          ? join(process.env.HOME ?? '', 'Library', 'Application Support')
          : join(process.env.HOME ?? '', '.config')
    const runtimeCache = appData ? join(appData, 'desktop', 'models', ...MODEL_ID.split('/')) : null
    if (runtimeCache && MODEL_FILES.every((f) => existsSync(join(runtimeCache, f)))) {
      console.log(`bundle: seeding model from runtime cache (${runtimeCache})`)
      for (const f of MODEL_FILES) {
        mkdirSync(dirname(join(cacheDir, f)), { recursive: true })
        cpSync(join(runtimeCache, f), join(cacheDir, f))
      }
    } else {
      for (const f of MODEL_FILES) {
        const target = join(cacheDir, f)
        if (existsSync(target)) continue
        const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${f}`
        console.log(`bundle: downloading ${url}`)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`model download failed: ${res.status} ${url}`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, Buffer.from(await res.arrayBuffer()))
      }
    }
  }
  if (!complete()) throw new Error('semantic model bundle incomplete')
  cpSync(join(root, '..', 'bundle-cache', 'model'), join(bundleDir, 'model'), { recursive: true })
  console.log(`bundle: semantic model bundled (${MODEL_ID})`)
}

{
  const { build } = await import('esbuild')
  await build({
    entryPoints: [join(root, 'mcp-entry.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: join(bundleDir, 'mcp', 'engram-mcp.cjs'),
    logLevel: 'warning',
  })
  console.log('bundle: engram MCP server bundled (mcp/engram-mcp.cjs)')
}

console.log(`bundle ready: ${bundleDir}`)
