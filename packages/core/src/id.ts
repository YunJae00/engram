import { randomBytes } from 'node:crypto'

export function generateNoteId(now: Date = new Date()): string {
  const time = now.getTime().toString(36)
  const rand = (randomBytes(4).readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, '0')
  return `n-${time}-${rand}`
}

export const NOTE_ID_PATTERN = /^n-[0-9a-z]+-[0-9a-z]{4,8}$/
