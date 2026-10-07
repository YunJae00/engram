import { isAbsolute, relative, sep } from 'node:path'
import type { AgentTool, TurnStep } from 'core'

type Finding = { status: 'pass' | 'fail' | 'unknown'; basis: string; refs?: string[] }
type Report = { checks: (Finding & { requirement: string })[]; grounding: Finding }
type Output = { name: string; path: string; hash?: string; after?: number; sheets?: string[] }
type Receipt = Record<string, unknown>
type Read = { step: TurnStep; position: number; value?: Receipt }

const TOOL = 'report_result_check'
const READS = /^(read_open_page|read_pages|look|verify|read_desktop|look_desktop|read_live_document|file_read|file_read_package|file_read_workbook|excel_read|word_read|ppt_read)$/
const CHANGES = /^(page_steps|press|press_key|press_point|type_text|choose|upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package)$/
const CREATES = /^(file_create_copy|file_create_workbook|file_edit_package)$/
// These are capture/recording evidence, not text deliverables. Their own
// provenance/approval checks remain responsible; this gate does not certify pixels.
const CAPTURE_MEDIA = /\.(png|mp4|webm)$/i
const HASH = /^[a-f0-9]{64}$/i
const object = (value: unknown): value is Receipt => !!value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown, max = 2000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max
const keys = (value: Receipt, required: string[], optional: string[]) => required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))

function finding(value: unknown, requirement = false): Finding & { requirement?: string } {
  const required = ['status', 'basis', ...(requirement ? ['requirement'] : [])]
  if (!object(value) || !keys(value, required, ['refs']) || !['pass', 'fail', 'unknown'].includes(String(value.status))
    || !nonempty(value.basis) || (requirement && !nonempty(value.requirement, 500))
    || (value.refs !== undefined && (!Array.isArray(value.refs) || value.refs.length > 40 || value.refs.some(ref => !nonempty(ref, 4096))))) {
    throw new Error(`Provide ${required.join(', ')} with a valid status and a nonempty basis.`)
  }
  return value as Finding & { requirement?: string }
}

function report(value: unknown): Report {
  if (!object(value) || !keys(value, ['checks', 'grounding'], []) || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 32) {
    throw new Error('Provide 1 to 32 requirement checks and a separate grounding finding.')
  }
  value.checks.forEach(check => finding(check, true))
  finding(value.grounding)
  return value as Report
}

const text = { type: 'string', minLength: 1, maxLength: 2000 }
const properties = {
  status: { type: 'string', enum: ['pass', 'fail', 'unknown'] }, basis: text,
  refs: { type: 'array', maxItems: 40, items: { ...text, maxLength: 4096 } },
}

export function resultCheckTool(config?: { outputs: { name: string; path: string }[]; sources: string[]; requireSourceEvidence?: boolean; generatedDirectory?: string }): AgentTool {
  return {
    name: TOOL,
    description: 'Report the result check after checking every requested outcome and final artifact. Derive acceptance checks only from the original requested outcomes and constraints, plus correctness or safety conditions necessary to satisfy them. Do not promote optional inspection methods or extra workflows into new requirements; report unperformed scope limitations separately. Keep each basis concise: name the observed fact and how it satisfies or fails the requirement. grounding separately checks that material claims match the sources or are explicitly labeled assumptions, proposals or unverified. refs are optional notes. The host checks the evidence itself from this turn: each final text file must be reopened in full after its last write (a workbook: every sheet), and claims need a real source (an attachment or a read of an original page or file, not a generated output). PNG/MP4/WebM captures are outside this check: do not retake, upload or claim visual verification for them. Report fail or unknown honestly. If validation.accepted is false, fix only the listed issues and resubmit in the SAME TURN. Do not change anything after an accepted report. Then give a concise user-facing answer with only final artifact links; do not print the report JSON.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['checks', 'grounding'], properties: {
      checks: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false,
        required: ['requirement', 'status', 'basis'], properties: { requirement: { ...text, maxLength: 500 }, ...properties } } },
      grounding: { type: 'object', additionalProperties: false, required: ['status', 'basis'], properties },
    } },
    async run(args, context) {
      context.signal?.throwIfAborted()
      const resultCheck = report(args)
      const observation = JSON.stringify({ resultCheck })
      if (!config) return observation
      const validation = checkResult([...(context.steps ?? []), { tool: TOOL, args, observation }], config.outputs, config.sources, config.requireSourceEvidence, config.generatedDirectory)
      return JSON.stringify({ resultCheck, validation })
    },
  }
}

function receipt(step: TurnStep): Receipt | undefined {
  try { const value: unknown = JSON.parse(step.observation); return object(value) ? value : undefined }
  catch { return undefined }
}

