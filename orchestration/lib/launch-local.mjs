import { spawn } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import process from 'node:process'

// The shell's default Node can be older than package.json engines, so prefer the newest nvm install.
function nodeBin() {
  const versions = join(process.env.NVM_DIR ?? join(homedir(), '.nvm'), 'versions', 'node')
  try {
    const newest = readdirSync(versions).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
    if (newest) return join(versions, newest, 'bin')
  } catch {
    return dirname(process.execPath)
  }
  return dirname(process.execPath)
}

export const NODE_BIN = nodeBin()

// nvm's layout is versions/node/<version>/bin. When that directory is absent, NODE_BIN is the running Node's directory.
export function withNodeOnPath(env = process.env) {
  const out = { ...env }
  const key = Object.keys(out).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = out[key]
  out[key] = current ? `${NODE_BIN}${delimiter}${current}` : NODE_BIN
  return out
}

function detached(cmd, args, { cwd, stdoutPath, stderrPath }) {
  const out = openSync(stdoutPath, 'a')
  const err = stderrPath === stdoutPath ? out : openSync(stderrPath, 'a')
  try {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ['ignore', out, err],
      env: withNodeOnPath(),
    })
    child.unref()
    return { pid: child.pid }
  } finally {
    closeSync(out)
    if (err !== out) closeSync(err)
  }
}

export function claudeLocalArgs({ prompt, schemaPath, addDirs = [], model } = {}) {
  const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json']
  if (model) args.push('--model', model)
  if (addDirs.length) args.push('--add-dir', ...addDirs)
  if (schemaPath) args.push('--json-schema', JSON.stringify(JSON.parse(readFileSync(schemaPath, 'utf8'))))
  return args
}

export function launchClaude({ cwd, prompt, logPath, outPath, schemaPath, addDirs = [], model }) {
  return detached('claude', claudeLocalArgs({ prompt, schemaPath, addDirs, model }), {
    cwd, stdoutPath: outPath, stderrPath: logPath,
  })
}

const CODEX_SCHEMA_DROP = new Set([
  '$schema', '$id', 'title', 'definitions', '$defs',
  'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'format',
])

// Codex structured output rejects draft-07 `$ref` / `pattern` that Claude's `--json-schema` accepts.
export function codexOutputSchema(schema) {
  const defs = { ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) }
  const walk = (node, stack) => {
    if (Array.isArray(node)) return node.map((entry) => walk(entry, stack))
    if (!node || typeof node !== 'object') return node
    if (typeof node.$ref === 'string') {
      const name = node.$ref.replace(/^#\/(?:definitions|\$defs)\//, '')
      if (!Object.hasOwn(defs, name)) throw new Error(`unsupported $ref ${node.$ref}`)
      if (stack.has(name)) throw new Error(`cyclic $ref ${node.$ref}`)
      stack.add(name)
      const resolved = walk(defs[name], stack)
      stack.delete(name)
      return resolved
    }
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      if (CODEX_SCHEMA_DROP.has(key)) continue
      out[key] = walk(value, stack)
    }
    // Strict structured output needs every property listed in `required`; optional fields come back empty.
    if (out.properties && Array.isArray(out.required)) out.required = Object.keys(out.properties)
    return out
  }
  return walk(schema, new Set())
}

export function materializeCodexSchema(schemaPath, destPath) {
  const flat = codexOutputSchema(JSON.parse(readFileSync(schemaPath, 'utf8')))
  writeFileSync(destPath, JSON.stringify(flat))
  return destPath
}

export function codexArgs({ cwd, prompt, sandbox, schemaPath, addDirs = [], model, outPath } = {}) {
  // A login shell sources nvm and puts the default Node (v22) ahead of NODE_BIN.
  const args = ['exec', '-C', cwd, '-s', sandbox, '-c', 'allow_login_shell=false', '--skip-git-repo-check', '--ephemeral']
  if (model) args.push('-m', model)
  for (const dir of addDirs) args.push('--add-dir', dir)
  if (schemaPath) args.push('--output-schema', schemaPath)
  args.push('-o', outPath, '--json', prompt)
  return args
}

export function launchCodex({ codexBin, cwd, prompt, logPath, outPath, sandbox, schemaPath, addDirs = [], model }) {
  const outputSchema = schemaPath ? materializeCodexSchema(schemaPath, `${outPath}.schema.json`) : undefined
  return detached(codexBin, codexArgs({ cwd, prompt, sandbox, schemaPath: outputSchema, addDirs, model, outPath }), {
    cwd, stdoutPath: logPath, stderrPath: logPath,
  })
}

const CLAUDE_USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']

export function parseClaudeTokens(text) {
  try {
    const usage = JSON.parse(text).usage
    if (!usage) return null
    const total = CLAUDE_USAGE_KEYS.reduce((sum, key) => sum + (usage[key] ?? 0), 0)
    return Number.isInteger(total) ? total : null
  } catch {
    return null
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export function parseCodexTokens(text) {
  let found = null
  for (const line of text.split('\n')) {
    const event = line.includes('"turn.completed"') ? parseLine(line) : null
    if (event?.type === 'turn.completed' && event.usage) found = (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0)
  }
  return found
}

export async function readTokens(kind, outPath) {
  const text = await readFile(outPath, 'utf8').catch(() => '')
  return kind === 'claude' ? parseClaudeTokens(text) : parseCodexTokens(text)
}
