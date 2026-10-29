import os from 'node:os'
import { execFileSync } from 'node:child_process'

export function macAvailableMemory(output: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1])
  const count = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.$`, 'm').exec(output)?.[1])
  // vm_stat prints free minus speculative; available includes both and inactive.
  // Same definition as https://github.com/giampaolo/psutil/blob/master/psutil/arch/osx/mem.c
  const counts = ['free', 'speculative', 'inactive'].map(count)
  if (![4096, 16384].includes(pageSize) || counts.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined
  const bytes = counts.reduce((sum, value) => sum + value, 0) * pageSize
  return Number.isSafeInteger(bytes) ? bytes : undefined
}
let cached: { at: number; bytes: number } | undefined
export function availableMemory(): number {
  if (process.platform !== 'darwin') return os.freemem()
  const now = Date.now()
  if (cached && now >= cached.at && now - cached.at < 1000) return cached.bytes
  let bytes = os.freemem()
  try {
    const measured = macAvailableMemory(execFileSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 250, maxBuffer: 16384 }))
    if (measured !== undefined) bytes = Math.min(os.totalmem(), measured)
  } catch { /* Keep the conservative OS value if measurement is unavailable. */ }
  cached = { at: now, bytes }
  return bytes
}
