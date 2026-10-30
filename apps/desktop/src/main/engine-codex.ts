import { modelCall } from './model-call-metrics.js'
import { availableMemory } from './available-memory.js'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logSessionTools } from './session-diagnostics.js'
import { askInTurn } from './voice-line.js'
import { ENGINE_BUDGETS, type EngineDetection, type EngineEvent, type EngineJobInput, type ToolSessionJob, type ToolSessionResult } from 'core'
import { cloudErrorKind, codexBinary, LOGIN_TIMEOUT_MS, runText, STATUS_TIMEOUT_MS, StatusCache, withHelpersOnPath, type CloudEngine, type CloudLoginOptions } from './engine-cloud.js'
import { CodexAccount } from './codex-account.js'
import { loadSettings } from './settings.js'
import { runCodexTurn } from './codex-turn.js'
import { accountEnvironment, activeAccountProfile } from './account-profiles.js'
import { hasBrainConnection, clearBrainConnection, codexProviderOverrides, loadBrainConnections, probeConnection } from './brain-connections.js'
import { startToolServer, type ToolServer } from './codex-tool-server.js'
import { CodexVoice } from './engine-codex-voice.js'
import { appServer, claimCodexWorkFolder, closeCodexSession as closeCodexNativeSession, closeCodexSessions as closeCodexNativeSessions, codexSpareCount, codexSpareFolders, runCodexNative, warmCodexSession } from './codex-native.js'


export const RUNTIME_TOOLS_OFF = [
  'apps', 'multi_agent', 'image_generation', 'shell_tool', 'unified_exec', 'plugins', 'remote_plugin', 'browser_use',
  'browser_use_external', 'computer_use', 'in_app_browser', 'goals', 'tool_suggest', 'skill_search',
  'skill_mcp_dependency_install', 'view_image', 'hooks', 'sleep_tool', 'workspace_dependencies',
  'multi_agent_v2', 'artifact', 'standalone_web_search', 'in_app_local_automation', 'worktrees',
  'code_mode', 'code_mode_only', 'shell_snapshot', 'shell_snapshot_v2', 'request_permissions_tool',
].map(feature => `features.${feature}=false`).concat('include_apply_patch_tool=false')
const TOOL_SERVER = 'engram_comet'
const TOOL_REACH = `Work only through the ${TOOL_SERVER} tools. The read-only sandbox applies to this runtime's own commands, not to those tools: they can read the approved files, save outputs and act in the browser and applications as their descriptions say.`
const TOKEN_ENV = 'ENGRAM_COMET_TOOL_TOKEN'
const NATIVE_KEEP = new Set(['shell_tool', 'unified_exec', 'shell_snapshot', 'shell_snapshot_v2'])
export const NATIVE_TOOLS_OFF = RUNTIME_TOOLS_OFF.filter(entry => entry !== 'include_apply_patch_tool=false' && !NATIVE_KEEP.has(entry.slice('features.'.length, -'=false'.length)))
  .concat('web_search="disabled"', 'notify=[]')
const NATIVE_REACH = `Engram's tools are the ${TOOL_SERVER} tools: use them for the web, notes, approvals and every deliverable. Your own shell and file edits work in the task folder; the sandbox keeps writes there and the network off.`

export function disableMcpOverrides(catalog: string, extra: Record<string, string> = {}): string[] {
  const servers: unknown = JSON.parse(catalog)
  if (!Array.isArray(servers)) throw new Error('Could not read the ChatGPT tool configuration.')
  const disabled = servers.filter(server => !Object.hasOwn(extra, server?.name)).map(server => {
    const key = typeof server?.transport?.url === 'string' ? 'url' : 'command'
    const transport = server?.transport?.[key]
    if (typeof server?.name !== 'string' || typeof transport !== 'string') throw new Error('Could not read the ChatGPT tool configuration.')
    return `${JSON.stringify(server.name)}={${key}=${JSON.stringify(transport)},enabled=false}`
  })
  return [`mcp_servers={${[...disabled, ...Object.entries(extra).map(([name, value]) => `${name}=${value}`)].join(',')}}`]
}

