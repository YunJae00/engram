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
        body: '# 배포 절차 v1\n\n수동 FTP 업로드로 배포한다.',
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
        body: '# 배포 절차 v2\n\nCI 파이프라인이 스테이징까지 자동 배포한다.',
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
        body: '# 배포 절차 v3\n\n프로덕션까지 완전 자동 배포, 승인 버튼 1회.',
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
        body: '# 요금제\n\n프로 요금제는 월 5만원이다.',
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
        body: '# 요금제\n\n프로 요금제는 월 7만원이다.',
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
        body: '# 5월 스프린트 회의\n\n로그인 개편은 6월 첫 주에 나간다.',
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
        body: '# 아이디어\n\n온보딩에 샘플 볼트 자동 생성 옵션을 넣자.',
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
        body: '# 프로젝트 킥오프\n\n킥오프 미팅.',
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
        body: '# 중간 점검\n\n킥오프와 출시 사이 어딘가의 중간 점검.',
        type: 'meeting',
        happened_at: '2026-02-20',
      },
      at('2026-06-01T09:05:00Z'),
    ),
    await createNote(
      paths,
      {
        id: 'n-ship-0001',
        body: '# v0 출시\n\n첫 배포.',
        type: 'meeting',
        happened_at: '2026-03-01',
        timeline: 'pinned',
      },
      at('2026-06-01T09:10:00Z'),
    ),
  )

  return { paths, notes }
}
