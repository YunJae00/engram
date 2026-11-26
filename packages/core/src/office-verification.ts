import { posix, win32 } from 'node:path'
import type { AgentLoopResult, AgentLoopStep } from './agent-loop.js'
import { officeArithmeticFault } from './office-arithmetic.js'
import { evidenceFault } from './work-evidence.js'

const WRITES = new Set(['excel_write', 'ppt_build', 'ppt_edit', 'word_write', 'word_edit'])
const READS = new Set(['excel_read', 'ppt_read', 'word_read'])
export const OFFICE_CLOSED = 'Nothing was changed: the application is not open and is not started for this.'
const BUILD_REFUSED = 'The deck does not read clean yet'
export const NOTHING_BUILT = 'Nothing was built'
const REFUSED_BEFORE_WRITE = /^(?:that did not work:\s*)?Nothing was built\b/
export const DOCUMENT_CHECK_RULE = 'After writing, read the changed document back and compare it with the request before reporting completion. Check every changed range or document. Text readback does not verify formulas, unsupported objects or visual layout: inspect those only when the request is about them, and never mention a check nobody asked for. A new file from word_write, ppt_build or file_create_workbook is saved and compared by the host itself and its receipt is that readback: answer with its link at once, and read it again only when the person asked for the content to be checked.'

function receipt(step: AgentLoopStep): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(step.observation)
    if (value && typeof value === 'object' && !Array.isArray(value) && !value.error && value.truncated !== true && value.reobserveRequired !== true && value.observationMayBeStale !== true) return value
  } catch {}
  return undefined
}

function identity(tool: string, result: Record<string, unknown>): string | undefined {
  const app = tool.split('_')[0]
  if (app === 'excel') return typeof result['workbook'] === 'string' && typeof result['sheet'] === 'string'
    ? JSON.stringify([app, result['workbook'].toLowerCase(), result['sheet'].toLowerCase()]) : undefined
  const path = result['file'] ?? result['saved']
  if (typeof path === 'string' && posix.isAbsolute(path)) return `${app}:${posix.normalize(path)}`
  return typeof path === 'string' && win32.isAbsolute(path) ? `${app}:${win32.normalize(path).toLowerCase()}` : undefined
}

function cells(range: unknown): string[] {
  if (typeof range === 'string') range = range.trim()
  if (typeof range !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,6}(:[A-Z]{1,3}[1-9]\d{0,6})?$/i.test(range)) return []
  const ends = range.toUpperCase().split(':').map(part => {
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(part)!
    return [Number(row), [...letters!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)] as const
  })
  const [a, b = a!] = ends
  if ((Math.abs(a![0] - b[0]) + 1) * (Math.abs(a![1] - b[1]) + 1) > 4000) return []
  const result: string[] = []
  for (let row = Math.min(a![0], b[0]); row <= Math.max(a![0], b[0]); row++)
    for (let col = Math.min(a![1], b[1]); col <= Math.max(a![1], b[1]); col++) result.push(`${row}:${col}`)
  return result
}

export function officeReadEvidence(step: AgentLoopStep): boolean {
  if (!READS.has(step.tool)) return false
  const result = receipt(step)
  if (!result || !identity(step.tool, result)) return false
  if (step.tool !== 'excel_read') return typeof result['revision'] === 'string' && /^[a-f0-9]{32}$/.test(result['revision']) && Array.isArray(result['content'])
  const covered = cells(result['range'])
  const rows = result['rows']
  return covered.length > 0 && Array.isArray(rows) && rows.every(Array.isArray) && rows.reduce((n, row) => n + row.length, 0) === covered.length
}

export function officeWriteUnverified(steps: AgentLoopStep[]): string | undefined {
  const pending = new Map<string, Set<string>>()
  const unknown: { tool: string; file?: string }[] = []
  const named = (step: AgentLoopStep, result?: Record<string, unknown>): string[] =>
    [result?.['path'], step.args['saveAs']].filter((one): one is string => typeof one === 'string' && !!one.trim()).map(one => one.trim().normalize('NFC').toLowerCase())
  for (const step of steps) {
    if (!WRITES.has(step.tool) && !READS.has(step.tool)) continue
    const result = receipt(step)
    const key = result && identity(step.tool, result)
    if (WRITES.has(step.tool)) {
      if (result?.['completeReadback'] === true && typeof result['artifact'] === 'string') {
        const file = named(step, result)[0]
        const stem = (one: string): string => one.replaceAll('\\', '/').replace(/^.*\//, '').replace(/\.[^.]+$/, '')
        const same = (one: string): boolean => one === file || ((!/[\\/]/.test(one) || !/[\\/]/.test(file!)) && stem(one) === stem(file!))
        for (let at = unknown.length - 1; at >= 0; at--) if (file && unknown[at]!.tool === step.tool && unknown[at]!.file && same(unknown[at]!.file!)) unknown.splice(at, 1)
        continue
      }
      if (step.observation.includes(OFFICE_CLOSED)) continue
      if (step.observation.startsWith(BUILD_REFUSED) || REFUSED_BEFORE_WRITE.test(step.observation)) continue
      if (!key) { const file = named(step, result)[0]; unknown.push({ tool: step.tool, ...(file ? { file } : {}) }); continue }
      const needed = pending.get(key) ?? new Set<string>()
      if (step.tool === 'excel_write') {
        for (const [list, field] of [['cells', 'cell'], ['formats', 'range'], ['charts', 'data']] as const) {
          const entries = step.args[list]
          if (Array.isArray(entries)) for (const entry of entries) for (const cell of cells(entry?.[field])) needed.add(cell)
        }
      }
      pending.set(key, needed)
    } else if (key && result && officeReadEvidence(step)) {
      if (step.tool === 'excel_read' && Array.isArray(result['rows'])) {
        const needed = pending.get(key)
        const covered = cells(result['range'])
        if (needed && covered.length) {
          for (const cell of covered) needed.delete(cell)
          if (!needed.size) pending.delete(key)
        }
      } else if (step.tool !== 'excel_read' && typeof result['revision'] === 'string' && /^[a-f0-9]{32}$/.test(result['revision']) && Array.isArray(result['content'])) pending.delete(key)
    }
  }
  return unknown.length || pending.size ? 'An Office write has no successful read back of all changed targets. Report incomplete or unverified work; text readback alone does not verify visual layout.' : undefined
}

export function checkOfficeResult(result: AgentLoopResult): AgentLoopResult {
  if (result.asked || result.incomplete) return result
  const incomplete = evidenceFault(result.steps) ?? officeWriteUnverified(result.steps) ?? officeArithmeticFault(result.steps)
  return incomplete ? { ...result, incomplete } : result
}
