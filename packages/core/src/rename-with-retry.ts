import { rename } from 'node:fs/promises'

const RETRY_DELAYS_MS = [20, 40, 80, 160, 320] as const
const TRANSIENT_WINDOWS_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])

export async function renameWithRetry(source: string, target: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const delay = RETRY_DELAYS_MS[attempt]
      if (platform !== 'win32' || typeof code !== 'string' || !TRANSIENT_WINDOWS_ERRORS.has(code) || delay === undefined) throw error
      // Windows scanners may briefly hold either file; retain the atomic rename.
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
}
