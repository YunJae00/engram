import type { FileCard } from 'core'

export const withCards = (text: string, files: readonly FileCard[] = []): string => [
  files.reduce((shown, file) => (file.replaces ?? []).reduce((now, old) => now.replaceAll(`](engram-artifact:${old})`, `](engram-artifact:${file.href})`), shown), text),
  ...files.map(file => `[${file.name}](engram-artifact:${file.href})`),
].join('\n\n')