function badReceipt(value: Receipt, allowTruncated = false): boolean {
  return !!value.error || value.ok === false || !!value.refused || value.later === true || !!value.wall
    || (!allowTruncated && value.truncated === true) || value.partial === true || value.completeReadback === false
    || value.reobserveRequired === true || value.observationMayBeStale === true
    || (object(value.tableValidation) && value.tableValidation.valid === false)
    || (object(value.verification) && value.verification.status !== undefined && value.verification.status !== 'passed')
}

function textChunk(read: Read, part?: string): { offset: number; end: number; total: number } | undefined {
  const { step, value } = read
  if (step.seeded || step.tool !== (part ? 'file_read_package' : 'file_read') || !value || badReceipt(value, true) || typeof value.path !== 'string'
    || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) return
  const content = part ? value.xml : value.content
  if (typeof content !== 'string' || part && value.part !== part) return
  const offset = value.offset ?? 0
  const total = value.characters ?? (value.truncated === true ? undefined : content.length)
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(total) || (total as number) < 0) return
  const end = (offset as number) + content.length
  if (end > (total as number) || end < (total as number) && (value.truncated !== true || value.nextOffset !== end)
    || end === total && (value.truncated === true || value.nextOffset !== undefined && value.nextOffset !== null)) return
  return { offset: offset as number, end, total: total as number }
}

// Pages at one revision, read after `after`, that together cover the whole file.
function textCoverage(reads: Read[], path: string, hash?: string, after = -1, part?: string): { hash: string } | undefined {
  const current = reads.filter(read => read.position > after && read.step.tool === (part ? 'file_read_package' : 'file_read') && !read.step.seeded && read.value?.path === path && (!part || read.value.part === part))
  const revision = hash ?? current.at(-1)?.value?.sha256
  if (typeof revision !== 'string' || !HASH.test(revision)) return
  const chunks = current.filter(read => read.value?.sha256 === revision).flatMap(read => { const chunk = textChunk(read, part); return chunk ? [chunk] : [] })
  if (!chunks.length || chunks.some(chunk => chunk.total !== chunks[0]!.total)) return
  let cursor = 0
  for (const chunk of [...chunks].sort((a, b) => a.offset - b.offset)) {
    if (chunk.offset > cursor) return
    cursor = Math.max(cursor, chunk.end)
  }
  return cursor === chunks[0]!.total ? { hash: revision } : undefined
}

function packageCoverage(reads: Read[], path: string, hash?: string, after = -1): boolean {
  const current = reads.filter(read => read.position > after && !read.step.seeded && read.step.tool === 'file_read_package' && read.value?.path === path)
  const revision = hash ?? current.at(-1)?.value?.sha256
  if (typeof revision !== 'string' || !HASH.test(revision)) return false
  const receipt = current.filter(read => read.value?.sha256 === revision && !badReceipt(read.value, true)).at(-1)?.value
  const parts = receipt?.textParts
  return Array.isArray(parts) && parts.length > 0 && parts.length <= 2000
    && parts.every(part => typeof part === 'string' && part.length > 0 && !!textCoverage(current, path, revision, after, part))
}

