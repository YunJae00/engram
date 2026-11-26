import { contextText, promptFor } from '../../../packages/core/src/prompt.js'
import { firstLineState } from '../src/main/first-line.js'

export const ackPrompt = (message: string, korean: boolean, said?: readonly string[]): string => promptFor('ack', { message, korean, ...(said ? { said } : {}) })
export const firstLineNote = (channel: string): string => contextText({ firstLine: firstLineState(channel) })
