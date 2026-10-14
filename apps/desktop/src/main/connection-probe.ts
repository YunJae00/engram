import type { EngineDetection } from 'core'

export async function connectionProbe(probe: () => Promise<EngineDetection>, waitMs = 15_000): Promise<EngineDetection> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unknown = { installed: true, loggedIn: false, conclusive: false }
  try {
    return await Promise.race([Promise.resolve().then(probe).catch(() => unknown), new Promise<EngineDetection>(resolve => { timer = setTimeout(() => resolve(unknown), waitMs) })])
  } finally { clearTimeout(timer) }
}
