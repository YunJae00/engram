import { execFile } from 'node:child_process'
import type { AgentTool } from 'core'

export type VolumeRunner = (args: string[], signal?: AbortSignal) => Promise<string>

const osascript: VolumeRunner = (args, signal) => new Promise((resolve, reject) => {
  execFile('osascript', args, { timeout: 5_000, ...(signal ? { signal } : {}) }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
})

const ACTIONS = ['get', 'set', 'mute', 'unmute'] as const
type Action = typeof ACTIONS[number]
const READ = ['-e', 'get volume settings']

export function volumePercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('percent must be a number from 0 to 100')
  return Math.min(100, Math.max(0, Math.round(value)))
}

function readBack(text: string): { level: number | null; muted: boolean | null } {
  const level = text.match(/output volume:(\d+|missing value)/)?.[1]
  const muted = text.match(/output muted:(true|false|missing value)/)?.[1]
  if (level === undefined && muted === undefined) throw new Error(`Could not read the output volume: ${text.slice(0, 200)}`)
  return {
    level: level === undefined || level === 'missing value' ? null : Number(level),
    muted: muted === 'true' ? true : muted === 'false' ? false : null,
  }
}

function command(action: Action, percent: number): string[] | null {
  if (action === 'set') return ['-e', `set volume output volume ${percent}`]
  if (action === 'mute') return ['-e', 'set volume output muted true']
  if (action === 'unmute') return ['-e', 'set volume output muted false']
  return null
}

export function systemVolumeTool(run: VolumeRunner = osascript, platform: NodeJS.Platform = process.platform): AgentTool {
  return {
    name: 'system_volume',
    description: "Reads or sets the Mac's system output volume (0-100) and mute. Read-only/system: needs no app control approval and opens no app. After set/mute/unmute it reads the volume back; report the value it returns, not the one requested. Not supported on Windows or Linux.",
    argsSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        percent: { type: 'number', description: 'Target output volume 0-100 for set; out-of-range values are clamped.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: async (args, context) => {
      if (platform !== 'darwin') return `System volume control is not supported on ${platform === 'win32' ? 'Windows' : 'Linux'} yet.`
      const action = args['action']
      if (!ACTIONS.includes(action as Action)) throw new Error('action must be get, set, mute or unmute')
      const act = action as Action
      const percent = act === 'set' ? volumePercent(args['percent']) : 0
      const write = command(act, percent)
      context.signal?.throwIfAborted()
      if (write) await run(write, context.signal)
      context.signal?.throwIfAborted()
      const { level, muted } = readBack(await run(READ, context.signal))
      if (level === null) return 'This output device has no software volume control (macOS reports no level).'
      let answer = `Output volume ${act === 'get' ? 'is' : 'is now'} ${level}%${muted ? ' and muted' : ''}.`
      if (act === 'set' && level !== percent) answer += ` Asked for ${percent}%, but macOS reports ${level}%.`
      if (act === 'set' && muted) answer += ' Output is muted, so nothing is audible until it is unmuted.'
      if ((act === 'mute' && muted !== true) || (act === 'unmute' && muted !== false)) answer += ` The ${act} did not take effect.`
      if (act === 'set' && args['percent'] !== percent) answer += ` (requested ${String(args['percent'])}, clamped to ${percent}).`
      return answer
    },
  }
}
