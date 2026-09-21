import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ProcessClient } from './process-client.js'
import type { DevConsoleState } from '../shared/developers.js'

export class DevConsole {
  private readonly runs = new Map<string, { state: DevConsoleState; child: ProcessClient }>()
  constructor(private readonly logs: string) {}
  state(cwd: string): DevConsoleState | null { return this.runs.get(cwd)?.state ?? null }
  async run(cwd: string, command: string): Promise<DevConsoleState> {
    if (typeof command !== 'string' || !command.trim() || command.length > 20_000 || command.includes('\0')) throw new Error('Enter a command up to 20,000 characters.')
    if (this.state(cwd)?.running) throw new Error('Stop the current command first.')
    const state: DevConsoleState = { id: randomUUID(), command, cwd, output: '', running: true, truncated: false }
    const windows = process.platform === 'win32'
    const child = new ProcessClient(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; ${command}`] : ['-c', command], { cwd, killTree: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' } })
    this.runs.set(cwd, { state, child })
    const append = (text: string) => { state.truncated ||= state.output.length + text.length > 200_000; state.output = (state.output + text).slice(-200_000) }
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')]
    child.stdout.on('data', data => append(decoders[0]!.write(data)))
    child.stderr.on('data', data => append(decoders[1]!.write(data)))
    child.stdin.on('error', error => append(`\n${error.message}`))
    child.stdin.end()
    await new Promise<void>(resolve => {
      child.on('error', error => append(`\n${error.message}`))
      child.once('close', code => { append(decoders.map(decoder => decoder.end()).join('')); state.exitCode = code; state.running = false; resolve() })
    })
    await mkdir(this.logs, { recursive: true })
    const path = join(this.logs, `${state.id}.json`)
    await writeFile(path, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    state.logPath = path
    return state
  }
  async stop(cwd: string): Promise<void> {
    const run = this.runs.get(cwd)
    if (!run?.state.running) return
    run.state.stopped = true; run.child.kill()
    await run.child.waitForClose()
  }
  async stopAll(): Promise<void> { await Promise.all([...this.runs.keys()].map(cwd => this.stop(cwd))) }
}
