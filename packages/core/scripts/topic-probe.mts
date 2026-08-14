// What does the subject-merge cap actually cost on a real vault?
//
// subject.ts rejects any term that does not appear in EXACTLY 2 communities:
//   if (where.length !== MAX_SUBJECT_COMMUNITIES) continue
// so a subject spread over three or four clusters merges nothing. The user's
// projects have grown past two — MyClientology and Engram each dominate four
// clusters — which is why the Brain shows 11 topics for ~4 projects.
//
// Prints the topic list under the current rule and under a relaxed one, so the
// trade is a measurement rather than an argument.
import { loadNotes } from '../src/notes.js'
import { noteTitle } from '../src/schema.js'
import { vaultPaths } from '../src/vault.js'
import { topicComponents } from '../src/jobs/graph.js'
import { mergeBySubject } from '../src/jobs/subject.js'

const notes = await loadNotes(vaultPaths(process.env['ENGRAM_VAULT'] ?? 'C:/Users/ykwon060/Engram'))
const eligible = notes.filter((n) => n.front.status === 'current' && n.front.type !== 'hub')
const byId = new Map(eligible.map((n) => [n.front.id, n]))

const adjacent = new Map<string, Set<string>>()
const link = (a: string, b: string) => {
  if (!byId.has(a) || !byId.has(b)) return
  if (!adjacent.has(a)) adjacent.set(a, new Set())
  if (!adjacent.has(b)) adjacent.set(b, new Set())
  adjacent.get(a)!.add(b)
  adjacent.get(b)!.add(a)
}
for (const note of eligible) for (const rel of note.front.derived_from) link(note.front.id, rel)

const communities = topicComponents(adjacent)
console.log(`${eligible.length} notes → ${communities.length} link communities`)

const titleOf = (id: string) => noteTitle(byId.get(id)!)
const show = (label: string, topics: { ids: string[]; subject: string | null }[]) => {
  const big = topics.filter((t) => t.ids.length >= 2)
  console.log(`\n${label}: ${big.length} topics`)
  for (const t of [...big].sort((a, b) => b.ids.length - a.ids.length)) {
    console.log(`   ${String(t.ids.length).padStart(3)}  ${t.subject ?? '(no subject)'}`)
  }
}

show('아무 선언 없음 (현재)', mergeBySubject(communities, titleOf, adjacent))
show('MyClientology 를 이름으로 선언', mergeBySubject(communities, titleOf, adjacent, { aliases: [['MyClientology', 'myclient']] }))
show('+ SATURN 을 우산으로 선언', mergeBySubject(communities, titleOf, adjacent, { aliases: [['MyClientology', 'myclient']], umbrella: ['saturn', 'hcompany'] }))
