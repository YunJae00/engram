import { contextText, promptFor } from '../../../packages/core/src/prompt.js'
import { firstLineState } from '../src/main/first-line.js'

export const quickPrompt = (message: string, korean: boolean, said?: readonly string[]): string => promptFor('quick', { message, korean, ...(said ? { said } : {}) })
export const firstLineNote = (channel: string): string => contextText({ firstLine: firstLineState(channel) })
