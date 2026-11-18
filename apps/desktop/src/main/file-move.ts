import { link, lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentTool, VaultPaths } from 'core'

const within = (root: string, path: string) => {
  const tail = relative(root, path)
  return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
}
async function actual(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return resolve(await actual(dirname(path)), relative(dirname(path), path))
  }
}

export function fileMoveTool(paths: VaultPaths, assertActive: () => void): AgentTool {
  return {
    name: 'file_move',
    description: `Move or rename the person's files and folders inside their workspace folder ${paths.workspace}, when they asked for it: sort a folder into subfolders, rename, or put an earlier move back. moves: [{from, to}], each a path inside the workspace (absolute, or relative to it) with to the full new path including the name; up to 500 in one call. Missing folders are created. Nothing is overwritten and nothing is deleted: if any target already exists nothing is moved at all. It needs no approval and no command, so never ask to run mv outside the sandbox for this. Engram's own folders (notes, inbox, sources, _views, .engram) are not touched. Afterwards answer with one bullet line per folder: its name, how many files it holds and their names.`,
    argsSchema: { type: 'object', additionalProperties: false, required: ['moves'], properties: {
      moves: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
    } },
    async run(args, context) {
      context.signal?.throwIfAborted()
      assertActive()
      const moves = args['moves']
      if (!Array.isArray(moves) || !moves.length || moves.length > 500) throw new Error('Supply 1 to 500 moves.')
      const root = await realpath(paths.workspace)
      const own = await Promise.all([paths.cache, paths.notes, paths.inbox, paths.sources, paths.views].map(actual)), tasks = await actual(resolve(paths.workspace, 'tasks'))
      const place = async (value: unknown): Promise<string> => {
        if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Each move needs a from and a to path.')
        const path = resolve(root, value)
        const real = resolve(await actual(dirname(path)), path.slice(dirname(path).length + 1))
        if (real === root || !within(root, real) || own.some(folder => within(folder, real) || within(real, folder)) || within(real, tasks)) throw new Error(`Only the person's own files inside ${paths.workspace} can be moved, not Engram's folders: ${value}`)
        return real
      }
      const plan: { from: string; to: string; folder: boolean }[] = []
      for (const move of moves) {
        if (!move || typeof move !== 'object') throw new Error('Each move needs a from and a to path.')
        const from = await place((move as Record<string, unknown>)['from']), to = await place((move as Record<string, unknown>)['to'])
        const info = await lstat(from).catch(() => null)
        if (!info || !(info.isFile() || info.isDirectory())) throw new Error(`Not a file or folder: ${relative(root, from)}`)
        if (from === to || within(from, to)) throw new Error(`A folder cannot be moved into itself: ${relative(root, from)}`)
        if (await lstat(to).catch(() => null) || plan.some(one => one.to === to)) throw new Error(`Nothing was moved: ${relative(root, to)} already exists. Choose another name.`)
        if (plan.some(one => one.from === from)) throw new Error(`Listed twice: ${relative(root, from)}`)
        plan.push({ from, to, folder: info.isDirectory() })
      }
      const done: typeof plan = []
      try {
        for (const move of plan) {
          context.signal?.throwIfAborted()
          assertActive()
          await mkdir(dirname(move.to), { recursive: true })
          if (move.folder) { if (await lstat(move.to).catch(() => null)) throw new Error(`${relative(root, move.to)} already exists.`); await rename(move.from, move.to) }
          else {
            await link(move.from, move.to)
            try { await unlink(move.from) } catch (error) { await unlink(move.to).catch(() => undefined); throw error }
          }
          done.push(move)
        }
      } catch (error) {
        for (const move of done.reverse()) await rename(move.to, move.from).catch(() => undefined)
        throw new Error(`Nothing was moved: ${error instanceof Error ? error.message : String(error)}`)
      }
      if ((await Promise.all(plan.map(async move => !!await lstat(move.to).catch(() => null) && !await lstat(move.from).catch(() => null)))).every(Boolean)) context.onObservedAfterAction?.()
      const folders = new Map<string, string[]>()
      for (const move of plan) {
        const folder = relative(root, dirname(move.to)).split(sep).join('/') || '.'
        folders.set(folder, [...(folders.get(folder) ?? []), move.to.slice(dirname(move.to).length + 1)])
      }
      return JSON.stringify({ moved: plan.length, overwritten: 0, deleted: 0, folders: [...folders].map(([folder, files]) => ({ folder, count: files.length, files })) })
    },
  }
}
