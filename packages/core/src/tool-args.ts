import type { AgentToolContext } from './agent-loop.js'
import { carriesSecret, secretsIn } from './secrets.js'

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

export function localPageUrl(text: string): string | null {
  const asked = text.trim()
  if (!asked || /[\r\n]/.test(asked)) return null
  const address = /^file:/i.test(asked) ? asked : asked.startsWith('/') ? `file://${encodeURI(asked)}` : /^[a-z]:[\\/]/i.test(asked) ? `file:///${encodeURI(asked.replace(/\\/g, '/'))}` : null
  if (!address) return null
  try {
    const url = new URL(address)
    return url.protocol === 'file:' && (!url.host || url.host === 'localhost') && /\.x?html?$/i.test(decodeURIComponent(url.pathname)) ? url.href : null
  } catch { return null }
}

export function requireNoLocalPage(text: string, anywhere = false): void {
  const rest = anywhere ? text.replace(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ') : ''
  const named = anywhere && (/(?<![a-z0-9])file:\S/i.test(text) || /\.x?html?(?![a-z0-9])/i.test(rest) && /(?:^|[\s"'`(<=])(?:~[^\s\\/]*|[a-z]:)?[\\/]/i.test(rest))
  if (/^\s*file:/i.test(text) || localPageUrl(text) || localPageUrl(text.trim().replace(/^~[^\s\\/]*[\\/]/, '/')) || named) throw new Error('A local file is not opened in another app or an external browser. Open it with open_page (file:///… or its absolute path): it opens in the built-in browser, where the form can be filled and its submit asks the person. If open_page cannot open it, say so and stop; do not try another app.')
}
