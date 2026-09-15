import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, chmod, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, dialog } from 'electron'
import { fromJSONSchema } from 'zod'
import { addRoutine, appendBotTurn, callMemoryTool, cometTools, createBot, listRoutines, MEMORY_MCP_TOOLS, officeArithmeticFault, officeWriteUnverified, routineTask, routineTaskPrompt, type AgentLoopStep, type AgentTool } from 'core'
import { agentCourier } from './agent-courier.js'
import { resetLane } from './agent-browser.js'
import { officeAgentTools } from './office-agent.js'
import { clearApplicationWork } from './application-work.js'
import { cometFileTools } from './file-work.js'
import { loadSettings } from './settings.js'
import { broadcast } from './engine-health.js'
import type { VaultContext } from './vault.js'

let server: Server | undefined
let context: VaultContext | undefined
let enabled = false
// ponytail: one external operation at a time; use per-resource leases if parallel external work becomes necessary.
let busy = false
let switching: Promise<unknown> = Promise.resolve()
const sockets = new Set<Socket>()
const authenticatedSockets = new Set<Socket>()
const lanes = new Map<string, Socket>()
const controllers = new Set<AbortController>()
export const externalInfoPath = () => join(app.getPath('userData'), 'external-connection.json')
export const externalStatus = () => ({ enabled, active: controllers.size > 0, connected: authenticatedSockets.size })
export const externalOwns = (lane: string) => lanes.has(lane)
export function stopExternalLane(lane: string): void { lanes.get(lane)?.destroy() }
export function setExternalContext(next: VaultContext): void {
  if (context && context.paths.root !== next.paths.root) stopExternalCalls()
  context = next
}
export function stopExternalCalls(): void {
  for (const controller of controllers) controller.abort()
  for (const socket of sockets) socket.destroy()
}

const objectSchema = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const BEGIN = { name: 'engram_begin', description: 'Start an Engram task. The person approves the exact goal before any data or controls are available. A visible conversation records the session.', inputSchema: objectSchema({ goal: { type: 'string', maxLength: 4000 } }, ['goal']) }
const FINISH = { name: 'engram_finish', description: 'Check document readback and supported arithmetic, then record a result. This does not prove task or visual correctness; state unverified parts explicitly.', inputSchema: objectSchema({ summary: { type: 'string', maxLength: 8000 } }, ['summary']) }
const ROUTINE = { name: 'engram_routine', description: 'Read a saved routine and its starting URLs, method and checks. Returns instructions, not an executed result. Perform the steps with Engram tools.', inputSchema: objectSchema({ id: { type: 'string', maxLength: 200 } }, ['id']) }
const KEEP = { name: 'engram_keep', description: 'After engram_finish, ask the person to confirm the result was successful and save its goal, starting URLs and method as a routine. Never save incomplete work as a success.', inputSchema: objectSchema({ name: { type: 'string', minLength: 1, maxLength: 100 } }, ['name']) }

function availableTools(ctx: VaultContext, lane: string, office: boolean): AgentTool[] {
  return [
    ...cometTools({ paths: ctx.paths, skillNotes: () => ctx.store.getAll(), retrieve: async () => [], courier: agentCourier({ lane, awaitCompletion: true }) }).filter(tool => !['search_memory', 'run_procedure', 'ask_person'].includes(tool.name)),
    ...cometFileTools(ctx.paths, lane), ...(office ? officeAgentTools(lane) : []),
  ]
}

async function approve(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const detail = JSON.stringify(args, null, 2)
  if (detail.length > 16000) throw new Error('Request is too large to review. Split it into smaller operations.')
  const answer = await dialog.showMessageBox({ type: 'question', title: 'External AI request', message: name === KEEP.name ? 'Was this task completed correctly? Save it as a routine?' : `Allow ${name}?`, detail: `An external client requests this operation. Returned data will be sent to that client and may reach its AI provider. Only this operation is approved.\n\n${detail}`, buttons: ['Deny', name === KEEP.name ? 'Confirm and save' : 'Allow once'], defaultId: 0, cancelId: 0, signal })
  signal.throwIfAborted()
  if (answer.response !== 1) throw new Error('The person declined. Stop and explain what remains undone.')
}

