import { randomBytes } from 'node:crypto'

// Note id format: n-<epoch base36>-<random base36, 6 chars>, e.g.
// "n-lz3k9x-a1b2c3". Sortable by creation time; 36^6 (~2.2e9) random space
// keeps same-millisecond bursts collision-safe.
export function generateNoteId(now: Date = new Date()): string {
  const time = now.getTime().toString(36)
  const rand = (randomBytes(4).readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, '0')
  return `n-${time}-${rand}`
}

// Fixture/import ids may use shorter suffixes (e.g. n-deploy-0001).
export const NOTE_ID_PATTERN = /^n-[0-9a-z]+-[0-9a-z]{4,8}$/
