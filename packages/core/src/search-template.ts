// Where to search is the person's choice, not this codebase's. Rather than
// naming engines in code — which fixes the answer for everyone and cannot
// learn a company's own search — the app learns the shape once: the person
// pastes a result address from whatever they already use, and the query in it
// becomes a blank to fill next time.

// The address with the search terms swapped for {q}, or null if that address
// carries no terms at all.
export function deriveSearchTemplate(pasted: string, terms?: string): string | null {
  let url: URL
  try {
    url = new URL(pasted.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const params = [...url.searchParams.entries()]
  if (params.length === 0) return null
  const wanted = terms?.trim().toLowerCase()
  // The parameter holding the words: the one that matches what was searched
  // for, or failing that the longest — which is what a query looks like
  // beside tracking ids and locale codes.
  const named = wanted ? params.find(([, value]) => value.trim().toLowerCase() === wanted) : undefined
  const longest = params.reduce((best, one) => (one[1].length > best[1].length ? one : best), params[0]!)
  const chosen = named ?? longest
  if (chosen[1].trim().length < 2) return null
  url.searchParams.set(chosen[0], '{q}')
  // searchParams escapes the braces; the template must keep them readable.
  return url.toString().replace('%7Bq%7D', '{q}')
}

// Fill the blank. Returns null when the template lost its placeholder, so a
// caller never silently searches for nothing.
export function searchUrlFor(template: string, query: string): string | null {
  if (!template.includes('{q}')) return null
  const filled = template.replace('{q}', encodeURIComponent(query))
  try {
    const url = new URL(filled)
    return url.protocol === 'http:' || url.protocol === 'https:' ? filled : null
  } catch {
    return null
  }
}

// A results page is mostly furniture: menus, promos, the site's own apps.
// Ordering the links by how much of the question they echo picks the result
// and leaves the furniture — without knowing whose page it is.
export function rankLinks(
  links: { text: string; url: string }[],
  query: string,
  cap = 5,
): { text: string; url: string }[] {
  const words = query
    .toLowerCase()
    .split(/[\s,./?!]+/)
    .filter((word) => word.length > 1)
  const scored = links.map((link, order) => {
    const hay = `${link.text} ${link.url}`.toLowerCase()
    // The same reading as everywhere else: a word counts when the page says
    // it, ending or no ending. Counting whole words only put a page whose
    // title happened to share one generic word above the one that held the
    // answer (measured).
    const hits = words.filter((word) => (isLatin(word) ? hay.includes(word) : gluedWord(word, hay))).length
    // A headline is longer than a menu item; among equals, prefer the one
    // that reads like a sentence, then the page's own order.
    return { link, score: hits * 100 + Math.min(link.text.length, 60) - order / 100 }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((one) => one.link)
}

// Written with spaces between the words, or with the endings glued on?
function isLatin(word: string): boolean {
  return /^[\p{Script=Latin}\p{Nd}\p{P}]+$/u.test(word)
}

// A language that writes its words apart is matched word for word - a
// substring hit finds "me" inside "deployment" and calls an unrelated page an
// answer. Endings still have to give, though: "deploys" and "deploy" are the
// same question, so a shared start is enough once the word is long enough to
// mean something on its own.
const STEM_MIN = 4

// Where the endings are glued on, the word the person typed and the word on
// the page differ only at the tail: "공지에서" against "공지사항" share a subject and
// not a single token. Dropping a syllable or two off the end is enough to see
// it, and short words are left alone so the match stays a match.
function gluedWord(word: string, hay: string): boolean {
  if (hay.includes(word)) return true
  if (word.length >= 3 && hay.includes(word.slice(0, -1))) return true
  return word.length >= 4 && hay.includes(word.slice(0, -2))
}

function sameWord(word: string, tokens: Set<string>): boolean {
  if (tokens.has(word)) return true
  if (word.length < STEM_MIN) return false
  for (const token of tokens) {
    if (token.length < STEM_MIN) continue
    if (token.startsWith(word) || word.startsWith(token)) return true
  }
  return false
}

// The words a question is actually about — what is left once the tokens too
// short to anchor anything are dropped.
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,./?!"'()[\]{}<>:;]+/)
    .filter((word) => word.length > 1)
}

// Did what came back have anything to do with what was asked? A question that
// names nothing — "handle that" with no "that" in sight — searches perfectly
// well and lands on a page about something else entirely, and the only honest
// next move is to ask rather than to write up whatever turned up.
export function answersTheQuestion(found: string, query: string): boolean {
  const hay = found.toLowerCase()
  const tokens = new Set(contentWords(found))
  const words = contentWords(query)
  if (words.length === 0) return false
  return words.some((word) => (isLatin(word) ? sameWord(word, tokens) : gluedWord(word, hay)))
}

// The embedder answers every question with its nearest few notes, so being
// returned says nothing at all. Below this the neighbour is noise rather than
// a neighbour - it is the same floor the vault's own hybrid search uses, and
// the only thing a similarity score can honestly be asked to decide.
export const SEMANTIC_NOISE = 0.35

// And where it stops being a guess. Above this the embedder is saying "same
// subject, other words"; below it the notes are neighbours worth showing and
// no more, which is when the page is worth a look as well.
export const SEMANTIC_SURE = 0.65
