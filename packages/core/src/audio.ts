import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BinaryProvider } from './binary.js'
import { killTree, spawnServerChild } from './engine/spawn.js'

// Long recordings are legitimately slow, but nothing here is unbounded — a
// wedged binary must not hold the cores and the librarian job forever.
const TRANSCRIBE_TIMEOUT_MS = 20 * 60_000

// Audio pipeline: whisper.cpp transcription with
// first-use model download. When no whisper binary is available the caller
// leaves the audio in the inbox — degrade, never break (docs/BLOCKERS.md).

export class WhisperUnavailableError extends Error {
  constructor(detail: string) {
    super(`whisper unavailable: ${detail}`)
    this.name = 'WhisperUnavailableError'
  }
}

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
const MODEL_FILE = 'ggml-base.bin'

export async function ensureWhisperModel(modelsDir: string, url = MODEL_URL): Promise<string> {
  const modelPath = join(modelsDir, MODEL_FILE)
  try {
    await access(modelPath)
    return modelPath
  } catch {
    /* download below */
  }
  await mkdir(modelsDir, { recursive: true })
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new WhisperUnavailableError(`model download failed (${response.status})`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(modelPath))
  return modelPath
}

export async function transcribeAudio(
  provider: BinaryProvider,
  audioFile: string,
  modelsDir: string,
): Promise<string> {
  const whisper = provider.whisper()
  const model = await ensureWhisperModel(modelsDir)
  const outBase = audioFile + '.transcript'
  await new Promise<void>((resolve, reject) => {
    let child
    try {
      // Tracked, not bare: whisper decodes on every core, so one that outlives
      // its app pins the whole machine. spawnServerChild files it in the
      // ledger the boot janitor reads, and killAllEngineChildrenSync ends it
      // at quit.
      child = spawnServerChild(whisper, ['-m', model, '-f', audioFile, '-otxt', '-of', outBase], dirname(audioFile))
    } catch (err) {
      reject(new WhisperUnavailableError(String(err)))
      return
    }
    const timer = setTimeout(() => {
      killTree(child)
      reject(new WhisperUnavailableError(`no result within ${Math.round(TRANSCRIBE_TIMEOUT_MS / 60_000)} minutes`))
    }, TRANSCRIBE_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new WhisperUnavailableError(err.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new WhisperUnavailableError(`exit ${code}`))
    })
  })
  const text = await readFile(`${outBase}.txt`, 'utf8')
  await rm(`${outBase}.txt`, { force: true })
  return text.trim()
}