export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema)
  if (schema === null || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    out[key] = strictSchema(value)
  }
  if (out['type'] === 'object' || 'properties' in out) {
    const properties = (out['properties'] ?? {}) as Record<string, unknown>
    const required = new Set(Array.isArray(out['required']) ? out['required'] : [])
    out['properties'] = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key,
      required.has(key) || allowsNull(value) ? value : { anyOf: [value, { type: 'null' }] },
    ]))
    out['required'] = Object.keys(properties)
    out['additionalProperties'] = false
  }
  return out
}

function allowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return schema === true
  const node = schema as Record<string, unknown>
  return node['type'] === 'null' || (Array.isArray(node['type']) && node['type'].includes('null')) ||
    (Array.isArray(node['enum']) && node['enum'].includes(null)) || node['const'] === null ||
    (Array.isArray(node['anyOf']) && node['anyOf'].some(allowsNull))
}

export function restoreOptionalFields(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || value === null) return value
  const node = schema as Record<string, unknown>
  if (Array.isArray(value)) return value.map(item => restoreOptionalFields(item, node['items']))
  if (typeof value !== 'object') return value
  if (Array.isArray(node['anyOf'])) {
    const tool = (value as Record<string, unknown>)['tool']
    const branch = node['anyOf'].find(candidate => candidate?.properties?.tool?.enum?.includes(tool))
    if (branch) return restoreOptionalFields(value, branch)
  }
  const properties = (node['properties'] ?? {}) as Record<string, unknown>
  const required = new Set(Array.isArray(node['required']) ? node['required'] : [])
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    item !== null || !(key in properties) || required.has(key) || allowsNull(properties[key]),
  ).map(([key, item]) => [key, restoreOptionalFields(item, properties[key])]))
}

export function readLoginStatus(out: string, code: number | null): EngineDetection {
  if (code === null) return { installed: true, loggedIn: false, conclusive: false }
  if (/not logged in/i.test(out)) return { installed: true, loggedIn: false, conclusive: true }
  if (/logged in/i.test(out)) return { installed: true, loggedIn: true, conclusive: true }
  return { installed: true, loggedIn: false, conclusive: false }
}

export class CodexEngine implements CloudEngine {
  private get env(): NodeJS.ProcessEnv { return accountEnvironment('codex', this.accountProfile) }
  constructor(readonly accountProfile = activeAccountProfile('codex')) {}
  readonly id = 'codex' as const
  readonly label = 'ChatGPT'
  readonly desktopToolIsolation = true
  private readonly status = new StatusCache()
  forgetStatus(): void { this.status.forget() }

  async warmQuick(workdir: string): Promise<void> { await this.voiceFor(workdir) }
  async quick(prompt: string, options: { workdir: string; timeoutMs: number }): Promise<string> {
    const metric = modelCall('codex', prompt.length, 'low')
    try { return await askInTurn(() => this.voiceFor(options.workdir), prompt, options.timeoutMs) } finally { metric.end() }
  }
  private async voiceFor(workdir: string): Promise<CodexVoice | undefined> {
    await loadBrainConnections()
    const binary = codexBinary()
    if (!binary) return undefined
    const env = withHelpersOnPath(binary, this.env)
    const catalog = await mcpCatalog(binary, workdir, env, new AbortController().signal)
    const model = (await loadSettings()).codexModel.trim()
    const spec = { rpc: appServer(binary), env, config: [...disableMcpOverrides(catalog), ...RUNTIME_TOOLS_OFF, ...codexProviderOverrides(this.accountProfile)], cwd: workdir, ...(model ? { model } : {}) }
    if (!codexVoice || codexVoice.closed || codexVoice.spent || codexVoice.key !== JSON.stringify([spec.cwd, spec.model ?? '', spec.config])) { codexVoice?.close(); codexVoice = new CodexVoice(spec) }
    return codexVoice
  }
  confirmAuth(): void { this.status.set({ installed: true, loggedIn: true, conclusive: true }) }

