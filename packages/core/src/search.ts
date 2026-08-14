import MiniSearch from 'minisearch'
import type { Note } from './schema.js'
import { noteTitle } from './schema.js'

const CJK_RE = /[぀-ヿ㄰-㆏一-鿿가-힯]/
const SPLIT_RE = /[\n\r\p{Z}\p{P}]+/u

export function cjkTokenize(text: string): string[] {
  const out: string[] = []
  for (const token of text.split(SPLIT_RE)) {
    if (!token) continue
    out.push(token)
    if (token.length >= 3 && CJK_RE.test(token)) {
      for (let i = 0; i < token.length - 1; i++) out.push(token.slice(i, i + 2))
    }
  }
  return out
}

const OPTIONS = {
  fields: ['title', 'body', 'type'],
  storeFields: ['title', 'status'],
  idField: 'id',
  tokenize: cjkTokenize,
}

// J7's merge-dedup pairing calibrated its score threshold on plain whitespace
// tokens; bigram inflation would shift every score, so it opts out (no
// `tokenize` key at all — minisearch falls back to its default tokenizer).
const PLAIN_OPTIONS = {
  fields: OPTIONS.fields,
  storeFields: OPTIONS.storeFields,
  idField: OPTIONS.idField,
}

interface IndexedDoc {
  id: string
  title: string
  body: string
  type: string
  status: string
}

function toDoc(note: Note): IndexedDoc {
  return {
    id: note.front.id,
    title: noteTitle(note),
    body: note.body,
    type: note.front.type,
    status: note.front.status,
  }
}

export function buildIndex(notes: Note[], opts: { cjkNgrams?: boolean } = {}): MiniSearch<IndexedDoc> {
  const index = new MiniSearch<IndexedDoc>(opts.cjkNgrams === false ? PLAIN_OPTIONS : OPTIONS)
  index.addAll(notes.map(toDoc))
  return index
}

export interface SearchHit {
  id: string
  title: string
  status: string
  score: number
}

export function searchIndex(index: MiniSearch<IndexedDoc>, query: string): SearchHit[] {
  return index.search(query, { prefix: true, fuzzy: 0.2 }).map((r) => ({
    id: String(r.id),
    title: String(r.title),
    status: String(r.status),
    score: r.score,
  }))
}

export function searchIndexStrict(index: MiniSearch<IndexedDoc>, query: string): SearchHit[] {
  const minTerms = query.trim().length < 12 ? 2 : 3
  const queryTokens = [...new Set(cjkTokenize(query).filter((token) => token.length >= 2))]
  return index
    .search(query, { prefix: true })
    .filter((r) => {
      let covered = 0
      for (const token of queryTokens) if (r.terms.some((term) => term.startsWith(token))) covered++
      return covered >= minTerms
    })
    .map((r) => ({
      id: String(r.id),
      title: String(r.title),
      status: String(r.status),
      score: r.score,
    }))
}

