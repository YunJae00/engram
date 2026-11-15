// The Claude agent runtime Engram downloads and runs. Its Claude Code CLI
// carries the same patch number (SDK 0.3.272 ships Claude Code 2.1.272).
export const CLAUDE_RUNTIME_VERSION = '0.3.272'

// Opus 5.5 is accepted from Claude Code 2.1.280 on. An older runtime answers
// every call naming claude-opus-5-5 with a 400 ("does not support this model"),
// so it is given the `opus` alias, which it resolves to the newest Opus it knows.
export const OPUS_55 = 'claude-opus-5-5'
const OPUS_55_FIRST_PATCH = 280
export function workModelFor(runtimeVersion: string): string {
  const [major, minor, patch] = runtimeVersion.split('.').map(part => Number.parseInt(part, 10))
  if (major === undefined || minor === undefined || patch === undefined || [major, minor, patch].some(Number.isNaN)) return 'opus'
  const newer = major > 0 || minor > 3 || (minor === 3 && patch >= OPUS_55_FIRST_PATCH)
  return newer ? OPUS_55 : 'opus'
}
