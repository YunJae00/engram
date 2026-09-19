import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export async function devLocalPath(cwd: string, value: unknown): Promise<boolean> {
  if (typeof value !== 'string') return false
  try {
    const root = await realpath(cwd), target = await realpath(resolve(root, value)), tail = relative(root, target)
    return !isAbsolute(tail) && tail !== '..' && !tail.startsWith('../') && !tail.startsWith('..\\')
      && !/(^|[\\/])(?:\.git|\.claude|\.codex|\.ssh|\.aws|\.env[^\\/]*|credentials(?:\.[^\\/]*)?|[^\\/]*\.(?:pem|key|pfx))([\\/]|$)/i.test(tail)
  } catch { return false }
}

export async function devEditPreview(cwd: string, tool: string, input: Record<string, unknown>): Promise<{ path: string; before: string; after: string } | undefined> {
  if (!['Edit', 'Write'].includes(tool) || typeof input['file_path'] !== 'string') return undefined
  const root = await realpath(cwd), path = resolve(root, input['file_path'])
  const inside = (target: string) => { const tail = relative(root, target); return tail !== '' && !isAbsolute(tail) && tail !== '..' && !tail.startsWith('../') && !tail.startsWith('..\\') && !/(^|[\\/])(?:\.git|\.claude|\.codex|\.ssh|\.aws|\.env[^\\/]*|credentials(?:\.[^\\/]*)?|[^\\/]*\.(?:pem|key|pfx))([\\/]|$)/i.test(tail) }
  if (!inside(path)) return undefined
  let actual: string, before = ''
  try {
    actual = await realpath(path)
    if (!inside(actual)) return undefined
    const info = await stat(actual)
    if (!info.isFile() || info.size > 500_000) return undefined
    before = await readFile(actual, 'utf8')
    if (before.includes('\0')) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || tool !== 'Write') return undefined
    let parent = dirname(path)
    for (;;) {
      try { const canonical = await realpath(parent); if (canonical !== root && !inside(canonical)) return undefined; break }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) return undefined; parent = dirname(parent) }
    }
  }
  let after: string
  if (tool === 'Write') {
    if (typeof input['content'] !== 'string' || input['content'].length > 500_000) return undefined
    after = input['content']
  } else {
    const old = input['old_string'], next = input['new_string']
    if (typeof old !== 'string' || !old || typeof next !== 'string' || !before.includes(old)) return undefined
    if (input['replace_all'] !== true && before.indexOf(old) !== before.lastIndexOf(old)) return undefined
    after = input['replace_all'] === true ? before.split(old).join(next) : before.replace(old, () => next)
    if (after.length > 500_000) return undefined
  }
  return { path, before, after }
}
