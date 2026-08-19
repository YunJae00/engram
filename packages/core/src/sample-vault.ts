import { createNote } from './notes.js'
import type { Note } from './schema.js'
import { initVault, type VaultPaths } from './vault.js'

// Deterministic sample vault (BUILD_PLAN M1-6): a 3-step supersede chain,
// a disputed pair, an expired note, an undetermined-chronology note and a
// pinned/inferred trio for interpolation demos. No git — fixtures live
// inside the monorepo repo.
export async function generateSampleVault(root: string): Promise<{ paths: VaultPaths; notes: Note[] }> {
  const paths = await initVault(root, { git: false })
  const at = (iso: string) => new Date(iso)
  const notes: Note[] = []

  // 3-step supersede chain: deploy procedure v1 → v2 → v3(current).
  notes.push(
    await createNote(
      paths,
      {
        id: 'n-deploy-0001',
        body: '# Deploy process v1\n\nDeploys go out by manual FTP upload.',
        type: 'reference',
        status: 'superseded',
        happened_at: '2026-01-10',
      },
      at('2026-01-10T09:00:00Z'),
    ),
    await createNote(
      paths,
      {
        id: 'n-deploy-0002',
        body: '# Deploy process v2\n\nThe CI pipeline deploys automatically up to staging.',
        type: 'reference',
        status: 'superseded',
        supersedes: ['n-deploy-0001'],
        happened_at: '2026-03-05',
      },
      at('2026-03-05T09:00:00Z'),
    ),
    await createNote(
      paths,
      {
        id: 'n-deploy-0003',
        body: '# Deploy process v3\n\nFully automatic to production, one approval button.',
        type: 'reference',
        status: 'current',
        supersedes: ['n-deploy-0002'],
        happened_at: '2026-06-20',
      },
      at('2026-06-20T09:00:00Z'),
    ),
  )

  // Disputed pair: two current claims that contradict each other.
  notes.push(
    await createNote(
      paths,
      {
        id: 'n-price-0001',
        body: '# Pricing\n\nThe pro plan is 50,000 won a month.',
        type: 'fact',
        status: 'disputed',
        happened_at: '2026-04-01',
      },
      at('2026-04-01T09:00:00Z'),
    ),
    await createNote(
      paths,
      {
        id: 'n-price-0002',
        body: '# Pricing\n\nThe pro plan is 70,000 won a month.',
        type: 'fact',
        status: 'disputed',
        happened_at: '2026-05-15',
      },
      at('2026-05-15T09:00:00Z'),
    ),
  )

  // Expired note: fast decay, verified window long gone.
  notes.push(
    await createNote(
      paths,
      {
        id: 'n-sprint-0001',
        body: '# May sprint meeting\n\nThe login revamp ships in the first week of June.',
        type: 'meeting',
        decay: 'fast',
        happened_at: '2026-05-02',
      },
      at('2026-05-02T09:00:00Z'),
    ),
  )

  notes.push(
    await createNote(
      paths,
      {
        id: 'n-idea-0001',
        body: '# Idea\n\nAdd a sample-vault option to onboarding.',
        type: 'idea',
        decay: 'ephemeral',
      },
      at('2026-06-25T09:00:00Z'),
    ),
  )

  // Pinned/inferred trio for interpolation: kick-off — (inferred) — launch.
  notes.push(
    await createNote(
      paths,
      {
        id: 'n-kick-0001',
        body: '# Project kickoff\n\nThe kickoff meeting.',
        type: 'meeting',
        happened_at: '2026-02-01',
        timeline: 'pinned',
      },
      at('2026-06-01T09:00:00Z'),
    ),
    await createNote(
      paths,
      {
        id: 'n-mid-0001',
        body: '# Midpoint check\n\nA checkpoint somewhere between kickoff and launch.',
        type: 'meeting',
        happened_at: '2026-02-20',
      },
      at('2026-06-01T09:05:00Z'),
    ),
    await createNote(
      paths,
      {
        id: 'n-ship-0001',
        body: '# v0 launch\n\nThe first deploy.',
        type: 'meeting',
        happened_at: '2026-03-01',
        timeline: 'pinned',
      },
      at('2026-06-01T09:10:00Z'),
    ),
  )

  return { paths, notes }
}
