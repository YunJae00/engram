import { officeTools, type AgentTool } from 'core'
import { freeName } from './file-work.js'

export interface OfficeOutputs { save(name: string, data: Buffer): Promise<Record<string, unknown>>; held?(): Promise<Set<string>> }

const COMMON_HANGUL = ((): Set<string> => {
  const found = new Set<string>()
  try { const decode = new TextDecoder('euc-kr'); for (let lead = 0xb0; lead <= 0xc8; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++) found.add(decode.decode(Uint8Array.of(lead, trail))) } catch {}
  return found
})()
export function mistypedWords(texts: readonly { where: string; text: string }[], personal = ''): string[] {
  const odd = (one: string) => /[\uFFFD\u1100-\u11FF]/.test(one) || (one < ' ' && !'\t\n\r'.includes(one)) || (COMMON_HANGUL.size > 0 && /[가-힣]/.test(one) && !COMMON_HANGUL.has(one) && !personal.includes(one))
  return texts.flatMap(({ where, text }) => (text.match(/[^\s,.:;()[\]"'“”‘’·/|-]+/g) ?? [])
    .filter(word => /[가-힣\u1100-\u11FF][\u0300-\u036f]/.test(word) || [...word].some(odd))
    .map(word => `${word} (${where})`)).slice(0, 8)
}
export type Proofread = (prompt: string) => Promise<string>
export const PROOF_MS = 5000
const proofPrompt = (texts: readonly string[]): string => [
  'Below are lines of a Korean document, one per line. Some words may have been garbled while typing: a wrong or stray syllable, a stray mark, a word nobody writes or that does not fit its sentence.',
  'For each garbled word write one line: garbled => intended. Change nothing else: not the style, spacing, numbers, names, English or anything correct.',
  'If nothing is garbled, reply with exactly NONE.',
  '',
  ...texts,
].join('\n')
export function proofFixes(raw: string, texts: readonly string[]): [string, string][] {
  const whole = texts.join('\n'), digits = (text: string): string => text.replace(/\D/g, '')
  const fixes = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const found = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?["'“‘]?(.+?)["'”’]?\s*(?:=>|->|→)\s*["'“‘]?(.+?)["'”’]?\s*$/.exec(line)
    if (!found) continue
    const [, wrong = '', right = ''] = found
    if (wrong === right || !whole.includes(wrong) || !/[가-힣]/.test(wrong) || !/[가-힣]/.test(right) || digits(wrong) !== digits(right) || Math.abs([...wrong].length - [...right].length) > 2) continue
    fixes.set(wrong, right)
  }
  return [...fixes]
}
const withFixes = (value: unknown, fixes: readonly [string, string][]): unknown =>
  typeof value === 'string' ? fixes.reduce((text, [wrong, right]) => text.split(wrong).join(right), value)
    : Array.isArray(value) ? value.map(one => withFixes(one, fixes))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, one]) => [key, withFixes(one, fixes)])) : value
const written = (op: 'ppt.build' | 'word.write', args: Record<string, unknown>): { titles: string[]; texts: { where: string; text: string }[] } => {
  if (op === 'ppt.build') {
    const slides = (Array.isArray(args['slides']) ? args['slides'] : []) as { title?: unknown; subtitle?: unknown; bullets?: unknown; table?: { rows?: unknown } }[]
    return {
      titles: slides.map(slide => String(slide.title ?? '')),
      texts: slides.flatMap((slide, at) => [slide.title, slide.subtitle, ...(Array.isArray(slide.bullets) ? slide.bullets : []), ...(Array.isArray(slide.table?.rows) ? (slide.table.rows as unknown[]).flat() : [])]
        .filter((one): one is string => typeof one === 'string').map(text => ({ where: `slide ${at + 1}`, text }))),
    }
  }
  const blocks = (Array.isArray(args['blocks']) ? args['blocks'] : []) as { kind?: unknown; text?: unknown; items?: unknown; table?: { rows?: unknown } }[]
  return {
    titles: blocks.filter(block => ['title', 'heading'].includes(String(block.kind)) && typeof block.text === 'string').map(block => block.text as string),
    texts: blocks.flatMap((block, at) => [block.text, ...(Array.isArray(block.items) ? block.items : []), ...(Array.isArray(block.table?.rows) ? (block.table.rows as unknown[]).flat() : [])]
      .filter((one): one is string => typeof one === 'string').map(text => ({ where: `block ${at + 1}`, text }))),
  }
}

