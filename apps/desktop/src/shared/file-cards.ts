import type { FileCard } from 'core'

export const withCards = (text: string, files: readonly FileCard[] = []): string => [text, ...files.map(file => `[${file.name}](engram-artifact:${file.href})`)].join('\n\n')
export const replacedLinks = (files: readonly FileCard[] = []): string[] => files.flatMap(file => file.replaces ?? [])
