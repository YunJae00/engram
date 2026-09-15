import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'

const run = promisify(execFile)
export async function managedBookmarkSources(browser: string): Promise<{ id: string; name: string; text: string }[]> {
  if (browser !== 'chrome' && browser !== 'edge') return []
  const key = browser === 'chrome' ? 'ManagedBookmarks' : 'ManagedFavorites'
  if (process.platform === 'win32') {
    const product = browser === 'chrome' ? 'Google\\Chrome' : 'Microsoft\\Edge'
    const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; $items = @(); foreach ($scope in @('HKLM','HKCU')) { $path = $scope + ':\\Software\\Policies\\${product}'; if (Test-Path -LiteralPath $path) { $item = Get-ItemProperty -LiteralPath $path; $value = $item.PSObject.Properties['${key}']; if ($null -ne $value -and $value.Value -is [string]) { $items += @{ id = $scope; text = $value.Value } } } }; ConvertTo-Json -InputObject $items -Compress`
    const executable = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await run(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 5_000_000, encoding: 'utf8' })
    const rows: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    if (!Array.isArray(rows)) throw new Error('Managed bookmark policy could not be read')
    return rows.flatMap(row => row && ['HKLM', 'HKCU'].includes(row.id) && typeof row.text === 'string' ? [{ id: `${browser}:managed:${row.id}`, name: row.id === 'HKLM' ? 'Organization · Device' : 'Organization · User', text: row.text }] : [])
  }
  if (process.platform === 'darwin') {
    const domain = browser === 'chrome' ? 'com.google.Chrome' : 'com.microsoft.Edge'
    const results: { id: string; name: string; text: string }[] = []
    for (const [scope, folder] of [['device', '/Library/Managed Preferences'], ['user', join(homedir(), 'Library', 'Preferences')]] as const) {
      const result = await run('/usr/bin/plutil', ['-extract', key, 'json', '-o', '-', join(folder, `${domain}.plist`)], { timeout: 5000, maxBuffer: 5_000_000, encoding: 'utf8' }).catch(() => undefined)
      if (result) results.push({ id: `${browser}:managed:${scope}`, name: `Organization · ${scope === 'device' ? 'Device' : 'User'}`, text: result.stdout })
    }
    return results
  }
  return []
}
