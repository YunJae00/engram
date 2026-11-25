export const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

export function officeOutputName(title: string, extension: '.docx' | '.pptx', requested?: string, fallback = 'document'): string {
  const last = typeof requested === 'string' ? requested.split(/[\\/]/).pop() ?? '' : ''
  const clean = (value: string) => value.replace(new RegExp(`\\${extension}$`, 'i'), '').replace(/[^\p{L}\p{N}_ .()-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}_]+/u, '').trim().slice(0, 60).trim()
  const stem = clean(last) || clean(title) || fallback
  return reserved.test(stem) ? `${fallback}${extension}` : `${stem}${extension}`
}
