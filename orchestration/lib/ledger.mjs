import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { overlaps } from './overlap.mjs'

const EDGES = {
  queued: ['briefed', 'blocked'],
  briefed: ['designing', 'implementing', 'blocked', 'needs_human'],
  designing: ['briefed', 'blocked', 'needs_human'],
  implementing: ['implemented', 'bounced', 'blocked', 'needs_human'],
  implemented: ['verifying', 'bounced', 'blocked'],
  verifying: ['verified', 'bounced', 'blocked', 'needs_human', 'implemented'],
  bounced: ['briefed', 'needs_human'],
  verified: ['merged', 'blocked', 'needs_human'],
  merged: ['integrated', 'reverted'],
  integrated: ['released'],
  blocked: [],
  needs_human: [],
  released: [],
  reverted: [],
}

const TERMINAL = new Set(['integrated', 'blocked', 'needs_human', 'reverted', 'released'])

const dir = (root) => join(root, 'orchestration')
const ledgerPath = (root) => join(dir(root), 'ledger.json')

export function loadRoles(root) {
  const text = readFileSync(join(dir(root), 'roles.md'), 'utf8')
  const blocks = [...text.matchAll(/^```json\n([\s\S]*?)^```/gm)]
  if (blocks.length !== 1) throw new Error(`roles.md must contain exactly one json block, found ${blocks.length}`)
  return JSON.parse(blocks[0][1])
}

export function saveLedger(root, ledger) {
  const file = ledgerPath(root)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`)
  renameSync(temp, file)
}

export function loadLedger(root) {
  const file = ledgerPath(root)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const ledger = { batch: new Date().toISOString().replace(/[-:]/g, '').slice(0, 15), items: [] }
  saveLedger(root, ledger)
  return ledger
}

const cell = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ')

function appendRow(file, header, values) {
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, `${header.join('\t')}\n`)
  appendFileSync(file, `${[new Date().toISOString(), ...values].map(cell).join('\t')}\n`)
}

export function decide(root, { item, phase, decision, why, evidence, result }) {
  appendRow(join(dir(root), 'decisions.tsv'), ['ts', 'item', 'phase', 'decision', 'why', 'evidence', 'result'], [
    item, phase, decision, why, evidence, result,
  ])
}

export function followup(root, { item, file, line, claim }) {
  appendRow(join(dir(root), 'followups.tsv'), ['ts', 'item', 'file', 'line', 'claim'], [item, file, line, claim])
}

export function transition(item, next) {
  if (!EDGES[item.state]?.includes(next)) throw new Error(`invalid transition ${item.id}: ${item.state} -> ${next}`)
  item.state = next
  return item
}

export function isTerminal(state) {
  return TERMINAL.has(state)
}

export function currentAttempt(item) {
  return item.attempts.at(-1) ?? null
}

export function isHard(item, roles) {
  return (
    item.difficulty === 'hard' ||
    roles.hardWhen.areas.includes(item.area) ||
    overlaps(item.allowedFiles, roles.hardWhen.sharedFiles) ||
    item.repeat === true ||
    item.bounces >= 1
  )
}

export function rung(item, roles) {
  return roles.ladder[item.area]?.[item.bounces] ?? null
}
