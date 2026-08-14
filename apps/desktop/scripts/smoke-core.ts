import { BundledBinaryProvider, createNote, GitLayer, initVault, loadNotes } from 'core'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bundleDir = process.env['ENGRAM_BUNDLE_DIR']
if (!bundleDir) throw new Error('ENGRAM_BUNDLE_DIR is required')
const provider = new BundledBinaryProvider(bundleDir)

async function main(): Promise<void> {
  console.log(`smoke: PATH="${process.env['PATH'] ?? ''}"`)
  console.log(`smoke: bundled git = ${provider.hasBundledGit() ? provider.git() : 'MISSING'}`)
  if (!provider.hasBundledGit()) throw new Error('bundled git missing — run bundle-binaries first')

  const root = mkdtempSync(join(tmpdir(), 'engram-smoke-'))
  const paths = await initVault(root, { git: true, provider })
  console.log('smoke: vault initialized ✓')

  writeFileSync(join(paths.inbox, 'capture.md'), '# Smoke capture\n\nIt works without a system toolchain.')
  const note = await createNote(paths, { body: '# Smoke note\n\nCreated by the clean-env smoke.' })
  console.log(`smoke: capture + note ✓ (${note.front.id})`)

  const git = new GitLayer(paths.workspace, provider)
  const commit = await git.autoCommit('smoke: capture and note')
  if (!commit) throw new Error('auto-commit produced no commit')
  console.log(`smoke: hidden git commit ✓ (${commit.slice(0, 8)})`)

  const notes = await loadNotes(paths)
  if (notes.length !== 1) throw new Error(`expected 1 note, found ${notes.length}`)
  console.log('smoke: reload + schema validation ✓')
  console.log('SMOKE_PASS')
}

main().catch((err) => {
  console.error('SMOKE_FAIL', err)
  process.exit(1)
})
