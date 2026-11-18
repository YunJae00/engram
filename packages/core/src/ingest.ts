import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { transcribeAudio, WhisperUnavailableError } from './audio.js'
import type { BinaryProvider } from './binary.js'
import { clipUrl } from './clipping.js'
import { collectResult, engineCwd, type Engine } from './engine/types.js'
import { normalizeCapture } from './parsers.js'
import type { VaultPaths } from './vault.js'

const TEXT_EXT = new Set(['.md', '.txt'])
const PDF_EXT = new Set(['.pdf'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg'])
const URL_EXT = new Set(['.url'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a'])

export const VISION_MAX_BYTES = 10 * 1024 * 1024

export interface IngestOptions {
  provider?: BinaryProvider
  modelsDir?: string
  vision?: (relPath: string) => Promise<string | null>
  visionMaxBytes?: number
  ocr?: (path: string) => Promise<string>
}

export function visionExtractor(
  paths: VaultPaths,
  engines: Engine[],
): ((relPath: string) => Promise<string | null>) | undefined {
  const engine = engines.find((e) => e.vision)
  if (!engine) return undefined
  return async (relPath: string) => {
    try {
      const text = await collectResult(engine, {
        prompt: [
          `Read the image file at ${relPath} in this workspace and transcribe it.`,
          'Return clean markdown containing ALL visible text, in its original language.',
          'For charts, diagrams or photos, add one short paragraph describing what they show.',
          'Return ONLY the markdown — no preamble, no code fences.',
        ].join('\n'),
        workdir: engineCwd(paths),
        readOnly: true,
      })
      const trimmed = text.trim()
      return trimmed.length > 0 ? trimmed : null
    } catch {
      return null
    }
  }
}

async function extractPdf(path: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const buffer = await readFile(path)
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

async function ocrImage(path: string): Promise<string> {
  const { default: Tesseract } = await import('tesseract.js')
  const result = await Tesseract.recognize(path, 'eng+kor')
  return result.data.text
}

function parseUrlFile(content: string): string | null {
  const ini = /^URL=(.+)$/m.exec(content)?.[1]
  if (ini) return ini.trim()
  const bare = content.trim()
  return /^https?:\/\/\S+$/.test(bare) ? bare : null
}

interface IngestResult {
  file: string
  converted: boolean
}

export async function prepareInboxItem(
  paths: VaultPaths,
  file: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const ext = extname(file).toLowerCase()
  const fullPath = join(paths.inbox, file)

  if (TEXT_EXT.has(ext)) {
    const content = await readFile(fullPath, 'utf8')
    const normalized = normalizeCapture(content)
    if (normalized !== content) {
      await writeFile(fullPath, normalized)
      return { file, converted: true }
    }
    return { file, converted: false }
  }

  const toMarkdown = async (): Promise<string | null> => {
    if (PDF_EXT.has(ext)) return extractPdf(fullPath)
    if (IMAGE_EXT.has(ext)) {
      if (options.vision) {
        const { size } = await stat(fullPath)
        if (size <= (options.visionMaxBytes ?? VISION_MAX_BYTES)) {
          const viaEngine = await options.vision(`inbox/${file}`)
          if (viaEngine !== null) return viaEngine
        }
      }
      return (options.ocr ?? ocrImage)(fullPath)
    }
    if (URL_EXT.has(ext)) {
      const url = parseUrlFile(await readFile(fullPath, 'utf8'))
      return url ? clipUrl(url) : null
    }
    if (AUDIO_EXT.has(ext) && options.provider && options.modelsDir) {
      try {
        return await transcribeAudio(options.provider, fullPath, options.modelsDir)
      } catch (err) {
        if (err instanceof WhisperUnavailableError) return null
        throw err
      }
    }
    return null
  }

  const text = await toMarkdown()
  if (text === null) return { file, converted: false }

  const stem = basename(file, extname(file))
  const body = `${text.trim()}\n\n> source: sources/${file}\n`
  let mdFile = `${stem}.md`
  for (let n = 1; ; n++) {
    try {
      await writeFile(join(paths.inbox, mdFile), body, { flag: 'wx' })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      mdFile = `${stem}-${n}.md`
    }
  }
  await rename(fullPath, join(paths.sources, file))
  return { file: mdFile, converted: true }
}