async function composeOffice(op: 'ppt.build' | 'word.write', asked: Record<string, unknown>, outputs: OfficeOutputs | undefined, own: Set<string>, personal: string, signal?: AbortSignal, assertActive?: () => void, proofread?: Proofread): Promise<unknown> {
  signal?.throwIfAborted()
  assertActive?.()
  if (!outputs) throw new Error('A document can be composed only in a chat that keeps its outputs.')
  const said = written(op, asked).texts.map(one => one.text)
  const fixes = proofread && said.some(text => /[가-힣]/.test(text)) ? await proofread(proofPrompt(said)).then(raw => proofFixes(raw, said), () => []) : []
  const args = fixes.length ? withFixes(asked, fixes) as Record<string, unknown> : asked
  const odd = mistypedWords(written(op, args).texts, personal)
  if (odd.length) {
    throw new Error(`Nothing was built: these words are garbled (a character nobody types): ${odd.join(', ')}. Write each as the word meant and call ${op === 'ppt.build' ? 'ppt_build' : 'word_write'} again with everything else the same.`)
  }
  signal?.throwIfAborted()
  assertActive?.()
  const built = op === 'ppt.build'
    ? await (await import('./deck-render.js')).buildDeck(args as unknown as Parameters<typeof import('./deck-render.js').buildDeck>[0])
    : await (await import('./doc-render.js')).buildDoc(args as unknown as Parameters<typeof import('./doc-render.js').buildDoc>[0])
  signal?.throwIfAborted()
  assertActive?.()
  const held = await outputs.held?.() ?? new Set<string>()
  const name = freeName(built.name, free => held.has(free.normalize('NFC')) && !own.has(free))
  own.add(name.toLowerCase())
  const receipt = await outputs.save(name, built.data)
  const count = 'slides' in built ? { slides: built.slides } : { blocks: built.blocks }
  const { titles } = written(op, args)
  const listed = titles.length ? ` ${op === 'ppt.build' ? 'Slides' : 'Headings'}: ${titles.map((title, at) => `${at + 1}. ${title}`).join(' / ')}.` : ''
  const counted = 'slides' in built ? `${built.slides} slides` : `${built.blocks} blocks`
  const corrected = fixes.length ? ` The host corrected these words in the file: ${fixes.map(([wrong, right]) => `${wrong} → ${right}`).join(', ')}.` : ''
  return {
    ...receipt, ...count, ...(titles.length ? { titles } : {}),
    verification: `Saved as ${name} and compared byte for byte by the host; no Office window was opened. Verified in the file: ${counted}, every one with the text you gave${fixes.length ? ' but for the words below' : ''}.${listed}${corrected} It is done: do not read it back or build it again. Answer now with its markdownLink.`,
  }
}

type BuildOp = 'ppt.build' | 'word.write'

export function officeComposer(outputs: OfficeOutputs | undefined, personal: string, assertActive: () => void, proofread?: Proofread): (op: BuildOp, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> {
  const composed = new Map<string, unknown>()
  const own = new Set<string>()
  return async (op, args, signal) => {
    const key = `${op}\0${JSON.stringify(args)}`
    if (composed.has(key)) { signal?.throwIfAborted(); assertActive(); return composed.get(key) }
    const receipt = await composeOffice(op, args, outputs, own, personal, signal, assertActive, proofread)
    const named = (one: unknown): string | undefined => /^\[([^\]]+)\]/.exec(String((one as { markdownLink?: unknown }).markdownLink ?? ''))?.[1]?.toLowerCase()
    for (const [held, earlier] of composed) if (named(earlier) === named(receipt)) composed.delete(held)
    composed.set(key, receipt)
    return receipt
  }
}

export function officeBuildTools(compose: ReturnType<typeof officeComposer>): AgentTool[] {
  return officeTools({ run: async (op, args, signal) => {
    if (op !== 'ppt.build' && op !== 'word.write') throw new Error(`${op} needs the Office app, which is not part of this tool set.`)
    return compose(op, args, signal)
  } }).filter(tool => tool.name === 'word_write' || tool.name === 'ppt_build')
}
