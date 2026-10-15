import type { AgentToolContext } from './agent-loop.js'
import { carriesSecret, secretsIn } from './secrets.js'

// Argument hygiene shared by the tools that reach the computer: exact keys,
// printable text, and no secret ever typed into another app.
export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Object.values(Object.getOwnPropertyDescriptors(value)).every((field) => 'value' in field)
}

export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key))
}

export function printable(text: string): boolean {
  return [...text].every((character) => {
    const code = character.codePointAt(0)!
    return code >= 32 && !(code >= 127 && code <= 159) && !(code >= 0xd800 && code <= 0xdfff) && code !== 0x2028 && code !== 0x2029
  })
}

const OBVIOUS_SECRET = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+\S{8,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i

export function requirePublicText(text: string, context: AgentToolContext): void {
  if (secretsIn(text).length || carriesSecret(text, context.task) || carriesSecret(text, context.read ?? '') || OBVIOUS_SECRET.test(text)) throw new Error('Passwords, tokens and other secrets must be entered directly by the person, not desktop typing or verification.')
}
