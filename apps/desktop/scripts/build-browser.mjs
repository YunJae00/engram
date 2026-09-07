import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  const script = fileURLToPath(new URL('./build-browser.ps1', import.meta.url))
  execFileSync('powershell.exe', ['-NoProfile', '-File', script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
}
