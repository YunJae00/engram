import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BinaryProvider } from './binary.js'

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
      child = spawn(whisper, ['-m', model, '-f', audioFile, '-otxt', '-of', outBase], { stdio: 'ignore' })
    } catch (err) {
      reject(new WhisperUnavailableError(String(err)))
      return
    }
    child.on('error', (err) => reject(new WhisperUnavailableError(err.message)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new WhisperUnavailableError(`exit ${code}`))
    })
  })
  const text = await readFile(`${outBase}.txt`, 'utf8')
  await rm(`${outBase}.txt`, { force: true })
  return text.trim()
}
