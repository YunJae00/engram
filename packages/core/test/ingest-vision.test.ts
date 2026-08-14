import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Engine } from '../src/engine/types.js'
import { prepareInboxItem, visionExtractor, VISION_MAX_BYTES } from '../src/ingest.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex') // magic only — content never parsed

async function vaultWithImage(name: string) {
  const paths = await initVault(await tmpVaultRoot(name), { git: false })
  await writeFile(join(paths.inbox, 'shot.png'), PNG_BYTES)
  return paths
}

describe('hybrid image ingest', () => {
  it('prefers the vision engine and archives the original to sources/', async () => {
    const paths = await vaultWithImage('vision-first')
    let visionPath: string | null = null
    const result = await prepareInboxItem(paths, 'shot.png', {
      vision: async (relPath) => {
        visionPath = relPath
        return '# from vision'
      },
      ocr: async () => {
        throw new Error('OCR must not run when vision succeeds')
      },
    })
    expect(result).toEqual({ file: 'shot.md', converted: true })
    expect(visionPath).toBe('inbox/shot.png')
    const md = await readFile(join(paths.inbox, 'shot.md'), 'utf8')
    expect(md).toContain('# from vision')
    expect(md).toContain('> source: sources/shot.png')
    await expect(readFile(join(paths.sources, 'shot.png'))).resolves.toBeDefined()
  })

  it('falls back to OCR when the vision engine refuses (null)', async () => {
    const paths = await vaultWithImage('vision-null')
    const result = await prepareInboxItem(paths, 'shot.png', {
      vision: async () => null,
      ocr: async () => 'ocr text',
    })
    expect(result.converted).toBe(true)
    expect(await readFile(join(paths.inbox, 'shot.md'), 'utf8')).toContain('ocr text')
  })

  it('never sends an oversized image to the engine (size cap → OCR)', async () => {
    const paths = await vaultWithImage('vision-cap')
    let visionCalled = false
    const result = await prepareInboxItem(paths, 'shot.png', {
      vision: async () => {
        visionCalled = true
        return 'should not happen'
      },
      visionMaxBytes: 4, // file is 8 bytes
      ocr: async () => 'ocr text',
    })
    expect(visionCalled).toBe(false)
    expect(await readFile(join(paths.inbox, 'shot.md'), 'utf8')).toContain('ocr text')
    expect(result.file).toBe('shot.md')
    expect(VISION_MAX_BYTES).toBe(10 * 1024 * 1024)
  })
})

describe('visionExtractor', () => {
  const visionEngine = (result: () => string): Engine => ({
    id: 'mock',
    vision: true,
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run(job) {
      // the transcription job must be read-only and name the workspace path
      expect(job.readOnly).toBe(true)
      expect(job.prompt).toContain('inbox/shot.png')
      yield { type: 'result', text: result() }
    },
  })

  it('is undefined without a vision-capable engine', async () => {
    const paths = await initVault(await tmpVaultRoot('vision-none'), { git: false })
    const blind: Engine = {
      id: 'mock',
      detect: async () => ({ installed: true, loggedIn: true }),
      async *run() {
        yield { type: 'result', text: 'x' }
      },
    }
    expect(visionExtractor(paths, [blind])).toBeUndefined()
  })

  it('returns the engine transcription, and null on engine failure', async () => {
    const paths = await initVault(await tmpVaultRoot('vision-run'), { git: false })
    const ok = visionExtractor(paths, [visionEngine(() => ' transcribed ')])!
    await expect(ok('inbox/shot.png')).resolves.toBe('transcribed')
    const boom = visionExtractor(paths, [
      visionEngine(() => {
        throw new Error('engine died')
      }),
    ])!
    await expect(boom('inbox/shot.png')).resolves.toBeNull()
  })
})
