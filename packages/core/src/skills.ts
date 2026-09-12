import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import matter from 'gray-matter'
import { noteTitle } from './schema.js'
import type { Note } from './schema.js'
import type { VaultPaths } from './vault.js'

const PROCEDURE_RE = /함정|주의|방법|절차|규칙|패턴|체크|반드시|금지|해결|수정|검증|필수|pitfall|gotcha|rule|how|fix|always|never|checklist|must/i
const MIN_NOTES = 3
const CANDIDATE_CAP = 2
const MAX_AUTO_SKILLS = 8
const BODY_CAP = 6_000
const OPEN_BYTES = 100_000
const DESC_CAP = 200
// Secrets and identities never leave the vault inside a skill file.
const PRIVACY_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/i

export interface SkillLedgerEntry {
  folder: string
  hash: string
  distilledAt: string
  // The user edited the installed file — it is theirs now, never rewritten.
  userOwned?: boolean
}
export type SkillsLedger = Record<string, SkillLedgerEntry>

export interface SkillCandidate {
  slug: string
  folder: string
  notes: Note[]
}

export function skillSlug(folder: string): string {
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function ledgerFile(paths: VaultPaths): string {
  return join(paths.workspace, '.engram', 'skills-ledger.json')
}

export async function readSkillsLedger(paths: VaultPaths): Promise<SkillsLedger> {
  try {
    const ledger = JSON.parse(await readFile(ledgerFile(paths), 'utf8'))
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return {}
    return Object.fromEntries(Object.entries(ledger).filter(([, entry]) => {
      const value = entry as Partial<SkillLedgerEntry> | null
      return value && typeof value.folder === 'string' && typeof value.hash === 'string' && typeof value.distilledAt === 'string'
    })) as SkillsLedger
  } catch {
    return {}
  }
}

export async function writeSkillsLedger(paths: VaultPaths, ledger: SkillsLedger): Promise<void> {
  await mkdir(join(paths.workspace, '.engram'), { recursive: true })
  await writeFile(ledgerFile(paths), JSON.stringify(ledger, null, 2))
}

// Folders worth distilling: enough procedure-shaped conclusions, and at least
// one of them newer than the last distillation (nothing new → nothing to say).
export function skillCandidates(notes: Note[], ledger: SkillsLedger): SkillCandidate[] {
  const byFolder = new Map<string, Note[]>()
  for (const note of notes) {
    if (note.front.status !== 'current' || note.front.type === 'hub' || !note.front.context) continue
    if (!PROCEDURE_RE.test(noteTitle(note))) continue
    const list = byFolder.get(note.front.context) ?? []
    list.push(note)
    byFolder.set(note.front.context, list)
  }
  const autoOwned = Object.values(ledger).filter((entry) => entry.userOwned !== true).length
  const candidates: SkillCandidate[] = []
  for (const [folder, list] of byFolder) {
    if (list.length < MIN_NOTES) continue
    const slug = skillSlug(folder)
    if (!slug) continue
    const entry = ledger[slug]
    if (entry?.userOwned === true) continue
    if (entry === undefined && autoOwned + candidates.length >= MAX_AUTO_SKILLS) continue
    const newest = list.reduce((a, b) => (a.front.created > b.front.created ? a : b))
    if (entry !== undefined && newest.front.created <= entry.distilledAt) continue
    candidates.push({ slug, folder, notes: list.sort((a, b) => (a.front.created < b.front.created ? 1 : -1)) })
  }
  return candidates
    .sort((a, b) => (a.notes[0]!.front.created < b.notes[0]!.front.created ? 1 : -1))
    .slice(0, CANDIDATE_CAP)
}

// The engine's contract: refuse loudly or answer structurally — never pad.
export function distillPrompt(candidate: SkillCandidate): string {
  const evidence = candidate.notes
    .slice(0, 12)
    .map((n) => `- ${noteTitle(n)}\n${n.body.split('\n').slice(1).join('\n').trim().slice(0, 600)}`)
    .join('\n\n')
  return [
    `You distill a developer's own recurring know-how into a reusable skill file. The notes below are conclusions they reached repeatedly while working in the folder "${candidate.folder}".`,
    'GATE — reply with exactly {"skip": true} unless ALL hold:',
    '1. The notes describe the same KIND of problem recurring (not one-off events).',
    '2. There is a reusable procedure or checklist worth ~20+ lines of guidance.',
    '3. A person would plausibly invoke this by name while working (a real trigger).',
    'If the gate passes, reply with ONLY this JSON (no markdown fence):',
    '{"title": "<short imperative title>", "description": "<one sentence: when to use, phrased with words the user actually types>", "body": "<markdown with sections: ## When to use / ## Steps / ## Pitfalls — concrete, from the evidence only, no invention. Write in the language the notes are written in.>"}',
    'Never include personal names, emails, tokens, or channel names.',
    `--- Evidence notes (folder: ${candidate.folder}) ---`,
    evidence,
  ].join('\n\n')
}

export interface SkillDraft {
  title: string
  description: string
  body: string
}

export function renderSkillMd(slug: string, folder: string, draft: SkillDraft): string {
  return [
    '---',
    `name: engram-${slug}`,
    `description: ${JSON.stringify(draft.description.replace(/[\r\n]+/g, ' ').trim())}`,
    '---',
    '',
    `<!-- engram:skill v1 folder=${folder} — distilled by Engram from your own notes; edit freely, edits are never overwritten -->`,
    '',
    `# ${draft.title.trim()}`,
    '',
    draft.body.trim(),
    '',
  ].join('\n')
}

export function skillContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function passesPrivacyLint(content: string): boolean {
  return !PRIVACY_RE.test(content)
}

export interface InstallResult {
  installed: boolean
  reason?: 'user-owned' | 'privacy' | 'too-long'
}

// Skills live in the vault, the way routines do — the app's own home, not a
// vendor's. One folder per skill under .engram/skills, so a skill is portable
// with the vault and reachable by the comet without depending on whatever
// engine happens to be driving it.
export function skillsDir(paths: VaultPaths): string {
  return join(paths.workspace, '.engram', 'skills')
}

function frontMatter(content: string): { name?: string; description?: string; body: string } {
  // Accept plain YAML delimiters only; metadata must never select an executable parser.
  if (!/^---\r?\n/.test(content)) return { body: content.trim() }
  const parsed = matter(content, { language: 'yaml' })
  return { description: typeof parsed.data['description'] === 'string' ? parsed.data['description'] : undefined, body: parsed.content.trim() }
}

const SKILL_NAME = /^[A-Za-z0-9가-힣_-]+$/
function inside(base: string, target: string): boolean {
  const path = relative(base, target)
  return path !== '' && path !== '..' && !path.startsWith(`..\\`) && !path.startsWith('../') && !isAbsolute(path)
}

async function skillContent(paths: VaultPaths, name: string, path: string): Promise<string | null> {
  if (!SKILL_NAME.test(name) || isAbsolute(path)) return null
  const root = await realpath(skillsDir(paths)).catch(() => null)
  if (!root) return null
  const base = await realpath(join(root, name)).catch(() => null)
  if (!base || !inside(root, base)) return null
  const target = await realpath(join(base, path)).catch(() => null)
  if (!target || !inside(base, target)) return null
  const info = await stat(target)
  if (!info.isFile()) return null
  if (info.size > OPEN_BYTES) throw new Error('Skill file exceeds 100 KB. Split it into smaller reference files; no partial content was returned.')
  return readFile(target, 'utf8')
}

export interface SkillCard {
  name: string
  description: string
}

// The index tier: every skill's name and one-line description, cheap enough to
// carry in the prompt so the model knows what it can open without any of the
// bodies costing a token until one is needed.
export async function listSkills(paths: VaultPaths): Promise<SkillCard[]> {
  const dir = skillsDir(paths)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const cards: SkillCard[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue
    const content = await skillContent(paths, entry.name, 'SKILL.md').catch(() => null)
    if (content === null) continue
    try {
      const { description } = frontMatter(content)
      if (description) cards.push({ name: entry.name, description: description.replace(/\s+/g, ' ').trim().slice(0, DESC_CAP) })
    } catch { /* Invalid metadata is not advertised as an available skill. */ }
  }
  return cards.sort((a, b) => (a.name < b.name ? -1 : 1))
}

// The load tier: one skill's how-to in full, by the name the index gave. A
// reference file inside the skill can be asked for by relative path, kept
// inside the skill's own folder so a name can never reach elsewhere.
export async function readSkillFile(paths: VaultPaths, name: string, path?: string): Promise<string | null> {
  const content = await skillContent(paths, name, path ?? 'SKILL.md')
  return content === null ? null : path === undefined ? frontMatter(content).body : content
}

// Install into <vault>/.engram/skills/engram-<slug>/SKILL.md. The hash in the
// ledger is the ownership proof: a file on disk that no longer matches it was
// edited by the user, and from then on it is theirs.
export async function installSkill(
  paths: VaultPaths,
  candidate: SkillCandidate,
  draft: SkillDraft,
  now: Date = new Date(),
): Promise<InstallResult> {
  if (!SKILL_NAME.test(candidate.slug)) throw new Error('Invalid skill slug.')
  const content = renderSkillMd(candidate.slug, candidate.folder, draft)
  if (content.length > BODY_CAP) return { installed: false, reason: 'too-long' }
  if (!passesPrivacyLint(content)) return { installed: false, reason: 'privacy' }
  const ledger = await readSkillsLedger(paths)
  const entry = ledger[candidate.slug]
  const dir = join(skillsDir(paths), `engram-${candidate.slug}`)
  const file = join(dir, 'SKILL.md')
  if ((await lstat(dir).catch(() => null))?.isSymbolicLink() || (await lstat(file).catch(() => null))?.isSymbolicLink()) return { installed: false, reason: 'user-owned' }
  const existing = await readFile(file, 'utf8').catch(() => null)
  if (entry?.userOwned || (existing !== null && (!entry || skillContentHash(existing) !== entry.hash))) {
    ledger[candidate.slug] = { folder: candidate.folder, hash: existing === null ? '' : skillContentHash(existing), distilledAt: now.toISOString(), ...entry, userOwned: true }
    await writeSkillsLedger(paths, ledger)
    return { installed: false, reason: 'user-owned' }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(file, content, 'utf8')
  ledger[candidate.slug] = { folder: candidate.folder, hash: skillContentHash(content), distilledAt: now.toISOString() }
  await writeSkillsLedger(paths, ledger)
  return { installed: true }
}

// Copy only skills recorded by this vault. Preserve legacy sources and all
// destination conflicts; another vault or a user may still depend on them.
export async function migrateSkillsHome(home: string, paths: VaultPaths): Promise<number> {
  const legacy = join(home, '.claude', 'skills')
  const ledger = await readSkillsLedger(paths)
  const entries = await readdir(legacy, { withFileTypes: true }).catch(() => [])
  let moved = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('engram-') || !SKILL_NAME.test(entry.name) || !Object.hasOwn(ledger, entry.name.slice(7))) continue
    const from = join(legacy, entry.name)
    const to = join(skillsDir(paths), entry.name)
    if (await lstat(to).catch(() => null)) continue
    await mkdir(skillsDir(paths), { recursive: true })
    await cp(from, to, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
    moved++
  }
  return moved
}

// The brief's receipt: skills distilled/refreshed in the window.
export function countRecentSkills(ledger: SkillsLedger, sinceMs: number): number {
  return Object.values(ledger).filter(
    (entry) => entry.userOwned !== true && Date.parse(entry.distilledAt) >= sinceMs,
  ).length
}
