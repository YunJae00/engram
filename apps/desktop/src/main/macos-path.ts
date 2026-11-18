import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

export function fixMacPath(): void {
  if (process.platform !== 'darwin') return
  const parts = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  try {
    const shell = process.env['SHELL'] ?? '/bin/zsh'
    const out = execFileSync(shell, ['-lc', 'echo -n "$PATH"'], { encoding: 'utf8', timeout: 5000 })
    parts.push(...out.trim().split(':').filter(Boolean))
  } catch {
  }
  parts.push('/opt/homebrew/bin', '/usr/local/bin', `${homedir()}/.local/bin`)
  process.env['PATH'] = [...new Set(parts)].join(':')
}
