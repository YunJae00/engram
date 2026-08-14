// Brain topic panel probe: seeds a vault with one linked topic (hub synthesis
// + members carrying link_reasons) plus unconnected strays, opens the Brain
// tab, selects the topic and screenshots the detail panel. Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/topic-shots.mts
import { _electron as electron } from '@playwright/test'
import { createNote, initVault, readNote, writeNote } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/topic-shots-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/topic-shots/', import.meta.url))

interface Seed {
  body: string
  date: string
  type?: string
  decay?: 'fast' | 'slow'
}

const MEMBERS: Seed[] = [
  {
    date: '2026-06-20T10:00:00Z',
    body: '# Chunking strategy results\n\nParagraph-based 512-token chunks with 15% overlap were the most stable on our technical corpus. Fixed 256 splits tables and code blocks so recall drops; 1024 mixes unrelated paragraphs and precision suffers. Measured on the 30 golden questions.',
  },
  {
    date: '2026-06-22T09:00:00Z',
    body: '# Embedding model: adopting bge-m3\n\nOn Korean technical documents bge-m3 beat text-embedding-3-small by 12 points of recall@5, with the gap widening on mixed-language corpora. Local serving keeps the cost at zero. Downside: indexing is slow.',
  },
  {
    date: '2026-06-25T14:00:00Z',
    type: 'decision',
    body: '# Fixed the hard-coded search topN\n\nRoot cause of some documents never being retrieved: search() hard-coded topN=4, so even with 18 documents only four chunks ever came back. Switched to a topN proportional to the document count.',
  },
  {
    date: '2026-06-28T11:00:00Z',
    decay: 'fast',
    body: '# Reranker evaluation\n\nCross-encoder reranking over the top 20 candidates visibly improves the final top 5, at +80ms per query. Acceptable for conversational search; unnecessary for batch indexing.',
  },
  {
    date: '2026-07-01T16:00:00Z',
    body: '# RAG evaluation harness\n\nA harness now tracks recall@5 over the 30 golden questions on every chunking, embedding or reranker change. Current baseline: 0.74. The question set was mined from real user query logs.',
  },
]

// reasons[i] = why member i links to member i-1 (a chain keeps one component).
const REASONS = [
  '',
  'Same retrieval-quality experiment series',
  'The topN bug surfaced during these recall runs',
  'Reranker tested on top of the fixed retrieval',
  'Harness guards every change the others describe',
]

const STRAYS: Seed[] = [
  { date: '2026-06-18T08:00:00Z', body: '# Shoulder rehab routine\n\nBand external rotations 3x15, face pulls 3x12, wall slides 10. Pain-free range only.' },
  { date: '2026-07-02T21:00:00Z', body: '# Reading: The Programmer\'s Brain\n\nWorking memory holds 4-6 items; chunking is what makes code readable.' },
]

const HUB_BODY = `# RAG retrieval quality

The retrieval stack has converged: paragraph-based 512-token chunks with 15% overlap, bge-m3 embeddings served locally, and a cross-encoder reranker over the top 20 candidates. A recurring failure mode — some documents never surfacing — traced back to a hard-coded topN, now proportional to corpus size.

**Open thread:** indexing speed with bge-m3 is the remaining bottleneck; the evaluation harness (baseline recall@5 = 0.74) guards every further change.

## Notes
- these member lines are dropped by the page renderer`

async function seed(): Promise<void> {
  await rm(VAULT, { recursive: true, force: true })
  await mkdir(VAULT, { recursive: true })
  const paths = await initVault(VAULT, { git: false })
  const ids: string[] = []
  for (const s of MEMBERS) {
    const note = await createNote(paths, { body: s.body, type: s.type, decay: s.decay }, new Date(s.date))
    ids.push(note.front.id)
  }
  // Chain the members and attach the link reasons (J2 would normally write these).
  for (let i = 1; i < ids.length; i++) {
    const note = await readNote(paths, ids[i])
    note.front.derived_from = [ids[i - 1]]
    note.front.link_reasons = { [ids[i - 1]]: REASONS[i] }
    await writeNote(paths, note)
  }
  await createNote(paths, { body: HUB_BODY, type: 'hub', derived_from: ids }, new Date('2026-07-10T08:00:00Z'))
  for (const s of STRAYS) await createNote(paths, { body: s.body }, new Date(s.date))
  console.log('vault ready:', VAULT)
}

async function main(): Promise<void> {
  await seed()
  await mkdir(OUT, { recursive: true })
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: VAULT,
      ENGRAM_USERDATA: join(VAULT, '.userdata'),
      ENGRAM_NO_GIT: '1',
      ENGRAM_ENGINE: 'none',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId('activity-brain').click()
  await page.getByTestId('brain-page').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(OUT, '01-topic-panel.png') })
  console.log('shot: 01-topic-panel')
  // The unconnected bucket page, same section grammar.
  const stray = page.getByTestId('brain-unconnected')
  if (await stray.count()) {
    await stray.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(OUT, '02-unconnected-panel.png') })
    console.log('shot: 02-unconnected-panel')
  }
  await app.close()
  console.log('shots →', OUT)
}

void main()