export function setExternalEnabled(value: boolean): Promise<ReturnType<typeof externalStatus>> {
  const next = switching.then(() => changeEnabled(value))
  switching = next.catch(() => undefined)
  return next
}
async function changeEnabled(value: boolean): Promise<ReturnType<typeof externalStatus>> {
  if (value === enabled) return externalStatus()
  if (!value) {
    enabled = false
    stopExternalCalls()
    server?.close(); server = undefined
    await rm(externalInfoPath(), { force: true })
    return externalStatus()
  }
  const folder = join(app.getPath('userData'), 'external')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const socketFolder = process.platform === 'win32' ? undefined : await mkdtemp(join(tmpdir(), 'engram-'))
  if (socketFolder) await chmod(socketFolder, 0o700)
  const pipe = socketFolder ? join(socketFolder, 'bridge.sock') : `\\\\.\\pipe\\engram-${randomUUID()}`
  const token = randomBytes(32).toString('hex')
  const settings = await loadSettings()
  const listener = createServer(socket => {
    socket.setEncoding('utf8')
    sockets.add(socket)
    let buffer = ''
    let authenticated = false
    let running: AbortController | undefined
    let goal = '', lane = '', botId = ''
    let checkedSummary = ''
    let finished = false
    const steps: AgentLoopStep[] = []
    const bound = context
    let tools = bound ? availableTools(bound, `external-${randomUUID()}`, settings.computerUse === true) : []
    const seen = new Set<string>()
    let currentId = ''
    const send = (id: string, result?: unknown, error?: string) => { if (!socket.destroyed) socket.write(JSON.stringify({ id, result, error }) + '\n') }
    socket.setTimeout(15 * 60_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      running?.abort(); sockets.delete(socket); authenticatedSockets.delete(socket)
      if (lanes.get(lane) === socket) { lanes.delete(lane); clearApplicationWork(lane); void resetLane(lane).catch(() => {}) }
    })
    const handle = async (message: Record<string, unknown>) => {
      const id = typeof message.id === 'string' ? message.id : ''
      if (!id || id.length > 100) { socket.destroy(); return }
      const received = typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0)
      if (received.length !== token.length || !timingSafeEqual(received, Buffer.from(token))) { socket.destroy(); return }
      authenticated = true
      authenticatedSockets.add(socket)
      if (message.method === 'cancel') { if (id === currentId) running?.abort(); return }
      if (!enabled || !bound || bound !== context) { send(id, undefined, 'Open a workspace in Engram and reconnect.'); return }
      if (running || busy) { send(id, undefined, 'Another external operation is running. Wait for its result.'); return }
      if (seen.has(id)) { send(id, undefined, 'Duplicate request id. Inspect the prior result; do not replay an operation.'); return }
      if (seen.size >= 1000) { send(id, undefined, 'Session limit reached. Finish and reconnect.'); return }
      seen.add(id); currentId = id
      const controller = new AbortController()
      running = controller; controllers.add(controller); busy = true
      const signal = controller.signal
      let action = ''
      let dispatched = false
      try {
        if (message.method === 'tools') { send(id, [BEGIN, FINISH, ROUTINE, KEEP, ...MEMORY_MCP_TOOLS, ...tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.argsSchema }))]); return }
        if (message.method !== 'call') throw new Error('Unknown operation')
        const params = message.params as Record<string, unknown> | undefined
        const name = params?.name
        const args = params?.args
        if (typeof name !== 'string' || name.length > 100 || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool request')
        action = name
        const input = args as Record<string, unknown>
        if (name === 'engram_begin') {
          if (goal && !finished) throw new Error('A task is already active. Finish it or reconnect for a new task.')
          if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 4000) throw new Error('Provide a goal of 1–4000 characters.')
          await approve(name, input, signal)
          const bot = await createBot(bound.paths, { name: input.goal.slice(0, 80) })
          goal = input.goal; botId = bot.id; lane = `bot-${bot.id}`
          finished = false; checkedSummary = ''; steps.length = 0; lanes.set(lane, socket)
          await appendBotTurn(bound.paths, bot.id, { role: 'user', text: goal, at: new Date().toISOString() })
          const currentSettings = await loadSettings()
          tools = availableTools(bound, lane, currentSettings.computerUse === true)
          broadcast({ type: 'bots:changed' })
          send(id, { content: [{ type: 'text', text: 'Task approved. Refresh tools/list for available browser, file and Office tools. Each data access or operation still needs approval. Use engram_finish to check and report the result.' }] }); return
        }
        if (!goal) throw new Error('Call engram_begin with the exact user goal first.')
        if (finished && name !== KEEP.name) throw new Error('This task is finished. Call engram_begin with the next user goal before using tools again.')
        const tool = tools.find(item => item.name === name)
        if (tool && steps.length >= 200) throw new Error('This session reached its operation limit. Finish with the confirmed results and remaining work.')
        if (!tool && !MEMORY_MCP_TOOLS.some(item => item.name === name) && ![FINISH.name, ROUTINE.name, KEEP.name].includes(name)) throw new Error('Unknown or unavailable tool')
        const schema = tool?.argsSchema ?? [...MEMORY_MCP_TOOLS, FINISH, ROUTINE, KEEP].find(item => item.name === name)!.inputSchema
        const checked = fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0]).safeParse(input)
        if (!checked.success) throw new Error(`Invalid tool arguments: ${checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 800)}`)
        if (tool && /^(excel_|word_|ppt_)/.test(name) && (await loadSettings()).computerUse !== true) throw new Error('Computer use was disabled. Enable it before requesting Office operations.')
        if (name === KEEP.name && (!finished || !checkedSummary || !steps.length)) throw new Error('Finish and verify a task before saving a routine.')
        await approve(name, name === KEEP.name ? { ...input, goal, result: checkedSummary } : input, signal)
        await appendFile(join(folder, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), bot: botId, tool: name, state: 'approved' }) + '\n', { mode: 0o600 })
        signal.throwIfAborted()
        dispatched = true
        let text: string
        let image: { data: string; mimeType: string } | undefined
        if (name === FINISH.name) {
          if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 8000) throw new Error('Provide a concise summary and any unverified parts.')
          clearApplicationWork(lane)
          const fault = officeWriteUnverified(steps) ?? officeArithmeticFault(steps)
          checkedSummary = fault ? '' : input.summary
          text = `${fault ? `Not verified as complete. ${fault}` : 'Automated document checks found no outstanding fault. Task and visual correctness remain the caller’s responsibility.'}\n\n${input.summary}`
          await appendBotTurn(bound.paths, botId, { role: 'assistant', text, at: new Date().toISOString() })
          if (!fault) { finished = true; lanes.delete(lane) }
          broadcast({ type: 'bots:changed' })
        } else if (name === KEEP.name) {
          const routine = await addRoutine(bound.paths, { name: String(input.name), steps: [], task: routineTask(goal, steps) })
          checkedSummary = ''
          text = `Saved routine ${routine.id}. Reuse it by reading engram_routine; always verify fresh results.`
          broadcast({ type: 'bots:changed' }); broadcast({ type: 'vault:changed' })
        } else if (name === ROUTINE.name) {
          const routine = (await listRoutines(bound.paths)).find(item => item.id === input.id)
          if (!routine) throw new Error('Routine not found')
          text = routine.task ? routineTaskPrompt(routine) : `Observe and adapt these recorded steps. They are instructions, not a completed result:\n${JSON.stringify(routine.steps)}`
        } else if (tool) {
          checkedSummary = ''
          const callContext = { task: goal, signal, read: steps.map(step => step.observation).join('\n').slice(-40000) }
          const result: { text: string; image?: { data: string; mimeType: string } } = await (tool.runRich ? tool.runRich(input, callContext) : tool.run(input, callContext).then(text => ({ text }))).catch(error => {
            steps.push({ tool: name, args: input, observation: JSON.stringify({ error: 'The operation did not return a receipt. Its effects are unknown; inspect before retrying.' }) })
            throw error
          })
          text = result.text; image = result.image
          steps.push({ tool: name, args: input, observation: text })
        } else text = await callMemoryTool({ vaultRoot: bound.paths.root }, name, input)
        signal.throwIfAborted()
        await appendFile(join(folder, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), bot: botId, tool: name, state: 'returned' }) + '\n', { mode: 0o600 })
        send(id, { content: [{ type: 'text', text }, ...(image ? [{ type: 'image', ...image }] : [])] })
      } catch (error) {
        if (action) await appendFile(join(folder, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), bot: botId, tool: action, state: signal.aborted ? 'canceled' : dispatched ? 'uncertain' : 'not-executed' }) + '\n', { mode: 0o600 }).catch(() => {})
        send(id, undefined, signal.aborted ? 'Stopped. An already delivered operation may have taken effect; inspect before retrying.' : `${dispatched ? 'An operation may have taken effect. Inspect before retrying. ' : ''}${String((error as Error).message ?? error)}`)
      }
      finally { controllers.delete(controller); running = undefined; busy = false }
    }
    const authTimeout = setTimeout(() => { if (!authenticated) socket.destroy() }, 5000)
    authTimeout.unref()
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 1_000_000) { socket.destroy(); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try { const value = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request'); void handle(value) } catch { socket.destroy(); return }
      }
    })
  })
  if (socketFolder) listener.once('close', () => { void rmdir(socketFolder).catch(() => {}) })
  try {
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(pipe, () => { listener.removeListener('error', reject); resolve() }) })
  } catch (error) { if (socketFolder) await rmdir(socketFolder).catch(() => {}); throw error }
  listener.on('error', () => { void setExternalEnabled(false) })
  try {
    if (process.platform !== 'win32') await chmod(pipe, 0o600)
    await writeFile(externalInfoPath(), JSON.stringify({ pipe, token }), { mode: 0o600 })
  } catch (error) { listener.close(); throw error }
  server = listener; enabled = true
  return externalStatus()
}