function readable(step: TurnStep): boolean {
  if (step.seeded || !READS.test(step.tool) || !step.observation.trim()) return false
  const value = receipt(step)
  if (value && badReceipt(value)) return false
  if (step.tool.startsWith('file_')) return !!value && typeof value.path === 'string' && typeof value.sha256 === 'string'
    && HASH.test(value.sha256) && (value.offset === undefined || value.offset === 0)
    && (value.nextOffset === undefined || value.nextOffset === null)
    && (typeof value.content === 'string' || typeof value.xml === 'string' || Array.isArray(value.parts) || Array.isArray(value.rows))
  if (step.tool === 'verify') return !!value && object(value.verification) && value.verification.status === 'passed'
  if (step.tool === 'read_pages') return /^Batch read:/.test(step.observation) && !/\[Page extract truncated;/.test(step.observation)
  return !/that did not work:|could not|no longer matches|was not found|has not exposed readable content|extract is incomplete|A dialog is open|\[Page extract truncated;|This model reads text only/i.test(step.observation)
}

function fullOutputRead(step: TurnStep, output: Output): boolean {
  const value = receipt(step)
  if (!value || !readable(step) || value.path !== output.path || (output.hash && value.sha256 !== output.hash)) return false
  if (step.tool === 'file_read') return false
  // Explicit full readback is accepted; a package manifest or selected range is not whole-file proof.
  return value.completeReadback === true && step.args.range === undefined
}

export function latestResultOutputs(steps: TurnStep[], outputs: { name: string; path: string }[]): Output[] {
  const latest = new Map<string, Output>(outputs.map(output => [output.name, output]))
  for (const [position, step] of steps.entries()) {
    if (step.seeded || !CREATES.test(step.tool)) continue
    const value = receipt(step)
    if (!value || value.error || value.ok === false || typeof value.path !== 'string' || typeof value.sha256 !== 'string' || !HASH.test(value.sha256) || typeof step.args.name !== 'string') continue
    const sheets = Array.isArray(value.sheets) ? value.sheets.flatMap(sheet => object(sheet) && typeof sheet.sheet === 'string' ? [sheet.sheet] : []) : undefined
    latest.set(step.args.name, { name: step.args.name, path: value.path, hash: value.sha256, after: position, ...(sheets?.length ? { sheets } : {}) })
  }
  return [...latest.values()]
}

// The host decides from what it observed this turn; the model's report adds
// only its own verdicts, and a fail or unknown there stays unresolved.
export function checkResult(steps: TurnStep[], outputs: { name: string; path: string }[], sources: string[], requireSourceEvidence = false, generatedDirectory?: string): { accepted: boolean; issues: string[] } {
  const issues: string[] = []
  const index = steps.map(step => step.tool === TOOL && !step.seeded).lastIndexOf(true)
  if (index < 0) issues.push('The requirement and source-grounding verdict is missing. Check the actual results and call report_result_check; reading alone does not confirm the request was satisfied.')
  if (index >= 0) {
    const result = receipt(steps[index]!)
    try {
      if (!result || badReceipt(result) || !Object.hasOwn(result, 'resultCheck')) throw new Error('No successful result-check receipt.')
      const checked = report(result.resultCheck)
      for (const item of [...checked.checks, { ...checked.grounding, requirement: 'Source grounding' }]) {
        if (item.status !== 'pass') issues.push(`${item.requirement}: ${item.status} — ${item.basis}`)
      }
    } catch (error) {
      issues.push(`Result-check report is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (steps.slice(index + 1).some(step => !step.seeded && CHANGES.test(step.tool))) issues.push('The result changed after report_result_check. Reread the affected result and submit a new report.')
  }

  const latest = latestResultOutputs(steps, outputs)
  const outputPaths = new Set(latest.map(output => output.path))
  const generated = (path: string): boolean => {
    if (outputPaths.has(path)) return true
    if (!generatedDirectory) return false
    const location = relative(generatedDirectory, path)
    return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location)
  }
  const reads: Read[] = (index < 0 ? steps : steps.slice(0, index)).map((step, position) => ({ step, position, value: receipt(step) }))
  const invalidSources = new Set(reads.flatMap(({ step, value }) =>
    !step.seeded && step.tool === 'file_read' && value && object(value.tableValidation) && value.tableValidation.valid === false && typeof value.path === 'string' ? [value.path] : []))
  const observedSource = ({ step, value }: Read): boolean => {
    const path = value?.path
    if (typeof path === 'string' && generated(path)) return false
    if (step.tool === 'file_read_package') return typeof path === 'string' && packageCoverage(reads, path)
    if (step.tool !== 'file_read') return readable(step)
    return typeof path === 'string' && !invalidSources.has(path) && textCoverage(reads, path)?.hash === value?.sha256
  }
  if ((requireSourceEvidence || sources.length) && !sources.some(path => !invalidSources.has(path) && !generated(path)) && !reads.some(observedSource)) {
    issues.push('No usable source evidence. Read an original attachment, page or file (not a generated output) and compare the material claims with it.')
  }

  for (const output of latest) {
    if (CAPTURE_MEDIA.test(output.name)) continue
    const hash = output.hash ?? reads.filter(read => !read.step.seeded && read.value?.path === output.path).at(-1)?.value?.sha256
    const expected = { ...output, ...(typeof hash === 'string' ? { hash } : {}) }
    const fullReads = reads.filter(({ step, position }) => position > (output.after ?? -1) && fullOutputRead(step, expected))
    const sheetNames = new Set(output.sheets)
    for (const read of fullReads) if (Array.isArray(read.value?.sheetNames)) {
      for (const name of read.value.sheetNames) if (typeof name === 'string') sheetNames.add(name)
    }
    const workbook = /\.xlsx$/i.test(output.name)
    const sheetsCovered = !workbook || sheetNames.size > 0 && [...sheetNames].every(sheet => fullReads.some(read => read.value?.sheet === sheet))
    const textCovered = !workbook && (!!textCoverage(reads, output.path, expected.hash, output.after) || packageCoverage(reads, output.path, expected.hash, output.after))
    if (!textCovered && (!fullReads.length || !sheetsCovered)) {
      issues.push(`Reread every final part of ${output.name} (${output.path}) after its last write: the whole text at one revision, every sheet of a workbook, or every listed textParts entry of a document package.`)
    }
    if (reads.some(({ step, value }) => !step.seeded && step.tool === 'file_read' && value?.path === output.path && object(value.tableValidation) && value.tableValidation.valid === false)) {
      issues.push(`${output.name}: table structure is invalid. Correct its rows/quoting, then create and fully read a valid final copy.`)
    }
  }
  return { accepted: issues.length === 0, issues: [...new Set(issues)] }
}
