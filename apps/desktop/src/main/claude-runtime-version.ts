export const CLAUDE_RUNTIME_VERSION = '0.3.272'

export const OPUS_55 = 'claude-opus-5-5'
const OPUS_55_FIRST_PATCH = 280
export function workModelFor(runtimeVersion: string): string {
  const [major, minor, patch] = runtimeVersion.split('.').map(part => Number.parseInt(part, 10))
  if (major === undefined || minor === undefined || patch === undefined || [major, minor, patch].some(Number.isNaN)) return 'opus'
  const newer = major > 0 || minor > 3 || (minor === 3 && patch >= OPUS_55_FIRST_PATCH)
  return newer ? OPUS_55 : 'opus'
}
