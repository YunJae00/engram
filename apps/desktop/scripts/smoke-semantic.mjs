import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { execFile } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))

async function main() {
  const repo = resolve(scriptDir, '../../..')
  await mkdir(join(repo, 'tmp'), { recursive: true })
  const root = await mkdtemp(join(repo, 'tmp', 'semantic-smoke-'))
  const app = await _electron.launch({
    executablePath: process.env.ENGRAM_PACKAGED_APP ?? resolve(scriptDir, process.platform === 'darwin'
      ? `../dist/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Engram.app/Contents/MacOS/Engram`
      : '../dist/win-unpacked/Engram.exe'),
    args: ['--no-sandbox'], timeout: 180000,
    env: { ...process.env, ENGRAM_USERDATA: join(root, 'profile'), ENGRAM_VAULT: join(root, 'vault'), ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_INDEX_NOW: '1' },
  })
  try {
    const page = await app.firstWindow({ timeout: 120000 })
    await page.getByTestId('shell').waitFor({ timeout: 120000 })
    let status
    const until = Date.now() + 180000
    while (Date.now() < until) {
      status = await page.evaluate(() => globalThis.engram.semanticStatus())
      if (status.status === 'ready') break
      if (status.status === 'error') throw new Error(status.detail)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.equal(status?.status, 'ready', JSON.stringify(status))
    const metadata = JSON.parse(await readFile(join(root, 'vault/workspace/.engram/vectors.json'), 'utf8'))
    assert.equal(metadata.dim, 1024)
    assert.equal(metadata.model, 'Xenova/bge-m3')
    const runtime = await app.evaluate(({ app }) => ({ executable: process.execPath, resources: process.resourcesPath, script: `${app.getAppPath()}/out/main/codex-worker.js` }))
    const helper = join(runtime.resources, 'bin', 'desktop', process.platform === 'darwin' ? 'EngramDesktop' : 'EngramDesktop.exe')
    const native = await new Promise((resolve, reject) => execFile(helper, ['--self-test'], { timeout: 30000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
    assert.match(String(native), /passed/i)
    const reply = await new Promise((resolve, reject) => {
      const child = execFile(runtime.executable, [runtime.script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000 }, (error, stdout) => {
        if (error) reject(error)
        else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } }
      })
      child.stdin.end(JSON.stringify({ options: { codexPathOverride: join(root, 'missing-runtime') }, thread: { workingDirectory: root, skipGitRepoCheck: true }, input: 'Unused fixture input' }) + '\n')
    })
    assert.match(reply.error, /ENOENT/)
    console.log(JSON.stringify({ root, status, dimensions: metadata.dim, packagedNativeSelfTest: 'passed' }))
  } finally { await app.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
