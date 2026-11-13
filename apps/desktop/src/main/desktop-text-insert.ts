import type { DesktopObservationDto } from '../shared/desktop.js'
import type { DesktopHost } from './desktop-host.js'

export const TEXT_CHUNK_UNITS = 20
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function typeArgs(text: string): { text: string; chunks: string[] } {
  const value = text.normalize('NFC')
  if (!value || value.length > 2000 || /\p{Cc}/u.test(value)) throw new Error('Type 1 to 2000 printable characters without line breaks.')
  const chunks: string[] = []
  let chunk = ''
  for (const { segment } of graphemes.segment(value)) {
    if (segment.length > TEXT_CHUNK_UNITS) throw new Error('Text contains a character too long to insert.')
    if (chunk.length + segment.length > TEXT_CHUNK_UNITS) { chunks.push(chunk); chunk = '' }
    chunk += segment
  }
  if (chunk) chunks.push(chunk)
  return { text: value, chunks }
}

export interface TypeReceipt { strategy?: string; expected?: string }
export interface TypedReport { strategy: 'selected-text' | 'keys' | 'unknown'; insert: 'one-piece' | 'chunked'; verified: boolean; landed?: string; hint?: string }

// The native receipt says which strategy ran and what the whole field must now read; the observation is a second, independent read.
export function typedReport(text: string, receipt: TypeReceipt | undefined, view: DesktopObservationDto): TypedReport {
  const value = text.normalize('NFC')
  const strategy = receipt?.strategy === 'selected-text' || receipt?.strategy === 'keys' ? receipt.strategy : 'unknown'
  const insert = strategy === 'selected-text' || (strategy === 'keys' && typeArgs(value).chunks.length === 1) ? 'one-piece' : 'chunked'
  const field = view.nodes.find(node => node.runtimeId && node.runtimeId === view.focusedControl)
  const expected = receipt?.expected?.normalize('NFC')
  if (!field || typeof field.value !== 'string' || field.valueTruncated || expected === undefined || !expected.includes(value))
    return { strategy, insert, verified: false, hint: 'The field could not be read back. Look at it before saying it is done or sending.' }
  if (field.value.normalize('NFC') === expected) return { strategy, insert, verified: true }
  return { strategy, insert, verified: false, landed: field.value.slice(-200), hint: 'The field does not hold exactly the requested text. Tell the person what landed; do not send.' }
}

export function typedUnverified(error: unknown): boolean {
  return /does not hold the typed text|could not be read back after typing/.test(error instanceof Error ? error.message : String(error))
}

export function sendsKey(action: { kind: string; key?: string }): boolean {
  return action.kind === 'key' && action.key === 'Enter'
}

// actOnDesktop drops the native receipt, so the type call is observed on the bound host while it runs.
export async function withTypeReceipt<T>(host: Pick<DesktopHost, 'request'> | undefined, text: string, run: () => Promise<T>): Promise<[T, TypeReceipt | undefined]> {
  if (!host) return [await run(), undefined]
  const original = host.request
  let receipt: TypeReceipt | undefined
  host.request = (async (method, args, ...rest) => {
    const result: unknown = await original.call(host, method, args, ...rest)
    if (method === 'type' && args['text'] === text && result && typeof result === 'object') receipt = result as TypeReceipt
    return result
  }) as DesktopHost['request']
  try { return [await run(), receipt] } finally { host.request = original }
}
