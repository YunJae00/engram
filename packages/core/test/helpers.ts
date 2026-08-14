import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP_ROOT = fileURLToPath(new URL('../../../tmp/', import.meta.url))

export async function tmpVaultRoot(prefix: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true })
  return mkdtemp(join(TMP_ROOT, `${prefix}-`))
}

export const LIVE_TIMEOUT_MS = 480_000
