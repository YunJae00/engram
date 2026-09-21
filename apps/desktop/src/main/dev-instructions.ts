import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

// Read text guidance without enabling executable project settings or hooks.
export async function devClaudeInstructions(cwd: string): Promise<string> {
  const root = await realpath(cwd), guidance: string[] = []
  for (const path of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    let target: string
    try { target = await realpath(resolve(root, path)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const tail = relative(root, target)
    if (isAbsolute(tail) || tail === '..' || tail.startsWith('../') || tail.startsWith('..\\')) throw new Error(`${path} points outside this workspace. Review its location before starting.`)
    const expected = resolve(root, path), normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (normalize(target) !== normalize(expected)) throw new Error(`${path} redirects to another file. Use a regular instruction file in this workspace.`)
    const handle = await open(target, 'r')
    try {
      const info = await handle.stat(), buffer = Buffer.alloc(65_537)
      if (!info.isFile() || info.size > 65_536) throw new Error(`${path} must be a text file up to 64 KB.`)
      let size = 0
      while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead }
      if (size > 65_536 || buffer.subarray(0, size).includes(0)) throw new Error(`${path} must be a text file up to 64 KB.`)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)) }
      catch { throw new Error(`${path} must contain UTF-8 text.`) }
      if (text.trim()) guidance.push(`Project instructions from ${path}:\n${text}`)
    } finally { await handle.close() }
  }
  return guidance.join('\n\n')
}
