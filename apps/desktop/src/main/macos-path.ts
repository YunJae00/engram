import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

// macOS GUI apps launched from the Dock/Finder inherit launchd's minimal
// PATH (/usr/bin:/bin:…), not the user's shell PATH — so PATH-resolved
// binaries (claude, whisper, Homebrew git) that work in a terminal are
// invisible to the packaged app. Ask the user's login shell for its PATH
// once at boot and adopt it. Dev launches from a terminal already carry the
// full PATH; merging is a no-op there. Windows/Linux never hit this.
export function fixMacPath(): void {
  if (process.platform !== 'darwin') return
  const parts = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  try {
    // Login (non-interactive) shell: sources .zprofile/.profile where PATH
    // exports live, without interactive rc noise polluting stdout.
    const shell = process.env['SHELL'] ?? '/bin/zsh'
    const out = execFileSync(shell, ['-lc', 'echo -n "$PATH"'], { encoding: 'utf8', timeout: 5000 })
    parts.push(...out.trim().split(':').filter(Boolean))
  } catch {
    /* shell probe failed — the static fallbacks below still apply */
  }
  // Common install locations some setups only add in interactive rc files.
  parts.push('/opt/homebrew/bin', '/usr/local/bin', `${homedir()}/.local/bin`)
  process.env['PATH'] = [...new Set(parts)].join(':')
}
