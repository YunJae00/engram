import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { activityScript } from '../src/main/activity-script.js'

it.skipIf(process.platform !== 'win32')('discovers open app paths at startup once, without recording hidden or inaccessible processes', async () => {
  const script = activityScript(123, 15_000)
  const startup = /\$seen = @\{\}([\s\S]*?)\$tick = 0/.exec(script)?.[0].replace('$tick = 0', '')
  expect(startup).toContain('Get-Process')
  const fixture = String.raw`
function Get-Process {
  [pscustomobject]@{ ProcessName = 'Editor'; MainWindowHandle = 1; Path = 'C:\Apps\Editor.exe' }
  [pscustomobject]@{ ProcessName = 'Editor'; MainWindowHandle = 2; Path = 'C:\Apps\Editor.exe' }
  [pscustomobject]@{ ProcessName = 'Hidden'; MainWindowHandle = 0; Path = 'C:\Apps\Hidden.exe' }
  [pscustomobject]@{ ProcessName = 'Missing'; MainWindowHandle = 3; Path = $null }
  $denied = [pscustomobject]@{ ProcessName = 'Denied'; MainWindowHandle = 4 }
  $denied | Add-Member ScriptProperty Path { throw 'Access denied' }
  $denied
  [pscustomobject]@{ ProcessName = 'Viewer'; MainWindowHandle = 5; Path = 'C:\Apps\Viewer.exe' }
}
`
  const command = Buffer.from(fixture + startup, 'utf16le').toString('base64')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], { windowsHide: true, timeout: 30_000 })
  expect(stdout.trim().split(/\r?\n/)).toEqual([':path|Editor|C:\\Apps\\Editor.exe', ':path|Viewer|C:\\Apps\\Viewer.exe'])
})
