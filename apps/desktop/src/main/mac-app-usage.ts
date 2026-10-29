import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AppUse } from 'core'
const run = promisify(execFile)

export function parseMacAppUse(raw: string): AppUse | undefined {
  // mdls emits requested attributes in alphabetical order, separated by NUL.
  const [name, date, count] = raw.split('\0')
  const runs = Number(count), lastRun = Date.parse(date ?? '')
  if (!name || name === '(null)' || !Number.isSafeInteger(runs) || runs <= 0) return undefined
  return { name, runs, focusMs: 0, ...(Number.isFinite(lastRun) ? { lastRun } : {}) }
}

export async function readMacAppUse(): Promise<AppUse[]> {
  const paths = new Set<string>()
  for (const root of ['/Applications', '/System/Applications', join(homedir(), 'Applications')]) {
    const { stdout } = await run('/usr/bin/mdfind', ['-0', '-onlyin', root, 'kMDItemContentType == "com.apple.application-bundle"'], { encoding: 'utf8', timeout: 3000, maxBuffer: 262144 }).catch(() => ({ stdout: '' }))
    for (const path of stdout.split('\0')) if (path.startsWith(root + '/') && path.endsWith('.app')) paths.add(path)
  }
  const output: AppUse[] = [], list = [...paths].slice(0, 256)
  for (let index = 0; index < list.length; index += 4) {
    const batch = await Promise.all(list.slice(index, index + 4).map(async path => {
      const { stdout } = await run('/usr/bin/mdls', ['-raw', '-name', 'kMDItemDisplayName', '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemUseCount', path], { encoding: 'utf8', timeout: 2000, maxBuffer: 16384 }).catch(() => ({ stdout: '' }))
      return parseMacAppUse(stdout)
    }))
    output.push(...batch.filter((value): value is AppUse => Boolean(value)))
  }
  return output.sort((left, right) => right.runs - left.runs)
}
