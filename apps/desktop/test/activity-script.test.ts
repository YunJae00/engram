import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { activityScript } from '../src/main/activity-script.js'

it.skipIf(process.platform !== 'win32')('discovers open and installed app paths at startup once, without recording hidden, inaccessible or missing programs', async () => {
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
function Get-ChildItem {
  param($Path)
  function key($name, $exe) { $k = [pscustomobject]@{ PSChildName = $name; Exe = $exe }; $k | Add-Member ScriptMethod GetValue { param($n) $this.Exe }; $k }
  if ($Path -like 'HKCU:*') { key 'Notes.exe' '"C:\Apps\Notes.exe"'; key 'Editor.exe' 'C:\Other\Editor.exe' }
  else { key 'Gone.exe' 'C:\Apps\Gone.exe' }
}
function Test-Path { param([string]$LiteralPath) $LiteralPath -notlike '*Gone*' }
`
  const command = Buffer.from(fixture + startup, 'utf16le').toString('base64')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], { windowsHide: true, timeout: 30_000 })
  expect(stdout.trim().split(/\r?\n/)).toEqual([':path|Editor|C:\\Apps\\Editor.exe', ':path|Viewer|C:\\Apps\\Viewer.exe', ':path|Notes|C:\\Apps\\Notes.exe'])
})