  detect(): Promise<EngineDetection> {
    return this.status.read(async () => {
      const binary = codexBinary()
      if (!binary) return { installed: false, loggedIn: false, conclusive: true }
      await loadBrainConnections()
      if (hasBrainConnection('codex', this.accountProfile)) { const probe = await probeConnection('codex', undefined, this.accountProfile); return { installed: true, loggedIn: probe.ok, conclusive: probe.status !== 0 } }
      const { code, out } = await runText(binary, ['login', 'status'], STATUS_TIMEOUT_MS, withHelpersOnPath(binary, this.env))
      return readLoginStatus(out, code)
    })
  }

  async login(options?: CloudLoginOptions): Promise<{ ok: boolean; message?: string }> {
    const account = new CodexAccount(options?.signal ?? new AbortController().signal, LOGIN_TIMEOUT_MS, this.env)
    try {
      await account.login((url) => options?.onUrl?.(url))
      this.status.set({ installed: true, loggedIn: true, conclusive: true })
      return { ok: true }
    } finally { account.close() }
  }

  async logout(): Promise<void> {
    await loadBrainConnections()
    if (hasBrainConnection('codex', this.accountProfile)) { await clearBrainConnection('codex', this.accountProfile); this.status.forget(); return }
    const binary = codexBinary()
    if (binary) await runText(binary, ['logout'], STATUS_TIMEOUT_MS, withHelpersOnPath(binary, this.env))
    this.status.forget()
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    if (job.signal?.aborted) return
    await loadBrainConnections()
    const binary = codexBinary()
    if (!binary) {
      yield { type: 'error', message: 'the ChatGPT runtime is not part of this build', kind: 'crash' }
      return
    }
    const codexModel = (job.model ?? (await loadSettings()).codexModel).trim()
    const abort = new AbortController()
    const budget = job.timeoutMs ?? ENGINE_BUDGETS.job
    const timer = setTimeout(() => abort.abort(), budget)
    const onAbort = (): void => abort.abort()
    job.signal?.addEventListener('abort', onAbort, { once: true })
    const metric = modelCall('codex', job.prompt.length, job.effort ?? (job.modelHint === 'fast' ? 'low' : undefined))
    try {
      const env = withHelpersOnPath(binary, this.env)
      const catalog = { out: await mcpCatalog(binary, job.workdir, env, abort.signal) }
      const configOverrides = [...disableMcpOverrides(catalog.out), ...RUNTIME_TOOLS_OFF, ...codexProviderOverrides(this.accountProfile)]
      let text = await runCodexTurn({
        options: { codexPathOverride: binary, env, configOverrides },
        thread: {
        workingDirectory: job.workdir,
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        webSearchMode: 'disabled',
        networkAccessEnabled: false,
        ...(job.effort ? { modelReasoningEffort: job.effort } : job.modelHint === 'fast' ? { modelReasoningEffort: 'low' } : {}),
        ...(codexModel ? { model: codexModel } : {}),
        },
        input: job.imagePaths?.length ? [{ type: 'text' as const, text: job.prompt }, ...job.imagePaths.map(path => ({ type: 'local_image' as const, path }))] : job.prompt,
        ...(job.jsonSchema ? { outputSchema: strictSchema(job.jsonSchema) } : {}),
      }, abort.signal)
      if (job.jsonSchema) {
        try { text = JSON.stringify(restoreOptionalFields(JSON.parse(text), job.jsonSchema)) } catch { /* Keep malformed output for the existing parser to diagnose. */ }
      }
      yield { type: 'result', text }
    } catch (err) {
      if (job.signal?.aborted) return
      if (abort.signal.aborted) {
        yield { type: 'error', message: `timed out after ${budget}ms`, kind: 'timeout' }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      yield { type: 'error', message, kind: cloudErrorKind(message) }
    } finally {
      metric.end()
      clearTimeout(timer)
      job.signal?.removeEventListener('abort', onAbort)
    }
  }

  async warm(job: ToolSessionJob): Promise<void> {
    if (job.signal?.aborted || !job.native) return
    await loadBrainConnections()
    const binary = codexBinary()
    if (!binary) return
    const live = new Set(codexSpareFolders())
    for (const [cwd, server] of spareServers) if (!live.has(cwd)) { spareServers.delete(cwd); await server.close() }
    const target = Math.min(4, Math.max(1, Math.floor(availableMemory() / 1_500_000_000)))
    while (codexSpareCount() < target && !job.signal?.aborted) {
      const cwd = codexSpareCount() === 0 ? job.native.cwd : join(dirname(job.native.cwd), `spare-${randomUUID()}`)
      await mkdir(cwd, { recursive: true })
      const server = await startToolServer(job.tools, job.signal)
      spareServers.set(cwd, server)
      const env = { ...withHelpersOnPath(binary, this.env), [TOKEN_ENV]: server.token }
      try {
        const endpoint = `{url=${JSON.stringify(server.url)},bearer_token_env_var="${TOKEN_ENV}",tool_timeout_sec=900,default_tools_approval_mode="approve"}`
        const catalog = await mcpCatalog(binary, cwd, env, job.signal ?? new AbortController().signal)
        const codexModel = (job.model ?? (await loadSettings()).codexModel).trim()
        job.signal?.throwIfAborted()
        const warmed = await warmCodexSession({ rpc: appServer(binary), env,
          config: [...disableMcpOverrides(catalog, { [TOOL_SERVER]: endpoint }), ...NATIVE_TOOLS_OFF, ...codexProviderOverrides(this.accountProfile)],
          instructions: [job.system.replaceAll(job.native.cwd, cwd), NATIVE_REACH].join('\n\n'), ...(codexModel ? { model: codexModel } : {}),
        }, { ...job.native, cwd, readRoots: job.native.readRoots?.map(root => root === job.native!.cwd ? cwd : root) })
        if (!warmed) { spareServers.delete(cwd); await server.close(); break }
      } catch (error) { spareServers.delete(cwd); await server.close(); throw error }
    }
  }
  spareReady(): boolean { return codexSpareCount() >= Math.min(4, Math.max(1, Math.floor(availableMemory() / 1_500_000_000))) }
  claimWorkFolder(channel: string, fallback: string): string { return claimCodexWorkFolder(channel, fallback) }

  async runTools(job: ToolSessionJob): Promise<ToolSessionResult> {
    if (job.signal?.aborted) return { answer: '', error: 'canceled' }
    await loadBrainConnections()
    logSessionTools('codex', job)
    const binary = codexBinary()
    if (!binary) return { answer: '', error: 'the ChatGPT runtime is not part of this build' }
    const metric = modelCall('codex', job.prompt.length + job.system.length, job.effort, job.tools.length)
    const onToken = job.onToken
    job = { ...job, onToken: text => { metric.token(); onToken?.(text) } }
    const abort = new AbortController()
    const onAbort = (): void => abort.abort()
    job.signal?.addEventListener('abort', onAbort, { once: true })
    let server: ToolServer | undefined
    const pooled = job.native && job.sessionKey ? `${this.accountProfile}:${job.sessionKey}` : undefined
    try {
      server = pooled ? await toolServerFor(pooled, job.tools, job.native?.cwd) : await startToolServer(job.tools, abort.signal)
      const env = { ...withHelpersOnPath(binary, this.env), [TOKEN_ENV]: server.token }
      const catalog = { out: await mcpCatalog(binary, job.native?.cwd ?? job.workdir, env, abort.signal) }
      const endpoint = `{url=${JSON.stringify(server.url)},bearer_token_env_var="${TOKEN_ENV}",tool_timeout_sec=900,default_tools_approval_mode="approve"}`
      const codexModel = (job.model ?? (await loadSettings()).codexModel).trim()
      if (job.native) {
        const result = await runCodexNative({ ...job, sessionKey: pooled, native: job.native, signal: abort.signal }, {
          rpc: appServer(binary), env, config: [...disableMcpOverrides(catalog.out, { [TOOL_SERVER]: endpoint }), ...NATIVE_TOOLS_OFF, ...codexProviderOverrides(this.accountProfile)],
          instructions: [job.system, NATIVE_REACH].join('\n\n'), ...(codexModel ? { model: codexModel } : {}),
        })
        if (job.signal?.aborted) return { answer: '', error: 'canceled' }
        if (!result.commandsDenied) return result
      }
      const answer = await runCodexTurn({
        options: { codexPathOverride: binary, env, configOverrides: [...disableMcpOverrides(catalog.out, { [TOOL_SERVER]: endpoint }), ...RUNTIME_TOOLS_OFF, ...codexProviderOverrides(this.accountProfile)] },
        thread: {
          workingDirectory: job.workdir,
          sandboxMode: 'read-only',
          skipGitRepoCheck: true,
          approvalPolicy: 'never',
          webSearchMode: 'disabled',
          networkAccessEnabled: false,
          ...(job.effort ? { modelReasoningEffort: job.effort } : {}),
          ...(codexModel ? { model: codexModel } : {}),
        },
        input: [job.system, TOOL_REACH, job.opening, job.prompt].filter(Boolean).join('\n\n'),
      }, abort.signal)
      abort.signal.throwIfAborted()
      job.onToken?.(answer)
      return { answer }
    } catch (err) {
      if (job.signal?.aborted) return { answer: '', error: 'canceled' }
      return { answer: '', error: err instanceof Error ? err.message : String(err) }
    } finally {
      metric.end()
      job.signal?.removeEventListener('abort', onAbort)
      if (!pooled) await server?.close()
    }
  }
}

const CATALOG_MS = 10 * 60_000
const catalogs = new Map<string, { out: string; at: number }>()
const reading = new Map<string, Promise<string>>()
async function mcpCatalog(binary: string, cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
  const scope = /^(.*[\\/]\.engram[\\/]work)[\\/]/.exec(cwd)?.[1] ?? cwd
  const key = JSON.stringify([binary, scope, env['CODEX_HOME'] ?? env['HOME'] ?? env['USERPROFILE'] ?? ''])
  const held = catalogs.get(key)
  if (held && Date.now() - held.at < CATALOG_MS) return held.out
  const pending = reading.get(key) ?? (async () => {
    const catalog = await runText(binary, ['-C', cwd, 'mcp', 'list', '--json'], 60_000, env, { signal: new AbortController().signal })
    if (catalog.code !== 0) throw new Error('Could not read the ChatGPT tool configuration. Try again after checking the runtime.')
    for (const [stored, value] of catalogs) if (Date.now() - value.at >= CATALOG_MS) catalogs.delete(stored)
    catalogs.set(key, { out: catalog.out, at: Date.now() })
    return catalog.out
  })().finally(() => reading.delete(key))
  reading.set(key, pending)
  return new Promise<string>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) return stop()
    signal.addEventListener('abort', stop, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}
export function forgetCodexCatalog(): void { catalogs.clear() }

const SERVER_IDLE_MS = 60 * 60_000
const toolServers = new Map<string, { server: ToolServer; usedAt: number }>()
const spareServers = new Map<string, ToolServer>()
async function toolServerFor(key: string, tools: ToolSessionJob['tools'], cwd?: string): Promise<ToolServer> {
  const held = toolServers.get(key)
  if (held) { held.server.setTools(tools); held.usedAt = Date.now(); return held.server }
  const server = cwd && spareServers.get(cwd) || await startToolServer(tools)
  if (cwd) spareServers.delete(cwd)
  server.setTools(tools)
  toolServers.set(key, { server, usedAt: Date.now() })
  return server
}
let codexVoice: CodexVoice | undefined
export function closeCodexSessions(): void {
  closeCodexNativeSessions()
  codexVoice?.close()
  for (const held of toolServers.values()) void held.server.close()
  toolServers.clear()
  for (const server of spareServers.values()) void server.close()
  spareServers.clear()
}
export function closeCodexSession(key: string): void {
  closeCodexNativeSession(key)
  for (const [stored, held] of toolServers) if (stored === key || stored.endsWith(`:${key}`)) { toolServers.delete(stored); void held.server.close() }
}
setInterval(() => {
  for (const [key, held] of toolServers) if (Date.now() - held.usedAt > SERVER_IDLE_MS) { toolServers.delete(key); void held.server.close() }
}, 60_000).unref()
