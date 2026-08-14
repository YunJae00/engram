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

// Images above this size never go to the engine (context/token safety) —
// they fall back to local OCR, which merely gets slower, not wrong.
export const VISION_MAX_BYTES = 10 * 1024 * 1024

export interface IngestOptions {
  provider?: BinaryProvider
  modelsDir?: string
  // Engine-backed image transcription: takes a workspace-relative path,
  // returns markdown or null (unavailable/refused → caller falls back to OCR).
  vision?: (relPath: string) => Promise<string | null>
  visionMaxBytes?: number
  // Injectable for tests — tesseract downloads traineddata on first use.
  ocr?: (path: string) => Promise<string>
}

// Builds the vision callback from the connected engines, or undefined when
// none can see images. Wired automatically by sweep/processCapture so the CLI
// and the app get the hybrid pipeline without extra plumbing.
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
      return null // engine down/refusing → OCR fallback, never a lost capture
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
  // Windows .url files: [InternetShortcut]\nURL=https://…  Plain files with a
  // bare URL work too.
  const ini = /^URL=(.+)$/m.exec(content)?.[1]
  if (ini) return ini.trim()
  const bare = content.trim()
  return /^https?:\/\/\S+$/.test(bare) ? bare : null
}

export interface IngestResult {
  // inbox file (possibly rewritten to .md) that J1 should read
  file: string
  converted: boolean
}

// Converts one inbox item to text in place. Non-convertible files stay put.
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
        // whisper missing/broken → the audio waits in the inbox (degrade)
        if (err instanceof WhisperUnavailableError) return null
        throw err
      }
    }
    return null
  }

  const text = await toMarkdown()
  if (text === null) return { file, converted: false }

  // Original moves to sources/, extracted text becomes the inbox item.
  const stem = basename(file, extname(file))
  const mdFile = `${stem}.md`
  await rename(fullPath, join(paths.sources, file))
  await writeFile(join(paths.inbox, mdFile), `${text.trim()}\n\n> source: sources/${file}\n`)
  return { file: mdFile, converted: true }
}
